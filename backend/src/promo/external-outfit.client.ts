import { unwrapAbsoluteMediaUrl } from '../common/utils/media-url';
/**
 * 外部穿搭工作流 Agent 客户端（LKB）。
 * 与自建羊毛衫流程并存；Token 仅从 env / 本机 key 文件读取，禁止写死进仓。
 *
 * POST {base}/api/invocations/sync
 * Header: Authorization: Bearer <OUTFIT_AGENT_API_KEY>
 * Body: { agentCode, garmentImages[1..9], modelImageUrl?, instruction? }
 */
import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

export interface ExternalOutfitRequest {
  /** 成衣图 URL，1～9 张（需外部可访问；私有 OSS 须先签短时 URL） */
  garmentImages: string[];
  /** 可选模特图 URL */
  modelImageUrl?: string;
  /** 自然语言指令（中英均可，按 Agent 约定） */
  instruction?: string;
  /** 覆盖默认 agentCode */
  agentCode?: string;
}

export interface ExternalOutfitResult {
  ok: boolean;
  /** 规范化后的结果图 URL 列表 */
  imageUrls: string[];
  /** 上游原始 JSON（截断前）便于对比留痕 */
  raw: unknown;
  requestId?: string;
  ms: number;
  error?: string;
  agentCode: string;
}

@Injectable()
export class ExternalOutfitClient {
  private readonly logger = new Logger('ExternalOutfit');

