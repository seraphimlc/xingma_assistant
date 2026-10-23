import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { AuthService, LoginResult } from '../auth/auth.service';
import { AuthContext } from '../common/interfaces/auth-context.interface';
import { CustomersService } from '../customers/customers.service';
import { TenantsService, TenantInfo, PROD_APP_ID } from '../tenants/tenants.service';
import { WechatService } from '../wechat/wechat.service';
import { InvitesService } from '../invites/invites.service';

/**
 * 登录（客户侧无 UI，分享落地静默调用；管理端首页显式调用）：
 * - 生产：AppID → 租户 → AppSecret（租户表或 WECHAT_APP_SECRET）→ jscode2session → openid
 * - 开发：DEV_FAKE_LOGIN=true 时由 code 派生稳定假 openid，可用 preferRole 指定角色
 * - openid 命中 tenant_members → owner/staff；否则作为客户，customer_profiles 自动建档
 */
@Injectable()
export class LoginService {
  private readonly logger = new Logger(LoginService.name);

  constructor(
    private readonly auth: AuthService,
    private readonly config: ConfigService,
    private readonly tenants: TenantsService,
    private readonly customers: CustomersService,
    private readonly wechat: WechatService,
    private readonly invites: InvitesService,
  ) {}

  async login(params: {
    code: string;
    appId?: string;
    tenantId?: string;
    preferRole?: 'owner' | 'staff' | 'customer';
    inviteCode?: string;
  }): Promise<LoginResult> {
    if (!params.code) throw new BadRequestException('缺少 code');
    const devFake = !!this.config.get<boolean>('wechat.devFakeLogin');
    const tenant = await this.resolveTenant(params.appId, params.tenantId, devFake);

    let openid: string;
    // 只有 dev_ 开头的 code 才走假登录；真实 wx.login 的 code 一律走微信 code2session
    const isFakeCode = devFake && params.code.startsWith('dev_');
    if (isFakeCode) {
      // 去掉时间戳尾巴，让同一角色多次登录得到同一 openid
      const seed = params.code.replace(/_\d+$/, '');
      openid = `dev_${createHash('sha1').update(`${tenant.id}:${seed}`).digest('hex').slice(0, 24)}`;
      this.logger.warn(`DEV_FAKE_LOGIN 假登录 tenant=${tenant.id} openid=${openid}`);
    } else {
      const secret = await this.tenants.getAppSecret(tenant);
      if (!secret) {
        throw new ServiceUnavailableException(
          `小程序 ${tenant.wxAppId} 未配置 AppSecret：请在服务端环境变量 WECHAT_APP_SECRET 或 tenants.wx_app_secret 中配置后重启`,
        );
      }
      const s = await this.wechat.code2Session(tenant.wxAppId, secret, params.code);
      openid = s.openid;
      // session_key 不下发、不入 JWT
    }

    let member = await this.tenants.findMember(tenant.id, openid);
    if (!member && isFakeCode && (params.preferRole === 'owner' || params.preferRole === 'staff')) {
      member = await this.tenants.ensureMember(tenant.id, openid, params.preferRole);
    }
    // 首个真实微信登录且主动选择管理端入口的人，自动成为该档口业主（之后需业主邀请）
    if (!member && !isFakeCode && params.preferRole === 'owner' && !(await this.tenants.hasRealOwner(tenant.id))) {
      member = await this.tenants.ensureMember(tenant.id, openid, 'owner');
      this.logger.log(`首位业主绑定 tenant=${tenant.id}`);
    }

    // 扫码/邀请码：绑定为业主或员工（优先于客户建档）
    if (params.inviteCode) {
      const acc = await this.invites.acceptByCode(tenant.id, openid, params.inviteCode);
      member = acc.member;
    }

    let payload: AuthContext;
    if (member) {
      payload = { tenantId: tenant.id, openid, role: member.role, memberId: member.id };
    } else {
      const base: AuthContext = { tenantId: tenant.id, openid, role: 'customer' };
      const customer = await this.customers.ensureProfile(base);
      payload = { ...base, customerId: customer.id };
    }
    const token = await this.auth.sign(payload);
    return { token, ...payload };
  }

  async getMe(user: AuthContext) {
    if (user.role === 'owner' || user.role === 'staff') {
      const nickname = await this.tenants.getMemberNickname(user.tenantId, user.openid);
      return {
        role: user.role,
        tenantId: user.tenantId,
        openid: user.openid,
        memberId: user.memberId,
        nickname: nickname || null,
        avatarUrl: null,
      };
    }
    const c = await this.customers.ensureProfile(user);
    return {
      role: user.role,
      tenantId: user.tenantId,
      openid: user.openid,
      customerId: c.id,
      nickname: c.nickname,
      avatarUrl: c.avatarUrl,
      phone: c.phone,
      levelCode: c.levelCode,
      rank: c.rank,
    };
  }

  async updateProfile(
    user: AuthContext,
    body: { nickname?: string; avatarUrl?: string; phone?: string },
  ) {
    const nickname = body.nickname != null ? String(body.nickname).trim().slice(0, 64) : undefined;
    const avatarUrl = body.avatarUrl != null ? String(body.avatarUrl).trim().slice(0, 512) : undefined;
    const phone = body.phone != null ? String(body.phone).trim().slice(0, 32) : undefined;
    if (nickname === undefined && avatarUrl === undefined && phone === undefined) {
      throw new BadRequestException('请提供 nickname、avatarUrl 或 phone');
    }
    const patch: { nickname?: string | null; avatarUrl?: string | null; phone?: string | null } = {};
    if (nickname !== undefined) patch.nickname = nickname || null;
    if (avatarUrl !== undefined) patch.avatarUrl = avatarUrl || null;
    if (phone !== undefined) patch.phone = phone || null;

    if (user.role === 'owner' || user.role === 'staff') {
      if (nickname !== undefined) {
        await this.tenants.updateMemberNickname(user.tenantId, user.openid, nickname || null);
      }
      // 分享授权同步写 customer_profiles，客户列表可见昵称/头像
      await this.customers.updateSelfProfile(
        { tenantId: user.tenantId, openid: user.openid, role: 'customer', customerId: user.customerId },
        patch,
      );
      return this.getMe(user);
    }
    await this.customers.updateSelfProfile(user, patch);
    return this.getMe(user);
  }

  private async resolveTenant(appId: string | undefined, tenantId: string | undefined, devFake: boolean): Promise<TenantInfo> {
    if (appId) return this.tenants.resolveByAppId(appId);
    // 开发态允许直接传 tenantId
    if (devFake && tenantId) {
      const t = await this.tenants.getById(tenantId);
      if (t) return t;
    }
    if (!appId && !tenantId) {
      return this.tenants.resolveByAppId(this.config.get<string>('wechat.defaultAppId') || PROD_APP_ID);
    }
    throw new UnauthorizedException('无法识别租户：请携带 X-Wx-Appid');
  }
}
