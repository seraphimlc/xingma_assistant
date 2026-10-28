import { Injectable, Logger, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuthContext } from './interfaces/auth-context.interface';
import { AuditLog } from './entities/audit-log.entity';

export type AuditActorKind = 'user' | 'system' | 'job';

export type AuditActorSnapshot = {
  memberId?: string | null;
  openid?: string | null;
  role?: string | null;
  nickname?: string | null;
  kind?: AuditActorKind;
  jobId?: string | null;
};

export type AuditInput = {
  tenantId: string;
  action: string;
  /** 真人操作：AuthContext；系统/任务可省略并用 actorSnapshot */
  actor?: AuthContext | null;
  actorSnapshot?: AuditActorSnapshot | null;
  /** 实体类型（entityType） */
  targetType?: string | null;
  /** 实体 id（entityId） */
  targetId?: string | null;
  /** 载荷/diff；禁止写入密钥/token/密码 */
  detail?: Record<string, unknown> | null;
};

const SECRET_KEY_RE =
  /^(password|passwd|secret|token|accesskey|access_key|api[_-]?key|authorization|jwt|private[_-]?key)$/i;

function scrubDetail(detail: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!detail) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) {
    if (SECRET_KEY_RE.test(k)) {
      out[k] = '[redacted]';
      continue;
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = scrubDetail(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * 实体写操作审计（append-only）。DB 不可用或写入失败时仅打日志，不阻断主流程。
 * 分析/UI 不在此服务内——只负责记录。
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  private readonly mem: Array<Record<string, unknown>> = [];
  /** openid → nickname 短缓存，避免同请求内重复查库 */
  private readonly nickCache = new Map<string, { at: number; nick: string | null }>();

  constructor(@Optional() private readonly ds?: DataSource) {}

  private get db(): DataSource | null {
    return process.env.DB_ENABLED === 'true' && this.ds ? this.ds : null;
  }

  /** 系统/任务操作人（不伪造真人） */
  static systemActor(jobId?: string | null): AuditActorSnapshot {
    return {
      kind: jobId ? 'job' : 'system',
      role: jobId ? 'job' : 'system',
      memberId: null,
      openid: null,
      nickname: jobId ? `job:${jobId}` : 'system',
      jobId: jobId || null,
    };
  }

  private async resolveNickname(tenantId: string, openid: string | null | undefined): Promise<string | null> {
    if (!openid || !this.db) return null;
    const key = `${tenantId}:${openid}`;
    const hit = this.nickCache.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.nick;
    try {
      const rows: Array<{ nickname: string | null }> = await this.db.query(
        'SELECT nickname FROM tenant_members WHERE tenant_id = ? AND openid = ? LIMIT 1',
        [tenantId, openid],
      );
      const nick = rows?.[0]?.nickname ? String(rows[0].nickname).slice(0, 64) : null;
      this.nickCache.set(key, { at: Date.now(), nick });
      if (this.nickCache.size > 500) {
        const first = this.nickCache.keys().next().value;
        if (first) this.nickCache.delete(first);
      }
      return nick;
    } catch {
      return null;
    }
  }

  /**
   * 持久化一条审计。永不抛出。
   */
  async record(input: AuditInput): Promise<void> {
    try {
      const actor = input.actor;
      const snap = input.actorSnapshot;
      const kind: AuditActorKind = snap?.kind || (actor ? 'user' : 'system');
      let nickname =
        (snap?.nickname != null && String(snap.nickname).trim() !== ''
          ? String(snap.nickname).trim().slice(0, 64)
          : null) || null;
      const openid = snap?.openid ?? actor?.openid ?? null;
      const memberId = snap?.memberId ?? actor?.memberId ?? null;
      const role = snap?.role ?? actor?.role ?? (kind === 'job' ? 'job' : kind === 'system' ? 'system' : null);

      if (!nickname && kind === 'user' && openid) {
        nickname = await this.resolveNickname(input.tenantId, openid);
      }
      if (!nickname && kind === 'job' && snap?.jobId) {
        nickname = `job:${snap.jobId}`;
      }
      if (!nickname && kind === 'system') {
        nickname = 'system';
      }

      const detailBase = scrubDetail(input.detail) || {};
      const detail = {
        ...detailBase,
        actorSnapshot: {
          kind,
          memberId,
          openid,
          role,
          nickname,
          jobId: snap?.jobId ?? (detailBase as any).jobId ?? null,
        },
      };

      const row = {
        tenantId: input.tenantId,
        actorMemberId: memberId,
        actorOpenid: openid,
        actorRole: role,
        actorNickname: nickname,
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        detailJson: JSON.stringify(detail).slice(0, 4000),
      };

      this.logger.log(
        `audit action=${row.action} tenant=${row.tenantId} actor=${row.actorNickname || row.actorMemberId || row.actorOpenid || kind} target=${row.targetType || ''}:${row.targetId || ''}`,
      );

      if (this.db) {
        const repo = this.db.getRepository(AuditLog);
        await repo.save(repo.create(row));
      } else {
        this.mem.push({ ...row, createdAt: new Date() });
        if (this.mem.length > 500) this.mem.shift();
      }
    } catch (e) {
      this.logger.warn(`audit persist failed: ${(e as Error).message}`);
    }
  }

  /** 不 await 的安全写入（主路径 fire-and-forget） */
  enqueue(input: AuditInput): void {
    void this.record(input);
  }
}
