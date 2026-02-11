#!/usr/bin/env npx tsx
/**
 * Redeploy API Service to a new provider
 *
 * The current provider (lem0n.cc) has broken wildcard DNS.
 * This script closes the old deployment and creates a new one on a different provider.
 *
 * Usage:
 *   cd akash-mcp && npx tsx scripts/redeploy-api.ts
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import { SDL } from '@akashnetwork/chain-sdk';

import { loadWalletAndClient } from '../src/utils/load-wallet.js';
import { loadCertificate } from '../src/utils/load-certificate.js';
import { sendManifest } from '../src/tools/send-manifest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, '../.env') });
config({ path: path.resolve(__dirname, '../.env.deploy') });

// ─── Current deployment info ────────────────────────────────────────────────
const OLD_DSEQ = 25474472;

// ─── Providers to exclude ───────────────────────────────────────────────────
const EXCLUDE_PROVIDERS = new Set([
  'akash1q4nsecnmxh9rmdyvlfx3nt654nkgp628yuy8sg',  // lem0n.cc - broken DNS
  'akash18ga02jzaq8cw52anyhzkwta5wygufgu6zsz6xc',  // europlots - has DB
  'akash1k94uya5rhrtj9rfw850az9aq2d6vdpjmtnlgd0',  // boogle - has data services
  'akash1xmjzu9dczlg9fa4v3pfvwzn7ty89r003laj4ac',  // tagus - has auth
  'akash1zlsep362zz46qlwzttm06t8lv9qtg8gtaya97u',  // america.computer - has proxy
  'akash1smapjx8m8363nmdvc2yr9atlqy8vcql73m9l0v',  // broken hostname
  'akash1pnae60m3nnnq89437kg892k50wjqx90zcysgzv',  // controller stuck
  'akash1rr5pzy4kz2wwwtntt5vz4as0afw0ljrfmhty8q',  // no named storage
  'akash1vg3gk6dynh9ys45tzjyedp0dl52s93kap75x3n',  // loses lease
  'akash1tweev0k42guyv3a2jtgphmgfrl2h5y2884vh9d',  // lease not found
  'akash1sjwuwre4qprcaa34f6324yz7m8nn0awvc75gp5',  // lease not found
]);

function mustEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing: ${key}`);
  return val;
}

function optEnv(key: string, fallback = ''): string {
  return process.env[key] || fallback;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function queryLeaseStatus(providerHostUri: string, dseq: number, gseq: number, oseq: number, certificate: any): Promise<any> {
  const uri = new URL(providerHostUri);
  const agent = new https.Agent({ cert: certificate.cert, key: certificate.privateKey, rejectUnauthorized: false, servername: 'localhost' });
  return new Promise<any>((resolve, reject) => {
    const req = https.request({
      hostname: uri.hostname,
      port: uri.port ? parseInt(uri.port) : 8443,
      path: `/lease/${dseq}/${gseq}/${oseq}/status`,
      method: 'GET',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      agent,
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function main() {
  console.log('========================================');
  console.log('  REDEPLOY API SERVICE');
  console.log('========================================\n');

  const ghcrPat = mustEnv('GHCR_PAT');
  const jwtSecret = mustEnv('JWT_SECRET');
  const databaseUrl = mustEnv('DATABASE_URL');
  const resendApiKey = optEnv('RESEND_API_KEY');
  const ipfsApiUrl = mustEnv('IPFS_API_URL');
  const otelEndpoint = optEnv('OTEL_EXPORTER_OTLP_ENDPOINT', '');
  const akashMnemonic = optEnv('AKASH_MNEMONIC');
  const rpcEndpoint = optEnv('RPC_ENDPOINT', 'https://rpc.akashnet.net:443');
  const grpcEndpoint = optEnv('GRPC_ENDPOINT', 'https://akash-grpc.publicnode.com:443');

  // Load Akash cert for MCP (same as update-cloud-api-image.ts)
  let akashCertJson = '';
  const certPath = path.resolve(__dirname, '../.local/akash-certs');
  const certFiles = fs.existsSync(certPath)
    ? fs.readdirSync(certPath).filter((f: string) => f.endsWith('.json'))
    : [];
  if (certFiles.length > 0) {
    const certContent = fs.readFileSync(path.join(certPath, certFiles[0]), 'utf-8');
    akashCertJson = Buffer.from(certContent).toString('base64');
  }

  // ─── Generate SDL ──────────────────────────────────────────────────────────
  const sdlContent = `---
version: "2.0"

services:
  api:
    image: ghcr.io/alternatefutures/service-cloud-api:latest
    credentials:
      host: ghcr.io
      username: alternatefutures
      password: ${ghcrPat}
    env:
      - DATABASE_URL=${databaseUrl}
      - NODE_ENV=production
      - PORT=4000
      - JWT_SECRET=${jwtSecret}
      - AUTH_SERVICE_URL=https://auth.alternatefutures.ai
      - RESEND_API_KEY=${resendApiKey}
      - AKASH_MNEMONIC=${akashMnemonic}
      - RPC_ENDPOINT=${rpcEndpoint}
      - GRPC_ENDPOINT=${grpcEndpoint}
      - AKASH_MCP_PATH=/app/akash-mcp/dist/index.js
      - AKASH_CERT_JSON=${akashCertJson}
      - IPFS_API_URL=${ipfsApiUrl}
      - IPFS_GATEWAY_URL=https://ipfs.alternatefutures.ai
      - ARWEAVE_WALLET=
      - FILECOIN_RPC_URL=https://api.node.glif.io/rpc/v0
      - FILECOIN_WALLET_KEY=
      - OTEL_EXPORTER_OTLP_ENDPOINT=${otelEndpoint}
      - OTEL_SERVICE_NAME=alternatefutures-api
      - OTEL_TRACES_SAMPLER=always_on
      - OTEL_METRICS_EXPORTER=otlp
      - OTEL_LOGS_EXPORTER=otlp
      - SENTRY_DSN=
    expose:
      - port: 4000
        as: 80
        to:
          - global: true
        accept:
          - api.alternatefutures.ai

profiles:
  compute:
    api:
      resources:
        cpu:
          units: 1.0
        memory:
          size: 1Gi
        storage:
          size: 512Mi

  placement:
    dcloud:
      attributes:
        host: akash
      signedBy:
        anyOf:
          - "akash1365yvmc4s7awdyj3n2sav7xfx76adc6dnmlx63"
      pricing:
        api:
          denom: uakt
          amount: 100

deployment:
  api:
    dcloud:
      profile: api
      count: 1
`;

  console.log('Parsing SDL...');
  const sdl = SDL.fromString(sdlContent, 'beta3');
  const groups = sdl.groups();
  const hash = await sdl.manifestVersion();

  // ─── Load wallet + certificate ──────────────────────────────────────────
  console.log('Loading wallet...');
  const { wallet, client, chainSDK } = await loadWalletAndClient();
  const accounts = await wallet.getAccounts();
  const owner = accounts[0]?.address;
  if (!owner) throw new Error('No wallet');
  console.log(`Owner: ${owner}`);
  const certificate = await loadCertificate(wallet, client, chainSDK);
  console.log('Certificate loaded.\n');

  // ─── Step 1: Close old deployment ──────────────────────────────────────
  console.log('=== Step 1: Close old API deployment ===');
  try {
    await chainSDK.akash.deployment.v1beta4.closeDeployment({
      id: { owner, dseq: BigInt(OLD_DSEQ) },
    });
    console.log(`Closed DSEQ ${OLD_DSEQ}`);
  } catch (e: any) {
    console.log(`Warning closing old deployment: ${e.message}`);
  }
  await sleep(5000);

  // ─── Step 2: Create new deployment ──────────────────────────────────────
  console.log('\n=== Step 2: Create new deployment ===');
  const statusResponse = await chainSDK.cosmos.base.tendermint.v1beta1.getLatestBlock({});
  const dseq = Number(statusResponse.block?.header?.height || 0);
  if (!dseq) throw new Error('Could not get block height');

  console.log(`New DSEQ: ${dseq}`);
  await chainSDK.akash.deployment.v1beta4.createDeployment({
    id: { owner, dseq: BigInt(dseq) },
    groups,
    hash,
    deposit: { amount: { denom: 'uakt', amount: '5000000' }, sources: [1] },
  });
  console.log('Deployment created.');

  // ─── Step 3: Wait for bids ──────────────────────────────────────────────
  console.log('\n=== Step 3: Wait for bids (30s) ===');
  await sleep(30000);

  const bidsResponse = await chainSDK.akash.market.v1beta5.getBids({
    filters: { owner, dseq: BigInt(dseq) },
  });

  const bids = bidsResponse.bids || [];
  console.log(`Received ${bids.length} bid(s)`);

  const usableBids = bids.filter((b: any) => {
    const p = b.bid?.id?.provider;
    return p && !EXCLUDE_PROVIDERS.has(p);
  });

  if (usableBids.length === 0) {
    const all = bids.map((b: any) => b.bid?.id?.provider).filter(Boolean);
    console.error(`No usable bids! All providers: ${all.join(', ')}`);
    console.error(`Excluded: ${Array.from(EXCLUDE_PROVIDERS).join(', ')}`);
    throw new Error('No usable bids after exclusions');
  }

  console.log(`Usable bids: ${usableBids.length}`);
  usableBids.forEach((b: any) => console.log(`  - ${b.bid?.id?.provider}`));

  const selected = usableBids[0];
  const bidId = selected.bid.id;
  const provider = bidId.provider;
  const gseq = Number(bidId.gseq || 1);
  const oseq = Number(bidId.oseq || 1);
  console.log(`\nSelected provider: ${provider}`);

  // ─── Step 4: Create lease ──────────────────────────────────────────────
  console.log('\n=== Step 4: Create lease ===');
  await chainSDK.akash.market.v1beta5.createLease({
    bidId: { owner, dseq: BigInt(dseq), gseq, oseq, provider, bseq: Number(bidId.bseq || 0) },
  });
  console.log('Lease created.');
  await sleep(10000);

  // ─── Step 5: Send manifest ──────────────────────────────────────────────
  console.log('\n=== Step 5: Send manifest ===');
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await sendManifest(sdl, { id: { owner, dseq, gseq, oseq, provider } } as any, certificate, chainSDK);
      console.log('Manifest sent.');
      break;
    } catch (e: any) {
      console.log(`Attempt ${attempt}/3 failed: ${e.message}`);
      if (attempt === 3) throw e;
      await sleep(10000);
    }
  }

  // ─── Step 6: Wait for service ──────────────────────────────────────────
  console.log('\n=== Step 6: Wait for service to be ready ===');
  const providerRes = await chainSDK.akash.provider.v1beta4.getProvider({ owner: provider });
  const providerHostUri = providerRes.provider?.hostUri;
  if (!providerHostUri) throw new Error('No provider host URI');

  let ingressUrl = '';
  for (let i = 1; i <= 20; i++) {
    await sleep(10000);
    try {
      const status = await queryLeaseStatus(providerHostUri, dseq, gseq, oseq, certificate);
      const svc = status?.services?.api;
      const ready = svc?.ready_replicas || 0;
      const available = svc?.available_replicas || 0;
      const uris = svc?.uris || [];
      console.log(`  Attempt ${i}/20: ready=${ready}, available=${available}, uris=${uris.join(',')}`);

      if ((ready > 0 || available > 0) && uris.length > 0) {
        // Find the ingress URL (not the custom domain)
        ingressUrl = uris.find((u: string) => u.includes('ingress')) || uris[0];
        console.log(`\nService ready! Ingress: ${ingressUrl}`);
        break;
      }
    } catch (e: any) {
      console.log(`  Attempt ${i}/20: ${e.message}`);
    }
  }

  if (!ingressUrl) throw new Error('Timed out waiting for API service');

  // ─── Done ──────────────────────────────────────────────────────────────
  console.log('\n========================================');
  console.log('  API SERVICE REDEPLOYED');
  console.log('========================================');
  console.log(`\nNew DSEQ:    ${dseq}`);
  console.log(`Provider:    ${provider}`);
  console.log(`Ingress:     ${ingressUrl}`);
  console.log(`\nNEXT STEPS:`);
  console.log(`1. Update pingap.toml upstream "api" addrs to: ["${ingressUrl}:80"]`);
  console.log(`2. Update pingap.toml proxy_set_headers Host for api location`);
  console.log(`3. Rebuild and push proxy image, then update proxy manifest`);
  console.log(`4. Update DEPLOYMENTS.md and service-cloud-api update-manifest.yml`);
}

main().catch((e) => {
  console.error('\nFATAL:', e?.message || e);
  process.exit(1);
});
