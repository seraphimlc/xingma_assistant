import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthContext } from '../common/interfaces/auth-context.interface';

export interface LoginResult {
  token: string;
  role: AuthContext['role'];
  tenantId: string;
  openid: string;
  memberId?: string;
  customerId?: string;
}

/** JWT 签发与校验（登录流程见 login/login.service.ts） */
@Injectable()
export class AuthService {
  constructor(private readonly jwt: JwtService) {}

  async sign(payload: AuthContext): Promise<string> {
    return this.jwt.signAsync({ ...payload });
  }

  verifyToken(token: string): AuthContext | null {
    try {
      const payload = this.jwt.verify(token) as AuthContext & { purpose?: string };
      // 试衣短票与登录 JWT 同密钥签发，但只能用于试衣接口，不能当客户会话。
      if (!payload || payload.purpose === 'tryon') return null;
      return payload;
    } catch {
      return null;
    }
  }

  /** 签发/校验带自定义过期时间的 JWT（试衣短票）。调用方自行限制 purpose。 */
  signRaw(payload: Record<string, unknown>, expiresInSec: number): Promise<string> {
    return this.jwt.signAsync(payload, { expiresIn: expiresInSec });
  }

  decodeVerified(token: string): Record<string, unknown> | null {
    try {
      return this.jwt.verify(token) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}
