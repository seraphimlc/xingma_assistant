import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as fs from 'fs';
import { AuthService } from '../auth/auth.service';
import { AuthContext } from '../common/interfaces/auth-context.interface';
import { ProductsService } from '../products/products.service';
import { looksLikeDocument } from '../vision/cover-select';
import { DecartTokenClient } from './decart-token.client';
import {
  SelectedTryOnColor,
  TryOnImageInput,
  classifyTryOnImage,
  selectTryOnColors,
  toPublicTryOnDto,
} from './tryon-garments';
import { SlidingWindowLimiter } from './tryon-rate';
import { TRYON_TICKET_TTL_SEC, readTryOnClaims, tryOnTicketPayload } from './tryon-ticket';

const TICKET_INVALID = '试衣链接已失效，请返回商品页重新打开';
const RATE_LIMITED = '试衣太频繁，请稍后再试';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

interface TryOnSource {
  name: string;
  skus: Array<{ id: string; color: string | null; status?: string }>;
  images: TryOnImageInput[];
}

@Injectable()
export class TryonService {
  private readonly logger = new Logger('TryOn');
  private readonly limiter = new SlidingWindowLimiter();
  private readonly docCache = new Map<string, boolean>();

  constructor(
    private readonly auth: AuthService,
    private readonly products: ProductsService,
    private readonly decart: DecartTokenClient,
    @Optional() private readonly dataSource?: DataSource,
  ) {}

  tokenFrom(req: { headers?: Record<string, string | undefined>; query?: Record<string, unknown>; body?: any }): string {
    const header = req.headers?.authorization || req.headers?.Authorization || '';
    if (header.startsWith('Bearer ')) return header.slice(7).trim();
    const queryTicket = req.query?.ticket;
    if (typeof queryTicket === 'string' && queryTicket.trim()) return queryTicket.trim();
    const bodyTicket = req.body?.ticket;
    if (typeof bodyTicket === 'string' && bodyTicket.trim()) return bodyTicket.trim();
    return '';
  }

  async catalog(
    token: string,
    productId: string,
    share?: { shareEventId?: string; boundCustomerId?: string },
  ) {
    const source = await this.sourceFor(token, productId, share);
    const colors = await this.colorsOf(productId, source);
    return toPublicTryOnDto(source.name, productId, colors);
  }

  async issueTicket(
    user: AuthContext,
    productId: string,
    share?: { shareEventId?: string; boundCustomerId?: string },
  ) {
    const source = await this.products.loadTryOnSource(user, productId, share);
    const colors = await this.colorsOf(productId, source);
    if (!colors.length) throw new BadRequestException('这款暂时没有可用于试衣的图片');
    const expMs = Date.now() + TRYON_TICKET_TTL_SEC * 1000;
    const ticket = await this.auth.signRaw(
      tryOnTicketPayload(user, productId) as unknown as Record<string, unknown>,
      TRYON_TICKET_TTL_SEC,
    );
    return { ticket, expiresAt: new Date(expMs).toISOString() };
  }

  async mintToken(
    token: string,
    body: { productId?: string; shareEventId?: string; boundCustomerId?: string },
    ip: string,
  ) {
    const session = token ? this.auth.verifyToken(token) : null;
    let openid = '';
    let productId = '';
    let source: TryOnSource;
    if (session) {
      productId = String(body?.productId || '').trim();
      if (!productId) throw new BadRequestException('缺少商品');
      openid = session.openid;
      this.assertRate(openid, productId, ip);
      source = await this.products.loadTryOnSource(session, productId, {
        shareEventId: body?.shareEventId,
        boundCustomerId: body?.boundCustomerId,
      });
    } else {
      const claims = readTryOnClaims(token ? this.auth.decodeVerified(token) : null);
      if (!claims) throw new UnauthorizedException(TICKET_INVALID);
      productId = claims.productId;
      openid = claims.openid;
      this.assertRate(openid, productId, ip);
      source = await this.products.loadTryOnSourceForTicket(claims.tenantId, productId);
    }
    const colors = await this.colorsOf(productId, source);
    if (!colors.length) throw new BadRequestException('这款暂时没有可用于试衣的图片');
    return this.decart.mintClientToken();
  }

  async readGarment(token: string, productId: string, colorId: string, share?: { shareEventId?: string; boundCustomerId?: string }) {
    if (!productId || !colorId) throw new BadRequestException('缺少试衣图片参数');
    const source = await this.sourceFor(token, productId, share);
    const colors = await this.colorsOf(productId, source);
    const color = colors.find((c) => c.id === colorId);
    if (!color) throw new NotFoundException('没有可试衣的图片');
    return this.readImageBytes(color);
  }

  private async sourceFor(
    token: string,
    productId: string,
    share?: { shareEventId?: string; boundCustomerId?: string },
  ): Promise<TryOnSource> {
    if (!productId) throw new BadRequestException('缺少商品');
    const session = token ? this.auth.verifyToken(token) : null;
    if (session) {
      return this.products.loadTryOnSource(session, productId, share);
    }
    const claims = readTryOnClaims(token ? this.auth.decodeVerified(token) : null, productId);
    if (!claims) throw new UnauthorizedException(TICKET_INVALID);
    return this.products.loadTryOnSourceForTicket(claims.tenantId, productId);
  }

