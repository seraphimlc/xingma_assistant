import { unwrapAbsoluteMediaUrl } from '../common/utils/media-url';
/**
 * LKB Agent 异步视频生成（sinan-video-generator）。
 * POST /api/invocations/rsync → poll GET /api/invocations/rsync/{id}
 * Token 仅从 env / 本机 key 文件读取，禁止写死进仓、禁止日志全文。
 */
import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

export type LkbVideoTaskType = 'FREE' | 'FIRST_LAST_FRAME';

export interface LkbVideoAttachment {
  type: 'image';
  uri: string;
  mediaType?: string;
  name?: string;
  metadata: { role: 'reference_image' | 'first_frame' | 'last_frame' };
}

export interface LkbVideoRequest {
  /** 中文分镜/镜头描述（messages content） */
  prompt: string;
  duration?: number;
  ratio?: string;
  resolution?: string;
  taskType?: LkbVideoTaskType;
  attachments?: LkbVideoAttachment[];
  generateAudio?: boolean;
  watermark?: boolean;
}

export interface LkbVideoResult {
  /** 仅非直链/需本地落盘时才有；LKB 直链模式可不下载 */
  buffer?: Buffer;
  mime: string;
  via: string;
  videoId: string;
  /** SUCCEEDED result.artifacts[].uri — 直接播放/入库，勿再转存自有 OSS */
  videoUrl: string;
  seconds?: number;
  size?: string;
  taskType: string;
}

@Injectable()
export class LkbVideoClient {
  private readonly logger = new Logger('LkbVideo');

  get baseUrl(): string {
    return (
      process.env.VIDEO_LKB_AGENT_BASE_URL ||
      process.env.LKB_VIDEO_BASE_URL ||
      'https://api-lkb-agent-test.demo.xyb2b.com'
    ).replace(/\/$/, '');
  }

  get agentCode(): string {
    return process.env.VIDEO_LKB_AGENT_CODE || 'sinan-video-generator';
  }

  get tenantId(): string {
    return String(process.env.VIDEO_LKB_AGENT_TENANT_ID || process.env.LKB_AGENT_TENANT_ID || '5').trim() || '5';
  }

  get defaultSeconds(): number {
    const n = parseInt(process.env.VIDEO_GEN_SECONDS || process.env.VIDEO_LKB_DURATION || '10', 10);
    return clampDuration(n || 10);
  }

  get defaultRatio(): string {
    return process.env.VIDEO_LKB_RATIO || '9:16';
  }

  get defaultResolution(): string {
    return process.env.VIDEO_LKB_RESOLUTION || '720p';
  }

  /** e.g. 720x1280 — for OSS / set metadata parity with xytoken */
  get defaultSize(): string {
    return process.env.VIDEO_GEN_SIZE || '720x1280';
  }

  private get timeoutMs(): number {
    return parseInt(process.env.VIDEO_LKB_TIMEOUT_MS || process.env.VIDEO_GEN_TIMEOUT_MS || '600000', 10);
  }

  private get pollMs(): number {
    return Math.max(2000, parseInt(process.env.VIDEO_LKB_POLL_MS || process.env.VIDEO_GEN_POLL_MS || '5000', 10));
  }

  /**
   * 读 KEY：VIDEO_LKB_AGENT_KEY / VIDEO_LKB_AGENT_API_KEY / LKB_AGENT_CALL_KEY，
   * 或 KEY_FILE（默认 .secrets/lkb-video-agent.key）。
   */
  private resolveApiKey(): string {
    const direct = String(
      process.env.VIDEO_LKB_AGENT_KEY ||
        process.env.VIDEO_LKB_AGENT_API_KEY ||
        process.env.LKB_AGENT_CALL_KEY ||
        '',
    ).trim();
    if (direct) return direct;
    const candidates = [
      String(process.env.VIDEO_LKB_AGENT_KEY_FILE || '').trim(),
      String(process.env.LKB_AGENT_CALL_KEY_FILE || '').trim(),
      '.secrets/lkb-video-agent.key',
    ].filter(Boolean);
    for (const file of candidates) {
      const abs = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
      try {
        if (!fs.existsSync(abs)) continue;
        const raw = fs.readFileSync(abs, 'utf8').trim();
        const m = raw.match(
          /^(?:VIDEO_LKB_AGENT_KEY|VIDEO_LKB_AGENT_API_KEY|LKB_AGENT_CALL_KEY)=(.+)$/m,
        );
        const key = (m ? m[1] : raw.split('\n')[0]).trim();
        if (key && !key.includes('=')) return key;
        if (m) return m[1].trim();
      } catch (e: any) {
        this.logger.warn(`读 LKB 视频 Key 文件失败: ${String(e?.message || e).slice(0, 80)}`);
      }
    }
    return '';
  }

