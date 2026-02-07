import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { getCertificatesDir } from './load-certificate.js';

describe('load-certificate', () => {
  it('stores certificates in a local gitignored directory (not under src/)', () => {
    const dir = getCertificatesDir();
    // Security invariant: never persist private keys under source tree.
    expect(dir).toContain('.local');
    expect(dir).toContain('akash-certs');
    expect(dir.replaceAll('\\', '/')).not.toContain('/src/');
    expect(path.basename(path.resolve(dir, '..', '..'))).toBe('akash-mcp');
  });
});

