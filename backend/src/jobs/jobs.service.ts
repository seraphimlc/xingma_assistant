import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { DataSource, In, Repository } from 'typeorm';
import { hostname } from 'os';
import { newId } from '../common/utils/id';
import { AuthContext } from '../common/interfaces/auth-context.interface';
import { JobEntity } from '../common/entities/job.entity';
import { JobEventEntity } from '../common/entities/job-event.entity';
import {
  JobHandler,
  JobProgress,
  JobRecord,
  JobStatus,
  JobType,
} from './job.types';
import { buildJobDisplayTitle } from './job-display-title';
import { Product } from '../common/entities/product.entity';
import { MediaAsset } from '../common/entities/media-asset.entity';
import { PromoSetEntity } from '../common/entities/promo-set.entity';
import { OssClient } from '../media/oss.client';

@Injectable()
export class JobsService {
  private readonly logger = new Logger('Jobs');
  private readonly handlers = new Map<string, JobHandler>();
  readonly workerId = `worker_${hostname().slice(0, 24)}_${process.pid}`;

  constructor(
    @Optional() private readonly dataSource?: DataSource,
    @Optional() private readonly oss?: OssClient,
  ) {}

  private jobs(): Repository<JobEntity> {
    if (!(this.dataSource && process.env.DB_ENABLED === 'true')) {
      throw new BadRequestException('任务框架需要 DB_ENABLED=true');
    }
    return this.dataSource.getRepository(JobEntity);
  }

  private events(): Repository<JobEventEntity> {
    return this.dataSource!.getRepository(JobEventEntity);
  }

  registerHandler(type: JobType, handler: JobHandler) {
    this.handlers.set(type, handler);
    this.logger.log(`registered handler: ${type}`);
  }

  getHandler(type: string) {
    return this.handlers.get(type);
  }

  listHandlerTypes() {
    return [...this.handlers.keys()];
  }

  /** Job.createdBy 存 memberId（优先）或 openid；历史任务可能两种都有 */
  private ownerIds(user: AuthContext): string[] {
    const ids = [user.memberId, user.openid]
      .map((x) => String(x || '').trim())
      .filter(Boolean);
    return [...new Set(ids)];
  }

  private isOwnedBy(row: JobEntity, user: AuthContext): boolean {
    const by = String(row.createdBy || '').trim();
    if (!by) return false;
    return this.ownerIds(user).includes(by);
  }

  private assertOwned(row: JobEntity | null, user: AuthContext): JobEntity {
    if (!row || !this.isOwnedBy(row, user)) {
      throw new NotFoundException('任务不存在');
    }
    return row;
  }

  async create(
    user: AuthContext,
    type: JobType,
    payload: Record<string, unknown>,
    opts?: { maxAttempts?: number; runAt?: Date },
  ) {
    const repo = this.jobs();
    const displayTitle = buildJobDisplayTitle(type, payload);
    const enrichedPayload = {
      ...payload,
      displayTitle: (payload as any).displayTitle || displayTitle,
    };
    const row = repo.create({
      id: newId('job'),
      tenantId: user.tenantId,
      type,
      status: 'queued',
      progress: { percent: 0, step: 'queued', message: displayTitle },
      payload: enrichedPayload,
      result: null,
      error: null,
      attempts: 0,
      maxAttempts: opts?.maxAttempts ?? 3,
      createdBy: user.memberId || user.openid || null,
      lockedBy: null,
      nextRunAt: opts?.runAt || null,
      startedAt: null,
      finishedAt: null,
    });
    await repo.save(row);
    await this.appendEvent(row, 'created', '任务已创建', { type });
    return this.toDto(row);
  }

