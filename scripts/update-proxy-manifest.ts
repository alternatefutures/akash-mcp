#!/usr/bin/env npx tsx
/**
 * Update SSL Proxy Manifest - Force provider to pull latest Docker image
 *
 * After CI builds and pushes a new ghcr.io/alternatefutures/infrastructure-proxy-pingap:main
 * image, this script updates the on-chain deployment and sends the manifest to
 * trigger the provider to repull the image.
 *
 * Usage:
 *   cd akash-mcp && npx tsx scripts/update-proxy-manifest.ts
 *   cd akash-mcp && npx tsx scripts/update-proxy-manifest.ts --manifest-only
 *
 * Required:
 *   - akash-mcp/.env (AKASH_MNEMONIC)
 *   - infrastructure-proxy/certs/origin.crt + origin.key
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import { SDL } from '@akashnetwork/chain-sdk';

import { loadWalletAndClient } from '../src/utils/load-wallet.js';
import { loadCertificate } from '../src/utils/load-certificate.js';
import { sendManifest } from '../src/tools/send-manifest.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');

// Load environment
config({ path: path.resolve(__dirname, '../.env') });
config({ path: path.resolve(__dirname, '../.env.deploy') });

// ─── Proxy deployment info (do not hardcode; pass in) ────────────────────────
const PROXY_DSEQ = Number(process.env.PROXY_DSEQ || '');
const PROXY_PROVIDER = process.env.PROXY_PROVIDER || '';

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function toPipedPem(pem: string): string {
  return pem
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n/g, '|')
    .replace(/\|+$/g, '')
    .replace(/^\|+/g, '');
}

async function main() {
  console.log('========================================');
  console.log('  UPDATE SSL PROXY MANIFEST');
  console.log('========================================\n');

  if (!PROXY_DSEQ || !Number.isFinite(PROXY_DSEQ) || !PROXY_PROVIDER) {
    throw new Error(
      'Missing PROXY_DSEQ / PROXY_PROVIDER. Set them in the environment (see repo-root `.github/DEPLOYMENTS.md`).'
    );
  }

  // Read TLS certificates
  const certFile = path.join(ROOT, 'infrastructure-proxy/certs/origin.crt');
  const keyFile = path.join(ROOT, 'infrastructure-proxy/certs/origin.key');

  if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
    throw new Error(`Missing TLS certificate files: ${certFile} or ${keyFile}`);
  }

  const originCert = fs.readFileSync(certFile, 'utf8');
  const originKey = fs.readFileSync(keyFile, 'utf8');

  const ghcrPat = process.env.GHCR_PAT || '';
  if (!ghcrPat) console.warn('WARNING: GHCR_PAT not set — image pull may fail if private');
  const proxyImage = process.env.PROXY_IMAGE || 'ghcr.io/alternatefutures/infrastructure-proxy-pingap:main';

  console.log(`Proxy DSEQ:     ${PROXY_DSEQ}`);
  console.log(`Proxy Provider: ${PROXY_PROVIDER}`);
  console.log(`Proxy Image:    ${proxyImage}`);
  console.log(`TLS Cert:       ${certFile} (${originCert.split('\n').length} lines)`);
  console.log();

  // ─── Generate SDL ──────────────────────────────────────────────────────────
  const pipedCert = toPipedPem(originCert);
  const pipedKey = toPipedPem(originKey);

  const sdlContent = `---
version: "2.0"

endpoints:
  proxy-ip:
    kind: ip

services:
  ssl-proxy:
    image: ${proxyImage}
    credentials:
      host: ghcr.io
      username: alternatefutures
      password: ${ghcrPat}
    expose:
      - port: 443
        as: 443
        to:
          - global: true
            ip: proxy-ip
      - port: 80
        as: 80
        to:
          - global: true
            ip: proxy-ip
      - port: 8080
        as: 8080
        to:
          - global: true
    env:
      - PINGAP_TLS_CERT=${pipedCert}
      - PINGAP_TLS_KEY=${pipedKey}
      - FORCE_RESTART=${Date.now()}

profiles:
  compute:
    ssl-proxy:
      resources:
        cpu:
          units: 1
        memory:
          size: 512Mi
        storage:
          - size: 512Mi

  placement:
    dcloud:
      attributes:
        host: akash
      signedBy:
        anyOf:
          - akash1365yvmc4s7awdyj3n2sav7xfx76adc6dnmlx63
          - akash18qa2a2ltfyvkyj0ggj3hkvuj6twzyumuaru9s4
      pricing:
        ssl-proxy:
          denom: uakt
          amount: 10000

deployment:
  ssl-proxy:
    dcloud:
      profile: ssl-proxy
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

  // ─── Step 1: Update on-chain deployment ──────────────────────────────────
  const manifestOnly = process.argv.includes('--manifest-only');

  if (manifestOnly) {
    console.log('\n=== Step 1: SKIPPED (--manifest-only) ===');
  } else {
    console.log('\n=== Step 1: Update on-chain deployment hash ===');
    console.log(`Updating DSEQ ${PROXY_DSEQ} with new manifest hash...`);

    try {
      await chainSDK.akash.deployment.v1beta4.updateDeployment({
        id: {
          owner,
          dseq: BigInt(PROXY_DSEQ),
        },
        hash,
      });
      console.log('On-chain deployment updated successfully.');
    } catch (error: any) {
      // If the hash is the same, the provider may still need a manifest resend
      if (error.message?.includes('deployment version not updated')) {
        console.log('Deployment hash unchanged (same SDL). Proceeding to manifest send...');
      } else {
        console.error('Failed to update deployment:', error.message);
        throw error;
      }
    }

    console.log('Waiting 10s for chain state to settle...');
    await sleep(10_000);
  }

  // ─── Step 2: Send manifest to provider ──────────────────────────────────
  console.log('\n=== Step 2: Send manifest to provider ===');

  const leasesRes = await chainSDK.akash.market.v1beta5.getLeases({
    filters: { owner, dseq: BigInt(PROXY_DSEQ), provider: PROXY_PROVIDER },
  });

  const lease = leasesRes.leases?.[0]?.lease;
  if (!lease?.id) throw new Error('No active lease found for proxy deployment');

  const gseq = Number(lease.id.gseq || 1);
  const oseq = Number(lease.id.oseq || 1);
  console.log(`Lease: DSEQ=${PROXY_DSEQ}, GSEQ=${gseq}, OSEQ=${oseq}`);

  // Use JS SDK directly (CLI has macOS TLS issues)
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await sendManifest(
        sdl,
        { id: { owner, dseq: PROXY_DSEQ, gseq, oseq, provider: PROXY_PROVIDER } } as any,
        certificate,
        chainSDK
      );
      console.log('Manifest sent successfully!');
      break;
    } catch (e: any) {
      console.log(`Manifest send attempt ${attempt}/3 failed: ${e.message}`);
      if (attempt === 3) throw e;
      console.log('Retrying in 10s...');
      await sleep(10_000);
    }
  }

  // ─── Done ────────────────────────────────────────────────────────────────
  console.log('\n========================================');
  console.log('  SSL PROXY MANIFEST UPDATED');
  console.log('========================================');
  console.log(`\nDSEQ:     ${PROXY_DSEQ} (unchanged)`);
  console.log(`Provider: ${PROXY_PROVIDER} (unchanged)`);
  console.log(`\nThe container will restart and pull the configured proxy image tag.`);
  console.log(`Wait ~60s for the proxy to become healthy, then test:`);
  console.log(`  curl -sf https://auth.alternatefutures.ai/health`);
}

main().catch((e) => {
  console.error('\nFATAL ERROR:', e?.message || e);
  process.exit(1);
});