  configured(): boolean {
    return !!this.resolveApiKey();
  }

  async generate(req: LkbVideoRequest): Promise<LkbVideoResult> {
    const key = this.resolveApiKey();
    if (!key) throw new Error('未配置 LKB 视频密钥（VIDEO_LKB_AGENT_KEY / KEY_FILE）');
    const prompt = String(req.prompt || '').trim();
    if (!prompt) throw new Error('视频脚本/prompt 为空');
    const duration = clampDuration(Number(req.duration ?? this.defaultSeconds) || this.defaultSeconds);
    const taskType: LkbVideoTaskType = req.taskType || 'FREE';
    const attachments = (req.attachments || [])
      .map((a) => (a ? { ...a, uri: unwrapAbsoluteMediaUrl(a.uri) } : a))
      .filter((a) => a && /^https?:\/\//i.test(String(a.uri || '')));
    if (taskType === 'FIRST_LAST_FRAME') {
      const hasFirst = attachments.some((a) => a.metadata?.role === 'first_frame');
      if (!hasFirst) throw new Error('FIRST_LAST_FRAME 需要 first_frame 附件');
    }

    const payload: Record<string, unknown> = {
      agentCode: this.agentCode,
      messages: [
        {
          role: 'USER',
          content: prompt,
          ...(attachments.length ? { attachments } : {}),
        },
      ],
      videoGeneration: {
        taskType,
        resolution: req.resolution || this.defaultResolution,
        ratio: req.ratio || this.defaultRatio,
        duration,
        // 生视频必须带音轨；上游 Seedance/LKB 默认可静音，强制 true（忽略 none BGM）
        generateAudio: true,
        watermark: req.watermark === true,
        returnLastFrame: false,
      },
    };

    // 上游瞬时：fixed channel / OSS 图片上传 — 本客户端再投几次再抛给 job 重试
    const maxSubmit = Math.max(1, parseInt(process.env.VIDEO_LKB_SUBMIT_RETRIES || '3', 10) || 3);
    let lastErr: Error | null = null;
    for (let i = 1; i <= maxSubmit; i++) {
      try {
        const created = await this.postRsync(payload, key);
        const videoId = String(created?.id || created?.requestId || created?.data?.id || '');
        if (!videoId) throw new Error(`LKB 建视频无 id: ${JSON.stringify(created).slice(0, 300)}`);

        const done = await this.poll(videoId, key);
        const videoUrl = extractVideoUrl(done);
        if (!videoUrl) {
          throw new Error(`LKB 成功但无视频 URL: ${JSON.stringify(done).slice(0, 400)}`);
        }
        const secondsOut = extractDurationSec(done) || duration;
        this.logger.log(
          `lkb video ${videoId} direct_url seconds=${secondsOut} (req=${duration}) url=${videoUrl.slice(0, 80)}`,
        );
        return {
          mime: 'video/mp4',
          via: `lkb:${this.agentCode}`,
          videoId,
          videoUrl,
          seconds: secondsOut,
          size: this.defaultSize,
          taskType,
        };
      } catch (e: any) {
        lastErr = e instanceof Error ? e : new Error(String(e?.message || e));
        const msg = lastErr.message;
        if (!isTransientLkbError(msg) || i >= maxSubmit) throw lastErr;
        const wait = Math.min(120_000, 15_000 * i);
        this.logger.warn(`LKB transient (${i}/${maxSubmit}) wait ${wait}ms: ${msg.slice(0, 140)}`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    throw lastErr || new Error('LKB 视频失败');
  }

  private authHeaders(key: string): Record<string, string> {
    return {
      Authorization: `Bearer ${key}`,
      'X-Tenant-Id': this.tenantId,
      Accept: 'application/json',
    };
  }

  private async postRsync(payload: Record<string, unknown>, key: string): Promise<any> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 120_000);
    try {
      const res = await fetch(`${this.baseUrl}/api/invocations/rsync`, {
        method: 'POST',
        headers: { ...this.authHeaders(key), 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`LKB rsync 非 JSON HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      // 202 Accepted 或 200
      if (!(res.status === 202 || res.ok) || json?.error) {
        const msg = json?.error?.message || json?.message || text.slice(0, 280);
        throw new Error(`LKB rsync HTTP ${res.status}: ${String(msg).slice(0, 280)}`);
      }
      this.logger.log(`lkb rsync accepted id=${json?.id || '-'} status=${json?.status || res.status}`);
      return json;
    } finally {
      clearTimeout(t);
    }
  }

  private async poll(videoId: string, key: string): Promise<any> {
    const deadline = Date.now() + this.timeoutMs;
    let last: any = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, this.pollMs));
      last = await this.getRsync(videoId, key);
      const status = String(last?.status || last?.data?.status || '').toUpperCase();
      this.logger.log(`lkb video ${videoId} status=${status || '-'}`);
      if (status === 'SUCCEEDED' || status === 'SUCCESS' || status === 'COMPLETED' || status === 'DONE') {
        // 整包返回：result.artifacts / token_usage 在顶层；勿只回 last.data（会丢 result）
        return last;
      }
      if (status === 'FAILED' || status === 'ERROR' || status === 'CANCELLED' || status === 'CANCELED') {
        const errMsg = last?.errorMessage || last?.data?.errorMessage || last?.error || '';
        const errCode = last?.errorCode || last?.data?.errorCode || '';
        const friendly = formatLkbUserError(errMsg || errCode || last, errCode);
        throw new Error(`LKB 视频失败: ${friendly}`);
      }
      // PENDING / RUNNING / 空 → 继续
    }
    throw new Error(`LKB 视频超时 ${videoId} last=${JSON.stringify(last).slice(0, 200)}`);
  }

  private async getRsync(id: string, key: string): Promise<any> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 60_000);
    try {
      const res = await fetch(`${this.baseUrl}/api/invocations/rsync/${encodeURIComponent(id)}`, {
        method: 'GET',
        headers: this.authHeaders(key),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`LKB poll 非 JSON HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      if (!res.ok || json?.error) {
        const msg = json?.error?.message || json?.message || text.slice(0, 280);
        throw new Error(`LKB poll HTTP ${res.status}: ${String(msg).slice(0, 280)}`);
      }
      return json;
    } finally {
      clearTimeout(t);
    }
  }

  private async downloadUrl(url: string): Promise<{ buffer: Buffer; mime: string }> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), Math.min(this.timeoutMs, 300_000));
    try {
      const res = await fetch(url, { method: 'GET', signal: ctrl.signal });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`下载 LKB 视频 HTTP ${res.status} ${text.slice(0, 200)}`);
      }
      const mime = res.headers.get('content-type') || 'video/mp4';
      return { buffer: Buffer.from(await res.arrayBuffer()), mime };
    } finally {
      clearTimeout(t);
    }
  }
}