  private async colorsOf(productId: string, source: TryOnSource): Promise<SelectedTryOnColor[]> {
    const enriched = await this.enrichFromPublishJob(productId, source.images);
    const prepared = enriched.map((img) => {
      const kind = classifyTryOnImage(img);
      const documentLike = kind === 'unknown' && img.localPath ? this.documentLike(img.localPath) : false;
      return documentLike ? { ...img, documentLike: true } : img;
    });
    return selectTryOnColors(prepared, source.skus);
  }

  /** 发品任务里留着原始文件名和角色；落库后文件常被改名为 01.jpg。 */
  private async enrichFromPublishJob(productId: string, images: TryOnImageInput[]): Promise<TryOnImageInput[]> {
    if (!this.dataSource || process.env.DB_ENABLED !== 'true' || !images.length) return images;
    try {
      const rows: Array<{ result: unknown }> = await this.dataSource.query(
        `SELECT result FROM jobs
         WHERE tenant_id = (SELECT tenant_id FROM products WHERE id = ? LIMIT 1)
           AND type = 'publish_product' AND status = 'succeeded'
           AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.productId')) = ?
         ORDER BY finished_at DESC
         LIMIT 1`,
        [productId, productId],
      );
      const result = this.asObject(rows[0]?.result);
      const shots = Array.isArray(result?.sourceImages) ? result.sourceImages : [];
      if (!shots.length) return images;
      const byId = new Map<string, { role?: string; filename?: string; colorHint?: string }>();
      for (const shot of shots) {
        if (!shot || typeof shot !== 'object') continue;
        const mediaId = String((shot as any).mediaId || '');
        if (!mediaId) continue;
        byId.set(mediaId, {
          role: (shot as any).role ? String((shot as any).role) : undefined,
          filename: (shot as any).filename ? String((shot as any).filename) : undefined,
          colorHint: (shot as any).colorHint ? String((shot as any).colorHint) : undefined,
        });
      }
      return images.map((img) => {
        const hit = byId.get(img.id);
        if (!hit) return img;
        const meta = { ...(img.meta || {}) };
        if (!meta.role && hit.role) meta.role = hit.role;
        if (!meta.colorHint && hit.colorHint) meta.colorHint = hit.colorHint;
        const generic = /^\d{1,3}\.(jpe?g|png|webp|gif)$/i.test(img.filename || '');
        const filename = generic && hit.filename ? hit.filename : img.filename;
        return { ...img, meta, filename };
      });
    } catch (e: any) {
      this.logger.warn(`tryon publish roles skipped: ${String(e?.message || e).slice(0, 120)}`);
      return images;
    }
  }

  private documentLike(localPath: string): boolean {
    const cached = this.docCache.get(localPath);
    if (cached != null) return cached;
    let hit = false;
    try {
      hit = looksLikeDocument(localPath);
    } catch {
      hit = false;
    }
    this.docCache.set(localPath, hit);
    return hit;
  }

  private assertRate(openid: string, productId: string, ip: string) {
    const who = `${openid}|${productId}`;
    if (!this.limiter.allow(`min:${who}`, 8, 60_000) || !this.limiter.allow(`long:${who}`, 30, 10 * 60_000)) {
      throw new HttpException(RATE_LIMITED, HttpStatus.TOO_MANY_REQUESTS);
    }
    const host = (ip || 'unknown').slice(0, 64);
    if (!this.limiter.allow(`ip:${host}`, 40, 60_000)) {
      throw new HttpException(RATE_LIMITED, HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  private async readImageBytes(color: SelectedTryOnColor): Promise<{ mime: string; data: Buffer }> {
    if (color.localPath && fs.existsSync(color.localPath)) {
      const data = fs.readFileSync(color.localPath);
      if (data.length > MAX_IMAGE_BYTES) throw new BadRequestException('图片过大，无法试衣');
      const mime = sniffImage(data);
      if (!mime) throw new BadRequestException('这张图片无法用于试衣');
      return { mime, data };
    }
    const url = String(color.sourceUrl || '');
    if (!isSafeRemoteImageUrl(url)) throw new NotFoundException('没有可试衣的图片');
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(12000), redirect: 'follow' });
    } catch (e: any) {
      this.logger.warn(`tryon image fetch failed: ${String(e?.message || e).slice(0, 120)}`);
      throw new BadRequestException('衣服图片暂时打不开');
    }
    if (!res.ok) throw new BadRequestException('衣服图片暂时打不开');
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_IMAGE_BYTES) throw new BadRequestException('图片过大，无法试衣');
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > MAX_IMAGE_BYTES) throw new BadRequestException('图片过大，无法试衣');
    const mime = sniffImage(data);
    if (!mime) throw new BadRequestException('这张图片无法用于试衣');
    return { mime, data };
  }

  private asObject(value: unknown): Record<string, any> | null {
    if (!value) return null;
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    }
    return typeof value === 'object' ? (value as Record<string, any>) : null;
  }
}

export function sniffImage(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (buf.length >= 6 && (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a')) {
    return 'image/gif';
  }
  return null;
}

export function isSafeRemoteImageUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0' || host === '::1') return false;
    if (host === '127.0.0.1' || host.startsWith('127.')) return false;
    if (host === '169.254.169.254' || host.startsWith('169.254.')) return false;
    if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

export function clientIp(req: { ip?: string; headers?: Record<string, string | string[] | undefined> }): string {
  const forwarded = req.headers?.['x-forwarded-for'];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const raw = (first || req.ip || '').split(',')[0].trim();
  return raw || 'unknown';
}
