import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

const MODEL = 'lucy-vton-latest';
const UNCONFIGURED = '试衣服务暂未开通，请稍后再试';
const UPSTREAM = '试衣暂时连不上，请稍后再试';

/**
 * 只用长效密钥向 Decart 换短时 client token。密钥留在服务器。
 * 读 DECART_API_KEY，或 DECART_API_KEY_FILE，否则 backend/.secrets/decart.key。
 */
@Injectable()
export class DecartTokenClient {
  private readonly logger = new Logger('DecartToken');

  configured(): boolean {
    return !!this.resolveApiKey();
  }

  async mintClientToken(): Promise<{ token: string; expiresAt: string }> {
    const key = this.resolveApiKey();
    if (!key) throw new ServiceUnavailableException(UNCONFIGURED);

    const base = (process.env.DECART_API_BASE || 'https://api.decart.ai').replace(/\/$/, '');
    let res: Response;
    try {
      res = await fetch(`${base}/v1/client/tokens`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
        },
        body: JSON.stringify({
          expiresIn: 90,
          allowedModels: [MODEL],
          allowedOrigins: this.allowedOrigins(),
        }),
        signal: AbortSignal.timeout(15000),
      });
    } catch (e: any) {
      this.logger.warn(`decart token mint network: ${this.safe(e?.message || e)}`);
      throw new ServiceUnavailableException(UPSTREAM);
    }

    if (!res.ok) {
      this.logger.warn(`decart token mint status=${res.status}`);
      throw new ServiceUnavailableException(UPSTREAM);
    }

    let body: any;
    try {
      body = await res.json();
    } catch {
      this.logger.warn('decart token mint invalid json');
      throw new ServiceUnavailableException(UPSTREAM);
    }

    const token = typeof body?.apiKey === 'string' ? body.apiKey.trim() : '';
    const expiresAt = typeof body?.expiresAt === 'string' ? body.expiresAt.trim() : '';
    if (!token || !expiresAt) {
      this.logger.warn('decart token mint missing client fields');
      throw new ServiceUnavailableException(UPSTREAM);
    }
    return { token, expiresAt };
  }

  private allowedOrigins(): string[] {
    const origins = new Set<string>();
    const add = (raw: string | undefined) => {
      const text = String(raw || '').trim();
      if (!text) return;
      try {
        origins.add(new URL(text).origin);
      } catch {
        /* 不是绝对 URL 就跳过 */
      }
    };
    add(process.env.APP_BASE_URL);
    add('https://xingma.visitworld.me');
    if (process.env.NODE_ENV !== 'production') {
      add('http://127.0.0.1:3000');
      add('http://localhost:3000');
    }
    return [...origins].slice(0, 20);
  }

  private resolveApiKey(): string {
    const direct = String(process.env.DECART_API_KEY || '').trim();
    if (direct) return direct;
    const explicit = String(process.env.DECART_API_KEY_FILE || '').trim();
    const files = explicit ? [explicit] : [path.join(this.backendRoot(), '.secrets', 'decart.key'), '.secrets/decart.key'];
    for (const file of files) {
      const abs = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
      try {
        if (!fs.existsSync(abs)) continue;
        const raw = fs.readFileSync(abs, 'utf8').trim();
        const matched = raw.match(/^DECART_API_KEY=(.+)$/m);
        const key = (matched ? matched[1] : raw.split('\n').find((line) => line && !line.startsWith('#')) || '')
          .trim()
          .replace(/^['"]|['"]$/g, '');
        if (key && !key.includes('=')) return key;
        if (matched) return matched[1].trim().replace(/^['"]|['"]$/g, '');
      } catch (e: any) {
        this.logger.warn(`读 Decart Key 文件失败: ${this.safe(e?.message || e)}`);
      }
    }
    return '';
  }

  private backendRoot(): string {
    return path.resolve(__dirname, '..', '..');
  }

  private safe(value: unknown): string {
    return String(value || '')
      .replace(/dct_[A-Za-z0-9_-]+/g, '[redacted]')
      .replace(/sk-[A-Za-z0-9_-]+/g, '[redacted]')
      .slice(0, 160);
  }
}
