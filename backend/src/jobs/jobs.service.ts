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
  USER_VISIBLE_JOB_TYPES,
  isUserVisibleJobType,
} from './job.types';
import { buildJobDisplayTitle } from './job-display-title';
import { Product } from '../common/entities/product.entity';
import { MediaAsset } from '../common/entities/media-asset.entity';
import { PromoSetEntity } from '../common/entities/promo-set.entity';
import { OssClient } from '../media/oss.client';
import { findTemplate, isVideoTemplate } from '../promo/promo.templates';

@Injectable()
export class JobsService {
  private readonly logger = new Logger('Jobs');
  private readonly handlers = new Map<string, JobHandler>();
  readonly workerId = `worker_${hostname().slice(0, 24)}_${process.pid}`;

  constructor(
    @Optional() private readonly dataSource?: DataSource,
    @Optional() private readonly oss?: OssClient,
  ) {}

  /** params.kind 缺失时仍按 templateId 识别视频，避免 orphan 重试成 promo_image */
  private isPromoVideoSet(
    templateId: string | null | undefined,
    params: Record<string, unknown> | null | undefined,
  ): boolean {
    const kind = String((params as any)?.kind || (params as any)?.mediaKind || '');
    if (kind === 'video' || kind === 'promo_video') return true;
    return isVideoTemplate(findTemplate(String(templateId || (params as any)?.templateId || '')));
  }

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

  /**
   * 档口同事可见可操作同租户 user-facing 任务（与素材页一致）。
   * 系统/非白名单任务仍仅创建者可访问。
   */
  private canAccessJob(row: JobEntity | null, user: AuthContext): boolean {
    if (!row || row.tenantId !== user.tenantId) return false;
    if (this.isOwnedBy(row, user)) return true;
    if (
      (user.role === 'owner' || user.role === 'staff') &&
      isUserVisibleJobType(row.type)
    ) {
      return true;
    }
    return false;
  }