  /**
   * 重生/同组再次生成：复用已有 job 行重新排队，不新建任务中心条目。
   * 找不到可复用行时才 create。
   */
  async reuseOrCreate(
    user: AuthContext,
    type: JobType,
    payload: Record<string, unknown>,
    opts?: { existingJobId?: string | null; maxAttempts?: number; runAt?: Date },
  ) {
    const repo = this.jobs();
    let row =
      (String(opts?.existingJobId || '').trim()
        ? await repo.findOne({
            where: { id: String(opts?.existingJobId).trim(), tenantId: user.tenantId },
          })
        : null) || null;

    // 组 id 兜底：避免 set.jobId 丢失时重生又新开任务中心一行
    const setId = String((payload as any)?.setId || '').trim();
    if ((!row || !this.isOwnedBy(row, user) || row.type !== type) && setId) {
      const owners = this.ownerIds(user);
      const candidates = await repo.find({
        where: {
          tenantId: user.tenantId,
          type,
          ...(owners.length === 1
            ? { createdBy: owners[0] }
            : owners.length
              ? { createdBy: In(owners) }
              : {}),
        },
        order: { createdAt: 'DESC' },
        take: 40,
      });
      row =
        candidates.find(
          (j) => this.isOwnedBy(j, user) && String((j.payload as any)?.setId || '').trim() === setId,
        ) || null;
    }

    if (row && this.isOwnedBy(row, user) && row.type === type) {
      const displayTitle = buildJobDisplayTitle(type, payload);
      const enrichedPayload = {
        ...payload,
        displayTitle: (payload as any).displayTitle || displayTitle,
      };
      row.status = 'queued';
      row.payload = enrichedPayload;
      row.progress = { percent: 0, step: 'queued', message: displayTitle };
      row.result = null;
      row.error = null;
      row.lockedBy = null;
      row.nextRunAt = opts?.runAt || null;
      row.startedAt = null;
      row.finishedAt = null;
      // 重生视为新一轮，重置 attempts，避免历史失败占满次数
      row.attempts = 0;
      if (opts?.maxAttempts) row.maxAttempts = opts.maxAttempts;
      await repo.save(row);
      await this.appendEvent(row, 'reused', '复用任务重新排队', {
        type,
        setId: setId || null,
      });
      this.logger.log(`reuseOrCreate type=${type} jobId=${row.id} setId=${setId || '-'}`);
      return this.toDto(row);
    }
    return this.create(user, type, payload, opts);
  }

  /**
   * 取消同 set 上其它仍在排队/执行的 promo 任务（历史重复行），避免并行写同一组。
   */
  async cancelSiblingPromoJobs(
    user: AuthContext,
    opts: { setId: string; exceptJobId?: string | null; types?: string[] },
  ) {
    const setId = String(opts.setId || '').trim();
    if (!setId) return 0;
    const types = opts.types?.length ? opts.types : ['promo_image', 'promo_video'];
    const except = String(opts.exceptJobId || '').trim();
    const owners = this.ownerIds(user);
    if (!owners.length) return 0;
    const repo = this.jobs();
    const rows = await repo.find({
      where: {
        tenantId: user.tenantId,
        createdBy: owners.length === 1 ? owners[0] : In(owners),
        type: types.length === 1 ? types[0] : In(types),
        status: In(['queued', 'running'] as JobStatus[]),
      },
      order: { createdAt: 'DESC' },
      take: 50,
    });
    let n = 0;
    for (const row of rows) {
      if (except && row.id === except) continue;
      const sid = String((row.payload as any)?.setId || '').trim();
      if (sid !== setId) continue;
      row.status = 'cancelled';
      row.finishedAt = new Date();
      row.lockedBy = null;
      row.progress = {
        ...(row.progress || {}),
        step: 'cancelled',
        message: '已被同组重生取代',
        percent: (row.progress as any)?.percent ?? 0,
      };
      await repo.save(row);
      await this.appendEvent(row, 'cancel', '同组重生取消重复任务');
      n += 1;
    }
    return n;
  }

