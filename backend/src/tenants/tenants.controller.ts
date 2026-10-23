import { Body, Controller, Get, Headers, Param, Patch, UseGuards } from '@nestjs/common';
import { TenantsService } from './tenants.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../common/guards/roles.guard';
import { AuthUser } from '../common/decorators/auth-user.decorator';
import { AuthContext } from '../common/interfaces/auth-context.interface';

@Controller('api/tenants')
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  @Get('resolve')
  resolve(@Headers('x-wx-appid') appId: string) {
    return this.tenantsService.resolveByAppId(appId || 'wx394d23ea099d8a01');
  }

  @Get('current')
  @UseGuards(JwtAuthGuard)
  async current(@AuthUser() user: AuthContext) {
    const t = await this.tenantsService.getById(user.tenantId);
    return {
      id: t?.id,
      name: t?.name,
      contactQrUrl: t?.contactQrUrl || null,
      allowCustomerDownload: !!t?.allowCustomerDownload,
    };
  }

  @Patch('current/contact-qr')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('owner', 'staff')
  setContactQr(@AuthUser() user: AuthContext, @Body() body: { url?: string | null }) {
    return this.tenantsService.setContactQr(user.tenantId, body?.url ?? null);
  }

  @Patch('current/allow-customer-download')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('owner', 'staff')
  setAllowCustomerDownload(
    @AuthUser() user: AuthContext,
    @Body() body: { allow?: boolean; allowCustomerDownload?: boolean },
  ) {
    const allow =
      body?.allowCustomerDownload !== undefined ? !!body.allowCustomerDownload : !!body?.allow;
    return this.tenantsService.setAllowCustomerDownload(user.tenantId, allow);
  }

  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.tenantsService.getById(id);
  }
}
