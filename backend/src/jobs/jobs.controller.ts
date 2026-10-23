import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../common/guards/roles.guard';
import { AuthUser } from '../common/decorators/auth-user.decorator';
import { AuthContext } from '../common/interfaces/auth-context.interface';
import { JobsService } from './jobs.service';
import { JobStatus } from './job.types';

@Controller('api/jobs')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('owner', 'staff')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  /** 通用创建（调试/高级）；业务通常走 publish/async、promo/generate */
  @Post()
  create(
    @AuthUser() user: AuthContext,
    @Body()
    body: {
      type: string;
      payload?: Record<string, unknown>;
      maxAttempts?: number;
    },
  ) {
    return this.jobs.create(user, body.type, body.payload || {}, {
      maxAttempts: body.maxAttempts,
    });
  }

  @Get()
  list(
    @AuthUser() user: AuthContext,
    @Query('type') type?: string,
    @Query('status') status?: JobStatus,
    @Query('productId') productId?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.jobs.list(user, {
      type,
      status,
      productId,
      limit: limit ? parseInt(limit, 10) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
    });
  }

  @Get('meta/handlers')
  handlers() {
    return { types: this.jobs.listHandlerTypes() };
  }

  /** 手动回收孤儿/陈旧 running → 重新排队（业主） */
  @Post('reclaim-orphans')
  @Roles('owner')
  reclaimOrphans(
    @Query('onlyStale') onlyStale?: string,
    @Query('staleMs') staleMs?: string,
  ) {
    // 默认只收陈旧；onlyStale=0 才强制回收全部 running（慎用，会打断本进程活任务）
    const forceAll = onlyStale === '0' || onlyStale === 'false';
    return this.jobs
      .reclaimOrphanedRunning({
        onlyStale: !forceAll,
        staleMs: staleMs ? parseInt(staleMs, 10) : undefined,
      })
      .then((reclaimed) => ({ reclaimed }));
  }

  @Get(':id')
  get(@AuthUser() user: AuthContext, @Param('id') id: string) {
    return this.jobs.get(user, id);
  }

  @Get(':id/events')
  events(
    @AuthUser() user: AuthContext,
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    return this.jobs.listEvents(user, id, limit ? parseInt(limit, 10) : 50);
  }

  @Post(':id/retry')
  retry(@AuthUser() user: AuthContext, @Param('id') id: string) {
    return this.jobs.retry(user, id);
  }

  @Post(':id/cancel')
  cancel(@AuthUser() user: AuthContext, @Param('id') id: string) {
    return this.jobs.cancel(user, id);
  }
}