  async get(user: AuthContext, jobId: string) {
    const row = this.assertOwned(
      await this.jobs().findOne({ where: { id: jobId, tenantId: user.tenantId } }),
      user,
    );
    const dto = this.toDto(row);
    await this.enrichProductMeta(user.tenantId, [dto]);
    return dto;
  }

  async getEntity(tenantId: string, jobId: string) {
    return this.jobs().findOne({ where: { id: jobId, tenantId } });
  }

  async list(
    user: AuthContext,
    query?: {
      type?: string;
      status?: JobStatus;
      productId?: string;
      limit?: number;
      offset?: number;
    },
  ) {
    const take = Math.min(100, Math.max(1, Number(query?.limit) || 50));
    const skip = Math.max(0, Number(query?.offset) || 0);
    const owners = this.ownerIds(user);
    if (!owners.length) return { items: [], total: 0 };
    const where: any = {
      tenantId: user.tenantId,
      createdBy: owners.length === 1 ? owners[0] : In(owners),
    };
    if (query?.type) where.type = query.type;
    if (query?.status) where.status = query.status;
    // 按商品筛时多取一些再内存过滤（payload JSON），保证详情页能列全
    const productId = String(query?.productId || '').trim();
    const fetchTake = productId ? Math.min(200, Math.max(take * 4, 80)) : take;
    const [rows] = await this.jobs().findAndCount({
      where,
      order: { createdAt: 'DESC' },
      take: fetchTake,
      skip: productId ? 0 : skip,
    });
    let items = rows.map((r) => this.toDto(r));
    if (productId) {
      items = items.filter((it) => String(it.productId || '').trim() === productId);
      items = items.slice(skip, skip + take);
    }
    items = dedupePromoJobs(items);
    await this.enrichProductMeta(user.tenantId, items);
    return { items, total: items.length };
  }

  async listEvents(user: AuthContext, jobId: string, limit = 50) {
    await this.get(user, jobId);
    const rows = await this.events().find({
      where: { tenantId: user.tenantId, jobId },
      order: { id: 'ASC' },
      take: Math.min(200, limit),
    });
    return {
      items: rows.map((e) => ({
        id: e.id,
        event: e.event,
        level: e.level,
        message: e.message,
        data: e.data,
        createdAt: e.createdAt?.getTime?.() ?? e.createdAt,
      })),
    };
  }

  async retry(user: AuthContext, jobId: string) {
    const repo = this.jobs();
    const row = this.assertOwned(
      await repo.findOne({ where: { id: jobId, tenantId: user.tenantId } }),
      user,
    );
    if (row.status === 'running' || row.status === 'queued') {
      throw new BadRequestException('任务仍在排队或执行中');
    }
    if (row.status === 'succeeded') {
      throw new BadRequestException('已完成的任务无需重试');
    }
    // 失败 / 取消一律可重跑：重置 attempts，强制重新排队
    row.status = 'queued';
    row.error = null;
    row.finishedAt = null;
    row.lockedBy = null;
    row.nextRunAt = null;
    row.startedAt = null;
    row.attempts = 0;
    row.progress = { percent: 0, step: 'queued', message: '重新排队' };
    await repo.save(row);
    await this.appendEvent(row, 'retry', '用户触发重试（已重置次数）');
    await this.revivePromoSetForRequeuedJob(row);
    return this.toDto(row);
  }

  async cancel(user: AuthContext, jobId: string) {
    const repo = this.jobs();
    const row = this.assertOwned(
      await repo.findOne({ where: { id: jobId, tenantId: user.tenantId } }),
      user,
    );
    if (row.status === 'succeeded' || row.status === 'cancelled') {
      throw new BadRequestException(`当前状态不可取消: ${row.status}`);
    }
    row.status = 'cancelled';
    row.finishedAt = new Date();
    row.lockedBy = null;
    row.progress = { ...(row.progress || {}), step: 'cancelled', message: '已取消', percent: row.progress?.['percent'] as number ?? 0 };
    await repo.save(row);
    await this.appendEvent(row, 'cancel', '用户取消');
    await this.markPromoSetTerminal(row, 'failed', '任务已取消');
    return this.toDto(row);
  }


