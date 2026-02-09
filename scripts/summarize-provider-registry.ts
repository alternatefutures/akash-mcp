#!/usr/bin/env npx tsx
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { defaultProviderRegistryPath, loadProviderRegistry } from '../src/utils/provider-registry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function num(x: string | undefined) {
  if (!x) return Number.POSITIVE_INFINITY;
  const n = Number(x);
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

function main() {
  const registryPath = process.argv[2] || defaultProviderRegistryPath();
  if (!fs.existsSync(registryPath)) {
    console.error(`Registry not found: ${registryPath}`);
    console.error('Run redeploy-all at least once, or pass a path as arg.');
    process.exit(1);
  }

  const reg = loadProviderRegistry(registryPath);
  const services = Object.keys(reg.services || {});
  if (services.length === 0) {
    console.log('No services in registry yet.');
    return;
  }

  for (const service of services.sort()) {
    const svc = reg.services[service];
    const rows: Array<{ provider: string; bucket: 'working' | 'failing'; ok: number; fail: number; minBid?: string; lastBid?: string }> = [];

    for (const [provider, row] of Object.entries(svc.working || {})) {
      rows.push({
        provider,
        bucket: 'working',
        ok: row.ok || 0,
        fail: row.fail || 0,
        minBid: row.minBidAmount,
        lastBid: row.lastBidAmount,
      });
    }
    for (const [provider, row] of Object.entries(svc.failing || {})) {
      rows.push({
        provider,
        bucket: 'failing',
        ok: row.ok || 0,
        fail: row.fail || 0,
        minBid: row.minBidAmount,
        lastBid: row.lastBidAmount,
      });
    }

    rows.sort((a, b) => num(a.minBid) - num(b.minBid));

    console.log(`\n=== ${service} ===`);
    const top = rows.slice(0, 15);
    for (const r of top) {
      const bid = r.minBid ?? r.lastBid ?? '?';
      console.log(`- ${r.provider}  [${r.bucket}]  ok=${r.ok} fail=${r.fail}  minBid=${bid}`);
    }
    if (rows.length > top.length) console.log(`... (${rows.length - top.length} more)`);
  }
}

main();

