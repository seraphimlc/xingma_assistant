import { Body, Controller, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { HttpException } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { AuthUser } from '../common/decorators/auth-user.decorator';
import { AuthContext } from '../common/interfaces/auth-context.interface';
import { TryonService, clientIp } from './tryon.service';

@Controller()
export class TryonController {
  constructor(private readonly tryon: TryonService) {}

  /** 客户会话或试衣短票。只返回名称和本款颜色图，没有内部标记。 */
  @Get('api/products/:id/tryon')
  catalog(
    @Req() req: any,
    @Param('id') id: string,
    @Query('shareEventId') shareEventId?: string,
    @Query('boundCustomerId') boundCustomerId?: string,
  ) {
    return this.tryon.catalog(this.tryon.tokenFrom(req), id, { shareEventId, boundCustomerId });
  }

  /** 用当前客户会话换几分钟有效的试衣短票，供 web-view 查询串使用。 */
  @Post('api/products/:id/tryon/ticket')
  @UseGuards(JwtAuthGuard)
  ticket(
    @AuthUser() user: AuthContext,
    @Param('id') id: string,
    @Body() body: { shareEventId?: string; boundCustomerId?: string },
  ) {
    return this.tryon.issueTicket(user, id, {
      shareEventId: body?.shareEventId,
      boundCustomerId: body?.boundCustomerId,
    });
  }

  /** 短票或客户会话。只把 Decart 短时 client token 交回 H5。 */
  @Post('api/tryon/tokens')
  tokens(@Req() req: any, @Body() body: { ticket?: string; productId?: string; shareEventId?: string; boundCustomerId?: string }) {
    return this.tryon.mintToken(this.tryon.tokenFrom(req), body || {}, clientIp(req));
  }

  /** 同源拉成衣图，避免浏览器直连 OSS 被 CORS 拦住。 */
  @Get('api/tryon/garment')
  async garment(
    @Req() req: any,
    @Query('productId') productId: string,
    @Query('colorId') colorId: string,
    @Query('shareEventId') shareEventId: string | undefined,
    @Query('boundCustomerId') boundCustomerId: string | undefined,
    @Res() res: Response,
  ) {
    try {
      const file = await this.tryon.readGarment(this.tryon.tokenFrom(req), productId, colorId, {
        shareEventId,
        boundCustomerId,
      });
      res.status(200);
      res.setHeader('Content-Type', file.mime);
      res.setHeader('Content-Length', String(file.data.length));
      res.setHeader('Cache-Control', 'private, max-age=120');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.end(file.data);
    } catch (e: any) {
      if (res.headersSent) return;
      const status = e instanceof HttpException ? e.getStatus() : 500;
      const payload = e instanceof HttpException ? e.getResponse() : null;
      const raw = typeof payload === 'string' ? payload : (payload as any)?.message || '试衣暂时连不上，请稍后再试';
      const message = Array.isArray(raw) ? raw.join('；') : String(raw);
      const safe = /DECART|API_KEY|dct_/i.test(message) ? '试衣暂时连不上，请稍后再试' : message.slice(0, 80);
      res.status(status).json({ statusCode: status, message: safe });
    }
  }
}