  /**
   * 回收孤儿/陈旧 running：一律重新排队继续（不标记 failed，不消耗 maxAttempts）。
   * - onlyStale=false：全部 running（进程启动时，本进程尚未领取任何任务）
   * - onlyStale=true：updated_at 早于 now-staleMs（默认 JOB_STALE_MS=45min）
   * promo_image：若关联 promo_sets 被误标 failed，改回 generating。
   */
  async reclaimOrphanedRunning(opts?: {
    staleMs?: number;
    onlyStale?: boolean;
  }): Promise<number> {
    if (!(this.dataSource && process.env.DB_ENABLED === 'true')) return 0;
    const onlyStale = opts?.onlyStale === true;
    const envStale = parseInt(process.env.JOB_STALE_MS || '2700000', 10);
    const staleMs = Math.max(
      60_000,
      opts?.staleMs ?? (Number.isFinite(envStale) && envStale > 0 ? envStale : 2_700_000),
    );
    const repo = this.jobs();
    const qb = repo.createQueryBuilder('j').where('j.status = :st', { st: 'running' });
    if (onlyStale) {
      const cutoff = new Date(Date.now() - staleMs);
      qb.andWhere('j.updatedAt < :cutoff', { cutoff });
    }
    const rows = await qb.getMany();
    if (!rows.length) return 0;

    let n = 0;
    const msg = '进程中断，已重新排队继续';
    for (const row of rows) {
      const prevAttempts = row.attempts || 0;
      // 抵消 claim 时 +1，避免进程反复中断烧掉 maxAttempts
      row.attempts = Math.max(0, prevAttempts - 1);
      row.status = 'queued';
      row.lockedBy = null;
      row.nextRunAt = null;
      row.finishedAt = null;
      row.error = null;
      row.progress = {
        percent: 0,
        step: 'queued',
        message: msg,
      };
      await repo.save(row);
      await this.appendEvent(
        row,
        'reclaim',
        msg,
        { onlyStale, staleMs, previousAttempts: prevAttempts },
        'warn',
      );
      await this.revivePromoSetForRequeuedJob(row);
      n += 1;
    }
    if (n) {
      this.logger.warn(
        `reclaimOrphanedRunning count=${n} onlyStale=${onlyStale} staleMs=${staleMs}`,
      );
    }
    return n;
  }

  /** 任务终态（失败/取消）时，把仍挂 generating 的素材组收尾，避免素材页永远「生成中」 */
  private async markPromoSetTerminal(
    job: JobEntity,
    status: 'failed' | 'done' | 'partial',
    errMsg?: string,
  ) {
    if ((job.type !== 'promo_image' && job.type !== 'promo_video') || !this.dataSource) return;
    const setId = String((job.payload as any)?.setId || '').trim();
    if (!setId) return;
    try {
      const sets = this.dataSource.getRepository(PromoSetEntity);
      const row = await sets.findOne({ where: { id: setId, tenantId: job.tenantId } });
      if (!row) return;
      if (row.status !== 'generating') {
        return;
      }
      row.status = status;
      if (status === 'failed' && Array.isArray(row.images) && row.images.length) {
        row.images = row.images.map((img: any) => {
          if (img && (img.status === 'pending' || img.status === 'running')) {
            return {
              ...img,
              status: 'failed',
              error: String(errMsg || '任务失败').slice(0, 200),
            };
          }
          return img;
        });
      }
      await sets.save(row);
      this.logger.log(`promo_set ${setId} → ${status} (job ${job.id} terminal)`);
    } catch (e) {
      this.logger.warn(`markPromoSetTerminal: ${(e as Error).message}`);
    }
  }

