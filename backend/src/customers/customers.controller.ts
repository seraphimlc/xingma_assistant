import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CustomersService } from './customers.service';
import { ProductsService } from '../products/products.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../common/guards/roles.guard';
import { AuthUser } from '../common/decorators/auth-user.decorator';
import { AuthContext } from '../common/interfaces/auth-context.interface';

@Controller('api/customers')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CustomersController {
  constructor(
    private readonly customersService: CustomersService,
    private readonly productsService: ProductsService,
  ) {}

  @Get()
  @Roles('owner', 'staff')
  list(
    @AuthUser() user: AuthContext,
    @Query('q') q?: string,
    @Query('levelId') levelId?: string,
  ) {
    return this.customersService.list(user.tenantId, { q, levelId }, user);
  }

  /** 批量改等级（静态路径须在 :id 之前） */
  @Post('batch-level')
  @Roles('owner', 'staff')
  batchLevel(
    @AuthUser() user: AuthContext,
    @Body() body: { ids: string[]; levelId: string },
  ) {
    return this.customersService.batchUpdateLevel(user.tenantId, body.ids, body.levelId);
  }

  @Post('rules')
  @Roles('owner', 'staff')
  upsertRule(
    @AuthUser() user: AuthContext,
    @Body() body: { customerId: string; productId: string; effect: 'allow' | 'deny'; remark?: string },
  ) {
    return this.customersService.upsertRule(user.tenantId, body);
  }

  @Delete('rules/:ruleId')
  @Roles('owner', 'staff')
  removeRule(@AuthUser() user: AuthContext, @Param('ruleId') ruleId: string) {
    return this.customersService.removeRule(user.tenantId, ruleId);
  }

  /** 该客户访问过的商品（product_view_events） */
  @Get(':id/viewed-products')
  @Roles('owner', 'staff')
  viewedProducts(
    @AuthUser() user: AuthContext,
    @Param('id') id: string,
    @Query('limit') limit?: string,
  ) {
    return this.productsService.listCustomerViewedProducts(
      user,
      id,
      limit ? parseInt(limit, 10) : 50,
    );
  }

  @Get(':id')
  @Roles('owner', 'staff')
  detail(@AuthUser() user: AuthContext, @Param('id') id: string) {
    return this.customersService.get(user.tenantId, id);
  }

  /** 人工调整客户等级：levelId 必填；rank/code 由服务端解析，不信任客户端 */
  @Patch(':id/level')
  @Roles('owner', 'staff')
  updateLevel(
    @AuthUser() user: AuthContext,
    @Param('id') id: string,
    @Body() body: { levelId: string },
  ) {
    return this.customersService.updateLevel(user.tenantId, id, body.levelId);
  }

  @Post(':id/follow-ups')
  @Roles('owner', 'staff')
  addFollowUp(
    @AuthUser() user: AuthContext,
    @Param('id') id: string,
    @Body() body: { content: string; kind?: string; inquiryId?: string },
  ) {
    return this.customersService.addFollowUp(user, id, body);
  }

  @Delete(':id/follow-ups/:fuId')
  @Roles('owner', 'staff')
  removeFollowUp(
    @AuthUser() user: AuthContext,
    @Param('id') id: string,
    @Param('fuId') fuId: string,
  ) {
    return this.customersService.removeFollowUp(user.tenantId, id, fuId);
  }

  @Get(':id/rules')
  @Roles('owner', 'staff')
  listRules(@AuthUser() user: AuthContext, @Param('id') id: string) {
    return this.customersService.listRules(user.tenantId, id);
  }
}
