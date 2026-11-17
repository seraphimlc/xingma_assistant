import { ServiceUnavailableException } from '@nestjs/common';
import { DecartTokenClient } from './decart-token.client';

describe('DecartTokenClient', () => {
  const prevKey = process.env.DECART_API_KEY;
  const prevFile = process.env.DECART_API_KEY_FILE;
  const prevBase = process.env.DECART_API_BASE;

  afterEach(() => {
    process.env.DECART_API_KEY = prevKey;
    process.env.DECART_API_KEY_FILE = prevFile;
    process.env.DECART_API_BASE = prevBase;
    jest.restoreAllMocks();
  });

  it('says the service is unavailable without naming the key when it is missing', async () => {
    process.env.DECART_API_KEY = '';
    process.env.DECART_API_KEY_FILE = '/tmp/xingma-no-such-decart-key';
    const client = new DecartTokenClient();
    await expect(client.mintClientToken()).rejects.toBeInstanceOf(ServiceUnavailableException);
    try {
      await client.mintClientToken();
    } catch (e: any) {
      const msg = String(e.message || '');
      expect(msg).toContain('试衣');
      expect(msg).not.toMatch(/DECART|API_KEY|dct_|x-api-key/i);
    }
  });

  it('returns only the client token and expiry', async () => {
    process.env.DECART_API_KEY = 'test-server-key';
    process.env.DECART_API_BASE = 'https://api.decart.ai';
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        apiKey: 'client-token-abc',
        expiresAt: '2026-01-01T00:01:00.000Z',
        permissions: { secret: 'nope' },
      }),
    });
    (global as any).fetch = fetchMock;
    const client = new DecartTokenClient();
    const result = await client.mintClientToken();
    expect(result).toEqual({ token: 'client-token-abc', expiresAt: '2026-01-01T00:01:00.000Z' });
    expect(Object.keys(result).sort()).toEqual(['expiresAt', 'token']);
    expect(JSON.stringify(result)).not.toContain('test-server-key');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.decart.ai/v1/client/tokens');
    expect(init.headers['x-api-key']).toBe('test-server-key');
    expect(JSON.parse(init.body).allowedModels).toEqual(['lucy-vton-latest']);
  });
});
