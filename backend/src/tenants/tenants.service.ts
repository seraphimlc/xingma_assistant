import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { Tenant } from '../common/entities/tenant.entity';
import { TenantMember } from '../common/entities/tenant-member.entity';

export interface TenantInfo {
  id: string;
  name: string;
  wxAppId: string;
  contactQrUrl?: string | null;
  allowCustomerDownload?: boolean;
}

/** 生产档口（星马）默认租户：id 与 migrations/003_seed_default_tenant.sql 一致 */
export const DEFAULT_TENANT_ID = 'tenant_dev_001';
export const PROD_APP_ID = 'wx394d23ea099d8a01';

export interface MemberRec {
  id: string;
  tenantId: string;
  openid: string;
  role: 'owner' | 'staff';
}

/**
 * 租户服务：AppID → tenantId；AppSecret 读取；成员（业主/员工）查询。
 * DB_ENABLED=true 时读 tenants / tenant_members 表，否则走内存。
 */
@Injectable()
export class TenantsService {
  private readonly memTenants: TenantInfo[] = [
    { id: DEFAULT_TENANT_ID, name: '星马羊毛衫档口', wxAppId: PROD_APP_ID, allowCustomerDownload: false },
  ];
  private readonly memMembers = new Map<string, MemberRec>();

  constructor(
    private readonly config: ConfigService,
    @Optional() private readonly ds?: DataSource,
  ) {
    // 兼容旧的开发占位 AppID
    this.memTenants.push({ id: DEFAULT_TENANT_ID, name: '星马羊毛衫档口', wxAppId: 'wx_dev_appid_placeholder', allowCustomerDownload: false });
  }

  private get db(): DataSource | null {
    return process.env.DB_ENABLED === 'true' && this.ds ? this.ds : null;
  }

  async resolveByAppId(appId: string): Promise<TenantInfo> {
    if (this.db) {
      const t = await this.db.getRepository(Tenant).findOne({ where: { wxAppId: appId } });
      if (t && t.status === 'active') {
        return {
          id: t.id,
          name: t.name,
          wxAppId: t.wxAppId,
          contactQrUrl: (t as any).contactQrUrl || null,
          allowCustomerDownload: !!(t as any).allowCustomerDownload,
        };
      }
    } else {
      const t = this.memTenants.find((x) => x.wxAppId === appId);
      if (t) return t;
    }
    throw new NotFoundException(`未注册的小程序 AppID: ${appId}`);
  }

  async getById(tenantId: string): Promise<TenantInfo | null> {
    if (this.db) {
      const t = await this.db.getRepository(Tenant).findOne({ where: { id: tenantId } });
      return t
        ? {
            id: t.id,
            name: t.name,
            wxAppId: t.wxAppId,
            contactQrUrl: (t as any).contactQrUrl || null,
            allowCustomerDownload: !!(t as any).allowCustomerDownload,
          }
        : null;
    }
    return this.memTenants.find((x) => x.id === tenantId) || null;
  }

  /** AppSecret：优先租户表 wx_app_secret，其次环境变量 WECHAT_APP_SECRET（仅当 AppID 为默认 AppID） */
  async getAppSecret(tenant: TenantInfo): Promise<string> {
    if (this.db) {
      const row = await this.db
        .getRepository(Tenant)
        .createQueryBuilder('t')
        .addSelect('t.wxAppSecret')
        .where('t.id = :id', { id: tenant.id })
        .getOne();
      if (row?.wxAppSecret) return row.wxAppSecret;
    }
    const defAppId = this.config.get<string>('wechat.defaultAppId') || PROD_APP_ID;
    if (tenant.wxAppId === defAppId) {
      return this.config.get<string>('wechat.defaultAppSecret') || '';
    }
    return '';
  }

  async findMember(tenantId: string, openid: string): Promise<MemberRec | null> {
    if (this.db) {
      const m = await this.db
        .getRepository(TenantMember)
        .findOne({ where: { tenantId, openid, status: 'active' } });
      return m ? { id: m.id, tenantId: m.tenantId, openid: m.openid, role: m.role as MemberRec['role'] } : null;
    }
    return this.memMembers.get(`${tenantId}:${openid}`) || null;
  }

