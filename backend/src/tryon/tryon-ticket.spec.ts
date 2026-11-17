import { JwtService } from '@nestjs/jwt';
import { AuthService } from '../auth/auth.service';
import { TRYON_TICKET_TTL_SEC, readTryOnClaims, tryOnTicketPayload } from './tryon-ticket';

describe('try-on ticket', () => {
  const jwt = new JwtService({ secret: 'test-secret' });
  const auth = new AuthService(jwt);

  it('rejects a try-on ticket as a customer session and keeps it bound to one product', async () => {
    const payload = tryOnTicketPayload(
      { tenantId: 't1', openid: 'o1', role: 'customer', customerId: 'c1' },
      'prod-1',
    );
    const ticket = await auth.signRaw(payload as unknown as Record<string, unknown>, TRYON_TICKET_TTL_SEC);
    expect(auth.verifyToken(ticket)).toBeNull();
    const claims = readTryOnClaims(auth.decodeVerified(ticket), 'prod-1');
    expect(claims?.productId).toBe('prod-1');
    expect(claims?.openid).toBe('o1');
    expect(readTryOnClaims(auth.decodeVerified(ticket), 'other-product')).toBeNull();
  });

  it('still accepts a normal login token', async () => {
    const token = await jwt.signAsync({ tenantId: 't1', openid: 'o1', role: 'customer' });
    expect(auth.verifyToken(token)?.openid).toBe('o1');
    expect(readTryOnClaims(auth.decodeVerified(token))).toBeNull();
  });
});
