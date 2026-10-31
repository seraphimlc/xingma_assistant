import {
  Body,
  Controller,
  Param,
  Post,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../../common/guards/roles.guard';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthContext } from '../../common/interfaces/auth-context.interface';
import { PublishService } from './publish.service';
import { ConfirmPublishInput } from './publish.types';

@Controller('api/products/publish')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('owner', 'staff')
export class PublishController {
  constructor(private readonly publish: PublishService) {}

  /**
   * 主流程：上传后立刻建草稿+入队，返回 jobId+productId；后台分析/选封面/补全后 patch。
   * multipart field: files；可选 levelId/status/styleNo/name/batchId
   */
  @Post('async')
  @UseInterceptors(
    FilesInterceptor('files', 40, {
      storage: memoryStorage(),
      limits: { fileSize: 12 * 1024 * 1024 },
    }),
  )
  uploadAsync(
    @AuthUser() user: AuthContext,
    @UploadedFiles() files: Express.Multer.File[],
    @Body()
    body: {
      batchId?: string;
      levelId?: string;
      groupId?: string;
      status?: 'on_sale' | 'off_sale' | 'draft';
      priceDisplay?: 'show' | 'hide';
      styleNo?: string;
      name?: string;
    },
  ) {
    return this.publish.uploadAndEnqueue(user, files || [], body);
  }

  /**
   * 客户端直传 OSS 后建草稿+入队。
   * body.objectKeys = 业务 objectKey 列表（tenants/{tenantId}/...）
   */
  @Post('from-oss')
  fromOss(
    @AuthUser() user: AuthContext,
    @Body()
    body: {
      objectKeys: string[];
      batchId?: string;
      levelId?: string;
      groupId?: string;
      status?: string;
      priceDisplay?: string;
      styleNo?: string;
      name?: string;
    },
  ) {
    return this.publish.registerFromOssKeysAndEnqueue(user, body?.objectKeys || [], body);
  }

  /** 已有 batch：先落草稿再入队，返回 jobId+productId */
  @Post(':batchId/enqueue')
  enqueue(
    @AuthUser() user: AuthContext,
    @Param('batchId') batchId: string,
    @Body()
    body: {
      levelId?: string;
      groupId?: string;
      status?: string;
      priceDisplay?: string;
      styleNo?: string;
      name?: string;
    },
  ) {
    return this.publish.enqueueExistingBatch(user, batchId, body);
  }

  /**
   * 同步上传（兼容旧流程 / 仅攒图）
   */
  @Post('upload')
  @UseInterceptors(
    FilesInterceptor('files', 40, {
      storage: memoryStorage(),
      limits: { fileSize: 12 * 1024 * 1024 },
    }),
  )
  upload(
    @AuthUser() user: AuthContext,
    @UploadedFiles() files: Express.Multer.File[],
    @Body() body: { batchId?: string },
  ) {
    return this.publish.uploadBatch(user, files || [], body?.batchId);
  }

  /** 分析批次：图角色 + 颜色 SKU 草案 + 吊牌字段建议 */
  @Post(':batchId/analyze')
  analyze(
    @AuthUser() user: AuthContext,
    @Param('batchId') batchId: string,
    @Body() body: { runOcr?: boolean },
  ) {
    return this.publish.analyze(user, batchId, body);
  }

  /**
   * 待补全商品：吊牌图识别，返回建议字段。
   * 优先 body.objectKey（客户端直传 OSS 后只传 key）；兼容 multipart file。
   * 传 productId 时吊牌图挂进商品图集。
   */
  @Post('hangtag-analyze')
  @UseInterceptors(
    FilesInterceptor('file', 1, {
      storage: memoryStorage(),
      limits: { fileSize: 12 * 1024 * 1024 },
    }),
  )
  hangtagAnalyze(
    @AuthUser() user: AuthContext,
    @UploadedFiles() files: Express.Multer.File[],
    @Body() body: { productId?: string; objectKey?: string },
  ) {
    return this.publish.hangtagAnalyze(user, files?.[0], body);
  }

  /** 确认发品：创建商品 + 一色一 SKU（size=null） */
  @Post('confirm')
  confirm(@AuthUser() user: AuthContext, @Body() body: ConfirmPublishInput) {
    return this.publish.confirm(user, body);
  }
}