  get enabled(): boolean {
    const v = String(process.env.OUTFIT_AGENT_ENABLED || '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
  }

  get baseUrl(): string {
    return (process.env.OUTFIT_AGENT_BASE_URL || 'http://api-lkb-agent.pymsfz.cn').replace(/\/$/, '');
  }

  get agentCode(): string {
    return process.env.OUTFIT_AGENT_CODE || 'ai-adaptive-outfit-workflow';
  }

  private get timeoutMs(): number {
    return parseInt(process.env.OUTFIT_AGENT_TIMEOUT_MS || '300000', 10);
  }

  /** self | external | both */
  engineMode(): 'self' | 'external' | 'both' {
    const m = String(process.env.OUTFIT_ENGINE || 'self').trim().toLowerCase();
    if (m === 'external' || m === 'both') return m;
    return 'self';
  }

  /** 从 env 或本机 key 文件读 Token；永不打日志全文 */
  private resolveApiKey(): string {
    const direct = String(
      process.env.OUTFIT_AGENT_API_KEY || process.env.LKB_AGENT_TOKEN || '',
    ).trim();
    if (direct) return direct;
    const candidates = [
      String(process.env.OUTFIT_AGENT_API_KEY_FILE || '').trim(),
      '.secrets/outfit-agent.key',
      '.secrets/lkb-agent.env',
    ].filter(Boolean);
    for (const file of candidates) {
      const abs = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
      try {
        if (!fs.existsSync(abs)) continue;
        const raw = fs.readFileSync(abs, 'utf8').trim();
        // 支持纯 key 文件，或 KEY=value 的 env 片段
        const m = raw.match(/^(?:OUTFIT_AGENT_API_KEY|LKB_AGENT_TOKEN)=(.+)$/m);
        const key = (m ? m[1] : raw.split('\n')[0]).trim();
        if (key && !key.includes('=')) return key;
        if (m) return m[1].trim();
      } catch (e: any) {
        this.logger.warn(`读 Agent Key 文件失败: ${String(e?.message || e).slice(0, 80)}`);
      }
    }
    return '';
  }

  configured(): boolean {
    return this.enabled && !!this.resolveApiKey();
  }

  /**
   * 同步调用外部 Agent。未配置/未启用时返回 ok=false（不抛），便于 both 对比降级。
   */
  async invoke(req: ExternalOutfitRequest): Promise<ExternalOutfitResult> {
    const t0 = Date.now();
    const code = req.agentCode || this.agentCode;
    const key = this.resolveApiKey();
    if (!this.enabled) {
      return { ok: false, imageUrls: [], raw: null, ms: 0, error: 'OUTFIT_AGENT_ENABLED 未开启', agentCode: code };
    }
    if (!key) {
      return {
        ok: false,
        imageUrls: [],
        raw: null,
        ms: 0,
        error: '未配置 OUTFIT_AGENT_API_KEY（或 KEY_FILE），Token 须放本机 secrets/.env',
        agentCode: code,
      };
    }
    const images = (req.garmentImages || [])
      .map((u) => unwrapAbsoluteMediaUrl(u))
      .filter((u) => /^https?:\/\//i.test(u))
      .slice(0, 9);
    if (images.length < 1) {
      return { ok: false, imageUrls: [], raw: null, ms: 0, error: 'garmentImages 至少 1 张', agentCode: code };
    }

    // 实测：workflow.input 经 messages[0].content（JSON 字符串）传入；
    // OpenAPI 仅要求 messages；顶层 garmentImages 不会进 workflow.input。
    const workflowInput: Record<string, unknown> = { garmentImages: images };
    const modelUrl = unwrapAbsoluteMediaUrl(req.modelImageUrl);
    if (/^https?:\/\//i.test(modelUrl)) workflowInput.modelImageUrl = modelUrl;
    if (req.instruction) workflowInput.instruction = req.instruction;
    const payload: Record<string, unknown> = {
      agentCode: code,
      messages: [
        {
          role: 'user',
          content: JSON.stringify(workflowInput),
        },
      ],
    };

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/api/invocations/sync`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
        signal: ac.signal,
      });
      const text = await res.text();
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        return {
          ok: false,
          imageUrls: [],
          raw: text.slice(0, 2000),
          ms: Date.now() - t0,
          error: `非 JSON 响应 HTTP ${res.status}`,
          agentCode: code,
          requestId: res.headers.get('x-request-id') || undefined,
        };
      }
      if (!res.ok || json?.error) {
        const msg = json?.error?.message || json?.message || text.slice(0, 200);
        this.logger.warn(`external outfit HTTP ${res.status}: ${String(msg).slice(0, 160)}`);
        return {
          ok: false,
          imageUrls: [],
          raw: json,
          ms: Date.now() - t0,
          error: String(msg).slice(0, 500),
          agentCode: code,
          requestId: json?.error?.requestId || json?.requestId || res.headers.get('x-request-id') || undefined,
        };
      }
      const status = String(json?.status || '').toUpperCase();
      if (status === 'FAILED') {
        return {
          ok: false,
          imageUrls: [],
          raw: json,
          ms: Date.now() - t0,
          error: String(json?.errorMessage || json?.errorCode || '外部 Agent 执行失败').slice(0, 500),
          agentCode: code,
          requestId: json?.requestId || String(json?.id || '') || undefined,
        };
      }
      const imageUrls = extractImageUrls(json);
      return {
        ok: imageUrls.length > 0,
        imageUrls,
        raw: json,
        ms: Date.now() - t0,
        error: imageUrls.length ? undefined : '响应无可识别结果图 URL',
        agentCode: code,
        requestId: json?.requestId || String(json?.id || '') || undefined,
      };
    } catch (e: any) {
      const msg = String(e?.message || e).slice(0, 300);
      this.logger.warn(`external outfit fail: ${msg}`);
      return { ok: false, imageUrls: [], raw: null, ms: Date.now() - t0, error: msg, agentCode: code };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 从多种可能响应结构里抠出图片 URL（优先 artifacts[].uri） */
export function extractImageUrls(json: any): string[] {
  const out: string[] = [];
  const push = (u: unknown) => {
    const s = String(u || '').trim();
    if (/^https?:\/\//i.test(s) && !out.includes(s)) out.push(s);
  };
  // LKB 同步调用：responsePayload.output.artifacts
  const artifacts =
    json?.responsePayload?.output?.artifacts ||
    json?.output?.artifacts ||
    [];
  if (Array.isArray(artifacts)) {
    for (const a of artifacts) {
      if (a && (a.type === 'image' || a.media_type?.startsWith?.('image'))) push(a.uri || a.url);
    }
  }
  const walk = (node: any, depth: number) => {
    if (depth > 6 || node == null) return;
    if (typeof node === 'string') {
      // 避免把整段 JSON contentText 当 URL
      if (/^https?:\/\//i.test(node)) push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const x of node) walk(x, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    for (const k of ['imageUrls', 'images', 'outputImages', 'resultImages', 'urls', 'files', 'artifacts']) {
      if (k in node) walk(node[k], depth + 1);
    }
    for (const k of ['url', 'imageUrl', 'image_url', 'src', 'outputUrl', 'fileUrl', 'uri']) {
      if (k in node) push(node[k]);
    }
    for (const k of ['output', 'data', 'result', 'outputs', 'content', 'payload', 'responsePayload']) {
      if (k in node) walk(node[k], depth + 1);
    }
  };
  if (!out.length) walk(json, 0);
  return out.slice(0, 12);
}