  private assertOwned(row: JobEntity | null, user: AuthContext): JobEntity {
    if (!this.canAccessJob(row, user)) {
      throw new NotFoundException('任务不存在');
    }
    return row!;
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
    const createTotal = Math.max(1, Number((payload as any)?.count) || 0) || undefined;
    const row = repo.create({
      id: newId('job'),
      tenantId: user.tenantId,
      type,
      status: 'queued',
      progress: {
        percent: 0,
        step: 'queued',
        message: displayTitle,
        ...(createTotal ? { done: 0, total: createTotal } : {}),
      },
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
      {
        const regenIdx = Array.isArray((payload as any)?.regenIndexes)
          ? ((payload as any).regenIndexes as number[]).filter((n) => Number.isInteger(Number(n)))
          : [];
        const totalHint = Math.max(
          1,
          Number((payload as any)?.count) || 0,
          regenIdx.length || 0,
        );
        // 局部重生：total 用整组 count；done 先按「未重生槽」估算，worker 会校准
        const doneHint = regenIdx.length ? Math.max(0, totalHint - regenIdx.length) : 0;
        row.progress = {
          percent: 0,
          step: 'queued',
          message: regenIdx.length
            ? `重新生成 ${regenIdx.length} 张（${doneHint}/${totalHint}）`
            : displayTitle,
          done: doneHint,
          total: totalHint,
        };
      }
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
    const repo = this.jobs();
    const rows = await repo.find({
      where: {
        tenantId: user.tenantId,
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
    const orphanSetId = this.parseOrphanPromoSetId(jobId);
    if (orphanSetId) {
      return this.getOrphanPromoSetAsJob(user, orphanSetId);
    }
    const row = this.assertOwned(
      await this.jobs().findOne({ where: { id: jobId, tenantId: user.tenantId } }),
      user,
    );
    const dto = this.toDto(row);
    await this.enrichProductMeta(user.tenantId, [dto]);
    return dto;
  }

  /** 列表合成的 orphan_<setId>：无真实 job 行时也能打开任务详情 */
  private parseOrphanPromoSetId(jobId: string): string | null {
    const id = String(jobId || '').trim();
    if (!id.startsWith('orphan_')) return null;
    const setId = id.slice('orphan_'.length).trim();
    return setId || null;
  }

  private async getOrphanPromoSetAsJob(user: AuthContext, setId: string) {
    if (!this.dataSource || process.env.DB_ENABLED !== 'true') {
      throw new NotFoundException('任务不存在');
    }
    if (!(user.role === 'owner' || user.role === 'staff')) {
      throw new NotFoundException('任务不存在');
    }
    const sets = this.dataSource.getRepository(PromoSetEntity);
    const row = await sets.findOne({ where: { id: setId, tenantId: user.tenantId } });
    if (!row) throw new NotFoundException('任务不存在');
    // 已挂上真实 job：详情/重试走真实行，避免 orphan_ 残留
    const linkedJobId = String(row.jobId || '').trim();
    if (linkedJobId) {
      try {
        const jobRow = await this.jobs().findOne({
          where: { id: linkedJobId, tenantId: user.tenantId },
        });
        if (jobRow && this.canAccessJob(jobRow, user)) {
          const dto = this.toDto(jobRow);
          await this.enrichProductMeta(user.tenantId, [dto]);
          return dto;
        }
      } catch {
        /* fall through synthetic */
      }
    }
    const params = (row.params || {}) as any;
    const isVideo = this.isPromoVideoSet(row.templateId, params);
    const kind = isVideo ? 'video' : String(params.kind || params.mediaKind || 'image');
    const type = isVideo ? 'promo_video' : 'promo_image';
    const productId = String(row.productId || '').trim();
    const err =
      (Array.isArray(row.images) &&
        row.images.map((i: any) => i?.error).find((e: any) => e)) ||
      (row.status === 'failed' ? '生成失败' : '') ||
      '生成失败';
    const displayTitle = buildJobDisplayTitle(type, {
      ...params,
      templateId: row.templateId,
      styleNo: params.styleNo,
    });
    const orphanImgs = Array.isArray(row.images) ? row.images : [];
    const orphanDone = orphanImgs.filter((i: any) => i && i.status === 'done').length;
    const orphanTotal = Math.max(
      orphanImgs.length,
      Number(params.count) || 0,
      orphanDone,
    );
    const dto: any = {
      id: `orphan_${row.id}`,
      type,
      status: row.status === 'generating' ? 'running' : 'failed',
      progress: {
        percent: row.status === 'generating' ? 5 : 0,
        step: row.status === 'generating' ? 'running' : 'failed',
        message: String(err).slice(0, 120),
        done: orphanDone,
        total: orphanTotal || undefined,
      },
      payload: {
        ...params,
        productId,
        setId: row.id,
        templateId: row.templateId,
        displayTitle,
      },
      result: { setId: row.id, productId },
      error: row.status === 'failed' ? String(err).slice(0, 500) : null,
      attempts: 0,
      maxAttempts: 0,
      createdAt: row.createdAt?.getTime?.() ?? row.createdAt,
      updatedAt: row.updatedAt?.getTime?.() ?? row.updatedAt,
      productId,
      setId: row.id,
      title: displayTitle,
      orphanPromoSet: true,
    };
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
    const where: any = {
      tenantId: user.tenantId,
    };
    // 业主/员工：任务中心与素材页对齐，同租户 user-facing 任务全可见（含同事创建的失败视频）
    if (!(user.role === 'owner' || user.role === 'staff')) {
      return { items: [], total: 0 };
    }
    // 业主列表默认只返回 user-facing 类型；未知/系统 job 默认隐藏
    const rawType = String(query?.type || '').trim();
    if (rawType) {
      if (!isUserVisibleJobType(rawType)) {
        return { items: [], total: 0 };
      }
      where.type = rawType;
    } else {
      where.type = In([...USER_VISIBLE_JOB_TYPES]);
    }
    if (query?.status) where.status = query.status;
    // 多取一些再去重/合并孤儿失败组，避免失败视频被近期成功挤出窗口
    const productId = String(query?.productId || '').trim();
    const fetchTake = Math.min(200, Math.max(take * 4, productId ? 80 : take * 3));
    const [rows] = await this.jobs().findAndCount({
      where,
      order: { createdAt: 'DESC' },
      take: fetchTake,
      skip: productId ? 0 : skip,
    });
    let items = rows.map((r) => this.toDto(r));
    if (productId) {
      items = items.filter((it) => String(it.productId || '').trim() === productId);
    }
    items = dedupePromoJobs(items);
    items = await this.appendOrphanFailedPromoSets(user, items);
    items = dedupePromoJobs(items);
    if (productId) {
      items = items.filter((it) => String(it.productId || '').trim() === productId);
    }
    if (query?.status) {
      items = items.filter((it) => String(it.status || '') === String(query.status));
    }
    // 截断时优先保留排队/在做/失败，再补完成态
    const rankKeep = (st: string) => {
      if (st === 'running' || st === 'queued') return 0;
      if (st === 'failed') return 1;
      if (st === 'cancelled') return 2;
      return 3;
    };
    items = items
      .slice()
      .sort((a, b) => {
        const ra = rankKeep(String(a.status || ''));
        const rb = rankKeep(String(b.status || ''));
        if (ra !== rb) return ra - rb;
        return Number(b.createdAt || 0) - Number(a.createdAt || 0);
      })
      .slice(skip, skip + take);
    await this.enrichProductMeta(user.tenantId, items);
    return { items, total: items.length };
  }

  /**
   * 素材页能看到、但 job_id 为空/任务中心漏掉的失败组：补进列表，避免死胡同。
   * 无真实 job 时 id 用 set 关联；前端「查看」进素材组，「重新生成」走素材 regenerate。
   */
  private async appendOrphanFailedPromoSets(user: AuthContext, items: any[]): Promise<any[]> {
    if (!this.dataSource || process.env.DB_ENABLED !== 'true') return items;
    try {
      const sets = this.dataSource.getRepository(PromoSetEntity);
      const rows = await sets.find({
        where: { tenantId: user.tenantId, status: 'failed' as any },
        order: { updatedAt: 'DESC' },
        take: 40,
      });
      const seenSet = new Set(
        items
          .map((it) => String(it?.payload?.setId || it?.setId || '').trim())
          .filter(Boolean),
      );
      const seenJob = new Set(items.map((it) => String(it?.id || '').trim()).filter(Boolean));
      const out = items.slice();
      for (const row of rows) {
        if (!row?.id || seenSet.has(row.id)) continue;
        const jobId = String(row.jobId || '').trim();
        if (jobId && seenJob.has(jobId)) {
          seenSet.add(row.id);
          continue;
        }
        // 若仍有真实 job 但不在本页结果里，尽量挂上真实 job 行
        if (jobId) {
          try {
            const jobRow = await this.jobs().findOne({
              where: { id: jobId, tenantId: user.tenantId },
            });
            if (jobRow && this.canAccessJob(jobRow, user)) {
              const dto = this.toDto(jobRow);
              out.push(dto);
              seenSet.add(row.id);
              seenJob.add(jobRow.id);
              continue;
            }
          } catch {
            /* fall through synthetic */
          }
        }
        const params = (row.params || {}) as any;
        const isVideo = this.isPromoVideoSet(row.templateId, params);
        const kind = isVideo ? 'video' : String(params.kind || params.mediaKind || 'image');
        const err =
          (Array.isArray(row.images) &&
            row.images.map((i: any) => i?.error).find((e: any) => e)) ||
          '生成失败';
        const type = isVideo ? 'promo_video' : 'promo_image';
        const productId = String(row.productId || '').trim();
        const displayTitle = buildJobDisplayTitle(type, {
          ...params,
          templateId: row.templateId,
          styleNo: params.styleNo,
        });
        const failImgs = Array.isArray(row.images) ? row.images : [];
        const failDone = failImgs.filter((i: any) => i && i.status === 'done').length;
        const failTotal = Math.max(failImgs.length, Number(params.count) || 0, failDone);
        out.push({
          // 真实 job 不可用时一律用 orphan_ 前缀，避免详情/重试打到已删 jobId
          id: `orphan_${row.id}`,
          type,
          status: 'failed',
          progress: {
            percent: 0,
            step: 'failed',
            message: String(err).slice(0, 120),
            done: failDone,
            total: failTotal || undefined,
          },
          payload: {
            ...params,
            productId,
            setId: row.id,
            templateId: row.templateId,
            displayTitle,
          },
          result: { setId: row.id, productId },
          error: String(err).slice(0, 500),
          attempts: 0,
          maxAttempts: 0,
          createdAt: row.createdAt?.getTime?.() ?? row.createdAt,
          updatedAt: row.updatedAt?.getTime?.() ?? row.updatedAt,
          productId,
          setId: row.id,
          title: displayTitle,
          orphanPromoSet: true,
        });
        seenSet.add(row.id);
      }
      return out;
    } catch (e) {
      this.logger.warn(`appendOrphanFailedPromoSets: ${(e as Error).message}`);
      return items;
    }
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
    const orphanSetId = this.parseOrphanPromoSetId(jobId);
    if (orphanSetId) {
      return this.retryOrphanPromoSet(user, orphanSetId);
    }
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
    if (isUnrecognizedPublishResult(row.type, (row.result || {}) as any)) {
      throw new BadRequestException('识别失败不可重试，请重新选图发品');
    }
    // 失败 / 取消一律可重跑：重置 attempts，强制重新排队
    row.status = 'queued';
    row.error = null;
    row.finishedAt = null;
    row.lockedBy = null;
    row.nextRunAt = null;
    row.startedAt = null;
    row.attempts = 0;
    {
      const prevP = (row.progress || {}) as Record<string, unknown>;
      row.progress = {
        percent: 0,
        step: 'queued',
        message: '重新排队',
        ...(typeof prevP.done === 'number' ? { done: prevP.done } : {}),
        ...(typeof prevP.total === 'number' ? { total: prevP.total } : {}),
      };
    }
    await repo.save(row);
    await this.appendEvent(row, 'retry', '用户触发重试（已重置次数）');
    await this.revivePromoSetForRequeuedJob(row);
    return this.toDto(row);
  }

  /**
   * 无 job 行的失败素材组：按 set.params 复用/创建真实 job 并重新排队。
   * 任务中心「重新生成」与素材页 regenerate 同源效果，不再 toast 死胡同。
   */
  private async retryOrphanPromoSet(user: AuthContext, setId: string) {
    if (!this.dataSource || process.env.DB_ENABLED !== 'true') {
      throw new BadRequestException('任务服务未启用');
    }
    if (!(user.role === 'owner' || user.role === 'staff')) {
      throw new NotFoundException('任务不存在');
    }
    const sets = this.dataSource.getRepository(PromoSetEntity);
    const setRow = await sets.findOne({ where: { id: setId, tenantId: user.tenantId } });
    if (!setRow) throw new NotFoundException('任务不存在');

    const linkedJobId = String(setRow.jobId || '').trim();
    if (linkedJobId) {
      try {
        const existing = await this.jobs().findOne({
          where: { id: linkedJobId, tenantId: user.tenantId },
        });
        if (existing && this.canAccessJob(existing, user)) {
          if (existing.status === 'running' || existing.status === 'queued') {
            throw new BadRequestException('任务仍在排队或执行中');
          }
          if (existing.status !== 'succeeded') {
            // 直接重排队（勿回调 this.retry，避免与 orphan 路径循环引用）
            existing.status = 'queued';
            existing.error = null;
            existing.finishedAt = null;
            existing.lockedBy = null;
            existing.nextRunAt = null;
            existing.startedAt = null;
            existing.attempts = 0;
            {
              const prevP = (existing.progress || {}) as Record<string, unknown>;
              existing.progress = {
                percent: 0,
                step: 'queued',
                message: '重新排队',
                ...(typeof prevP.done === 'number' ? { done: prevP.done } : {}),
                ...(typeof prevP.total === 'number' ? { total: prevP.total } : {}),
              };
            }
            await this.jobs().save(existing);
            await this.appendEvent(existing, 'retry', '用户触发重试（孤儿组已挂回 job）');
            await this.revivePromoSetForRequeuedJob(existing);
            return this.toDto(existing);
          }
        }
      } catch (e) {
        if (e instanceof BadRequestException) throw e;
        /* fall through create */
      }
    }

    const params = (setRow.params || {}) as Record<string, unknown>;
    const productId = String(setRow.productId || '').trim();
    const templateId = String(setRow.templateId || (params as any).templateId || '').trim();
    const isVideo = this.isPromoVideoSet(templateId, params);
    const kind = isVideo ? 'video' : String((params as any).kind || (params as any).mediaKind || 'image');
    const type: JobType = isVideo ? 'promo_video' : 'promo_image';
    const refIds = ((params as any).referenceAssetIds || []).filter(Boolean);
    if (!productId || !templateId || !refIds.length) {
      throw new BadRequestException('该组缺少生成参数，无法重新生成');
    }

    const displayTitle = buildJobDisplayTitle(type, {
      ...params,
      templateId,
      productId,
      setId: setRow.id,
      styleNo: (params as any).styleNo,
    });
    const jobPayload: Record<string, unknown> = {
      ...params,
      productId,
      setId: setRow.id,
      templateId,
      kind: isVideo ? 'video' : (params as any).kind || 'image',
      mediaKind: isVideo ? 'video' : (params as any).mediaKind || 'image',
      displayTitle,
    };

    // 槽位立刻可见「重新生成中」
    setRow.status = 'generating' as any;
    if (isVideo) {
      setRow.images = [{ index: 0, status: 'pending' }] as any;
    } else if (Array.isArray(setRow.images) && setRow.images.length) {
      setRow.images = setRow.images.map((im: any, idx: number) => {
        if (!im) return { index: idx, status: 'pending' };
        return {
          ...im,
          status: 'pending',
          error: undefined,
          url: undefined,
          objectKey: undefined,
        };
      }) as any;
    } else {
      const count = Math.max(1, Number((params as any).count) || 1);
      setRow.images = Array.from({ length: count }, (_, i) => ({
        index: i,
        status: 'pending',
      })) as any;
    }

    const job = await this.reuseOrCreate(user, type, jobPayload, {
      existingJobId: linkedJobId || null,
    });
    setRow.jobId = job.id;
    await sets.save(setRow);
    this.logger.log(
      `retryOrphanPromoSet setId=${setRow.id} → jobId=${job.id} type=${type}`,
    );
    return job;
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
      {
        const prevP = (row.progress || {}) as Record<string, unknown>;
        row.progress = {
          percent: 0,
          step: 'queued',
          message: msg,
          ...(typeof prevP.done === 'number' ? { done: prevP.done } : {}),
          ...(typeof prevP.total === 'number' ? { total: prevP.total } : {}),
        };
      }
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

  /** promo 重排队：失败组拉回 generating，视频/失败槽复位 pending，并挂上本 job */
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
        const isVideo =
          job.type === 'promo_video' ||
          this.isPromoVideoSet(row.templateId, (row.params || {}) as any);
        if (isVideo) {
          row.images = [{ index: 0, status: 'pending' }] as any;
        } else if (Array.isArray(row.images) && row.images.length) {
          row.images = row.images.map((im: any, idx: number) => {
            if (!im) return { index: idx, status: 'pending' };
            if (im.status === 'failed' || im.error || !im.url) {
              return {
                ...im,
                status: 'pending',
                error: undefined,
                url: undefined,
                objectKey: undefined,
              };
            }
            return im;
          }) as any;
        }
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
      // 保留已有 done/total（局部重生排队时已写入），只改运行态字段
      const upd = await qr.manager.query(
        `UPDATE jobs
         SET status = 'running',
             locked_by = ?,
             attempts = attempts + 1,
             started_at = NOW(3),
             error = NULL,
             progress = JSON_SET(
               COALESCE(progress, JSON_OBJECT()),
               '$.percent', 1,
               '$.step', 'running',
               '$.message', '执行中'
             ),
             updated_at = NOW(3)
         WHERE id = ? AND status = 'queued'`,
        [
          this.workerId,
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
    const rr = (result || {}) as Record<string, any>;
    const unrecognized =
      job.type === 'publish_product' &&
      (rr.recognized === false || rr.outcome === '未识别出商品' || rr.styleNoProvisional === true);
    job.result = result;
    job.finishedAt = new Date();
    job.lockedBy = null;
    const prev = (job.progress || {}) as Record<string, unknown>;
    const done =
      typeof (result as any)?.done === 'number'
        ? (result as any).done
        : typeof prev.done === 'number'
          ? prev.done
          : undefined;
    const total =
      typeof (result as any)?.total === 'number'
        ? (result as any).total
        : typeof prev.total === 'number'
          ? prev.total
          : undefined;
    if (unrecognized) {
      const reason = String(rr.failureReason || rr.outcome || '未识别出商品').slice(0, 200);
      job.status = 'failed';
      job.error = `识别失败：${reason}`.slice(0, 800);
      job.progress = {
        ...prev,
        percent: 100,
        step: 'failed',
        message: '识别失败',
        failureReason: reason,
        ...(done != null ? { done } : {}),
        ...(total != null ? { total } : {}),
      };
      await this.jobs().save(job);
      await this.appendEvent(job, 'failed', `识别失败：${reason}`, { keys: Object.keys(result || {}) }, 'warn');
      return;
    }
    job.status = 'succeeded';
    job.error = null;
    job.progress = {
      ...prev,
      percent: 100,
      step: 'done',
      message: done != null && total != null ? `已完成 ${done}/${total}` : '已完成',
      ...(done != null ? { done } : {}),
      ...(total != null ? { total } : {}),
    };
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


  /**
   * 列表/详情展示用：终态任务若 progress.done 仍停在排队初值（旧 markSucceeded
   * 把 ...(job.progress) 放在 step/message 之后覆盖），用 result.done/total 校准，
   * 避免任务中心显示「完成 0/4」。c9ebb1a 修了写入，本方法补读路径与历史脏数据。
   */
  private progressForDto(
    status: string,
    progress: Record<string, unknown> | null | undefined,
    result: Record<string, unknown> | null | undefined,
  ): Record<string, unknown> {
    const prev = { ...(progress || {}) } as Record<string, unknown>;
    const rDone = (result as any)?.done;
    const rTotal = (result as any)?.total;
    const pDone = prev.done;
    const pTotal = prev.total;
    const done =
      typeof rDone === 'number'
        ? rDone
        : typeof pDone === 'number'
          ? pDone
          : undefined;
    const total =
      typeof rTotal === 'number'
        ? rTotal
        : typeof pTotal === 'number'
          ? pTotal
          : undefined;
    const terminal =
      status === 'succeeded' || status === 'failed' || status === 'cancelled';
    const doneStale =
      typeof rDone === 'number' &&
      typeof pDone === 'number' &&
      pDone !== rDone;
    const staleMid =
      terminal &&
      typeof prev.step === 'string' &&
      prev.step !== 'done' &&
      prev.step !== 'failed' &&
      prev.step !== 'cancelled';
    if (!terminal && !doneStale) {
      return {
        ...prev,
        ...(done != null ? { done } : {}),
        ...(total != null ? { total } : {}),
      };
    }
    const step =
      status === 'succeeded'
        ? 'done'
        : status === 'failed'
          ? 'failed'
          : status === 'cancelled'
            ? 'cancelled'
            : (prev.step as string) || undefined;
    let message: string | undefined =
      typeof prev.message === 'string' ? prev.message : undefined;
    const failReason = String((result as any)?.failureReason || prev.failureReason || '').trim();
    const unrecognized =
      (result as any)?.recognized === false ||
      (result as any)?.outcome === '未识别出商品' ||
      (result as any)?.styleNoProvisional === true;
    if (unrecognized || (status === 'failed' && (failReason || String(prev.message || '').includes('识别失败')))) {
      message = '识别失败';
      if (failReason) prev.failureReason = failReason;
    } else if (status === 'succeeded') {
      message =
        done != null && total != null ? `已完成 ${done}/${total}` : '已完成';
    } else if (staleMid || doneStale) {
      // keep prev message for failed/cancelled unless we only needed done fix
    }
    return {
      ...prev,
      ...(status === 'succeeded' ? { percent: 100 } : {}),
      ...(step ? { step } : {}),
      ...(message != null ? { message } : {}),
      ...(done != null ? { done } : {}),
      ...(total != null ? { total } : {}),
    };
  }

  toDto(row: JobEntity) {
    const rec = this.toRecord(row);
    const payload = summarizePayload(rec.type, rec.input) as Record<string, any>;
    const resultRec = { ...((rec.result || {}) as Record<string, any>) };
    const unrecognizedPublish = isUnrecognizedPublishResult(rec.type, resultRec);
    const resultStyleNo = String(
      resultRec?.styleNo || resultRec?.product?.styleNo || '',
    ).trim();
    // 识别失败：任何位置不得出现款号（含临时 V 号）
    if (unrecognizedPublish) {
      delete payload.styleNo;
      delete payload.draftStyleNo;
      if (payload.displayTitle && /款号|识别中|草稿|V\d{12}/i.test(String(payload.displayTitle))) {
        delete payload.displayTitle;
      }
      resultRec.styleNo = null;
      resultRec.draftStyleNo = null;
      if (resultRec.product) {
        resultRec.product = { ...resultRec.product, styleNo: null };
      }
    }
    const styleNo = unrecognizedPublish
      ? ''
      : resultStyleNo ||
        String(payload.styleNo || payload.draftStyleNo || '').trim() ||
        '';
    // 发品完成后用结果重算标题；未识别不得用临时号冒充款号
    const titleInput: Record<string, unknown> = { ...payload };
    if (rec.type === 'publish_product') {
      delete titleInput.displayTitle;
      if (unrecognizedPublish) {
        titleInput.recognized = false;
        titleInput.outcome = '未识别出商品';
        delete titleInput.styleNo;
        delete titleInput.draftStyleNo;
      } else if (resultStyleNo) {
        titleInput.styleNo = resultStyleNo;
        delete titleInput.draftStyleNo;
      }
    }
    if (rec.type === 'promo_image' && String((payload as any).templateId || '') === 'multi_color') {
      delete titleInput.displayTitle;
    }
    const title = buildJobDisplayTitle(rec.type, titleInput);
    const sourceMediaIds: string[] = (() => {
      const fromResult = Array.isArray(resultRec.sourceMediaIds) ? resultRec.sourceMediaIds : [];
      const fromPayload = Array.isArray(payload.mediaIds) ? payload.mediaIds : [];
      const ids = (fromResult.length ? fromResult : fromPayload)
        .map((x: any) => String(x || '').trim())
        .filter(Boolean);
      return [...new Set(ids)];
    })();
    return {
      id: rec.id,
      type: rec.type,
      status: rec.status,
      progress: this.progressForDto(rec.status, rec.progress as any, resultRec),
      payload,
      result: resultRec,
      error: unrecognizedPublish
        ? String(rec.error || resultRec.failureReason || '识别失败')
            .replace(/款号\s*V?\d[\w-]*/gi, '')
            .replace(/V\d{12}[A-Z0-9]*/gi, '')
            .trim() || '识别失败'
        : rec.error,
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
      sourceMediaIds,
      sourceImages: [] as Array<{ mediaId: string; url: string; filename?: string; role?: string }>,
      canRetry: !(unrecognizedPublish || rec.status === 'succeeded' || rec.status === 'queued' || rec.status === 'running'),
      unrecognized: unrecognizedPublish,
      productId: (() => {
        if (unrecognizedPublish) return '';
        const fromResult = String(resultRec.productId || resultRec.product?.id || '').trim();
        if (fromResult) return fromResult;
        return String(payload.productId || '').trim();
      })(),
      // 业主「查看」直达素材组详情；与 payload.setId 对齐
      setId:
        String(payload.setId || '').trim() ||
        String(resultRec.setId || '').trim() ||
        '',
    };
  }

  /** 批量补商品款号 / 封面缩略图；发品任务用上传首图作 thumb，并填全量 sourceImages */
  private async enrichProductMeta(
    tenantId: string,
    items: Array<{
      productId?: string;
      styleNo?: string;
      productThumb?: string;
      payload?: any;
      result?: any;
      sourceMediaIds?: string[];
      sourceImages?: Array<{ mediaId: string; url: string; filename?: string; role?: string }>;
      unrecognized?: boolean;
      type?: string;
    }>,
  ) {
    if (!(this.dataSource && process.env.DB_ENABLED === 'true') || !items.length) return;

    const mediaUrl = (objectKey: string) =>
      this.oss
        ? this.oss.publicUrl(objectKey)
        : `${(process.env.MEDIA_PUBLIC_BASE || process.env.APP_BASE_URL || '').replace(/\/$/, '')}/media/${objectKey.replace(/^\/+/, '')}`;

    const productIds = [
      ...new Set(
        items
          .filter((i) => !i.unrecognized)
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

    const sourceIdList: string[] = [];
    for (const item of items) {
      const ids = [
        ...(Array.isArray(item.sourceMediaIds) ? item.sourceMediaIds : []),
        ...(Array.isArray(item.payload?.mediaIds) ? item.payload.mediaIds : []),
        ...(Array.isArray(item.result?.sourceMediaIds) ? item.result.sourceMediaIds : []),
      ]
        .map((x) => String(x || '').trim())
        .filter(Boolean);
      item.sourceMediaIds = [...new Set(ids)];
      sourceIdList.push(...item.sourceMediaIds);
    }

    const byId = new Map<string, Product>();
    const coverIds: string[] = [];
    if (productIds.length) {
      const products = await this.dataSource.getRepository(Product).find({
        where: { tenantId, id: In(productIds) },
      });
      products.forEach((p) => byId.set(p.id, p));
      for (const p of products) {
        const c = (p.coverMediaIds || [])[0];
        if (c) coverIds.push(c);
      }
    }

    const mediaIdsNeeded = [...new Set([...coverIds, ...sourceIdList])];
    const mediaById = new Map<string, MediaAsset>();
    if (mediaIdsNeeded.length) {
      const rows = await this.dataSource.getRepository(MediaAsset).find({
        where: { tenantId, id: In(mediaIdsNeeded) },
      });
      rows.forEach((r) => mediaById.set(r.id, r));
    }

    for (const item of items) {
      if (item.unrecognized) {
        item.styleNo = '';
        item.productId = '';
      } else {
        const pid = String(
          item.productId ||
            item.payload?.productId ||
            item.result?.productId ||
            item.result?.product?.id ||
            '',
        ).trim();
        if (pid) {
          item.productId = pid;
          const p = byId.get(pid);
          if (p) {
            if (!item.styleNo) item.styleNo = p.styleNo || '';
            const coverId = (p.coverMediaIds || [])[0];
            const media = coverId ? mediaById.get(coverId) : undefined;
            if (media?.objectKey && !item.productThumb) {
              item.productThumb = mediaUrl(media.objectKey);
            }
          }
        }
      }

      // 发品：列表缩略图 = 首张上传图；详情 = 全部上传图
      const orderedIds = item.sourceMediaIds || [];
      const fromResultImgs = Array.isArray(item.result?.sourceImages)
        ? item.result.sourceImages
        : [];
      const roleById = new Map<string, string>();
      const nameById = new Map<string, string>();
      for (const im of fromResultImgs) {
        if (im?.mediaId) {
          if (im.role) roleById.set(String(im.mediaId), String(im.role));
          if (im.filename) nameById.set(String(im.mediaId), String(im.filename));
        }
      }
      const images: Array<{ mediaId: string; url: string; filename?: string; role?: string }> = [];
      for (const mid of orderedIds) {
        const m = mediaById.get(mid);
        const fromRes = fromResultImgs.find((x: any) => String(x?.mediaId) === mid);
        const url =
          (fromRes?.url && String(fromRes.url)) ||
          (m?.objectKey ? mediaUrl(m.objectKey) : '');
        if (!url) continue;
        images.push({
          mediaId: mid,
          url,
          filename: nameById.get(mid) || fromRes?.filename || '',
          role: roleById.get(mid) || fromRes?.role || '',
        });
      }
      item.sourceImages = images;
      // 列表 thumb：优先首张上传图（识别失败无商品封面时也有图）
      if (!item.productThumb && images[0]?.url) {
        item.productThumb = images[0].url;
      }
    }
  }
}

/**
 * promo 任务去重（列表展示用，不删库）：
 * 1) 同一 setId 只留最新一条（重生不应堆多行）
 * 2) 同一商品+模板：失败/取消仅当已被「更新的」成功或进行中取代时隐藏
 *    （旧成功不得盖住新失败；失败必须仍出现在任务中心）
 */
function dedupePromoJobs<T extends {
  id: string;
  type?: string;
  status?: string;
  productId?: string;
  payload?: any;
  createdAt?: number;
}>(items: T[]): T[] {
  const okStatus = new Set(['queued', 'running', 'succeeded', 'partial']);
  // 先按 setId 去重（列表已按 createdAt DESC）
  const seenSet = new Set<string>();
  const bySet: T[] = [];
  for (const it of items) {
    if (it.type !== 'promo_image' && it.type !== 'promo_video') {
      bySet.push(it);
      continue;
    }
    const setId = String(it.payload?.setId || '').trim();
    if (setId) {
      if (seenSet.has(setId)) continue;
      seenSet.add(setId);
    }
    bySet.push(it);
  }
  // 按时间新→旧：先遇到的成功/进行中盖住更旧的失败/取消；新失败不被旧成功盖住
  const coveredByNewerOk = new Set<string>();
  const out: T[] = [];
  for (const it of bySet) {
    if (it.type !== 'promo_image' && it.type !== 'promo_video') {
      out.push(it);
      continue;
    }
    const productId = String(it.productId || it.payload?.productId || '').trim();
    const templateId = String(it.payload?.templateId || '').trim();
    const st = String(it.status || '');
    if (!productId || !templateId) {
      out.push(it);
      continue;
    }
    const key = `${productId}::${templateId}::${it.type}`;
    if (okStatus.has(st)) {
      coveredByNewerOk.add(key);
      out.push(it);
      continue;
    }
    // failed / cancelled
    if (coveredByNewerOk.has(key)) continue;
    out.push(it);
  }
  return out;
}

function isUnrecognizedPublishResult(type: string, result: Record<string, any> | null | undefined): boolean {
  if (type !== 'publish_product') return false;
  const rr = result || {};
  return (
    rr.recognized === false ||
    rr.outcome === '未识别出商品' ||
    rr.styleNoProvisional === true ||
    /识别失败|未识别/.test(String(rr.failureReason || ''))
  );
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