/** 上游瞬时错误：fixed channel / OSS 上传 / 5xx — 可再投 */
export function isTransientLkbError(msg: string): boolean {
  const s = String(msg || '');
  return /fixed channel unavailable|OSS\s*图片上传失败|HTTP_503|EXTERNAL_SERVICE_ERROR|ECONNRESET|ETIMEDOUT|socket hang up|\b503\b|\b429\b|通道繁忙|拉取参考图失败|请稍后重试/i.test(
    s,
  );
}

/** 把 LKB errorMessage/errorCode 译成任务中心可读文案 */
export function formatLkbUserError(errorMessage: unknown, errorCode?: unknown): string {
  const raw = String(errorMessage ?? '')
    .replace(/^"+|"+$/g, '')
    .trim();
  const code = String(errorCode ?? '').trim();
  if (/fixed channel unavailable/i.test(raw) || code === 'HTTP_503') {
    return '视频通道繁忙（上游固定通道暂不可用），请稍后重试';
  }
  if (/OSS\s*图片上传失败/i.test(raw)) {
    return '上游拉取参考图失败，请稍后重试或换一张商品参考图';
  }
  if (raw) return raw.slice(0, 200);
  if (code) return code;
  return '视频生成失败';
}

/** job 层自动重试退避（attempts 已含本次） */
export function lkbTransientRetryDelayMs(attempt: number): number {
  const n = Math.max(1, Number(attempt) || 1);
  return Math.min(300_000, 45_000 * Math.pow(2, n - 1));
}

