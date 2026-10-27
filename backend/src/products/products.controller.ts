import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ProductsService } from './products.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../common/guards/roles.guard';
import { AuthUser } from '../common/decorators/auth-user.decorator';
import { AuthContext } from '../common/interfaces/auth-context.interface';
import { CreateProductInput, CreateSkuInput, UpdateProductInput } from './product.types';

@Controller('api/products')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  /** 商品列表：员工看全量（可筛），客户按鉴权过滤 */
  @Get()
  list(
    @AuthUser() user: AuthContext,
    @Query('q') q?: string,
    @Query('levelId') levelId?: string,
    @Query('status') status?: string,
    @Query('tag') tag?: string,
    @Query('groupId') groupId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('shareEventId') shareEventId?: string,
    @Query('boundCustomerId') boundCustomerId?: string,
    @Query('publicOnly') publicOnly?: string,
  ) {
    const query = {
      q,
      levelId,
      status,
      tag,
      groupId,
      page: page ? parseInt(page, 10) : 1,
      pageSize: pageSize ? parseInt(pageSize, 10) : 50,
    };
    if (user.role === 'owner' || user.role === 'staff') {
      return this.productsService.listForStaff(user.tenantId, query);
    }
    return this.productsService.listForCustomer(user, {
      ...query,
      shareEventId,
      boundCustomerId,
      publicOnly: publicOnly === '1' || publicOnly === 'true',
    });
  }

  @Post()
  @Roles('owner', 'staff')
  create(@AuthUser() user: AuthContext, @Body() body: CreateProductInput) {
    return this.productsService.create(user, body);
  }

  /** 手工发品：粘贴微信笔记风格文字 → 可编辑 suggestion */
  @Post('parse-note')
  @Roles('owner', 'staff')
  parseNote(@Body() body: { text?: string; note?: string }) {
    return this.productsService.parseNote(body?.text ?? body?.note ?? '');
  }

  @Post('batch-status')
  @Roles('owner', 'staff')
  batchStatus(
    @AuthUser() user: AuthContext,
    @Body() body: { ids: string[]; status: 'on_sale' | 'off_sale' },
  ) {
    return this.productsService.batchStatus(user, body.ids, body.status);
  }

  @Post(':id/copy')
  @Roles('owner', 'staff')
  copy(
    @AuthUser() user: AuthContext,
    @Param('id') id: string,
    @Body() body: { styleNo?: string },
  ) {
    return this.productsService.copy(user, id, body);
  }

  /** 编辑页：追加商品图（multipart field: files，可一次多张） */
  @Post(':id/images')
  @Roles('owner', 'staff')
  @UseInterceptors(
    FilesInterceptor('files', 20, {
      storage: memoryStorage(),
      limits: { fileSize: 12 * 1024 * 1024 },
    }),
  )
  addImages(
    @AuthUser() user: AuthContext,
    @Param('id') id: string,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    return this.productsService.addImages(user, id, files || []);
  }

  /** 编辑页：删除一张商品图 */
  @Delete(':id/images/:mediaId')
  @Roles('owner', 'staff')
  removeImage(
    @AuthUser() user: AuthContext,
    @Param('id') id: string,
    @Param('mediaId') mediaId: string,
  ) {
    return this.productsService.removeImage(user, id, mediaId);
  }

  /**
   * 生图/生视频成功后：追加 mediaIds 到 coverMediaIds 末尾（不替换；同 id 跳过）。
   * Body: { mediaIds: string[] }
   */
  @Post(':id/cover-media/append')
  @Roles('owner', 'staff')
  appendCoverMedia(
    @AuthUser() user: AuthContext,
    @Param('id') id: string,
    @Body() body: { mediaIds?: string[] },
  ) {
    return this.productsService.appendCoverMedia(user, id, body?.mediaIds || []);
  }

  /** 管理员：商品访问日志 */
  @Get(':id/views')
  @Roles('owner', 'staff')
  views(
    @AuthUser() user: AuthContext,
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    return this.productsService.listViews(user, id, limit ? parseInt(limit, 10) : 50);
  }

  /** 商品详情：服务端鉴权（含 designated_only） */
  @Get(':id')
  detail(
    @AuthUser() user: AuthContext,
    @Param('id') id: string,
    @Query('shareEventId') shareEventId?: string,
    @Query('boundCustomerId') boundCustomerId?: string,
  ) {
    return this.productsService.getDetail(user, id, { shareEventId, boundCustomerId });
  }

  @Patch(':id')
  @Roles('owner', 'staff')
  update(
    @AuthUser() user: AuthContext,
    @Param('id') id: string,
    @Body() body: UpdateProductInput,
  ) {
    return this.productsService.update(user, id, body);
  }

  @Delete(':id')
  @Roles('owner', 'staff')
  remove(@AuthUser() user: AuthContext, @Param('id') id: string) {
    return this.productsService.remove(user, id);
  }

  /** 整体对齐颜色 SKU（编辑页保存）；upsert，避免删再建撞 uk_sku */
  @Put(':id/skus')
  @Roles('owner', 'staff')
  replaceSkus(
    @AuthUser() user: AuthContext,
    @Param('id') id: string,
    @Body() body: { skus?: Array<{ color: string; price?: string | null }> },
  ) {
    return this.productsService.replaceColorSkus(user, id, body?.skus || []);
  }

  @Post(':id/skus')
  @Roles('owner', 'staff')
  addSku(
    @AuthUser() user: AuthContext,
    @Param('id') id: string,
    @Body() body: CreateSkuInput,
  ) {
    return this.productsService.addSku(user, id, body);
  }

  @Patch(':id/skus/:skuId')
  @Roles('owner', 'staff')
  updateSku(
    @AuthUser() user: AuthContext,
    @Param('id') id: string,
    @Param('skuId') skuId: string,
    @Body() body: Partial<CreateSkuInput>,
  ) {
    return this.productsService.updateSku(user, id, skuId, body);
  }

  @Delete(':id/skus/:skuId')
  @Roles('owner', 'staff')
  removeSku(
    @AuthUser() user: AuthContext,
    @Param('id') id: string,
    @Param('skuId') skuId: string,
  ) {
    return this.productsService.removeSku(user, id, skuId);
  }
}
