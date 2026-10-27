import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { unwrapAbsoluteMediaUrl } from '../common/utils/media-url';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const AliOss = require('ali-oss');

export type OssPutResult = { ossKey: string; url: string };

/**
 * 阿里云 OSS 适配：本地仍落盘（OCR/封面需要 localPath），
 * OSS_PROVIDER=aliyun 时同步 put；读链接一律短时签名 GET（私有桶）。
 * objectKey 在业务侧保持 tenants/...；OSS 上实际 key = `${OSS_PREFIX}/${objectKey}`。
 */
@Injectable()
export class OssClient implements OnModuleInit {
  private readonly logger = new Logger('OssClient');
  private client: any = null;
  private provider = 'mock';
  private prefix = '';
  private publicBase = '';
  /** 签名 GET 默认过期秒数（OSS_SIGNED_URL_EXPIRES / OSS_SIGNED_TTL，默认 3600） */
  private signedTtl = 3600;
  private serveLocal = false;
  /** 仅当显式 OSS_PUBLIC_READ=1 时返回永久公网 URL（兼容旧公开桶）；默认始终签名 */
  private publicRead = false;
  private accessKeyId = '';
  private accessKeySecret = '';
  private bucket = '';
  private region = '';
  private endpointHost = '';
  /** 新上传对象 ACL：私有桶用 private */
  private objectAcl: 'private' | 'public-read' = 'private';

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    this.reload();
  }

  /** 读取配置（含 ALIYUN_* fallback） */
  reload() {
    const env = (k: string, ...alts: string[]) => {
      for (const key of [k, ...alts]) {
        const v = process.env[key];
        if (v != null && String(v).trim() !== '') return String(v).trim();
      }
      return '';
    };

    this.provider = (env('OSS_PROVIDER') || this.config.get<string>('oss.provider') || 'mock').toLowerCase();
    this.prefix = (env('OSS_PREFIX', 'ALIYUN_OSS_PREFIX') || this.config.get<string>('oss.prefix') || '')
      .replace(/^\/+|\/+$/g, '');
    this.signedTtl = parseInt(
      env('OSS_SIGNED_URL_EXPIRES', 'OSS_SIGNED_TTL') ||
        String(this.config.get<number>('oss.signedUrlTtlSec') || 3600),
      10,
    );
    if (!Number.isFinite(this.signedTtl) || this.signedTtl < 60) this.signedTtl = 3600;
    this.serveLocal = env('MEDIA_SERVE_LOCAL') === '1' || env('MEDIA_SERVE_LOCAL').toLowerCase() === 'true';
    // 私有桶默认签名；仅 OSS_PUBLIC_READ=1 时走永久公网（或旧 OSS_FORCE_SIGNED=0 且 PUBLIC_READ）
    this.publicRead =
      env('OSS_PUBLIC_READ') === '1' || env('OSS_PUBLIC_READ').toLowerCase() === 'true';
    // 兼容：若仍设 OSS_FORCE_SIGNED=0 且未设 PUBLIC_READ，仍默认签名（忽略 FORCE=0）
    const forceSignedLegacy =
      env('OSS_FORCE_SIGNED') === '1' || env('OSS_FORCE_SIGNED').toLowerCase() === 'true';
    if (forceSignedLegacy) this.publicRead = false;

    const region = env('OSS_REGION', 'ALIYUN_OSS_REGION') || this.config.get<string>('oss.region') || '';
    const endpoint =
      env('OSS_ENDPOINT', 'ALIYUN_OSS_ENDPOINT') ||
      this.config.get<string>('oss.endpoint') ||
      (region ? `https://${region}.aliyuncs.com` : '');
    const bucket =
      env('OSS_BUCKET', 'ALIYUN_OSS_BUCKET') || this.config.get<string>('oss.bucket') || '';
    const accessKeyId =
      env('OSS_ACCESS_KEY_ID', 'ALIYUN_ACCESS_KEY_ID') ||
      this.config.get<string>('oss.accessKeyId') ||
      '';
    const accessKeySecret =
      env('OSS_ACCESS_KEY_SECRET', 'ALIYUN_ACCESS_KEY_SECRET') ||
      this.config.get<string>('oss.accessKeySecret') ||
      '';

    const aclEnv = (env('OSS_OBJECT_ACL') || 'private').toLowerCase();
    this.objectAcl = aclEnv === 'public-read' ? 'public-read' : 'private';

    // 公开读基址：优先 MEDIA_PUBLIC_BASE（若已是 OSS 域名）；否则 bucket.endpoint
    const mediaBase = (env('MEDIA_PUBLIC_BASE') || this.config.get<string>('oss.mediaPublicBase') || '').replace(
      /\/$/,
      '',
    );
    if (this.provider === 'aliyun' && bucket && endpoint) {
      const hostFromEndpoint = endpoint.replace(/^https?:\/\//, '').replace(/\/$/, '');
      const derived = `https://${bucket}.${hostFromEndpoint}`;
      const looksLocal =
        !mediaBase ||
        /127\.0\.0\.1|localhost|172\.\d+\.|192\.168\.|10\.\d+\.|visitworld\.me/i.test(mediaBase);
      this.publicBase = looksLocal ? derived : mediaBase;
    } else {
      this.publicBase = mediaBase;
    }

    this.accessKeyId = accessKeyId;
    this.accessKeySecret = accessKeySecret;
    this.bucket = bucket;
    this.region = region;
    this.endpointHost = endpoint.replace(/^https?:\/\//, '').replace(/\/$/, '');
    this.client = null;
    if (this.provider === 'aliyun') {
      if (!accessKeyId || !accessKeySecret || !bucket) {
        this.logger.warn('OSS_PROVIDER=aliyun 但缺少密钥/bucket，退回 mock URL');
        return;
      }
      const opts: Record<string, unknown> = {
        accessKeyId,
        accessKeySecret,
        bucket,
        timeout: 120000,
      };
      if (region) opts.region = region.startsWith('oss-') ? region : `oss-${region}`;
      if (endpoint) {
        opts.endpoint = endpoint.replace(/^https?:\/\//, '');
        opts.secure = endpoint.startsWith('https');
      }
      this.client = new AliOss(opts);
      this.logger.log(
        `OSS ready provider=aliyun bucket=${bucket} region=${region || '-'} prefix=${this.prefix || '(none)'} ` +
          `signedGet=${!this.publicRead} ttl=${this.signedTtl}s acl=${this.objectAcl} publicBase=${this.publicBase}`,
      );
    } else {
      this.logger.log(`OSS provider=${this.provider}（本地 /media 假 CDN）`);
    }
  }

  isAliyun(): boolean {
    return this.provider === 'aliyun' && !!this.client;
  }

  /** 业务 objectKey → OSS 完整 key；绝对 http(s) 禁止再拼 OSS_PREFIX */
  fullKey(objectKey: string): string {
    const unwrapped = unwrapAbsoluteMediaUrl(objectKey);
    if (/^https?:\/\//i.test(unwrapped)) {
      // 调用方应走 publicUrl；此处绝不把绝对 URL 当 key 加前缀
      return unwrapped;
    }
    const key = String(unwrapped || '').replace(/^\/+/, '');
    if (!this.prefix) return key;
    if (key === this.prefix || key.startsWith(`${this.prefix}/`)) return key;
    return `${this.prefix}/${key}`;
  }

  getSignedUrlExpiresSec(): number {
    return this.signedTtl;
  }

  /**
   * 短时签名 GET URL（私有桶读）。expiresSec 默认 OSS_SIGNED_URL_EXPIRES（约 1h）。
   */
  signGetUrl(objectKey: string, expiresSec?: number): string {
    return this.getSignedUrlSync(objectKey, expiresSec);
  }

  /**
   * 对外可访问 URL。
   * - aliyun + 非 MEDIA_SERVE_LOCAL：默认签名 GET；仅 OSS_PUBLIC_READ=1 时永久公网
   * - 其它：`${MEDIA_PUBLIC_BASE|APP_BASE_URL}/media/${objectKey}`
   */
  publicUrl(objectKey: string): string {
    const raw = unwrapAbsoluteMediaUrl(objectKey);
    // 外部 HTTPS 已是完整 URL（outfit agent 等），禁止再拼 bucket/prefix
    if (/^https?:\/\//i.test(raw)) return raw;
    if (this.isAliyun() && !this.serveLocal) {
      if (!this.publicRead) {
        try {
          return this.signGetUrl(raw);
        } catch (e: any) {
          this.logger.warn(`signGetUrl failed: ${String(e?.message || e).slice(0, 120)}`);
        }
      }
      const base = this.publicBase.replace(/\/$/, '');
      return `${base}/${this.fullKey(raw)}`;
    }
    const base = (
      process.env.MEDIA_PUBLIC_BASE ||
      process.env.APP_BASE_URL ||
      this.config.get<string>('appBaseUrl') ||
      'http://127.0.0.1:3000'
    ).replace(/\/$/, '');
    return `${base}/media/${String(raw).replace(/^\/+/, '')}`;
  }

  /** 短时复用签名，避免列表轮询每次换 URL 导致小程序图片闪烁 */
  private signedUrlCache = new Map<string, { url: string; expireAt: number }>();

  getSignedUrlSync(objectKey: string, ttlSec?: number): string {
    if (!this.client) throw new Error('OSS client not ready');
    const raw = unwrapAbsoluteMediaUrl(objectKey);
    if (/^https?:\/\//i.test(raw)) return raw;
    const ttl = ttlSec ?? this.signedTtl;
    const full = this.fullKey(raw);
    const cacheKey = `${full}|${ttl}`;
    const now = Date.now();
    // 在过期前保留约 80% TTL，期间返回同一签名串
    const hit = this.signedUrlCache.get(cacheKey);
    if (hit && hit.expireAt > now) return hit.url;
    const url = this.client.signatureUrl(full, { expires: ttl });
    const keepMs = Math.max(60_000, Math.floor(ttl * 1000 * 0.8));
    this.signedUrlCache.set(cacheKey, { url, expireAt: now + keepMs });
    if (this.signedUrlCache.size > 2000) {
      for (const [k, v] of this.signedUrlCache) {
        if (v.expireAt <= now) this.signedUrlCache.delete(k);
        if (this.signedUrlCache.size <= 1500) break;
      }
    }
    return url;
  }

  async getSignedUrl(objectKey: string, ttlSec?: number): Promise<string> {
    return this.getSignedUrlSync(objectKey, ttlSec);
  }

  async putObject(buffer: Buffer, objectKey: string, mime?: string): Promise<OssPutResult> {
    if (!this.isAliyun()) {
      return { ossKey: objectKey, url: this.publicUrl(objectKey) };
    }
    const ossKey = this.fullKey(objectKey);
    const headers: Record<string, string> = {
      'x-oss-object-acl': this.objectAcl,
    };
    if (mime) headers['Content-Type'] = mime;
    await this.client.put(ossKey, buffer, { headers });
    return { ossKey, url: this.publicUrl(objectKey) };
  }

  /** 写入失败不阻断主流程，仅打日志（本地文件已在） */
  async putObjectSafe(buffer: Buffer, objectKey: string, mime?: string): Promise<string> {
    try {
      const r = await this.putObject(buffer, objectKey, mime);
      return r.url;
    } catch (e: any) {
      this.logger.warn(`OSS put failed ${objectKey}: ${String(e?.message || e).slice(0, 200)}`);
      // 回退本地假 CDN，避免前端彻底无图
      const base = (process.env.APP_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
      return `${base}/media/${String(objectKey).replace(/^\/+/, '')}`;
    }
  }

  mediaProvider(): string {
    return this.isAliyun() ? 'aliyun' : 'local';
  }

  /** 客户端直传 host：https://{bucket}.{endpointHost} */
  uploadHost(): string {
    if (!this.bucket || !this.endpointHost) return '';
    return `https://${this.bucket}.${this.endpointHost}`;
  }

  getBucket(): string {
    return this.bucket;
  }

  getRegion(): string {
    return this.region;
  }

  /**
   * PostObject 直传凭证（适合微信 wx.uploadFile）。
   * objectKey 为业务 key（tenants/...）；表单 key 字段用 fullKey。
   * 私有桶：acl=private，读仍靠 signGetUrl / publicUrl。
   */
  createPostUploadCredential(
    objectKey: string,
    opts?: { maxSize?: number; ttlSec?: number; mimePrefix?: string },
  ) {
    if (!this.isAliyun() || !this.accessKeyId || !this.accessKeySecret) {
      throw new Error('OSS 未就绪，无法签发直传凭证');
    }
    const fullKey = this.fullKey(objectKey);
    const ttl = opts?.ttlSec ?? Math.min(this.signedTtl, 3600);
    const expireAt = Date.now() + ttl * 1000;
    const maxSize = opts?.maxSize ?? 12 * 1024 * 1024;
    const mimePrefix = opts?.mimePrefix ?? 'image/';
    const acl = this.objectAcl;
    const policyObj = {
      expiration: new Date(expireAt).toISOString(),
      conditions: [
        ['eq', '$key', fullKey],
        ['content-length-range', 0, maxSize],
        ['starts-with', '$Content-Type', mimePrefix],
        ['eq', '$x-oss-object-acl', acl],
      ],
    };
    const policy = Buffer.from(JSON.stringify(policyObj)).toString('base64');
    const signature = createHmac('sha1', this.accessKeySecret).update(policy).digest('base64');
    return {
      provider: 'aliyun' as const,
      mode: 'post' as const,
      objectKey,
      key: fullKey,
      host: this.uploadHost(),
      bucket: this.bucket,
      region: this.region,
      accessKeyId: this.accessKeyId,
      policy,
      signature,
      expireAt,
      successActionStatus: '200',
      acl,
      maxSize,
      publicUrl: this.publicUrl(objectKey),
      signedUrlExpiresSec: this.signedTtl,
    };
  }

  /** 从 OSS 拉回 buffer（直传后服务端落盘做 OCR/封面） */
  async getObjectBuffer(objectKey: string): Promise<Buffer> {
    if (!this.isAliyun() || !this.client) {
      throw new Error('OSS 未就绪，无法下载对象');
    }
    const result = await this.client.get(this.fullKey(objectKey));
    const content = result?.content;
    if (!content) throw new Error(`OSS 对象为空: ${objectKey}`);
    return Buffer.isBuffer(content) ? content : Buffer.from(content);
  }
}