  /** promo_image 重排队：若 set 误为 failed，改回 generating（generating 保持不动） */
  private async revivePromoSetForRequeuedJob(job: JobEntity) {
    if ((job.type !== 'promo_image' && job.type !== 'promo_video') || !this.dataSource) return;
    const setId = String((job.payload as any)?.setId || '').trim();
    if (!setId) return;
    try {
      const sets = this.dataSource.getRepository(PromoSetEntity);
      const row = await sets.findOne({
        where: { id: setId, tenantId: job.tenantId },
      });
      if (!row) return;
      // 用户重试 / reclaim：失败或其它非完成态都拉回 generating，并挂上本 job
      if (row.status !== 'done' && row.status !== 'partial') {
        const prev = row.status;
        row.status = 'generating';
        row.jobId = job.id;
        await sets.save(row);
        if (prev !== 'generating') {
          this.logger.log(
            `promo_set ${setId} ${prev}→generating (job requeue ${job.id})`,
          );
        }
      } else if (row.jobId !== job.id) {
        row.jobId = job.id;
        await sets.save(row);
      }
    } catch (e) {
      this.logger.warn(
        `revivePromoSetForRequeuedJob failed: ${(e as Error).message}`,
      );
    }
  }

  /** 调度器：原子领取一条到期 queued 任务（FOR UPDATE SKIP LOCKED） */
  async claimNext(): Promise<JobEntity | null> {
    if (!(this.dataSource && process.env.DB_ENABLED === 'true')) return null;
    const qr = this.dataSource.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      const rows: Array<{ id: string }> = await qr.manager.query(
        `SELECT id FROM jobs
         WHERE status = 'queued'
           AND (next_run_at IS NULL OR next_run_at <= NOW(3))
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
      );
      if (!rows?.length) {
        await qr.commitTransaction();
        return null;
      }
      const id = rows[0].id;
      const upd = await qr.manager.query(
        `UPDATE jobs
         SET status = 'running',
             locked_by = ?,
             attempts = attempts + 1,
             started_at = NOW(3),
             error = NULL,
             progress = CAST(? AS JSON),
             updated_at = NOW(3)
         WHERE id = ? AND status = 'queued'`,
        [
          this.workerId,
          JSON.stringify({ percent: 1, step: 'running', message: '执行中' }),
          id,
        ],
      );
      // mysql2: ResultSetHeader
      const affected = (upd as any)?.affectedRows ?? (Array.isArray(upd) ? upd[0]?.affectedRows : 0);
      await qr.commitTransaction();
      if (!affected) return null;
      const fresh = await this.jobs().findOne({ where: { id } });
      if (fresh) await this.appendEvent(fresh, 'claimed', `由 ${this.workerId} 领取`);
      return fresh;
    } catch (e) {
      try {
        await qr.rollbackTransaction();
      } catch {
        /* ignore */
      }
      this.logger.warn(`claimNext failed: ${(e as Error).message}`);
      return null;
    } finally {
      await qr.release();
    }
  }

  async markSucceeded(job: JobEntity, result: Record<string, unknown>) {
    job.status = 'succeeded';
    job.result = result;
    job.error = null;
    job.finishedAt = new Date();
    job.lockedBy = null;
    job.progress = { percent: 100, step: 'done', message: '完成', ...(job.progress || {}) };
    (job.progress as any).percent = 100;
    await this.jobs().save(job);
    await this.appendEvent(job, 'succeeded', '任务成功', { keys: Object.keys(result || {}) });
  }

  async markFailed(job: JobEntity, err: string, opts?: { requeue?: boolean; delayMs?: number }) {
    const msg = String(err || 'unknown').slice(0, 800);
    if (opts?.requeue && job.attempts < job.maxAttempts) {
      const delay = opts.delayMs ?? Math.min(300_000, 2000 * Math.pow(2, job.attempts));
      job.status = 'queued';
      job.error = msg;
      job.lockedBy = null;
      job.nextRunAt = new Date(Date.now() + delay);
      job.finishedAt = null;
      job.progress = { percent: 0, step: 'queued', message: `失败将重试: ${msg.slice(0, 80)}` };
      await this.jobs().save(job);
      await this.appendEvent(job, 'retry', `自动重试，${delay}ms 后`, { error: msg }, 'warn');
      return;
    }
    job.status = 'failed';
    job.error = msg;
    job.finishedAt = new Date();
    job.lockedBy = null;
    job.progress = { ...(job.progress || {}), step: 'failed', message: msg };
    await this.jobs().save(job);
    await this.appendEvent(job, 'failed', msg, null, 'error');
    await this.markPromoSetTerminal(job, 'failed', msg);
  }

  async updateProgress(jobId: string, tenantId: string, patch: Partial<JobProgress>) {
    const row = await this.jobs().findOne({ where: { id: jobId, tenantId } });
    if (!row || row.status !== 'running') return;
    row.progress = { ...(row.progress || {}), ...patch } as any;
    await this.jobs().save(row);
  }

  async appendEvent(
    job: Pick<JobEntity, 'id' | 'tenantId'>,
    event: string,
    message?: string,
    data?: Record<string, unknown> | null,
    level: string = 'info',
  ) {
    try {
      await this.events().save(
        this.events().create({
          jobId: job.id,
          tenantId: job.tenantId,
          event,
          message: (message || '').slice(0, 512) || null,
          data: data || null,
          level,
        }),
      );
    } catch (e) {
      this.logger.warn(`appendEvent failed: ${(e as Error).message}`);
    }
  }

  toRecord(row: JobEntity): JobRecord {
    const progress = { percent: 0, ...(row.progress as object || {}) } as JobProgress;
    return {
      id: row.id,
      tenantId: row.tenantId,
      userId: row.createdBy || undefined,
      type: row.type,
      status: row.status,
      progress,
      input: row.payload || {},
      result: row.result,
      error: row.error,
      attempts: row.attempts,
      maxAttempts: row.maxAttempts,
      createdAt: row.createdAt?.getTime?.() ?? Date.now(),
      updatedAt: row.updatedAt?.getTime?.() ?? Date.now(),
      startedAt: row.startedAt ? row.startedAt.getTime() : null,
      finishedAt: row.finishedAt ? row.finishedAt.getTime() : null,
    };
  }

  toDto(row: JobEntity) {
    const rec = this.toRecord(row);
    const payload = summarizePayload(rec.type, rec.input);
    const resultStyleNo = String(
      (rec.result as any)?.styleNo || (rec.result as any)?.product?.styleNo || '',
    ).trim();
    const styleNo =
      resultStyleNo ||
      String((payload as any).styleNo || (payload as any).draftStyleNo || '').trim() ||
      '';
    // 发品完成后用结果款号重算标题；multi_color 忽略错误缓存「场景里的模特」
    const titleInput: Record<string, unknown> = { ...(payload as any) };
    if (rec.type === 'publish_product' && resultStyleNo) {
      titleInput.styleNo = resultStyleNo;
      delete titleInput.displayTitle;
      delete titleInput.draftStyleNo;
    }
    if (rec.type === 'promo_image' && String((payload as any).templateId || '') === 'multi_color') {
      delete titleInput.displayTitle;
    }
    const title = buildJobDisplayTitle(rec.type, titleInput);
    return {
      id: rec.id,
      type: rec.type,
      status: rec.status,
      progress: rec.progress,
      payload,
      result: rec.result,
      error: rec.error,
      attempts: rec.attempts,
      maxAttempts: rec.maxAttempts,
      createdBy: row.createdBy,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      startedAt: rec.startedAt,
      finishedAt: rec.finishedAt,
      nextRunAt: row.nextRunAt ? row.nextRunAt.getTime() : null,
      title,
      styleNo,
      productThumb: '' as string,
      productId:
        String((payload as any).productId || '').trim() ||
        String((rec.result as any)?.productId || (rec.result as any)?.product?.id || '').trim() ||
        '',
    };
  }

  /** 批量补商品款号 / 封面缩略图 */
  private async enrichProductMeta(
    tenantId: string,
    items: Array<{
      productId?: string;
      styleNo?: string;
      productThumb?: string;
      payload?: any;
      result?: any;
    }>,
  ) {
    if (!(this.dataSource && process.env.DB_ENABLED === 'true') || !items.length) return;
    const ids = [
      ...new Set(
        items
          .map(
            (i) =>
              i.productId ||
              i.payload?.productId ||
              i.result?.productId ||
              i.result?.product?.id ||
              '',
          )
          .map((x) => String(x || '').trim())
          .filter(Boolean),
      ),
    ];
    if (!ids.length) return;

    const products = await this.dataSource.getRepository(Product).find({
      where: { tenantId, id: In(ids) },
    });
    const byId = new Map(products.map((p) => [p.id, p]));
    const coverIds = products
      .map((p) => (p.coverMediaIds || [])[0])
      .filter(Boolean) as string[];
    const mediaById = new Map<string, MediaAsset>();
    if (coverIds.length) {
      const rows = await this.dataSource.getRepository(MediaAsset).find({
        where: { tenantId, id: In(coverIds), status: 'active' },
      });
      rows.forEach((r) => mediaById.set(r.id, r));
    }

    for (const item of items) {
      const pid = String(
        item.productId ||
          item.payload?.productId ||
          item.result?.productId ||
          item.result?.product?.id ||
          '',
      ).trim();
      if (!pid) continue;
      item.productId = pid;
      const p = byId.get(pid);
      if (!p) continue;
      if (!item.styleNo) item.styleNo = p.styleNo || '';
      const coverId = (p.coverMediaIds || [])[0];
      const media = coverId ? mediaById.get(coverId) : undefined;
      if (media?.objectKey) {
        item.productThumb = this.oss
          ? this.oss.publicUrl(media.objectKey)
          : `${(process.env.MEDIA_PUBLIC_BASE || process.env.APP_BASE_URL || '').replace(/\/$/, '')}/media/${media.objectKey.replace(/^\/+/, '')}`;
      }
    }
  }
}

/**
 * promo_image：同一 setId 只留最新一条（含已完成历史），避免重生堆积多条任务。
 * 无 setId 的进行中任务：同商品+模板只留最新。
 */
function dedupePromoJobs<T extends {
  id: string;
  type?: string;
  status?: string;
  productId?: string;
  payload?: any;
  createdAt?: number;
}>(items: T[]): T[] {
  const active = new Set(['queued', 'running']);
  const seenSet = new Set<string>();
  const seenTpl = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    if (it.type !== 'promo_image' && it.type !== 'promo_video') {
      out.push(it);
      continue;
    }
    const setId = String(it.payload?.setId || '').trim();
    const productId = String(it.productId || it.payload?.productId || '').trim();
    const templateId = String(it.payload?.templateId || '').trim();
    if (setId) {
      if (seenSet.has(setId)) continue;
      seenSet.add(setId);
      out.push(it);
      continue;
    }
    // 无 setId：仅折叠进行中的同模板重复
    if (active.has(String(it.status || '')) && productId && templateId) {
      const key = `${productId}::${templateId}`;
      if (seenTpl.has(key)) continue;
      seenTpl.add(key);
    }
    out.push(it);
  }
  return out;
}

function summarizePayload(type: string, input: Record<string, unknown>) {
  const { files, images, ...rest } = input as any;
  return {
    ...rest,
    type,
    fileCount: Array.isArray(files) ? files.length : undefined,
    imageCount: Array.isArray(images) ? images.length : undefined,
  };
}
