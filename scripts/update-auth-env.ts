#!/usr/bin/env npx tsx
/**
 * Update Auth Service Manifest - Inject RESEND_API_KEY (and refresh all env vars)
 *
 * This performs an in-place manifest update on the EXISTING auth deployment:
 *   1. Updates the on-chain deployment hash (same compute/placement, new env vars)
 *   2. Sends the new manifest to the provider
 *
 * The deployment keeps its DSEQ and ingress URL — no DNS changes required.
 *
 * Usage:
 *   cd akash-mcp && npx tsx scripts/update-auth-env.ts
 *
 * Required:
 *   - akash-mcp/.env       (AKASH_MNEMONIC)
 *   - akash-mcp/.env.deploy (GHCR_PAT, JWT_SECRET, DATABASE_URL, RESEND_API_KEY, STRIPE_SECRET_KEY)
 *   - AUTH_DSEQ + AUTH_PROVIDER (set via env or inline before running; see repo-root `DEPLOYMENTS.md`)
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

// ─── Auth deployment info (do not hardcode; pass in) ─────────────────────────
const AUTH_DSEQ = Number(process.env.AUTH_DSEQ || '');
const AUTH_PROVIDER = process.env.AUTH_PROVIDER || '';

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
  console.log('  UPDATE AUTH SERVICE MANIFEST');
  console.log('========================================\n');

  if (!AUTH_DSEQ || !Number.isFinite(AUTH_DSEQ) || !AUTH_PROVIDER) {
    throw new Error(
      'Missing AUTH_DSEQ / AUTH_PROVIDER. Set them in the environment (see repo-root `DEPLOYMENTS.md`).'
    );
  }

  // Validate env vars
  const ghcrPat = mustEnv('GHCR_PAT');
  const jwtSecret = mustEnv('JWT_SECRET');
  const databaseUrl = mustEnv('DATABASE_URL');
  const resendApiKey = mustEnv('RESEND_API_KEY');
  const stripeSecretKey = optEnv('STRIPE_SECRET_KEY');
  const openaiApiKey = optEnv('OPENAI_API_KEY');
  const jwtRefreshSecret = optEnv('JWT_REFRESH_SECRET', jwtSecret + '-refresh');

  console.log(`Auth DSEQ:      ${AUTH_DSEQ}`);
  console.log(`Auth Provider:  ${AUTH_PROVIDER}`);
  // Never print secret material into logs (CI output is often retained).
  console.log(`RESEND_API_KEY: ${resendApiKey ? '(set)' : '(missing)'}`);
  console.log(
    `DATABASE_URL:   ${databaseUrl.replace(/\/\/([^:]+):([^@]+)@/g, '//$1:<redacted>@')}`
  );
  console.log();

  const authImage = optEnv('AUTH_IMAGE', 'ghcr.io/alternatefutures/service-auth:latest');

  // ─── Generate SDL ──────────────────────────────────────────────────────────
  // This MUST match the original deployment's profiles/placement/deployment
  // sections exactly. Only env vars and image tag can change.
  const sdlContent = `---
version: "2.0"

services:
  auth-api:
    image: ${authImage}
    credentials:
      host: ghcr.io
      username: alternatefutures
      password: ${ghcrPat}
    expose:
      - port: 3000
        as: 80
        to:
          - global: true
        accept:
          - auth.alternatefutures.ai
    env:
      - NODE_ENV=production
      - PORT=3000
      # Database - PostgreSQL (direct env var, no Infisical)
      - DATABASE_URL=${databaseUrl}
      # Secrets injected directly (Infisical skipped)
      - JWT_SECRET=${jwtSecret}
      - JWT_REFRESH_SECRET=${jwtRefreshSecret}
      - RESEND_API_KEY=${resendApiKey}
      # Payments (Stripe)
      - STRIPE_SECRET_KEY=${stripeSecretKey}
      # AI Proxy
      - OPENAI_API_KEY=${openaiApiKey}
      # JWT Token Expiry
      - JWT_EXPIRES_IN=15m
      - JWT_REFRESH_EXPIRES_IN=7d
      # URLs
      - DOMAIN=alternatefutures.ai
      - APP_URL=https://auth.alternatefutures.ai
      - FRONTEND_URL=https://app.alternatefutures.ai
      - CORS_ORIGIN=https://app.alternatefutures.ai
      # OAuth Redirect URIs
      - GOOGLE_REDIRECT_URI=https://auth.alternatefutures.ai/auth/oauth/callback/google
      - GITHUB_REDIRECT_URI=https://auth.alternatefutures.ai/auth/oauth/callback/github
      - TWITTER_REDIRECT_URI=https://auth.alternatefutures.ai/auth/oauth/callback/twitter
      - DISCORD_REDIRECT_URI=https://auth.alternatefutures.ai/auth/oauth/callback/discord
      # Infisical (disabled - env var fallback)
      - INFISICAL_SITE_URL=https://secrets.alternatefutures.ai
      - INFISICAL_CLIENT_ID=
      - INFISICAL_CLIENT_SECRET=
      - INFISICAL_PROJECT_ID=
      - INFISICAL_ENVIRONMENT=prod

profiles:
  compute:
    auth-api:
      resources:
        cpu:
          units: 1.0
        memory:
          size: 1Gi
        storage:
          - size: 1Gi

  placement:
    akash:
      attributes:
        host: akash
      signedBy:
        anyOf:
          - "akash1365yvmc4s7awdyj3n2sav7xfx76adc6dnmlx63"
      pricing:
        auth-api:
          denom: uakt
          amount: 100

deployment:
  auth-api:
    akash:
      profile: auth-api
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

  // Check CLI availability
  const useCli = await hasProviderServicesCli();
  if (useCli) {
    console.log('provider-services CLI available — will use for manifest sending.');
  } else {
    console.log('Using JS SDK for manifest sending.');
  }

  // ─── Step 1: Update on-chain deployment ──────────────────────────────────
  const manifestOnly = process.argv.includes('--manifest-only');

  if (manifestOnly) {
    console.log('\n=== Step 1: SKIPPED (--manifest-only) ===');
    console.log('On-chain deployment was already updated. Sending manifest only.');
  } else {
    console.log('\n=== Step 1: Update on-chain deployment hash ===');
    console.log(`Updating DSEQ ${AUTH_DSEQ} with new manifest hash...`);

    try {
      await chainSDK.akash.deployment.v1beta4.updateDeployment({
        id: {
          owner,
          dseq: BigInt(AUTH_DSEQ),
        },
        hash,
      });
      console.log('On-chain deployment updated successfully.');
    } catch (error: any) {
      console.error('Failed to update deployment:', error.message);
      throw error;
    }

    console.log('Waiting 10s for chain state to settle...');
    await sleep(10_000);
  }

  // ─── Step 2: Send manifest to provider ──────────────────────────────────
  console.log('\n=== Step 2: Send manifest to provider ===');

  // Query lease to get gseq/oseq
  const leasesRes = await chainSDK.akash.market.v1beta5.getLeases({
    filters: { owner, dseq: BigInt(AUTH_DSEQ), provider: AUTH_PROVIDER },
  });

  const lease = leasesRes.leases?.[0]?.lease;
  if (!lease?.id) throw new Error('No active lease found for auth deployment');

  const gseq = Number(lease.id.gseq || 1);
  const oseq = Number(lease.id.oseq || 1);
  console.log(`Lease: DSEQ=${AUTH_DSEQ}, GSEQ=${gseq}, OSEQ=${oseq}`);

  let currentUseCli = useCli;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      if (currentUseCli) {
        // Write SDL to temp file for CLI
        const tmpSdl = path.resolve(__dirname, '../.local/_tmp-update-auth.yaml');
        fs.mkdirSync(path.dirname(tmpSdl), { recursive: true });
        fs.writeFileSync(tmpSdl, sdlContent);
        try {
          await sendManifestCli({
            sdlPath: tmpSdl,
            dseq: AUTH_DSEQ,
            provider: AUTH_PROVIDER,
            node: process.env.RPC_ENDPOINT || 'https://rpc.akashnet.net:443',
          });
        } finally {
          try { fs.unlinkSync(tmpSdl); } catch {}
        }
      } else {
        await sendManifest(
          sdl,
          { id: { owner, dseq: AUTH_DSEQ, gseq, oseq, provider: AUTH_PROVIDER } } as any,
          certificate,
          chainSDK
        );
      }
      console.log('Manifest sent successfully!');
      break;
    } catch (e: any) {
      const errMsg = e.message || String(e);
      console.log(`Manifest send attempt ${attempt}/3 failed: ${errMsg}`);

      // If CLI fails with TLS error (common on macOS), fall back to JS SDK
      if (currentUseCli && (errMsg.includes('x509:') || errMsg.includes('tls: failed'))) {
        console.log('CLI TLS error detected — falling back to JS SDK for manifest sending.');
        currentUseCli = false;
      }

      if (attempt === 3) throw e;
      console.log('Retrying in 10s...');
      await sleep(10_000);
    }
  }

  // ─── Done ────────────────────────────────────────────────────────────────
  console.log('\n========================================');
  console.log('  AUTH SERVICE MANIFEST UPDATED');
  console.log('========================================');
  console.log(`\nDSEQ:     ${AUTH_DSEQ} (unchanged)`);
  console.log(`Provider: ${AUTH_PROVIDER} (unchanged)`);
  console.log(`\nRESEND_API_KEY is now injected. The container will restart with the new env vars.`);
  console.log(`Wait ~30s for the container to become healthy, then test:`);
  console.log(`  curl -sf https://auth.alternatefutures.ai/health`);
}

main().catch((e) => {
  console.error('\nFATAL ERROR:', e?.message || e);
  process.exit(1);
});