  /** 租户是否已有真实（非 dev_ 假）业主 */
  async hasRealOwner(tenantId: string): Promise<boolean> {
    if (this.db) {
      const list = await this.db.getRepository(TenantMember).find({ where: { tenantId, role: 'owner', status: 'active' } });
      return list.some((m) => !String(m.openid).startsWith('dev_'));
    }
    for (const m of this.memMembers.values()) {
      if (m.tenantId === tenantId && m.role === 'owner' && !m.openid.startsWith('dev_')) return true;
    }
    return false;
  }

  /** 仅开发假登录 / 后台邀请使用：确保成员存在 */
  async ensureMember(tenantId: string, openid: string, role: 'owner' | 'staff'): Promise<MemberRec> {
    const exist = await this.findMember(tenantId, openid);
    if (exist) {
      // 邀请为业主时可升级；已是业主保持不变
      if (role === 'owner' && exist.role !== 'owner') {
        if (this.db) {
          await this.db.getRepository(TenantMember).update({ id: exist.id }, { role: 'owner' });
        } else {
          exist.role = 'owner';
          this.memMembers.set(`${tenantId}:${openid}`, exist);
        }
        return { ...exist, role: 'owner' };
      }
      return exist;
    }
    if (this.db) {
      const repo = this.db.getRepository(TenantMember);
      const m = await repo.save(repo.create({ tenantId, openid, role, status: 'active', unionId: null, nickname: null }));
      return { id: m.id, tenantId, openid, role };
    }
    const rec: MemberRec = { id: `mem_${openid.slice(-16)}`, tenantId, openid, role };
    this.memMembers.set(`${tenantId}:${openid}`, rec);
    return rec;
  }

  async getMemberNickname(tenantId: string, openid: string): Promise<string | null> {
    if (this.db) {
      const m = await this.db.getRepository(TenantMember).findOne({ where: { tenantId, openid } });
      return m?.nickname || null;
    }
    return null;
  }

  async updateMemberNickname(tenantId: string, openid: string, nickname: string | null) {
    if (this.db) {
      await this.db.getRepository(TenantMember).update({ tenantId, openid }, { nickname });
    }
    return { ok: true };
  }


  async listMembers(tenantId: string): Promise<Array<{ id: string; openid: string; role: string; nickname: string | null; status: string; createdAt?: Date }>> {
    if (this.db) {
      const rows = await this.db.getRepository(TenantMember).find({
        where: { tenantId, status: 'active' },
        order: { createdAt: 'ASC' },
      });
      return rows.map((m) => ({
        id: m.id,
        openid: m.openid,
        role: m.role,
        nickname: m.nickname,
        status: m.status,
        createdAt: m.createdAt,
      }));
    }
    return [...this.memMembers.values()]
      .filter((m) => m.tenantId === tenantId)
      .map((m) => ({ id: m.id, openid: m.openid, role: m.role, nickname: null, status: 'active' }));
  }

  async getContactQr(tenantId: string): Promise<string | null> {
    const info = await this.getById(tenantId);
    return info?.contactQrUrl || null;
  }

  async setContactQr(tenantId: string, url: string | null) {
    if (this.db) {
      const repo = this.db.getRepository(Tenant);
      const row = await repo.findOne({ where: { id: tenantId } });
      if (!row) throw new NotFoundException('租户不存在');
      row.contactQrUrl = url;
      await repo.save(row);
      return { contactQrUrl: row.contactQrUrl };
    }
    const mem = this.memTenants.find((x) => x.id === tenantId);
    if (!mem) throw new NotFoundException('租户不存在');
    mem.contactQrUrl = url;
    return { contactQrUrl: mem.contactQrUrl };
  }

  async setAllowCustomerDownload(tenantId: string, allow: boolean) {
    const value = !!allow;
    if (this.db) {
      const repo = this.db.getRepository(Tenant);
      const row = await repo.findOne({ where: { id: tenantId } });
      if (!row) throw new NotFoundException('租户不存在');
      (row as any).allowCustomerDownload = value;
      await repo.save(row);
      return { allowCustomerDownload: value };
    }
    const mem = this.memTenants.find((x) => x.id === tenantId);
    if (!mem) throw new NotFoundException('租户不存在');
    mem.allowCustomerDownload = value;
    return { allowCustomerDownload: value };
  }
}
