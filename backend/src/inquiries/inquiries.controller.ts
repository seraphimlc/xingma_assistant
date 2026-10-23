import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { CreateInquiryBody, InquiriesService } from './inquiries.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AuthUser } from '../common/decorators/auth-user.decorator';
import { AuthContext } from '../common/interfaces/auth-context.interface';

@Controller('api/inquiries')
@UseGuards(JwtAuthGuard)
export class InquiriesController {
  constructor(private readonly inquiriesService: InquiriesService) {}

  @Post()
  create(@AuthUser() user: AuthContext, @Body() body: CreateInquiryBody) {
    return this.inquiriesService.create(user, body || ({} as CreateInquiryBody));
  }

  @Get()
  list(
    @AuthUser() user: AuthContext,
    @Query('productId') productId?: string,
    @Query('customerId') customerId?: string,
  ) {
    return this.inquiriesService.list(user, { productId, customerId });
  }

  @Get(':id')
  detail(@AuthUser() user: AuthContext, @Param('id') id: string) {
    return this.inquiriesService.get(user, id);
  }
}
