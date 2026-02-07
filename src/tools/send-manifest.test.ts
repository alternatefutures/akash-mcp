import { describe, it, expect, vi } from 'vitest';
import https from 'https';
import { EventEmitter } from 'node:events';
import { sendManifest } from './send-manifest.js';

describe('sendManifest', () => {
  it('defaults provider gateway port to 8443 when hostUri has no port', async () => {
    let seenPort: any = null;
    let seenServername: any = null;

    const requestSpy = vi.spyOn(https, 'request').mockImplementation((options: any, cb: any) => {
      seenPort = options?.port;
      seenServername = options?.agent?.options?.servername;

      const res = new EventEmitter() as any;
      res.statusCode = 200;
      cb(res);

      const req = new EventEmitter() as any;
      req.write = () => {};
      req.end = () => {
        queueMicrotask(() => res.emit('end'));
      };
      return req;
    });

    const fakeSDL = {
      manifestSortedJSON: () => '{}',
    } as any;

    const fakeChainSDK = {
      akash: {
        provider: {
          v1beta4: {
            getProvider: vi.fn().mockResolvedValue({
              provider: { hostUri: 'https://provider.example.com' },
            }),
          },
        },
      },
    } as any;

    await sendManifest(
      fakeSDL,
      { id: { owner: 'akash1owner', dseq: 123, gseq: 1, oseq: 1, provider: 'akash1provider' } } as any,
      { cert: 'DUMMY_CERT', privateKey: 'DUMMY_KEY' } as any,
      fakeChainSDK
    );

    expect(seenPort).toBe(8443);
    expect(seenServername).toBe('localhost');
    requestSpy.mockRestore();
  });
});