export function clampDuration(n: number): number {
  const x = Math.round(Number(n) || 10);
  return Math.min(15, Math.max(4, x));
}

/** 从 LKB 成功响应抠视频 URL */
export function extractVideoUrl(json: any): string | null {
  const push = (u: unknown): string | null => {
    const s = String(u || '').trim();
    if (/^https?:\/\//i.test(s) && /\.(mp4|webm|mov)(\?|$)/i.test(s)) return s;
    if (/^https?:\/\//i.test(s) && /video/i.test(s)) return s;
    if (/^https?:\/\//i.test(s)) return s;
    return null;
  };
  // LKB SUCCEEDED: result.artifacts[].uri（实测）；兼容 output / responsePayload 变体
  const artifacts =
    json?.result?.artifacts ||
    json?.result?.output?.artifacts ||
    json?.responsePayload?.output?.artifacts ||
    json?.output?.artifacts ||
    json?.data?.result?.artifacts ||
    json?.data?.output?.artifacts ||
    [];
  if (Array.isArray(artifacts)) {
    for (const a of artifacts) {
      if (!a) continue;
      const typ = String(a.type || a.media_type || a.mediaType || '').toLowerCase();
      if (typ.includes('video') || /\.mp4/i.test(String(a.uri || a.url || ''))) {
        const hit = push(a.uri || a.url);
        if (hit) return hit;
      }
    }
    for (const a of artifacts) {
      const hit = push(a?.uri || a?.url);
      if (hit) return hit;
    }
  }
  for (const k of ['videoUrl', 'url', 'outputUrl', 'fileUrl', 'uri']) {
    const hit = push(json?.result?.[k] || json?.[k]);
    if (hit) return hit;
  }
  // 深搜一层 result
  const walk = (node: any, depth: number): string | null => {
    if (depth > 6 || node == null) return null;
    if (typeof node === 'string') return push(node);
    if (Array.isArray(node)) {
      for (const x of node) {
        const h = walk(x, depth + 1);
        if (h) return h;
      }
      return null;
    }
    if (typeof node !== 'object') return null;
    for (const k of ['videoUrl', 'url', 'uri', 'outputUrl', 'fileUrl', 'src']) {
      if (k in node) {
        const h = push(node[k]);
        if (h) return h;
      }
    }
    for (const k of ['result', 'output', 'data', 'artifacts', 'files', 'payload', 'responsePayload', 'outputs']) {
      if (k in node) {
        const h = walk(node[k], depth + 1);
        if (h) return h;
      }
    }
    return null;
  };
  return walk(json, 0);
}

/** 从 LKB SUCCEEDED 响应抠时长（秒）。优先 token_usage.media_usage.parameters.duration */
export function extractDurationSec(json: any): number | undefined {
  const tryNum = (v: unknown): number | undefined => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    // 毫秒误当秒：> 60 且整除 1000 量级时折算
    if (n > 60 && n < 600_000) {
      const asSec = n / 1000;
      if (asSec >= 2 && asSec <= 60) return Math.round(asSec);
    }
    if (n > 60) return undefined;
    return Math.round(n);
  };
  const paths = [
    json?.token_usage?.items?.[0]?.media_usage?.parameters?.duration,
    json?.token_usage?.items?.[0]?.media_usage?.parameters?.durationSec,
    json?.token_usage?.items?.[0]?.media_usage?.parameters?.durationMs,
    json?.result?.duration,
    json?.result?.durationSec,
    json?.result?.durationMs,
    json?.result?.seconds,
    json?.result?.output?.duration,
    json?.videoGeneration?.duration,
    json?.duration,
    json?.durationSec,
    json?.durationMs,
    json?.seconds,
  ];
  for (const p of paths) {
    const hit = tryNum(p);
    if (hit != null) return clampDuration(hit);
  }
  // artifacts metadata
  const arts = json?.result?.artifacts || json?.result?.output?.artifacts || [];
  if (Array.isArray(arts)) {
    for (const a of arts) {
      const hit =
        tryNum(a?.duration) ||
        tryNum(a?.durationSec) ||
        tryNum(a?.durationMs) ||
        tryNum(a?.metadata?.duration) ||
        tryNum(a?.metadata?.durationSec) ||
        tryNum(a?.metadata?.durationMs);
      if (hit != null) return clampDuration(hit);
    }
  }
  return undefined;
}
