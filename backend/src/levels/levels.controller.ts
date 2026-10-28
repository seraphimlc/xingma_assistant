import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../common/guards/roles.guard';
import { AuthUser } from '../common/decorators/auth-user.decorator';
import { AuthContext } from '../common/interfaces/auth-context.interface';
import { LevelsService } from './levels.service';
import { UpsertCustomerLevelInput, UpsertProductLevelInput } from './level.types';

@Controller('api/levels')
@UseGuards(JwtAuthGuard, RolesGuard)
export class LevelsController {
  constructor(private readonly levels: LevelsService) {}

  @Get('customer')
  @Roles('owner', 'staff')
  listCustomer(@AuthUser() user: AuthContext) {
    return this.levels.listCustomerLevels(user.tenantId);
  }

  @Post('customer')
  @Roles('owner', 'staff')
  createCustomer(@AuthUser() user: AuthContext, @Body() body: UpsertCustomerLevelInput) {
    return this.levels.createCustomerLevel(user.tenantId, body, user);
  }

  @Patch('customer/:id')
  @Roles('owner', 'staff')
  updateCustomer(
    @AuthUser() user: AuthContext,
    @Param('id') id: string,
    @Body() body: Partial<UpsertCustomerLevelInput>,
  ) {
    return this.levels.updateCustomerLevel(user.tenantId, id, body, user);
  }

  @Delete('customer/:id')
  @Roles('owner', 'staff')
  deleteCustomer(@AuthUser() user: AuthContext, @Param('id') id: string) {
    return this.levels.deleteCustomerLevel(user.tenantId, id, user);
  }

  @Get('product')
  @Roles('owner', 'staff')
  listProduct(@AuthUser() user: AuthContext) {
    return this.levels.listProductLevels(user.tenantId);
  }

  @Post('product')
  @Roles('owner', 'staff')
  createProduct(@AuthUser() user: AuthContext, @Body() body: UpsertProductLevelInput) {
    return this.levels.createProductLevel(user.tenantId, body, user);
  }

  @Patch('product/:id')
  @Roles('owner', 'staff')
  updateProduct(
    @AuthUser() user: AuthContext,
    @Param('id') id: string,
    @Body() body: Partial<UpsertProductLevelInput>,
  ) {
    return this.levels.updateProductLevel(user.tenantId, id, body, user);
  }

  @Delete('product/:id')
  @Roles('owner', 'staff')
  deleteProduct(@AuthUser() user: AuthContext, @Param('id') id: string) {
    return this.levels.deleteProductLevel(user.tenantId, id, user);
  }
}
