import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '@nestjs/common';
import { PublishBatch } from './publish.types';

/** 发品批次 TTL：与历史内存 Map 一致，约 2 小时 */
export const BATCH_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * 发品批次存储：内存 L1 + 磁盘落盘（uploads/{batchId}/_batch.json）。
 * 目的：pm2/API 重启后仍能 getBatch，避免「发品批次不存在或已过期」。
 * 选磁盘而非 Redis：生产 REDIS_* 已配但 redis-server 未装且 6379 拒连；uploads 目录本就持久。
 */
export class PublishBatchStore {
  private readonly memory = new Map<string, PublishBatch>();
  private readonly logger = new Logger('PublishBatchStore');

  constructor(private readonly storageRoot: () => string) {}

  private metaPath(tenantId: string, batchId: string) {
    return path.join(
      this.storageRoot(),
      'tenants',
      tenantId,
      'uploads',
      batchId,
      '_batch.json',
    );
  }

  private isExpired(b: PublishBatch, now = Date.now()) {
    return now - b.createdAt > BATCH_TTL_MS;
  }

  private readDisk(tenantId: string, batchId: string): PublishBatch | null {
    const p = this.metaPath(tenantId, batchId);
    if (!fs.existsSync(p)) return null;
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const parsed = JSON.parse(raw) as PublishBatch;
      if (!parsed?.batchId || !parsed?.tenantId || !Array.isArray(parsed.assets)) {
        return null;
      }
      return parsed;
    } catch (e: any) {
      this.logger.warn(
        `readDisk fail batchId=${batchId}: ${String(e?.message || e).slice(0, 120)}`,
      );
      return null;
    }
  }

  private writeDisk(batch: PublishBatch) {
    const p = this.metaPath(batch.tenantId, batch.batchId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(batch), 'utf8');
    fs.renameSync(tmp, p);
  }

  save(batch: PublishBatch) {
    this.memory.set(batch.batchId, batch);
    try {
      this.writeDisk(batch);
    } catch (e: any) {
      this.logger.warn(
        `writeDisk fail batchId=${batch.batchId}: ${String(e?.message || e).slice(0, 120)}`,
      );
    }
  }

  /**
   * 取批次：内存 → 磁盘。过期则删并返回 null。
   * tenantId 必须匹配（防串租户）。
   */
  get(tenantId: string, batchId: string): PublishBatch | null {
    const now = Date.now();
    let b = this.memory.get(batchId) || null;
    if (!b || b.tenantId !== tenantId) {
      b = this.readDisk(tenantId, batchId);
      if (b && b.tenantId === tenantId) {
        this.memory.set(batchId, b);
        this.logger.log(`hydrate batchId=${batchId} assets=${b.assets?.length || 0} from disk`);
      } else {
        b = null;
      }
    }
    if (!b || b.tenantId !== tenantId) return null;
    if (this.isExpired(b, now)) {
      this.delete(b.tenantId, b.batchId);
      return null;
    }
    return b;
  }

  delete(tenantId: string, batchId: string) {
    this.memory.delete(batchId);
    const p = this.metaPath(tenantId, batchId);
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch (e: any) {
      this.logger.warn(
        `deleteDisk fail batchId=${batchId}: ${String(e?.message || e).slice(0, 80)}`,
      );
    }
  }

  /** 仅清内存里过期项；磁盘过期在 get 时惰性删 */
  purgeExpiredMemory() {
    const now = Date.now();
    for (const [id, b] of this.memory) {
      if (this.isExpired(b, now)) this.memory.delete(id);
    }
  }
}
