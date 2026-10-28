import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

export type VisionContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/**
 * OpenAI 兼容多模态客户端（chat/completions + image_url/base64）。
 * 密钥只读 process.env，日志禁止打印全文。
 */
@Injectable()
export class VisionClient {
  private readonly logger = new Logger('Vision');

  private get base() {
    return (process.env.VISION_BASE_URL || 'https://api.xytoken.xyb2b.com/v1').replace(/\/$/, '');
  }
  private get key() {
    return process.env.VISION_API_KEY || '';
  }
  get model() {
    return process.env.VISION_MODEL || 'Aerith-haiku-5.5';
  }
  private get timeoutMs() {
    return parseInt(process.env.VISION_TIMEOUT_MS || '60000', 10);
  }
  configured() {
    return !!this.key;
  }

  /** 本地图片 → data URL（缩略后，控制 token） */
  fileToDataUrl(localPath: string, maxSide = 768, quality = 70): string {
    // 延迟 require 避免无 sharp/jimp 时硬依赖；用纯 buffer 原图（小图）或外部已缩略
    const buf = fs.readFileSync(localPath);
    const ext = path.extname(localPath).toLowerCase();
    const mime =
      ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    // 过大则走 python 缩略（项目已有 Pillow）
    if (buf.length > 180_000) {
      const out = this.shrinkWithPython(localPath, maxSide, quality);
      if (out) return `data:image/jpeg;base64,${out.toString('base64')}`;
    }
    return `data:${mime};base64,${buf.toString('base64')}`;
  }

  private shrinkWithPython(localPath: string, maxSide: number, quality: number): Buffer | null {
    try {
      const { execFileSync } = require('child_process') as typeof import('child_process');
      const script = `
from PIL import Image
import io,sys
im=Image.open(sys.argv[1]).convert('RGB')
im.thumbnail((int(sys.argv[2]),int(sys.argv[2])))
b=io.BytesIO(); im.save(b,'JPEG',quality=int(sys.argv[3])); sys.stdout.buffer.write(b.getvalue())
`;
      return execFileSync('python3', ['-c', script, localPath, String(maxSide), String(quality)], {
        maxBuffer: 8 * 1024 * 1024,
      });
    } catch (e: any) {
      this.logger.warn(`缩略失败，用原图: ${e?.message || e}`);
      return null;
    }
  }

  async chat(
    parts: VisionContentPart[],
    opts?: { maxTokens?: number; temperature?: number; timeoutMs?: number },
  ): Promise<string> {
    if (!this.key) throw new Error('未配置 VISION_API_KEY');
    const body = {
      model: this.model,
      temperature: opts?.temperature ?? 0,
      max_tokens: opts?.maxTokens ?? 400,
      messages: [{ role: 'user', content: parts }],
    };
    const ac = new AbortController();
    const waitMs = opts?.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : this.timeoutMs;
    const t = setTimeout(() => ac.abort(), waitMs);
    try {
      const res = await fetch(`${this.base}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      const text = await res.text();
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`vision 非 JSON 响应 HTTP ${res.status}`);
      }
      if (!res.ok || json.error) {
        const msg = json?.error?.message || text.slice(0, 200);
        // 不打印 key；截断错误
        throw new Error(`vision HTTP ${res.status}: ${String(msg).slice(0, 180)}`);
      }
      const content = json?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('vision 无 content');
      return content;
    } finally {
      clearTimeout(t);
    }
  }
}
