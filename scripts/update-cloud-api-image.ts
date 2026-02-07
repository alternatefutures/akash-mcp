#!/usr/bin/env npx tsx
/**
 * Update Cloud API Manifest - Trigger container restart to pull new Docker image
 *
 * Usage:
 *   cd akash-mcp && npx tsx scripts/update-cloud-api-image.ts
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import { SDL } from '@akashnetwork/chain-sdk';

import { loadWalletAndClient } from '../src/utils/load-wallet.js';
import { loadCertificate } from '../src/utils/load-certificate.js';
import { sendManifest } from '../src/tools/send-manifest.js';
import { hasProviderServicesCli, sendManifestCli } from '../src/utils/send-manifest-cli.js';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment
config({ path: path.resolve(__dirname, '../.env') });
config({ path: path.resolve(__dirname, '../.env.deploy') });

// ─── Cloud API deployment info (from DEPLOYMENTS.md) ─────────────────────
const API_DSEQ = 25424305;
const API_PROVIDER = 'akash1v4mngfecem3xz0lqyr054na5g49andmyvnyykk';

function mustEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

function optEnv(key: string, fallback = ''): string {
  return process.env[key] || fallback;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log('========================================');
  console.log('  UPDATE CLOUD API MANIFEST');
  console.log('========================================\n');

  const ghcrPat = mustEnv('GHCR_PAT');
  const jwtSecret = mustEnv('JWT_SECRET');
  const ysqlPassword = mustEnv('YSQL_PASSWORD');
  const resendApiKey = optEnv('RESEND_API_KEY');
  const akashMnemonic = optEnv('AKASH_MNEMONIC');
  const rpcEndpoint = optEnv('RPC_ENDPOINT', 'https://rpc.akashnet.net:443');
  const grpcEndpoint = optEnv('GRPC_ENDPOINT', 'https://akash-grpc.publicnode.com:443');

  // Load the local Akash certificate and base64-encode it for the container.
  // Without this, the MCP process inside the container fails because:
  // - No cert file on disk (ephemeral container storage)
  // - Can't create a new cert (one already exists on-chain)
  // See: REDEPLOYMENT-INCIDENT-REPORT.md Phase 12
  let akashCertJson = '';
  const certPath = path.resolve(__dirname, '../.local/akash-certs');
  const certFiles = fs.existsSync(certPath)
    ? fs.readdirSync(certPath).filter(f => f.endsWith('.json'))
    : [];
  if (certFiles.length > 0) {
    const certContent = fs.readFileSync(path.join(certPath, certFiles[0]), 'utf-8');
    akashCertJson = Buffer.from(certContent).toString('base64');
    console.log(`Loaded certificate from: ${certFiles[0]} (${akashCertJson.length} chars base64)`);
  } else {
    console.warn('WARNING: No local Akash certificate found. MCP process may fail to start.');
  }

  const databaseUrl = `postgresql://alternatefutures:${ysqlPassword}@provider.europlots.com:32648/alternatefutures`;

  console.log(`API DSEQ:       ${API_DSEQ}`);
  console.log(`API Provider:   ${API_PROVIDER}`);
  console.log(`DATABASE_URL:   ${databaseUrl.substring(0, 40)}...`);
  console.log();

  // ─── Generate SDL (must match original profiles/placement/deployment) ────
  const sdlContent = `---
version: "2.0"

services:
  api:
    image: ghcr.io/alternatefutures/service-cloud-api:fix3-amd64
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
      - IPFS_GATEWAY_URL=https://ipfs.alternatefutures.ai
      - OTEL_EXPORTER_OTLP_ENDPOINT=
      - OTEL_SERVICE_NAME=alternatefutures-api
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
      pricing:
        api:
          denom: uakt
          amount: 30

deployment:
  api:
    dcloud:
      profile: api
      count: 1
`;

  console.log('Parsing SDL...');
  const sdl = SDL.fromString(sdlContent, 'beta3');
  const hash = await sdl.manifestVersion();
  console.log(`Manifest hash: ${Buffer.from(hash).toString('hex').substring(0, 16)}...`);

  // ─── Load wallet + certificate ────────────────────────────────────────────
  console.log('\nLoading wallet and certificate...');
  const { wallet, client, chainSDK } = await loadWalletAndClient();
  const accounts = await wallet.getAccounts();
  const owner = accounts[0]?.address;
  if (!owner) throw new Error('Could not determine wallet address');
  console.log(`Owner: ${owner}`);

  const certificate = await loadCertificate(wallet, client, chainSDK);
  console.log('Certificate loaded.');

  const useCli = await hasProviderServicesCli();
  console.log(useCli ? 'Using CLI for manifest.' : 'Using JS SDK for manifest.');

  // ─── Step 1: Update on-chain deployment hash ──────────────────────────────
  const manifestOnly = process.argv.includes('--manifest-only');
  if (manifestOnly) {
    console.log('\n=== Step 1: SKIPPED (--manifest-only) ===');
  } else {
    console.log('\n=== Step 1: Update on-chain deployment hash ===');
    console.log(`Updating DSEQ ${API_DSEQ} with new manifest hash...`);

    await chainSDK.akash.deployment.v1beta4.updateDeployment({
      id: { owner, dseq: BigInt(API_DSEQ) },
      hash,
    });
    console.log('On-chain deployment updated successfully.');
    console.log('Waiting 10s for chain state to settle...');
    await sleep(10_000);
  }

  // ─── Step 2: Send manifest to provider ──────────────────────────────────
  console.log('\n=== Step 2: Send manifest to provider ===');

  const leasesRes = await chainSDK.akash.market.v1beta5.getLeases({
    filters: { owner, dseq: BigInt(API_DSEQ), provider: API_PROVIDER },
  });

  const lease = leasesRes.leases?.[0]?.lease;
  if (!lease?.id) throw new Error('No active lease found for API deployment');

  const gseq = Number(lease.id.gseq || 1);
  const oseq = Number(lease.id.oseq || 1);
  console.log(`Lease: DSEQ=${API_DSEQ}, GSEQ=${gseq}, OSEQ=${oseq}`);

  if (useCli) {
    const tmpSdl = path.resolve(__dirname, '../.local/_tmp-update-api.yaml');
    fs.mkdirSync(path.dirname(tmpSdl), { recursive: true });
    fs.writeFileSync(tmpSdl, sdlContent);
    try {
      await sendManifestCli({
        sdlPath: tmpSdl,
        dseq: API_DSEQ,
        provider: API_PROVIDER,
        node: rpcEndpoint,
      });
    } finally {
      try { fs.unlinkSync(tmpSdl); } catch {}
    }
  } else {
    await sendManifest(
      sdl,
      { id: { owner, dseq: API_DSEQ, gseq, oseq, provider: API_PROVIDER } } as any,
      certificate,
      chainSDK,
    );
  }
  console.log('Manifest sent successfully!');

  console.log('\n========================================');
  console.log('  CLOUD API MANIFEST UPDATED');
  console.log('========================================');
  console.log(`\nDSEQ:     ${API_DSEQ} (unchanged)`);
  console.log(`Provider: ${API_PROVIDER} (unchanged)`);
  console.log(`\nThe container will restart with the NEW Docker image (includes akash-mcp node_modules).`);
  console.log(`Wait ~30s then test:\n  curl -sf https://api.alternatefutures.ai/health`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
