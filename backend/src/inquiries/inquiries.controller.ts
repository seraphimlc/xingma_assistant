import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CreateInquiryBody, InquiriesService } from './inquiries.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../common/guards/roles.guard';
import { AuthUser } from '../common/decorators/auth-user.decorator';
import { AuthContext } from '../common/interfaces/auth-context.interface';

@Controller('api/inquiries')
@UseGuards(JwtAuthGuard, RolesGuard)
export class InquiriesController {
  constructor(private readonly inquiriesService: InquiriesService) {}

  @Post()
  create(@AuthUser() user: AuthContext, @Body() body: CreateInquiryBody) {
    return this.inquiriesService.create(user, body || ({} as CreateInquiryBody));
  }

  /** 未读摘要：客户 Tab 红点 + 列表行红点（须在 :id 之前） */
  @Get('unread-summary')
  @Roles('owner', 'staff')
  unreadSummary(@AuthUser() user: AuthContext) {
    return this.inquiriesService.unreadSummary(user);
  }

  /** 将该客户全部未读询价标为已读（打开客户详情时调用） */
  @Post('mark-read')
  @Roles('owner', 'staff')
  markRead(@AuthUser() user: AuthContext, @Body() body: { customerId?: string }) {
    return this.inquiriesService.markReadByCustomer(user, String(body?.customerId || ''));
  }

  @Get()
  list(
    @AuthUser() user: AuthContext,
    @Query('productId') productId?: string,
    @Query('customerId') customerId?: string,
  ) {
    return this.inquiriesService.list(user, { productId, customerId });
  }

  /** 单条询价标为已处理（可附处理说明） */
  @Post(':id/handled')
  @Roles('owner', 'staff')
  markHandled(
    @AuthUser() user: AuthContext,
    @Param('id') id: string,
    @Body() body?: { handledNote?: string; handleResult?: string },
  ) {
    return this.inquiriesService.markHandled(user, id, body || {});
  }

  @Get(':id')
  detail(@AuthUser() user: AuthContext, @Param('id') id: string) {
    return this.inquiriesService.get(user, id);
  }
}
