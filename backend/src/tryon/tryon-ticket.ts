import { AuthContext } from '../common/interfaces/auth-context.interface';

/** 与登录 JWT 区分。AuthService.verifyToken 会拒绝这个 purpose。 */
export const TRYON_PURPOSE = 'tryon';

/** 短票：够顾客从分享卡点进 H5、必要时改用系统浏览器，但不是长期登录态。 */
export const TRYON_TICKET_TTL_SEC = 10 * 60;

export interface TryOnTicketClaims {
  purpose: typeof TRYON_PURPOSE;
  tenantId: string;
  openid: string;
  role: AuthContext['role'];
  customerId?: string;
  memberId?: string;
  productId: string;
}

export function tryOnTicketPayload(user: AuthContext, productId: string): TryOnTicketClaims {
  return {
    purpose: TRYON_PURPOSE,
    tenantId: user.tenantId,
    openid: user.openid,
    role: user.role,
    customerId: user.customerId,
    memberId: user.memberId,
    productId,
  };
}

export function readTryOnClaims(payload: unknown, productId?: string): TryOnTicketClaims | null {
  if (!payload || typeof payload !== 'object') return null;
  const row = payload as Record<string, unknown>;
  if (row.purpose !== TRYON_PURPOSE) return null;
  if (typeof row.tenantId !== 'string' || !row.tenantId) return null;
  if (typeof row.openid !== 'string' || !row.openid) return null;
  if (typeof row.productId !== 'string' || !row.productId) return null;
  if (row.role !== 'owner' && row.role !== 'staff' && row.role !== 'customer') return null;
  if (productId && row.productId !== productId) return null;
  return {
    purpose: TRYON_PURPOSE,
    tenantId: row.tenantId,
    openid: row.openid,
    role: row.role,
    customerId: typeof row.customerId === 'string' ? row.customerId : undefined,
    memberId: typeof row.memberId === 'string' ? row.memberId : undefined,
    productId: row.productId,
  };
}
