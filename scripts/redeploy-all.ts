#!/usr/bin/env npx tsx
/**
 * Full Clean Redeploy - Close ALL Akash deployments and redeploy everything.
 *
 * Deployment order (each depends on the previous):
 *   0.5  Build + push service Docker images (auth, cloud-api) to GHCR
 *         Ensures Akash containers always have the latest code + Prisma client.
 *   1.   Close all active deployments
 *   2.   Deploy PostgreSQL (standalone)
 *   3.   Deploy data services (IPFS + Jaeger)
 *   4.   Deploy auth (standalone, with DATABASE_URL + secrets injected via env vars)
 *   4.5  Run database migrations for BOTH services + seed subscription plans
 *         - service-auth: prisma migrate deploy (migrations are complete)
 *         - service-cloud-api: prisma migrate diff (additive-only, no DROPs)
 *         See INCIDENTS.md (Shared DB + Prisma policy) for why this split exists.
 *   5.   Deploy API (standalone)
 *   6.   Update pingap.toml with raw provider ingress URLs (prevents circular routing)
 *   6.5  Build + push proxy Docker image (requires Docker + GHCR write:packages)
 *   7.   Deploy SSL proxy (Pingap with dedicated IP lease, using freshly built image)
 *   8.   Update config files (DEPLOYMENTS.md, workflows)
 *   8.5  Persist deployment info to .env.deploy (DATABASE_URL, DSEQs, providers)
 *   9.   Print summary
 *
 * Note: Infisical is SKIPPED. Secrets are injected directly as SDL env vars.
 * The auth service has a built-in fallback that reads from env vars when
 * Infisical credentials are not provided.
 *
 * Required:
 *   - Docker running (Docker Desktop or dockerd) — proxy image is built locally
 *   - GHCR_PAT with write:packages scope (for pushing proxy image to ghcr.io)
 *   - akash-mcp/.env       (AKASH_MNEMONIC)
 *   - akash-mcp/.env.deploy (all deployment secrets - see .env.deploy.example)
 *   - SSL proxy TLS material (Cloudflare Origin Certificate + key), provided via:
 *     - env: PINGAP_TLS_CERT + PINGAP_TLS_KEY (recommended for open source), OR
 *     - local files: infrastructure-proxy/certs/origin.crt + origin.key
 *
 * Usage:
 *   cd akash-mcp && npx tsx scripts/redeploy-all.ts
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import { SDL } from '@akashnetwork/chain-sdk';

import { loadWalletAndClient } from '../src/utils/load-wallet.js';
import { loadCertificate } from '../src/utils/load-certificate.js';
import { sendManifest } from '../src/tools/send-manifest.js';
import { hasProviderServicesCli, sendManifestCli } from '../src/utils/send-manifest-cli.js';
import { getFailingProvidersForService, getKnownWorkingProvidersForService, recordProviderResult } from '../src/utils/provider-registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');

// Load environment
config({ path: path.resolve(__dirname, '../.env') });
config({ path: path.resolve(__dirname, '../.env.deploy') });

// Optional local telemetry (gitignored): record all bids seen per service so we
// can later compare "cheapest" across providers even when we didn’t select them.
const PROVIDER_BIDS_LOG_PATH =
  process.env.AKASH_PROVIDER_BIDS_LOG_PATH || path.resolve(__dirname, '../.local/provider-bids.jsonl');

function appendBidsLog(entry: any) {
  try {
    fs.mkdirSync(path.dirname(PROVIDER_BIDS_LOG_PATH), { recursive: true });
    fs.appendFileSync(PROVIDER_BIDS_LOG_PATH, JSON.stringify(entry) + '\n');
  } catch {
    // best-effort; never block deployments
  }
}

// ─── Run state (for cleanup + provider registry) ────────────────────────────
let RUN_OWNER: string | null = null;
let RUN_CHAIN_SDK: any = null;
const RUN_CREATED_DSEQS = new Set<number>();

// ─── Known-bad providers ────────────────────────────────────────────────────
const ALWAYS_EXCLUDE = new Set([
  'akash1smapjx8m8363nmdvc2yr9atlqy8vcql73m9l0v', // Broken hostname
  'akash1pnae60m3nnnq89437kg892k50wjqx90zcysgzv', // ahn2-na.akash.pub - controller stuck, never creates k8s resources
  'akash1rr5pzy4kz2wwwtntt5vz4as0afw0ljrfmhty8q', // No named storage vol support - only created 2/8 services
  'akash1vg3gk6dynh9ys45tzjyedp0dl52s93kap75x3n', // zanthem.cloud - creates 2/8 svcs then loses lease
  'akash1tweev0k42guyv3a2jtgphmgfrl2h5y2884vh9d', // dcnorse.eu - lease not found after manifest
  'akash1aaul837r7en7hpk9wv2svg8u78fdq0t2j2e82z', // Rejects TLS client cert on manifest send (SSL alert 42)
  'akash1qmumr9mdnu9e8ymyr3nnf3qyjfkugj79eh6jzq', // yggdrasil-compute.com - broken DNS: provider.provider.yggdrasil-compute.com (doubled prefix)
  'akash1sjwuwre4qprcaa34f6324yz7m8nn0awvc75gp5', // quanglong.org - repeated kube: lease not found after manifest
  // leet.haus — was excluded for persistent "kube: lease not found" but that
  // was caused by missing persistent storage attributes in the SDL (now fixed).
  // 'akash1kqzpqqhm39umt06wu8m4hx63v5hefhrfmjf9dj',
]);

// ─── Preferred providers (known to work with complex multi-service + storage) ─
const PREFERRED_PROVIDERS: string[] = [
  // Intentionally empty for now.
  // When providers are flaky, forcing a single "preferred" provider causes
  // predictable failures + wasted retries. We rely on the safety filter +
  // failover loop instead.
];

// ─── Failover tuning ─────────────────────────────────────────────────────────
const MAX_PROVIDER_FAILOVERS = 5;
const LEASE_NOT_FOUND_FAILFAST = 6;

// ─── CLI availability (set during init) ──────────────────────────────────────
// When true, we shell out to `provider-services send-manifest` instead of
// using the JS SDK's `sendManifest()`. This mirrors the CI/CD path and can be
// more operationally reliable on some providers.
let USE_CLI_MANIFEST = false;

// ─── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Retry an async operation on transient RPC errors (HTTP 524 Cloudflare timeout,
 * 502/503 gateway errors, ECONNRESET, etc.). These are common with the public
 * Akash RPC endpoints and should not crash the entire deploy run.
 */
async function retryOnTransient<T>(
  fn: () => Promise<T>,
  opts: { label: string; maxRetries?: number; delayMs?: number } = { label: '' }
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 4;
  const baseDelay = opts.delayMs ?? 10_000;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const msg = String(err?.message || err || '');
      const isTransient =
        msg.includes('524') ||
        msg.includes('502') ||
        msg.includes('503') ||
        msg.includes('ECONNRESET') ||
        msg.includes('ETIMEDOUT') ||
        msg.includes('ECONNREFUSED') ||
        msg.includes('socket hang up') ||
        msg.includes('network timeout');

      if (isTransient && attempt <= maxRetries) {
        const delay = baseDelay * attempt; // linear backoff
        console.log(
          `  [${opts.label}] Transient RPC error (attempt ${attempt}/${maxRetries + 1}): ${msg.slice(0, 120)}`
        );
        console.log(`  [${opts.label}] Retrying in ${delay / 1000}s...`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  throw new Error('unreachable');
}

function injectGhcrCredentials(sdlContent: string) {
  const ghcrPat = mustEnv('GHCR_PAT');
  return sdlContent.replace(
    /^(\s+)(image:\s+ghcr\.io\/alternatefutures\/[^\n]+)$/gm,
    (_, indent, imageLine) => {
      return `${indent}${imageLine}\n${indent}credentials:\n${indent}  host: ghcr.io\n${indent}  username: alternatefutures\n${indent}  password: ${ghcrPat}`;
    }
  );
}

function mustEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key} (set it in .env.deploy)`);
  return val;
}

function optEnv(key: string, fallback = 'placeholder'): string {
  return process.env[key] || fallback;
}

function mustDbPassword(): string {
  const val = process.env.POSTGRES_PASSWORD || process.env.YSQL_PASSWORD;
  if (!val) {
    throw new Error(
      'Missing required env var: POSTGRES_PASSWORD (preferred) or YSQL_PASSWORD (deprecated alias) (set it in .env.deploy)'
    );
  }
  return val;
}

async function closeDeploymentQuiet(chainSDK: any, owner: string, dseq: number, label: string) {
  try {
    await retryOnTransient(
      () =>
        chainSDK.akash.deployment.v1beta4.closeDeployment({
          id: { owner, dseq: BigInt(dseq) },
        }),
      { label, maxRetries: 2 }
    );
    console.log(`  [${label}] Closed DSEQ ${dseq}`);
  } catch (e: any) {
    console.log(`  [${label}] Warning: Failed to close DSEQ ${dseq}: ${e.message || e}`);
  }
}

async function cleanupRunDeployments(label = 'cleanup') {
  if (!RUN_CHAIN_SDK || !RUN_OWNER) return;
  if (RUN_CREATED_DSEQS.size === 0) return;
  console.log(`\n  [${label}] Cleaning up ${RUN_CREATED_DSEQS.size} deployment(s) created in this run...`);
  // Close in reverse-ish order (higher DSEQ first) just for readability.
  const dseqs = Array.from(RUN_CREATED_DSEQS).sort((a, b) => b - a);
  for (const d of dseqs) {
    await closeDeploymentQuiet(RUN_CHAIN_SDK, RUN_OWNER, d, label);
  }
}

function mustReadFile(filePath: string): string {
  if (!fs.existsSync(filePath)) throw new Error(`Missing required file: ${filePath}`);
  return fs.readFileSync(filePath, 'utf8');
}

function toPipedPem(pem: string): string {
  return pem
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n/g, '|')
    .replace(/\|+$/g, '')
    .replace(/^\|+/g, '');
}

function redactDatabaseUrl(databaseUrl: string): string {
  // postgresql://user:password@host:port/db  ->  postgresql://user:<redacted>@host:port/db
  return databaseUrl.replace(/\/\/([^:]+):([^@]+)@/g, '//$1:<redacted>@');
}

function loadProxyTlsMaterial(): { certPiped: string; keyPiped: string; source: 'env' | 'files' } {
  const envCert = process.env.PINGAP_TLS_CERT;
  const envKey = process.env.PINGAP_TLS_KEY;
  if (envCert && envKey) {
    return { certPiped: toPipedPem(envCert), keyPiped: toPipedPem(envKey), source: 'env' };
  }

  const certFile = path.join(ROOT, 'infrastructure-proxy/certs/origin.crt');
  const keyFile = path.join(ROOT, 'infrastructure-proxy/certs/origin.key');
  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    const originCert = fs.readFileSync(certFile, 'utf8');
    const originKey = fs.readFileSync(keyFile, 'utf8');
    return { certPiped: toPipedPem(originCert), keyPiped: toPipedPem(originKey), source: 'files' };
  }

  throw new Error(
    [
      'Missing SSL proxy TLS material.',
      'Provide either:',
      '- env: PINGAP_TLS_CERT + PINGAP_TLS_KEY (pipe-separated PEM recommended), or',
      '- local files: infrastructure-proxy/certs/origin.crt and infrastructure-proxy/certs/origin.key',
    ].join('\n')
  );
}

function hr(title: string) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(70));
}

async function queryLeaseStatus(
  providerHostUri: string,
  dseq: number,
  gseq: number,
  oseq: number,
  certificate: any
): Promise<any> {
  const leasePath = `/lease/${dseq}/${gseq}/${oseq}/status`;
  const uri = new URL(providerHostUri);

  const agent = new https.Agent({
    cert: certificate.cert,
    key: certificate.privateKey,
    rejectUnauthorized: false,
    servername: 'localhost',
  });

  return await new Promise<any>((resolve, reject) => {
    const req = https.request(
      {
        hostname: uri.hostname,
        port: uri.port ? parseInt(uri.port, 10) : 8443,
        path: leasePath,
        method: 'GET',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        agent,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`Lease status HTTP ${res.statusCode}: ${data}`));
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// ─── Deployment result types ────────────────────────────────────────────────

interface DeployResult {
  dseq: number;
  provider: string;
  gseq: number;
  oseq: number;
  providerHostUri: string;
  bidAmount?: string;
  bidDenom?: string;
}

interface DatabaseResult extends DeployResult {
  dbHost: string;
  dbPort: number;
}

interface DataResult extends DeployResult {
  ipfsIngressUrl: string;
  ipfsApiHost: string;
  ipfsApiPort: number;
  otelHost: string;
  otelPort: number;
  jaegerIngressUrl: string;
}

interface ApiResult extends DeployResult {
  apiIngressUrl: string;
}

interface AuthResult extends DeployResult {
  ingressUrl: string;
}

interface ProxyResult extends DeployResult {
  ip: string;
}

// ─── Core deployment function ───────────────────────────────────────────────

async function deploySDL(
  sdlContent: string,
  excludeProviders: Set<string>,
  depositUakt: number,
  chainSDK: any,
  owner: string,
  certificate: any,
  label: string,
  sdlFilePath?: string,
): Promise<DeployResult> {
  let dseq = 0;
  let provider = '';
  let gseq = 1;
  let oseq = 1;
  let providerHostUri = '';
  let bidAmount: string | undefined;
  let bidDenom: string | undefined;

  try {
    console.log(`\n  [${label}] Parsing SDL...`);
    const sdl = SDL.fromString(sdlContent, 'beta3');
    const groups = sdl.groups();
    const hash = await sdl.manifestVersion();

    // Get current block height for DSEQ (retries on transient RPC errors)
    const statusResponse: any = await retryOnTransient(
      () => chainSDK.cosmos.base.tendermint.v1beta1.getLatestBlock({}),
      { label }
    );
    dseq = Number(statusResponse.block?.header?.height || 0);
    if (!dseq) throw new Error('Could not determine block height for DSEQ');

    console.log(`  [${label}] Creating deployment (DSEQ: ${dseq})...`);
    await retryOnTransient(
      () =>
        chainSDK.akash.deployment.v1beta4.createDeployment({
          id: { owner, dseq: BigInt(dseq) },
          groups,
          hash,
          deposit: {
            amount: { denom: 'uakt', amount: String(depositUakt) },
            sources: [1],
          },
        }),
      { label }
    );
    RUN_CREATED_DSEQS.add(dseq);
    console.log(`  [${label}] Deployment created. DSEQ: ${dseq}`);

    // Wait for bids
    console.log(`  [${label}] Waiting 30s for bids...`);
    await sleep(30_000);

    const bidsResponse: any = await retryOnTransient(
      () =>
        chainSDK.akash.market.v1beta5.getBids({
          filters: { owner, dseq: BigInt(dseq) },
        }),
      { label }
    );

    const bids = bidsResponse.bids || [];
    if (bids.length === 0) throw new Error(`[${label}] No bids received.`);

    console.log(`  [${label}] Received ${bids.length} bid(s).`);

    const getBidPrice = (b: any): { amount?: string; denom?: string; num?: number } => {
      const price = b?.bid?.price;
      const amount = price?.amount != null ? String(price.amount) : undefined;
      const denom = price?.denom != null ? String(price.denom) : undefined;
      const num = amount != null ? Number(amount) : Number.NaN;
      return { amount, denom, num: Number.isFinite(num) ? num : undefined };
    };

    // Merge always-exclude with deployment-specific excludes + per-service failing providers registry
    const registryExclude = getFailingProvidersForService({ service: label, minFails: 2 });
    const allExclude = new Set([...excludeProviders, ...ALWAYS_EXCLUDE, ...registryExclude]);

    // Filter to non-excluded bids
    const usableBids = bids.filter((b: any) => {
      const p = b.bid?.id?.provider;
      return p && !allExclude.has(p);
    });

    if (usableBids.length === 0) {
      const providers = bids.map((b: any) => b.bid?.id?.provider).filter(Boolean);
      throw new Error(
        `[${label}] No usable bids after exclusions. Providers: ${providers.join(', ')}. Excluded: ${Array.from(allExclude).join(', ')}`
      );
    }

    // Log all usable providers
    console.log(`  [${label}] Usable providers: ${usableBids.map((b: any) => b.bid?.id?.provider).join(', ')}`);

    // Prefer explicitly configured providers first.
    const preferred = PREFERRED_PROVIDERS.length
      ? usableBids.find((b: any) => PREFERRED_PROVIDERS.includes(b.bid?.id?.provider))
      : undefined;

    // Otherwise, choose the cheapest bid, preferring providers that have
    // previously *successfully* installed this service at least once.
    const knownWorking = getKnownWorkingProvidersForService({ service: label });
    const sortByPrice = (arr: any[]) =>
      arr
        .slice()
        .sort((a, b) => {
          const pa = getBidPrice(a).num ?? Number.POSITIVE_INFINITY;
          const pb = getBidPrice(b).num ?? Number.POSITIVE_INFINITY;
          return pa - pb;
        });

    const usableWorking = usableBids.filter((b: any) => knownWorking.has(b.bid?.id?.provider));
    const cheapestWorking = sortByPrice(usableWorking)[0];
    const cheapestAny = sortByPrice(usableBids)[0];

    const selected = preferred || cheapestWorking || cheapestAny;
    if (!selected?.bid?.id) throw new Error(`[${label}] No usable bids after exclusions.`);

    if (preferred) {
      console.log(`  [${label}] ✓ Using PREFERRED provider (explicit list).`);
    } else if (cheapestWorking) {
      const p = getBidPrice(cheapestWorking);
      console.log(
        `  [${label}] ✓ Using cheapest KNOWN-WORKING provider (price=${p.amount || '?'} ${p.denom || ''})`
      );
    } else {
      const p = getBidPrice(cheapestAny);
      console.log(`  [${label}] ✓ Using cheapest provider (price=${p.amount || '?'} ${p.denom || ''})`);
    }

    const bidId = selected.bid.id;
    provider = bidId.provider;
    gseq = Number(bidId.gseq || 1);
    oseq = Number(bidId.oseq || 1);
    const bseq = Number(bidId.bseq || 0);
    {
      const p = getBidPrice(selected);
      bidAmount = p.amount;
      bidDenom = p.denom;
    }

    console.log(`  [${label}] Selected provider: ${provider}`);

    // Log bid landscape (best-effort). This is safe to persist (no secrets).
    appendBidsLog({
      at: new Date().toISOString(),
      service: label,
      dseq,
      excluded: Array.from(allExclude),
      usableBids: usableBids.map((b: any) => {
        const p = getBidPrice(b);
        return {
          provider: b?.bid?.id?.provider,
          amount: p.amount,
          denom: p.denom,
        };
      }),
      selected: { provider, amount: bidAmount, denom: bidDenom },
      selectionMode: preferred ? 'preferred' : cheapestWorking ? 'cheapest_known_working' : 'cheapest',
    });

    // Create lease (retries on transient RPC errors)
    console.log(`  [${label}] Creating lease...`);
    await retryOnTransient(
      () =>
        chainSDK.akash.market.v1beta5.createLease({
          bidId: { owner, dseq: BigInt(dseq), gseq, oseq, provider, bseq },
        }),
      { label }
    );
    console.log(`  [${label}] Lease created.`);

  // Wait until the lease is visible on-chain (and not immediately closed).
  // provider-services filters for ACTIVE leases before sending manifests.
  console.log(`  [${label}] Waiting for lease to become visible on-chain...`);
  {
    let lastState: any = null;
    for (let i = 1; i <= 15; i++) {
      try {
        const leasesRes = await chainSDK.akash.market.v1beta5.getLeases({
          filters: { owner, dseq: BigInt(dseq), provider },
        });
        const lease = leasesRes.leases?.[0]?.lease;
        if (lease?.id) {
          lastState = lease.state;
          const closedOn = lease.closedOn ? Number((lease.closedOn as any).low ?? lease.closedOn) : 0;
          if (closedOn > 0) {
            throw new Error(`Lease closed on-chain (closedOn=${closedOn}, state=${lease.state})`);
          }
          // If we can see the lease and it's not closed, proceed.
          break;
        }
      } catch (e: any) {
        // ignore transient query errors, keep polling
        lastState = e?.message || String(e);
      }
      await sleep(4_000);
    }
    if (lastState) {
      console.log(`  [${label}] Lease chain visibility check complete. Last state: ${String(lastState)}`);
    }
  }

  // IMPORTANT:
  // In practice, many providers will accept the lease & even accept the manifest,
  // but still return "kube: lease not found" for a short window while their
  // controller catches up to the LeaseWon event.
  //
  // The GitHub Actions path (akash/provider-services) effectively avoids this by
  // adding delay and by targeting ACTIVE leases.
  //
  // We add a small settling delay here to reduce the race window.
  console.log(`  [${label}] Waiting 10s for provider lease watcher to catch up...`);
  await sleep(10_000);

  // Send manifest (with retries - large deployments can cause socket hangups)
  // CRITICAL: When USE_CLI_MANIFEST is true, we use the same `provider-services`
  // manifest-sending path as CI/CD. In practice this can be more operationally
  // reliable on some providers.
  console.log(`  [${label}] Sending manifest${USE_CLI_MANIFEST ? ' (via CLI)' : ' (via JS SDK)'}...`);

  // Log manifest hash for diagnostics
  const manifestHash = await sdl.manifestVersion();
  console.log(`  [${label}] Manifest version hash (JS SDK): ${Buffer.from(manifestHash).toString('hex').substring(0, 16)}...`);

  for (let retry = 1; retry <= 3; retry++) {
    try {
      if (USE_CLI_MANIFEST && sdlFilePath) {
        // Write the SDL with substituted secrets to a temp file for the CLI
        const tmpSdl = path.resolve(__dirname, `../.local/_tmp-deploy-${label}-${dseq}.yaml`);
        fs.mkdirSync(path.dirname(tmpSdl), { recursive: true });
        fs.writeFileSync(tmpSdl, sdlContent);
        try {
          await sendManifestCli({
            sdlPath: tmpSdl,
            dseq,
            provider,
            node: process.env.RPC_ENDPOINT || 'https://rpc.akashnet.net:443',
          });
        } finally {
          // Clean up temp file (contains secrets)
          try { fs.unlinkSync(tmpSdl); } catch {}
        }
      } else {
        await sendManifest(sdl, { id: { owner, dseq, gseq, oseq, provider } } as any, certificate, chainSDK);
      }
      console.log(`  [${label}] Manifest sent.`);
      break;
    } catch (e: any) {
      const errMsg = e.message || String(e);
      console.log(`  [${label}] Manifest send attempt ${retry}/3 failed: ${errMsg}`);

      // If the CLI fails with a TLS error (common on macOS with Go binaries),
      // fall back to the JS SDK for the remaining retries. The JS SDK manifest
      // hash was verified to match the Go provider's expectation.
      if (USE_CLI_MANIFEST && (errMsg.includes('x509:') || errMsg.includes('tls: failed'))) {
        console.log(`  [${label}] CLI TLS error detected — falling back to JS SDK for manifest sending.`);
        USE_CLI_MANIFEST = false;
      }

      if (retry === 3) throw e;
      console.log(`  [${label}] Retrying in 10s...`);
      await sleep(10_000);
    }
  }

    // Get provider host URI
    const providerRes = await chainSDK.akash.provider.v1beta4.getProvider({ owner: provider });
    providerHostUri = providerRes.provider?.hostUri || '';
    if (!providerHostUri) throw new Error(`[${label}] Could not resolve provider hostUri`);

  // Provider-ACK loop:
  // If the provider returns "lease not found" immediately after manifest submit,
  // re-send the manifest a couple of times with backoff. This matches what we
  // often need to do manually via scripts like `_temp-resend-manifest.ts`.
  //
  // Goal: ensure the provider has actually materialized Kubernetes resources
  // before we move on to the next step.
  for (let ackAttempt = 1; ackAttempt <= 3; ackAttempt++) {
    try {
      // Short delay before first status check to avoid immediate 404 spam
      await sleep(5_000);
      await queryLeaseStatus(providerHostUri, dseq, gseq, oseq, certificate);
      console.log(`  [${label}] Provider acknowledged lease (status endpoint reachable).`);
      break;
    } catch (e: any) {
      const msg = e?.message || String(e);
      const looksLikeLeaseNotFound =
        msg.includes('kube: lease not found') ||
        msg.includes('no deployments for lease') ||
        msg.includes('Could not query lease status') ||
        msg.includes('Lease status HTTP 404');

      if (!looksLikeLeaseNotFound || ackAttempt === 3) {
        // Not the classic race condition (or we exhausted retries) — let the
        // main readiness loop handle it / surface the error.
        console.log(`  [${label}] Provider ACK check failed (attempt ${ackAttempt}/3): ${msg}`);
        break;
      }

      console.log(
        `  [${label}] Provider not ready yet ("lease not found"). Re-sending manifest (attempt ${ackAttempt}/3)...`
      );
      try {
        if (USE_CLI_MANIFEST && sdlFilePath) {
          const tmpSdl = path.resolve(__dirname, `../.local/_tmp-deploy-${label}-${dseq}.yaml`);
          fs.mkdirSync(path.dirname(tmpSdl), { recursive: true });
          fs.writeFileSync(tmpSdl, sdlContent);
          try {
            await sendManifestCli({
              sdlPath: tmpSdl,
              dseq,
              provider,
              node: process.env.RPC_ENDPOINT || 'https://rpc.akashnet.net:443',
            });
          } finally {
            try { fs.unlinkSync(tmpSdl); } catch {}
          }
        } else {
          await sendManifest(sdl, { id: { owner, dseq, gseq, oseq, provider } } as any, certificate, chainSDK);
        }
        console.log(`  [${label}] Manifest re-sent.`);
      } catch (sendErr: any) {
        console.log(`  [${label}] Manifest re-send failed: ${sendErr?.message || sendErr}`);
      }
      await sleep(10_000);
    }
  }

    // NOTE: we intentionally do NOT mark a provider as "working" here.
    // "Working" means the service actually becomes ready (handled by the
    // per-service wrapper after `waitForServices` / IP lease assignment).
    return { dseq, provider, gseq, oseq, providerHostUri, bidAmount, bidDenom };
  } catch (e: any) {
    const msg = e?.message || String(e);
    if (provider) {
      recordProviderResult({
        service: label,
        provider,
        outcome: 'failing',
        reason: msg,
        dseq: dseq || undefined,
        bidAmount,
        bidDenom,
      });
    }
    throw e;
  }
}

async function waitForServices(
  providerHostUri: string,
  dseq: number,
  gseq: number,
  oseq: number,
  certificate: any,
  label: string,
  maxAttempts = 20,
  intervalMs = 10_000
): Promise<any> {
  console.log(`  [${label}] Waiting for services to become ready...`);
  let leaseNotFoundStreak = 0;
  let lastStatus: any = null;
  let lastError: any = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await sleep(intervalMs);
    try {
      const status = await queryLeaseStatus(providerHostUri, dseq, gseq, oseq, certificate);
      lastStatus = status;
      leaseNotFoundStreak = 0;

      // Check if services have ready replicas
      let allReady = true;
      let serviceCount = 0;
      if (status?.services) {
        for (const [svc, info] of Object.entries(status.services) as any) {
          serviceCount++;
          const ready = info?.ready_replicas || 0;
          const available = info?.available_replicas || 0;
          const total = info?.total || 0;
          const uris = info?.uris || [];
          console.log(
            `    Attempt ${attempt}/${maxAttempts}: ${svc} - ready: ${ready}/${total}, available: ${available}/${total}${uris.length ? `, uris: ${uris.join(', ')}` : ''}`
          );
          // Accept either ready_replicas OR available_replicas as "ready".
          // Some Akash providers report available_replicas=1 before ready_replicas=1
          // for services with persistent storage (implicit readiness probe timing).
          const isUp = (ready > 0) || (available > 0);
          if (total === 0 || !isUp) allReady = false;
        }
      }

      // Also check forwarded_ports exist (needed for YB TCP port extraction)
      const hasPorts = status?.forwarded_ports && Object.keys(status.forwarded_ports).length > 0;

      if (serviceCount >= 1 && allReady) {
        console.log(`  [${label}] All ${serviceCount} services ready.`);
        return status;
      }
    } catch (e: any) {
      lastError = e;
      const msg = e?.message || String(e);
      console.log(`    Attempt ${attempt}/${maxAttempts}: not ready (${msg})`);

      if (msg.includes('kube: lease not found') || msg.includes('no deployments for lease')) {
        leaseNotFoundStreak++;
        if (leaseNotFoundStreak >= LEASE_NOT_FOUND_FAILFAST) {
          throw new Error(
            `[${label}] Provider never created Kubernetes resources (lease not found) after ${leaseNotFoundStreak} checks.`
          );
        }
      } else {
        leaseNotFoundStreak = 0;
      }
    }
  }

  const details = lastError?.message ? ` Last error: ${lastError.message}` : '';
  const svcKeys = lastStatus?.services ? Object.keys(lastStatus.services).join(', ') : '(none)';
  throw new Error(`[${label}] Timed out waiting for services to become ready. Services seen: ${svcKeys}.${details}`);
}

// ─── Step 1: Close all deployments ──────────────────────────────────────────

async function closeAllDeployments(chainSDK: any, owner: string) {
  hr('STEP 1: Close ALL active deployments');

  const deploymentsRes: any = await retryOnTransient(
    () =>
      chainSDK.akash.deployment.v1beta4.getDeployments({
        filters: { owner, state: 'active' },
      }),
    { label: 'close-all' }
  );

  const deployments = deploymentsRes.deployments || [];
  if (deployments.length === 0) {
    console.log('  No active deployments found. Nothing to close.');
    return;
  }

  console.log(`  Found ${deployments.length} active deployment(s). Closing all...\n`);

  for (const depWrapper of deployments) {
    const dep = depWrapper.deployment;
    if (!dep?.id) continue;

    const dseq = Number(dep.id.dseq);
    try {
      await retryOnTransient(
        () =>
          chainSDK.akash.deployment.v1beta4.closeDeployment({
            id: { owner, dseq: BigInt(dseq) },
          }),
        { label: 'close-all', maxRetries: 2 }
      );
      console.log(`  Closed DSEQ: ${dseq}`);
    } catch (e: any) {
      console.log(`  Warning: Failed to close DSEQ ${dseq}: ${e.message}`);
    }

    // Small delay between closures to avoid nonce issues
    await sleep(3_000);
  }

  console.log('\n  All deployments closed. Waiting 10s for chain state to settle...');
  await sleep(10_000);
}

// ─── Step 2: Deploy PostgreSQL ───────────────────────────────────────────────

async function deployDatabase(
  chainSDK: any,
  owner: string,
  certificate: any,
  excludeProviders: Set<string>
): Promise<DatabaseResult> {
  hr('STEP 2: Deploy PostgreSQL (standalone)');

  const dbPassword = mustDbPassword();
  let sdlContent = mustReadFile(path.join(ROOT, 'service-cloud-api/infra/postgres-standalone.yaml'));
  sdlContent = sdlContent.replace(/\$\{POSTGRES_PASSWORD\}/g, dbPassword);

  const triedProviders = new Set<string>();
  let lastError: any = null;

  for (let attempt = 1; attempt <= MAX_PROVIDER_FAILOVERS; attempt++) {
    const attemptExclude = new Set<string>([...excludeProviders, ...triedProviders]);
    console.log(`\n  [postgres] Provider attempt ${attempt}/${MAX_PROVIDER_FAILOVERS}...`);

    let result: any;
    try {
      result = await deploySDL(sdlContent, attemptExclude, 5_000_000, chainSDK, owner, certificate, 'postgres', path.join(ROOT, 'service-cloud-api/infra/postgres-standalone.yaml'));
      const status = await waitForServices(
        result.providerHostUri,
        result.dseq,
        result.gseq,
        result.oseq,
        certificate,
        'postgres',
        20,       // 20 attempts — PostgreSQL starts in ~30s
        10_000    // 10s intervals — total timeout: ~3.3 minutes
      );

      let dbHost = '';
      let dbPort = 0;
      if (status?.forwarded_ports) {
        const pgPorts = status.forwarded_ports['postgres'] || [];
        for (const fp of pgPorts) {
          if (fp.port === 5432 && fp.proto === 'TCP') {
            dbHost = fp.host;
            dbPort = fp.externalPort;
            break;
          }
        }
      }

      console.log(`\n  postgres results:`);
      console.log(`    PostgreSQL: ${dbHost}:${dbPort} ${dbPort ? '' : '(not found - check forwarded_ports)'}`);

      if (!dbHost || !dbPort) {
        console.log('\n  Full lease status for debugging:');
        console.log(JSON.stringify(status, null, 2));
        throw new Error('[postgres] Could not extract forwarded port for 5432.');
      }

      recordProviderResult({
        service: 'postgres',
        provider: result.provider,
        outcome: 'working',
        dseq: result.dseq,
        bidAmount: result.bidAmount,
        bidDenom: result.bidDenom,
      });
      return { ...result, dbHost, dbPort };
    } catch (e: any) {
      lastError = e;
      if (result) {
        console.log(
          `  [postgres] ❌ Failed on provider ${result.provider} (DSEQ ${result.dseq}): ${e.message || e}`
        );
        recordProviderResult({
          service: 'postgres',
          provider: result.provider,
          outcome: 'failing',
          reason: e?.message || String(e),
          dseq: result.dseq,
          bidAmount: result.bidAmount,
          bidDenom: result.bidDenom,
        });
        triedProviders.add(result.provider);
        await closeDeploymentQuiet(chainSDK, owner, result.dseq, 'postgres');
      } else {
        console.log(`  [postgres] ❌ deploySDL failed (no lease created): ${e.message || e}`);
      }
      console.log(`  [postgres] Retrying with a different provider in 10s...`);
      await sleep(10_000);
    }
  }

  throw lastError || new Error('[postgres] Failed after provider failover attempts.');
}

// ─── Step 3: Deploy data services ────────────────────────────────────────────

async function deployData(
  chainSDK: any,
  owner: string,
  certificate: any,
  excludeProviders: Set<string>
): Promise<DataResult> {
  hr('STEP 3: Deploy data services (IPFS + Jaeger)');

  let sdlContent = mustReadFile(path.join(ROOT, 'service-cloud-api/deploy-data.yaml'));
  sdlContent = injectGhcrCredentials(sdlContent);

  const triedProviders = new Set<string>();
  let lastError: any = null;

  for (let attempt = 1; attempt <= MAX_PROVIDER_FAILOVERS; attempt++) {
    const attemptExclude = new Set<string>([...excludeProviders, ...triedProviders]);
    console.log(`\n  [data] Provider attempt ${attempt}/${MAX_PROVIDER_FAILOVERS}...`);

    let result: any;
    try {
      result = await deploySDL(sdlContent, attemptExclude, 5_000_000, chainSDK, owner, certificate, 'data', 'inline');
      const status = await waitForServices(
        result.providerHostUri,
        result.dseq,
        result.gseq,
        result.oseq,
        certificate,
        'data',
        30,
        10_000
      );

      let ipfsIngressUrl = '';
      let jaegerIngressUrl = '';
      let ipfsApiHost = '';
      let ipfsApiPort = 0;
      let otelHost = '';
      let otelPort = 0;

      if (status?.services) {
        for (const [svc, info] of Object.entries(status.services) as any) {
          const uris = info?.uris || [];
          if (svc === 'ipfs' && uris.length) ipfsIngressUrl = uris[0];
          if (svc === 'jaeger' && uris.length) jaegerIngressUrl = uris[0];
        }
      }

      if (status?.forwarded_ports) {
        const ipfsPorts = status.forwarded_ports['ipfs'] || [];
        for (const fp of ipfsPorts) {
          if (fp.port === 5001) {
            ipfsApiHost = fp.host;
            ipfsApiPort = fp.externalPort;
            break;
          }
        }
        // OTel collector is currently disabled; export directly to Jaeger OTLP/HTTP (4318).
        const jaegerPorts = status.forwarded_ports['jaeger'] || [];
        for (const fp of jaegerPorts) {
          if (fp.port === 4318) {
            otelHost = fp.host;
            otelPort = fp.externalPort;
            break;
          }
        }
      }

      console.log(`\n  data results:`);
      console.log(`    IPFS ingress:   ${ipfsIngressUrl || '(not found)'}`);
      console.log(`    IPFS API:       ${ipfsApiHost}:${ipfsApiPort} ${ipfsApiPort ? '' : '(not found)'}`);
      console.log(`    Jaeger ingress: ${jaegerIngressUrl || '(not found)'}`);
      console.log(`    OTel endpoint:  ${otelHost}:${otelPort} ${otelPort ? '' : '(not found)'}`);

      if (!ipfsApiHost || !ipfsApiPort) {
        console.log('\n  Full lease status for debugging:');
        console.log(JSON.stringify(status, null, 2));
        throw new Error('[data] Could not extract IPFS API forwarded port (5001).');
      }

      recordProviderResult({
        service: 'data',
        provider: result.provider,
        outcome: 'working',
        dseq: result.dseq,
        bidAmount: result.bidAmount,
        bidDenom: result.bidDenom,
      });
      return { ...result, ipfsIngressUrl, ipfsApiHost, ipfsApiPort, otelHost, otelPort, jaegerIngressUrl };
    } catch (e: any) {
      lastError = e;
      if (result) {
        console.log(`  [data] ❌ Failed on provider ${result.provider} (DSEQ ${result.dseq}): ${e.message || e}`);
        recordProviderResult({
          service: 'data',
          provider: result.provider,
          outcome: 'failing',
          reason: e?.message || String(e),
          dseq: result.dseq,
          bidAmount: result.bidAmount,
          bidDenom: result.bidDenom,
        });
        triedProviders.add(result.provider);
        await closeDeploymentQuiet(chainSDK, owner, result.dseq, 'data');
      } else {
        console.log(`  [data] ❌ deploySDL failed (no lease created): ${e.message || e}`);
      }
      console.log(`  [data] Retrying with a different provider in 10s...`);
      await sleep(10_000);
    }
  }

  throw lastError || new Error('[data] Failed after provider failover attempts.');
}

// ─── Step 4: Deploy auth ────────────────────────────────────────────────────

async function deployAuth(
  chainSDK: any,
  owner: string,
  certificate: any,
  excludeProviders: Set<string>,
  databaseUrl: string
): Promise<AuthResult> {
  hr('STEP 4: Deploy auth (standalone, secrets via env vars)');

  const ghcrPat = mustEnv('GHCR_PAT');
  const jwtSecret = mustEnv('JWT_SECRET');
  const jwtRefreshSecret = optEnv('JWT_REFRESH_SECRET', jwtSecret + '-refresh');
  const resendApiKey = optEnv('RESEND_API_KEY');
  const stripeSecretKey = optEnv('STRIPE_SECRET_KEY');
  const openaiApiKey = optEnv('OPENAI_API_KEY');

  let sdlContent = mustReadFile(path.join(ROOT, 'service-auth/deploy-akash.yaml'));

  // Replace :latest with unique tag to force Akash provider to pull fresh image
  const authTag = process.env._AUTH_IMAGE_TAG;
  if (authTag) {
    sdlContent = sdlContent.replace(
      /service-auth:latest/g,
      `service-auth:${authTag}`
    );
    console.log(`  [auth] Using image tag: ${authTag}`);
  }

  // Substitute GHCR credentials
  sdlContent = sdlContent.replace(/\$\{GHCR_PAT\}/g, ghcrPat);

  // Remove Infisical env vars (auth will use env var fallback instead)
  sdlContent = sdlContent.replace(/\$\{INFISICAL_CLIENT_ID\}/g, '');
  sdlContent = sdlContent.replace(/\$\{INFISICAL_CLIENT_SECRET\}/g, '');
  sdlContent = sdlContent.replace(/\$\{INFISICAL_PROJECT_ID\}/g, '');

  // Inject DATABASE_URL and runtime secrets directly into the env section
  // (replacing the Infisical comment with actual env vars)
  sdlContent = sdlContent.replace(
    '      # DATABASE_URL is now fetched from Infisical at runtime (PostgreSQL connection string)\n' +
      '      # Format: postgresql://user:password@host:5432/database',
    `      # Database - PostgreSQL (direct env var, no Infisical)\n` +
      `      - DATABASE_URL=${databaseUrl}\n` +
      `      # Secrets injected directly (Infisical skipped)\n` +
      `      - JWT_SECRET=${jwtSecret}\n` +
      `      - JWT_REFRESH_SECRET=${jwtRefreshSecret}\n` +
      `      - RESEND_API_KEY=${resendApiKey}\n` +
      `      - STRIPE_SECRET_KEY=${stripeSecretKey}\n` +
      `      - OPENAI_API_KEY=${openaiApiKey}`
  );

  const triedProviders = new Set<string>();
  let lastError: any = null;

  for (let attempt = 1; attempt <= MAX_PROVIDER_FAILOVERS; attempt++) {
    const attemptExclude = new Set<string>([...excludeProviders, ...triedProviders]);
    console.log(`\n  [auth] Provider attempt ${attempt}/${MAX_PROVIDER_FAILOVERS}...`);

    let result: any;
    try {
      result = await deploySDL(sdlContent, attemptExclude, 5_000_000, chainSDK, owner, certificate, 'auth', 'inline');
      // Wait for services
      const status = await waitForServices(
        result.providerHostUri,
        result.dseq,
        result.gseq,
        result.oseq,
        certificate,
        'auth'
      );

      let ingressUrl = '';
      let rawIngressUrl = '';
      if (status?.services) {
        for (const [, info] of Object.entries(status.services) as any) {
          const uris = info?.uris || [];
          // Prefer the raw provider ingress URL (contains .ingress.) over
          // custom domain names to avoid circular proxy routing.
          for (const uri of uris) {
            if (!ingressUrl) ingressUrl = uri;
            if (uri.includes('.ingress.')) rawIngressUrl = uri;
          }
        }
      }

      // Use raw ingress URL if available (critical for proxy config)
      const finalIngressUrl = rawIngressUrl || ingressUrl;
      console.log(`  Auth ingress: ${finalIngressUrl || '(not found)'}`);
      if (rawIngressUrl && rawIngressUrl !== ingressUrl) {
        console.log(`  Auth custom domain: ${ingressUrl} (not used for proxy)`);
      }
      if (!finalIngressUrl) {
        throw new Error('[auth] Could not detect ingress URL from lease status.');
      }

      recordProviderResult({
        service: 'auth',
        provider: result.provider,
        outcome: 'working',
        dseq: result.dseq,
        bidAmount: result.bidAmount,
        bidDenom: result.bidDenom,
      });
      return { ...result, ingressUrl: finalIngressUrl };
    } catch (e: any) {
      lastError = e;
      if (result) {
        console.log(`  [auth] ❌ Failed on provider ${result.provider} (DSEQ ${result.dseq}): ${e.message || e}`);
        recordProviderResult({
          service: 'auth',
          provider: result.provider,
          outcome: 'failing',
          reason: e?.message || String(e),
          dseq: result.dseq,
          bidAmount: result.bidAmount,
          bidDenom: result.bidDenom,
        });
        triedProviders.add(result.provider);
        await closeDeploymentQuiet(chainSDK, owner, result.dseq, 'auth');
      } else {
        console.log(`  [auth] ❌ deploySDL failed (no lease created): ${e.message || e}`);
      }
      console.log(`  [auth] Retrying with a different provider in 10s...`);
      await sleep(10_000);
    }
  }

  throw lastError || new Error('[auth] Failed after provider failover attempts.');
}

// ─── Step 5: Deploy API ─────────────────────────────────────────────────────

async function deployApi(
  chainSDK: any,
  owner: string,
  certificate: any,
  excludeProviders: Set<string>,
  databaseUrl: string,
  ipfsApiUrl: string,
  otelEndpoint: string
): Promise<ApiResult> {
  hr('STEP 5: Deploy API (standalone)');

  const jwtSecret = mustEnv('JWT_SECRET');
  const resendApiKey = optEnv('RESEND_API_KEY');
  const arweaveWallet = optEnv('ARWEAVE_WALLET');
  const filecoinWalletKey = optEnv('FILECOIN_WALLET_KEY');
  const sentryDsn = optEnv('SENTRY_DSN', '');
  const akashMnemonic = optEnv('AKASH_MNEMONIC');
  const rpcEndpoint = optEnv('RPC_ENDPOINT', 'https://rpc.akashnet.net:443');
  const grpcEndpoint = optEnv('GRPC_ENDPOINT', 'https://akash-grpc.publicnode.com:443');
  const akashMcpPath = optEnv('AKASH_MCP_PATH', '/app/akash-mcp/dist/index.js');

  // CRITICAL: The cloud-api container runs the akash-mcp as a subprocess.
  // Without the certificate available, the MCP process crashes on startup
  // (trying to revoke+regenerate on-chain), producing the opaque error
  // "MCP process not running". Inject the certificate as base64-encoded JSON
  // so it loads instantly from env without any network calls.
  const certJson = JSON.stringify({
    cert: certificate.cert,
    publicKey: certificate.publicKey,
    privateKey: certificate.privateKey,
  });
  const akashCertJsonB64 = Buffer.from(certJson).toString('base64');

  let sdlContent = mustReadFile(path.join(ROOT, 'service-cloud-api/deploy-api.yaml'));

  // Replace :latest with unique tag to force Akash provider to pull fresh image
  const apiTag = process.env._API_IMAGE_TAG;
  if (apiTag) {
    sdlContent = sdlContent.replace(
      /service-cloud-api:latest/g,
      `service-cloud-api:${apiTag}`
    );
    console.log(`  [api] Using image tag: ${apiTag}`);
  }

  sdlContent = sdlContent.replace(/__DATABASE_URL__/g, databaseUrl);
  sdlContent = sdlContent.replace(/__IPFS_API_URL__/g, ipfsApiUrl);
  sdlContent = sdlContent.replace(/__OTEL_ENDPOINT__/g, otelEndpoint);
  sdlContent = sdlContent.replace(
    /your_jwt_secret_min_32_chars_please_change_this_in_production/g,
    jwtSecret
  );
  sdlContent = sdlContent.replace(/your_resend_api_key/g, resendApiKey);
  sdlContent = sdlContent.replace(/your_arweave_wallet/g, arweaveWallet);
  sdlContent = sdlContent.replace(/your_filecoin_wallet_key/g, filecoinWalletKey);
  sdlContent = sdlContent.replace(/__AKASH_MNEMONIC__/g, akashMnemonic);
  sdlContent = sdlContent.replace(/__RPC_ENDPOINT__/g, rpcEndpoint);
  sdlContent = sdlContent.replace(/__GRPC_ENDPOINT__/g, grpcEndpoint);
  sdlContent = sdlContent.replace(/__AKASH_MCP_PATH__/g, akashMcpPath);
  sdlContent = sdlContent.replace(/__AKASH_CERT_JSON__/g, akashCertJsonB64);
  if (sentryDsn) {
    sdlContent = sdlContent.replace(/your_sentry_dsn/g, sentryDsn);
  }

  sdlContent = injectGhcrCredentials(sdlContent);

  const triedProviders = new Set<string>();
  let lastError: any = null;

  for (let attempt = 1; attempt <= MAX_PROVIDER_FAILOVERS; attempt++) {
    const attemptExclude = new Set<string>([...excludeProviders, ...triedProviders]);
    console.log(`\n  [api] Provider attempt ${attempt}/${MAX_PROVIDER_FAILOVERS}...`);

    let result: any;
    try {
      result = await deploySDL(sdlContent, attemptExclude, 5_000_000, chainSDK, owner, certificate, 'api', 'inline');
      const status = await waitForServices(
        result.providerHostUri,
        result.dseq,
        result.gseq,
        result.oseq,
        certificate,
        'api'
      );

      let apiIngressUrl = '';
      let rawApiIngressUrl = '';
      if (status?.services) {
        for (const [, info] of Object.entries(status.services) as any) {
          const uris = info?.uris || [];
          for (const uri of uris) {
            if (!apiIngressUrl) apiIngressUrl = uri;
            if (uri.includes('.ingress.')) rawApiIngressUrl = uri;
          }
        }
      }

      const finalApiIngressUrl = rawApiIngressUrl || apiIngressUrl;
      console.log(`  API ingress: ${finalApiIngressUrl || '(not found)'}`);
      if (rawApiIngressUrl && rawApiIngressUrl !== apiIngressUrl) {
        console.log(`  API custom domain: ${apiIngressUrl} (not used for proxy)`);
      }
      if (!finalApiIngressUrl) {
        throw new Error('[api] Could not detect ingress URL from lease status.');
      }

      recordProviderResult({
        service: 'api',
        provider: result.provider,
        outcome: 'working',
        dseq: result.dseq,
        bidAmount: result.bidAmount,
        bidDenom: result.bidDenom,
      });
      return { ...result, apiIngressUrl: finalApiIngressUrl };
    } catch (e: any) {
      lastError = e;
      if (result) {
        console.log(`  [api] ❌ Failed on provider ${result.provider} (DSEQ ${result.dseq}): ${e.message || e}`);
        recordProviderResult({
          service: 'api',
          provider: result.provider,
          outcome: 'failing',
          reason: e?.message || String(e),
          dseq: result.dseq,
          bidAmount: result.bidAmount,
          bidDenom: result.bidDenom,
        });
        triedProviders.add(result.provider);
        await closeDeploymentQuiet(chainSDK, owner, result.dseq, 'api');
      } else {
        console.log(`  [api] ❌ deploySDL failed (no lease created): ${e.message || e}`);
      }
      console.log(`  [api] Retrying with a different provider in 10s...`);
      await sleep(10_000);
    }
  }

  throw lastError || new Error('[api] Failed after provider failover attempts.');
}

// ─── Step 6: Deploy SSL proxy ───────────────────────────────────────────────

async function deployProxy(
  chainSDK: any,
  owner: string,
  certificate: any,
  excludeProviders: Set<string>
): Promise<ProxyResult> {
  hr('STEP 6: Deploy SSL proxy (Pingap with IP lease)');

  const sdlTemplateFile = path.join(ROOT, 'infrastructure-proxy/deploy-akash-ip-lease.yaml');
  const tls = loadProxyTlsMaterial();

  let sdlContent = mustReadFile(sdlTemplateFile);
  sdlContent = sdlContent.replace('<REPLACE_WITH_ORIGIN_CERT>', tls.certPiped);
  sdlContent = sdlContent.replace('<REPLACE_WITH_ORIGIN_KEY>', tls.keyPiped);

  if (sdlContent.includes('<REPLACE_WITH_ORIGIN_CERT>') || sdlContent.includes('<REPLACE_WITH_ORIGIN_KEY>')) {
    throw new Error('SDL TLS placeholders were not replaced.');
  }

  // If a custom image tag was built (Step 6.5), replace :main with the
  // specific tag to force the provider to pull the new image.
  const customProxyTag = process.env._PROXY_IMAGE_TAG;
  if (customProxyTag && customProxyTag !== 'main') {
    sdlContent = sdlContent.replace(
      /infrastructure-proxy-pingap:main/g,
      `infrastructure-proxy-pingap:${customProxyTag}`
    );
    console.log(`  [SSL-proxy] Using custom image tag: ${customProxyTag}`);
  }

  const triedProviders = new Set<string>();
  let lastError: any = null;

  console.log(`  [SSL-proxy] TLS source: ${tls.source}`);

  for (let attempt = 1; attempt <= MAX_PROVIDER_FAILOVERS; attempt++) {
    const attemptExclude = new Set<string>([...excludeProviders, ...triedProviders]);
    console.log(`\n  [SSL-proxy] Provider attempt ${attempt}/${MAX_PROVIDER_FAILOVERS}...`);

    let result: any;
    try {
      result = await deploySDL(sdlContent, attemptExclude, 5_000_000, chainSDK, owner, certificate, 'SSL-proxy', 'inline');

      // Wait for services and extract IP
      console.log(`  [SSL-proxy] Waiting for IP lease assignment...`);
      let ip = '';

      for (let ipAttempt = 1; ipAttempt <= 15; ipAttempt++) {
        await sleep(10_000);
        try {
          const status = await queryLeaseStatus(
            result.providerHostUri,
            result.dseq,
            result.gseq,
            result.oseq,
            certificate
          );

          // Check for IP in the ips section
          if (status?.ips) {
            for (const [, ipList] of Object.entries(status.ips) as any) {
              if (Array.isArray(ipList)) {
                for (const entry of ipList) {
                  if (entry.IP) {
                    ip = entry.IP;
                    break;
                  }
                }
              }
              if (ip) break;
            }
          }

          // Fallback: try to find IP in the JSON text
          if (!ip) {
            const text = JSON.stringify(status);
            const ipMatch = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
            if (ipMatch) ip = ipMatch[0];
          }

          if (ip) {
            console.log(`  [SSL-proxy] Leased IP: ${ip}`);
            recordProviderResult({
              service: 'SSL-proxy',
              provider: result.provider,
              outcome: 'working',
              dseq: result.dseq,
              bidAmount: result.bidAmount,
              bidDenom: result.bidDenom,
            });
            return { ...result, ip };
          }

          console.log(`    Attempt ${ipAttempt}/15: No IP yet...`);
        } catch (e: any) {
          console.log(`    Attempt ${ipAttempt}/15: ${e.message || e}`);
        }
      }

      throw new Error('[SSL-proxy] Timed out waiting for IP lease assignment.');
    } catch (e: any) {
      lastError = e;
      if (result) {
        console.log(
          `  [SSL-proxy] ❌ Failed on provider ${result.provider} (DSEQ ${result.dseq}): ${e.message || e}`
        );
        recordProviderResult({
          service: 'SSL-proxy',
          provider: result.provider,
          outcome: 'failing',
          reason: e?.message || String(e),
          dseq: result.dseq,
          bidAmount: result.bidAmount,
          bidDenom: result.bidDenom,
        });
        triedProviders.add(result.provider);
        await closeDeploymentQuiet(chainSDK, owner, result.dseq, 'SSL-proxy');
      } else {
        console.log(`  [SSL-proxy] ❌ deploySDL failed (no lease created): ${e.message || e}`);
      }
      console.log(`  [SSL-proxy] Retrying with a different provider in 10s...`);
      await sleep(10_000);
    }
  }

  throw lastError || new Error('[SSL-proxy] Failed after provider failover attempts.');
}

// ─── Step 4.5: Run database migrations + seed ──────────────────────────────
//
// CRITICAL: Two services share the same PostgreSQL database with SEPARATE
// Prisma schemas (service-auth and service-cloud-api). See INCIDENTS.md.
//
//   - service-auth: uses `prisma migrate deploy` (migrations are complete)
//   - service-cloud-api: migrations are NOW COMPLETE (2026-02-09 fix: merged
//     Organization/Service/Billing tables into the first migration). The
//     `migrate diff` fallback below is kept for safety but should be a no-op.
//
//   NEVER use `prisma db push` for cloud-api — it drops all auth tables.

async function runDatabaseMigrations(databaseUrl: string): Promise<void> {
  hr('STEP 4.5: Run database migrations + seed');

  const authDir = path.join(ROOT, 'service-auth');
  const apiDir = path.join(ROOT, 'service-cloud-api');
  const env = { ...process.env, DATABASE_URL: databaseUrl };

  // ── 1. service-auth: prisma migrate deploy ──
  // Safe: only applies pending migration files, never drops tables.
  console.log('  [auth] Running prisma migrate deploy...');
  try {
    const migrateOutput = execSync('npx prisma migrate deploy', {
      cwd: authDir,
      env,
      stdio: 'pipe',
      timeout: 120_000,
    }).toString();
    console.log('  ' + migrateOutput.split('\n').filter(l => l.trim()).join('\n  '));
  } catch (e: any) {
    const stderr = e.stderr?.toString() || '';
    const stdout = e.stdout?.toString() || '';
    // db push is ONLY safe for auth because it's the first service to touch
    // the DB on a clean deploy. Once cloud-api tables exist this would be
    // destructive, but on a clean deploy the DB is empty at this point.
    console.log(`  [auth] prisma migrate deploy failed: ${stderr || stdout}`);
    console.log('  [auth] Trying prisma db push (safe for initial schema creation)...');
    try {
      const pushOutput = execSync('npx prisma db push', {
        cwd: authDir,
        env,
        stdio: 'pipe',
        timeout: 120_000,
      }).toString();
      console.log('  ' + pushOutput.split('\n').filter(l => l.trim()).join('\n  '));
    } catch (pushErr: any) {
      console.error('  [auth] prisma db push also failed:', pushErr.stderr?.toString() || pushErr.message);
      throw new Error('[auth] Database migration failed. Cannot continue without tables.');
    }
  }

  // ── 2. Seed auth subscription plans ──
  console.log('\n  [auth] Seeding subscription plans...');
  try {
    const seedOutput = execSync('npx tsx scripts/seed-plans.ts', {
      cwd: authDir,
      env,
      stdio: 'pipe',
      timeout: 60_000,
    }).toString();
    console.log('  ' + seedOutput.split('\n').filter(l => l.trim()).join('\n  '));
  } catch (e: any) {
    const errMsg = e.stderr?.toString() || e.stdout?.toString() || e.message;
    console.log(`  [auth] Seed warning (non-fatal): ${errMsg}`);
  }

  // ── 3. service-cloud-api: additive-only schema sync ──
  // Cloud-api migrations are now complete (2026-02-09 fix), so this diff
  // should normally be a no-op. Kept as a safety net to catch any future
  // schema drift without destructive DROPs.
  //
  // NEVER use `prisma db push` here — it would drop all auth_* tables.
  console.log('\n  [cloud-api] Syncing schema (additive-only, no DROPs)...');
  try {
    // Generate diff: current DB state → target schema
    const diffSql = execSync(
      `npx prisma migrate diff --from-url "${databaseUrl}" --to-schema-datamodel prisma/schema.prisma --script`,
      {
        cwd: apiDir,
        env,
        stdio: 'pipe',
        timeout: 120_000,
      }
    ).toString();

    // Check if there's anything to do
    if (!diffSql.trim()) {
      console.log('  [cloud-api] Schema already in sync. Nothing to do.');
    } else {
      // Filter out all destructive statements (DROP TABLE, DROP CONSTRAINT,
      // DROP TYPE, DropForeignKey). Keep only CREATE/ALTER...ADD/AddForeignKey.
      const safeLines: string[] = [];
      let skip = false;
      for (const line of diffSql.split('\n')) {
        const trimmed = line.trim();
        // Skip comment lines that indicate destructive operations
        if (trimmed.startsWith('-- Drop') || trimmed.startsWith('-- DropTable') ||
            trimmed.startsWith('-- DropForeignKey') || trimmed.startsWith('-- DropEnum')) {
          skip = true;
          continue;
        }
        // Skip actual DROP/ALTER...DROP statements
        if (trimmed.startsWith('DROP ') || trimmed.match(/^ALTER TABLE .+ DROP /)) {
          skip = true;
          continue;
        }
        // A new comment section means we might be back to safe territory
        if (trimmed.startsWith('-- ') && !trimmed.startsWith('-- Drop')) {
          skip = false;
        }
        if (!skip) {
          safeLines.push(line);
        }
        // Reset skip on blank lines (statement boundaries)
        if (trimmed === '') {
          skip = false;
        }
      }

      const safeSql = safeLines.join('\n').trim();
      if (!safeSql) {
        console.log('  [cloud-api] Only destructive changes detected (skipped). Schema OK.');
      } else {
        // Double-check: refuse to execute if any DROP slipped through
        if (safeSql.includes('DROP TABLE') || safeSql.includes('DROP TYPE') || safeSql.includes('DROP CONSTRAINT')) {
          console.error('  [cloud-api] ✖ Safety check failed: DROP statement found in filtered SQL.');
          console.error('  [cloud-api] Skipping cloud-api schema sync to protect auth tables.');
          console.error('  [cloud-api] Run manually: prisma migrate diff + filter + prisma db execute');
        } else {
          // Write to temp file and execute
          const tmpSql = path.resolve(__dirname, '../.local/_cloud-api-schema-sync.sql');
          fs.mkdirSync(path.dirname(tmpSql), { recursive: true });
          fs.writeFileSync(tmpSql, safeSql);

          const stmtCount = (safeSql.match(/;\s*$/gm) || []).length;
          console.log(`  [cloud-api] Applying ${stmtCount} additive statement(s)...`);

          execSync(
            `npx prisma db execute --url "${databaseUrl}" --stdin < "${tmpSql}"`,
            {
              cwd: apiDir,
              env,
              stdio: 'pipe',
              timeout: 120_000,
            }
          );
          console.log('  [cloud-api] ✓ Schema synced successfully.');

          // Clean up temp file
          try { fs.unlinkSync(tmpSql); } catch {}
        }
      }
    }

    // Mark all cloud-api migrations as applied so future `migrate deploy`
    // doesn't try to re-run them and fail on already-existing objects.
    try {
      const migrationDir = path.join(apiDir, 'prisma/migrations');
      if (fs.existsSync(migrationDir)) {
        const migrations = fs.readdirSync(migrationDir)
          .filter(d => fs.statSync(path.join(migrationDir, d)).isDirectory())
          .sort();
        for (const migration of migrations) {
          try {
            execSync(
              `npx prisma migrate resolve --applied ${migration}`,
              { cwd: apiDir, env, stdio: 'pipe', timeout: 30_000 }
            );
          } catch {
            // Already applied or doesn't exist in _prisma_migrations — fine
          }
        }
        if (migrations.length > 0) {
          console.log(`  [cloud-api] Marked ${migrations.length} migration(s) as applied.`);
        }
      }
    } catch (e: any) {
      console.log(`  [cloud-api] Migration resolve warning: ${e.message || e}`);
    }
  } catch (e: any) {
    const errMsg = e.stderr?.toString() || e.message || String(e);
    // Don't fail the entire deploy for cloud-api schema issues — the auth
    // service is the critical path. Log prominently so it's noticed.
    console.error(`  [cloud-api] ✖ Schema sync failed: ${errMsg}`);
    console.error('  [cloud-api] The API service may fail on DB operations.');
    console.error('  [cloud-api] Fix manually: see INCIDENTS.md (Shared Postgres + Prisma policy)');
  }

  // ── 4. Verify critical tables from BOTH services exist ──
  console.log('\n  Verifying critical database tables...');
  try {
    const verifyOutput = execSync(
      `npx tsx -e "
        import { PrismaClient } from '@prisma/client';
        (async () => {
          const p = new PrismaClient();
          const codes = await p.verificationCode.count();
          const plans = await p.subscriptionPlan.count();
          console.log('auth_verification_codes: OK');
          console.log('auth_subscription_plans: ' + plans + ' plans');
          await p.\\$disconnect();
        })();
      "`,
      {
        cwd: authDir,
        env,
        stdio: 'pipe',
        timeout: 30_000,
      }
    ).toString();
    console.log('  ' + verifyOutput.split('\n').filter(l => l.trim()).join('\n  '));
  } catch (e: any) {
    const errMsg = e.stderr?.toString() || e.message;
    console.log(`  ⚠ Auth table verification warning: ${errMsg}`);
  }

  // Verify cloud-api tables
  try {
    const verifyApiOutput = execSync(
      `npx tsx -e "
        import { PrismaClient } from '@prisma/client';
        (async () => {
          const p = new PrismaClient();
          const projects = await p.project.count();
          const services = await p.service.count();
          const orgs = await p.organization.count();
          console.log('Project: OK (' + projects + ' rows)');
          console.log('Service: OK (' + services + ' rows)');
          console.log('Organization: OK (' + orgs + ' rows)');
          await p.\\$disconnect();
        })();
      "`,
      {
        cwd: apiDir,
        env,
        stdio: 'pipe',
        timeout: 30_000,
      }
    ).toString();
    console.log('  ' + verifyApiOutput.split('\n').filter(l => l.trim()).join('\n  '));
  } catch (e: any) {
    const errMsg = e.stderr?.toString() || e.message;
    console.log(`  ⚠ Cloud-API table verification warning: ${errMsg}`);
  }

  console.log('  ✓ Database migrations and seeding complete.');
}

// ─── Step 6.5: Build + push proxy image ────────────────────────────────────

function isDockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'pipe', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function isGhcrAuthenticated(): boolean {
  try {
    execSync('docker login ghcr.io --get-login', { stdio: 'pipe', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Build and push the proxy Docker image with the updated pingap.toml.
 * Returns the image tag to use in the proxy SDL.
 *
 * Requires Docker to be running and GHCR_PAT to have write:packages scope.
 * Throws on failure — there is no fallback. The proxy MUST be deployed with
 * the freshly-built image containing the correct pingap.toml upstream URLs.
 */
function buildAndPushProxyImage(): string {
  const proxyDir = path.join(ROOT, 'infrastructure-proxy');
  const imageBase = 'ghcr.io/alternatefutures/infrastructure-proxy-pingap';
  const tag = `deploy-${Date.now()}`;
  const fullImage = `${imageBase}:${tag}`;

  // Docker + GHCR auth were already validated in the pre-flight checks.
  // Build with explicit AMD64 platform (Akash providers are AMD64).
  console.log(`  Building: ${fullImage} (--platform linux/amd64)...`);
  try {
    execSync(
      `docker buildx build --platform linux/amd64 -t ${fullImage} -t ${imageBase}:main --push .`,
      {
        cwd: proxyDir,
        stdio: 'inherit',
        timeout: 300_000, // 5 minute timeout
      }
    );
  } catch (e: any) {
    const errMsg = e.message || String(e);
    if (errMsg.includes('permission_denied') || errMsg.includes('expected scopes')) {
      throw new Error(
        'Docker push to GHCR failed: permission denied.\n' +
        '  Your GHCR_PAT token does not have the write:packages scope.\n' +
        '  Go to https://github.com/settings/tokens and update the token,\n' +
        '  then set the new value in .env.deploy and re-run.'
      );
    }
    throw new Error(`Docker build+push failed: ${errMsg}`);
  }

  console.log(`  ✓ Proxy image built and pushed: ${fullImage}`);
  return tag;
}

/**
 * Build and push the service Docker images (auth + cloud-api).
 *
 * This ensures the Akash-deployed containers always have the latest code,
 * schema, and Prisma client. Without this, deploying after schema changes
 * causes silent runtime failures (e.g. Prisma client missing new fields).
 *
 * Requires Docker to be running and GHCR_PAT to have write:packages scope.
 */
function buildAndPushServiceImages(): void {
  hr('STEP 0.5: Build + push service Docker images');

  // Use unique timestamp tags to force Akash providers to pull fresh images.
  // Providers cache :latest and won't re-pull it even if the digest changed.
  // This is the same strategy used for the proxy image.
  const tag = `deploy-${Date.now()}`;

  const authDir = path.join(ROOT, 'service-auth');
  const authBase = 'ghcr.io/alternatefutures/service-auth';
  const authImage = `${authBase}:${tag}`;

  console.log(`  Building: ${authImage} (--platform linux/amd64)...`);
  try {
    execSync(
      `docker buildx build --no-cache --platform linux/amd64 -t ${authImage} -t ${authBase}:latest --push .`,
      { cwd: authDir, stdio: 'inherit', timeout: 600_000 }
    );
    console.log(`  ✓ Auth image built and pushed: ${authImage}`);
  } catch (e: any) {
    throw new Error(`Auth image build+push failed: ${e.message || e}`);
  }

  // cloud-api Dockerfile expects the monorepo root as build context
  // (it copies from service-cloud-api/ and akash-mcp/ paths)
  const apiBase = 'ghcr.io/alternatefutures/service-cloud-api';
  const apiImage = `${apiBase}:${tag}`;

  console.log(`\n  Building: ${apiImage} (--platform linux/amd64)...`);
  try {
    execSync(
      `docker buildx build --no-cache --platform linux/amd64 -f service-cloud-api/Dockerfile -t ${apiImage} -t ${apiBase}:latest --push .`,
      { cwd: ROOT, stdio: 'inherit', timeout: 600_000 }
    );
    console.log(`  ✓ Cloud API image built and pushed: ${apiImage}`);
  } catch (e: any) {
    throw new Error(`Cloud API image build+push failed: ${e.message || e}`);
  }

  // Store tags so deployAuth/deployApi can inject them into SDLs
  process.env._AUTH_IMAGE_TAG = tag;
  process.env._API_IMAGE_TAG = tag;
  console.log(`  Image tag: ${tag}\n`);
}

// ─── Persist deployment info to .env.deploy ─────────────────────────────────

function persistDeploymentInfo(
  database: DatabaseResult,
  data: DataResult,
  auth: AuthResult,
  api: ApiResult,
  proxy: ProxyResult | null,
  databaseUrl: string,
  dbPassword: string
): void {
  const envDeployPath = path.resolve(__dirname, '../.env.deploy');
  let content = '';

  if (fs.existsSync(envDeployPath)) {
    content = fs.readFileSync(envDeployPath, 'utf-8');
  }

  // Helper: set or update a key=value in the content
  function setEnvVar(key: string, value: string): void {
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
    } else {
      // Append at end
      content = content.trimEnd() + `\n${key}=${value}\n`;
    }
  }

  // Database
  setEnvVar('POSTGRES_PASSWORD', dbPassword);
  setEnvVar('YSQL_PASSWORD', dbPassword);
  setEnvVar('DATABASE_URL', databaseUrl);

  // Deployment identifiers
  setEnvVar('AUTH_DSEQ', String(auth.dseq));
  setEnvVar('AUTH_PROVIDER', auth.provider);
  setEnvVar('API_DSEQ', String(api.dseq));
  setEnvVar('API_PROVIDER', api.provider);
  if (proxy) {
    setEnvVar('PROXY_DSEQ', String(proxy.dseq));
    setEnvVar('PROXY_PROVIDER', proxy.provider);
  }

  // Data services
  if (data.ipfsApiHost && data.ipfsApiPort) {
    setEnvVar('IPFS_API_URL', `http://${data.ipfsApiHost}:${data.ipfsApiPort}`);
  }

  fs.writeFileSync(envDeployPath, content);
  console.log('  Persisted deployment info to .env.deploy');
}

// ─── Step 5: Update config files ────────────────────────────────────────────

function updateConfigFiles(
  database: DatabaseResult,
  data: DataResult,
  api: ApiResult,
  auth: AuthResult,
  proxy: ProxyResult
) {
  hr('STEP 8: Update config files');

  // pingap.toml was already updated in Step 6 (before proxy deploy) to prevent
  // circular routing. No need to update it again here.
  console.log('  pingap.toml: already updated in Step 6 (skipping)');

  // 8a. Update service-auth update-manifest.yml
  const authManifestPath = path.join(ROOT, 'service-auth/.github/workflows/update-manifest.yml');
  let authManifest = mustReadFile(authManifestPath);
  authManifest = authManifest.replace(
    /AUTH_DSEQ: "\d+"/,
    `AUTH_DSEQ: "${auth.dseq}"`
  );
  authManifest = authManifest.replace(
    /AUTH_PROVIDER: "[^"]+"/,
    `AUTH_PROVIDER: "${auth.provider}"`
  );
  fs.writeFileSync(authManifestPath, authManifest);
  console.log('  Updated: service-auth/.github/workflows/update-manifest.yml');

  // 6c. Update service-cloud-api update-manifest.yml (API-only deployment)
  const cloudApiManifestPath = path.join(ROOT, 'service-cloud-api/.github/workflows/update-manifest.yml');
  let cloudApiManifest = mustReadFile(cloudApiManifestPath);
  cloudApiManifest = cloudApiManifest.replace(
    /DSEQ_api: "\d+"/,
    `DSEQ_api: "${api.dseq}"`
  );
  cloudApiManifest = cloudApiManifest.replace(
    /PROVIDER_api: "[^"]+"/,
    `PROVIDER_api: "${api.provider}"`
  );
  fs.writeFileSync(cloudApiManifestPath, cloudApiManifest);
  console.log('  Updated: service-cloud-api/.github/workflows/update-manifest.yml');

  // 6d. Update root DEPLOYMENTS.md
  const deploymentsPath = path.join(ROOT, 'DEPLOYMENTS.md');
  const now = new Date().toISOString().split('T')[0];

  const deploymentsContent = `# Akash Deployments

## Production Services

| Service | DSEQ | Provider | Deployed | Notes |
|---------|------|----------|----------|-------|
| postgres (db) | ${database.dseq} | \`${database.provider}\` | ${now} | PostgreSQL 16 Alpine, persistent storage |
| data services | ${data.dseq} | \`${data.provider}\` | ${now} | IPFS + Jaeger (OTel collector disabled) |
| api | ${api.dseq} | \`${api.provider}\` | ${now} | GraphQL API |
| service-auth | ${auth.dseq} | \`${auth.provider}\` | ${now} | Standalone auth service |
| infrastructure-proxy (SSL) | ${proxy.dseq} | \`${proxy.provider}\` | ${now} | Pingap SSL proxy, dedicated IP ${proxy.ip || 'TBD'} |

## Endpoints

- **API**: https://api.alternatefutures.ai (via SSL proxy)
- **Auth**: https://auth.alternatefutures.ai (via SSL proxy)
- **Web App**: https://app.alternatefutures.ai (Vercel)
- **Data services (IPFS + Jaeger)**: deployed on Akash — see Cloudmos for provider ingress URLs (custom-domain routing depends on \`infrastructure-proxy/pingap.toml\`)

## Database Connection

PostgreSQL is exposed globally via TCP:
- **Host**: ${database.dbHost}
- **Port**: ${database.dbPort}
- **User**: alternatefutures
- **Database**: alternatefutures
- **Connection string**: \`postgresql://alternatefutures:<password>@${database.dbHost}:${database.dbPort}/alternatefutures\`

## Secrets Management

Secrets are injected directly as SDL environment variables at deploy time (no Infisical).
The auth service reads JWT_SECRET, RESEND_API_KEY, etc. from env vars.

## CI/CD Workflows

### service-auth
| Workflow | Trigger | What it does |
|----------|---------|--------------|
| \`deploy-akash.yml\` | Manual (workflow_dispatch) | Full redeploy - creates NEW DSEQ, requires DNS/proxy update |
| \`update-manifest.yml\` | Auto (after Docker build) or manual | In-place update - same DSEQ, updates on-chain deployment + sends manifest |
| \`docker-build.yml\` | Push to main | Builds and publishes Docker image to GHCR |

### service-cloud-api
| Workflow | Trigger | What it does |
|----------|---------|--------------|
| \`deploy-akash.yml\` | Manual (workflow_dispatch) | Full redeploy - creates NEW DSEQ |
| \`update-manifest.yml\` | Auto or manual | In-place manifest update |

## Wallet

- Address: \`akash1degudmhf24auhfnqtn99mkja3xt7clt9um77tn\`
- Explorer: [Cloudmos](https://deploy.cloudmos.io/addresses/akash1degudmhf24auhfnqtn99mkja3xt7clt9um77tn)

## Blocked Providers

| Provider | Reason |
|----------|--------|
| \`akash1smapjx8m8363nmdvc2yr9atlqy8vcql73m9l0v\` | Broken hostname |
| \`akash1qmumr9mdnu9e8ymyr3nnf3qyjfkugj79eh6jzq\` | yggdrasil-compute.com - broken DNS (doubled provider prefix) |

---

*Last updated: ${now}*
`;

  fs.writeFileSync(deploymentsPath, deploymentsContent);
  console.log('  Updated: DEPLOYMENTS.md');
}

// ─── Step 6: Print summary ──────────────────────────────────────────────────

function printSummary(
  database: DatabaseResult,
  data: DataResult,
  api: ApiResult,
  auth: AuthResult,
  proxy: ProxyResult | null,
  databaseUrl: string,
  opts?: { skipManualSteps?: boolean }
) {
  hr('DEPLOYMENT COMPLETE - SUMMARY');

  console.log(`
  postgres (db)
    DSEQ:       ${database.dseq}
    Provider:   ${database.provider}
    PostgreSQL: ${database.dbHost}:${database.dbPort}

  data services
    DSEQ:       ${data.dseq}
    Provider:   ${data.provider}
    IPFS:       ${data.ipfsIngressUrl || '(check Akash Console)'}
    OTel:       ${data.otelHost}:${data.otelPort}

  api
    DSEQ:     ${api.dseq}
    Provider: ${api.provider}
    API:      ${api.apiIngressUrl || '(check Akash Console)'}

  auth (Standalone)
    DSEQ:     ${auth.dseq}
    Provider: ${auth.provider}
    Ingress:  ${auth.ingressUrl || '(check Akash Console)'}

  SSL Proxy
    ${proxy ? `DSEQ:     ${proxy.dseq}\n    Provider: ${proxy.provider}\n    IP:       ${proxy.ip || '(check Akash Console)'}` : '(skipped)'}
`);

  if (opts?.skipManualSteps) return;

  hr('POST-DEPLOY CHECKLIST');

  const databaseUrlRedacted = redactDatabaseUrl(databaseUrl);

  console.log(`
  ✅ AUTOMATED (already done):
     - Service images built and pushed (auth + cloud-api → GHCR :latest)
     - Database migrations applied (prisma migrate deploy)
     - Subscription plans seeded (MONTHLY, YEARLY)
     - Deployment info saved to .env.deploy (DATABASE_URL, DSEQs, providers)
     - pingap.toml updated with raw provider ingress URLs
     - Proxy image built and pushed (tag: ${process.env._PROXY_IMAGE_TAG || 'main'})

  REMAINING MANUAL STEPS:

  1. UPDATE GITHUB SECRETS (if you use CI/CD):
     Set DATABASE_URL to:
     ${databaseUrlRedacted}

  2. UPDATE CLOUDFLARE DNS (if proxy IP changed):
     A records for *.alternatefutures.ai -> ${proxy?.ip || 'TBD'}

  3. COMMIT THE UPDATED CONFIG FILES:
     git add -A && git commit -m "Update deployment configs after full redeploy"
`);
}

// ─── Stale-process guard (lockfile-based) ────────────────────────────────────
// Only one redeploy-all should run at a time — concurrent instances deadlock on
// the wallet & Akash RPC. We use a lockfile containing the PID + process-group
// so we can reliably kill a previous run without accidentally matching our own
// ancestor shell (which also contains "redeploy-all.ts" in its command string).

const LOCKFILE_PATH = path.resolve(__dirname, '../.local/redeploy.lock');

function killStaleInstances(): void {
  try {
    if (!fs.existsSync(LOCKFILE_PATH)) return;

    const raw = fs.readFileSync(LOCKFILE_PATH, 'utf-8').trim();
    const stalePid = parseInt(raw, 10);
    if (!stalePid || stalePid === process.pid) return;

    // Check if that process is still alive
    try {
      process.kill(stalePid, 0); // signal 0 = existence check
    } catch {
      // Not running — stale lockfile, just clean it up
      console.log(`  Stale lockfile (PID ${stalePid} already exited) — removing.`);
      try { fs.unlinkSync(LOCKFILE_PATH); } catch { /* ignore */ }
      return;
    }

    // It's still alive — kill the process group to get npm + tsx + children
    console.log(`  ✖ Killing previous redeploy instance (PID ${stalePid})...`);
    try {
      // Try process group kill first (negative PID = process group)
      process.kill(-stalePid, 'SIGKILL');
    } catch {
      // Fallback: kill just the PID (may not be a group leader)
      try { process.kill(stalePid, 'SIGKILL'); } catch { /* gone */ }
    }

    // Also kill any orphaned child processes (npm exec tsx ...) via pkill
    try {
      execSync(
        `pkill -9 -f "tsx scripts/(redeploy-all|close-all-deployments|summarize-provider-registry)\\.ts" 2>/dev/null || true`,
        { stdio: 'pipe' },
      );
    } catch { /* best effort */ }

    // Give processes a moment to die
    try { execSync('sleep 1', { stdio: 'pipe' }); } catch { /* ignore */ }
    console.log('  Previous instance terminated.');
  } catch {
    // Can't read lockfile or something else went wrong — continue anyway
  }
}

function acquireLockfile(): void {
  fs.mkdirSync(path.dirname(LOCKFILE_PATH), { recursive: true });
  fs.writeFileSync(LOCKFILE_PATH, String(process.pid));
}

function releaseLockfile(): void {
  try {
    // Only remove if we still own it
    const content = fs.readFileSync(LOCKFILE_PATH, 'utf-8').trim();
    if (parseInt(content, 10) === process.pid) {
      fs.unlinkSync(LOCKFILE_PATH);
    }
  } catch { /* ignore */ }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('========================================');
  console.log('  FULL CLEAN REDEPLOY - AlternateFutures');
  console.log('========================================\n');

  // Kill any competing instances from previous runs to avoid wallet/RPC deadlocks
  console.log('Checking for stale redeploy processes...');
  killStaleInstances();
  acquireLockfile();
  // Release lockfile on any exit (normal, error, or signal)
  const onExit = () => releaseLockfile();
  process.on('exit', onExit);
  process.on('SIGINT', () => { onExit(); process.exit(130); });
  process.on('SIGTERM', () => { onExit(); process.exit(143); });
  console.log('');

  // Burn-in / telemetry modes (safe defaults: off)
  const skipProxy = process.env.AKASH_REDEPLOY_SKIP_PROXY === '1';
  const closeOnSuccess = process.env.AKASH_REDEPLOY_CLOSE_ON_SUCCESS === '1';

  // Validate required environment variables upfront
  console.log('Validating environment variables...');
  const requiredVars = ['JWT_SECRET', 'GHCR_PAT', 'AKASH_MNEMONIC'];

  const missing = requiredVars.filter((v) => !process.env[v]);
  if (!process.env.POSTGRES_PASSWORD && !process.env.YSQL_PASSWORD) {
    missing.push('POSTGRES_PASSWORD');
  }
  if (missing.length > 0) {
    console.error(`\nMissing required environment variables:\n  ${missing.join('\n  ')}`);
    console.error('\nCopy .env.deploy.example to .env.deploy and fill in your values.');
    process.exit(1);
  }
  console.log('All required environment variables present.\n');

  // Validate required files
  console.log('Validating required files...');
  const requiredFiles = [
    'service-cloud-api/infra/postgres-standalone.yaml',
    'service-cloud-api/deploy-data.yaml',
    'service-cloud-api/deploy-api.yaml',
    'service-auth/deploy-akash.yaml',
    'infrastructure-proxy/deploy-akash-ip-lease.yaml',
    'infrastructure-proxy/pingap.toml',
  ];

  for (const f of requiredFiles) {
    const full = path.join(ROOT, f);
    if (!fs.existsSync(full)) {
      console.error(`Missing required file: ${f}`);
      process.exit(1);
    }
  }
  console.log('All required files present.\n');

  // Validate proxy TLS material without printing it (open source-safe)
  if (!skipProxy) {
    try {
      const tls = loadProxyTlsMaterial();
      console.log(`SSL proxy TLS material present. Source: ${tls.source}\n`);
    } catch (e: any) {
      console.error(String(e?.message || e));
      process.exit(1);
    }
  } else {
    console.log('SSL proxy TLS check skipped (AKASH_REDEPLOY_SKIP_PROXY=1)\n');
  }

  // Validate Docker is available and can push to GHCR.
  // Docker is always required: service images (auth, cloud-api) are built
  // locally to ensure Akash containers have the latest code + Prisma client.
  // The proxy image also requires Docker when !skipProxy.
  {
    console.log('Validating Docker availability...');
    if (!isDockerAvailable()) {
      console.error('\n✖ Docker is required but not running.');
      console.error('  Service images (auth, cloud-api, proxy) are built locally.');
      console.error('  Please start Docker Desktop (or dockerd) and re-run.');
      process.exit(1);
    }
    console.log('  Docker is running.');

    // Pre-authenticate with GHCR so we catch permission issues before spending
    // 10+ minutes deploying all services.
    // SECURITY: Pass token via stdin/env — never interpolate into command strings.
    const ghcrPat = mustEnv('GHCR_PAT');
    try {
      if (!isGhcrAuthenticated()) {
        execSync('echo "$GHCR_PAT" | docker login ghcr.io -u alternatefutures --password-stdin', {
          stdio: 'pipe',
          timeout: 15_000,
          env: { ...process.env, GHCR_PAT: ghcrPat },
        });
      }
      console.log('  GHCR authentication OK.');
    } catch (e: any) {
      const safeMsg = (e?.message || String(e)).replace(ghcrPat, '***');
      console.error('\n✖ Failed to authenticate with GHCR.');
      console.error('  Ensure GHCR_PAT has write:packages scope.');
      console.error(`  Error: ${safeMsg}`);
      process.exit(1);
    }

    // Verify the GHCR_PAT token has write:packages scope by querying the
    // GitHub API. This catches the #1 cause of push failures (read-only token)
    // BEFORE we spend 10+ minutes deploying services.
    //
    // SECURITY: Never pass the token directly in shell commands — it leaks into
    // error messages if execSync throws. Use environment variables instead.
    console.log('  Verifying GHCR_PAT has write:packages scope...');
    try {
      const scopeHeaders = execSync(
        'curl -sI -H "Authorization: token $GHCR_PAT" https://api.github.com/user',
        { stdio: 'pipe', timeout: 15_000, env: { ...process.env, GHCR_PAT: ghcrPat } }
      ).toString();
      // GitHub returns X-OAuth-Scopes header listing all scopes the token has
      const scopeLine = scopeHeaders.split('\n').find(l => l.toLowerCase().startsWith('x-oauth-scopes:'));
      if (scopeLine) {
        const scopes = scopeLine.replace(/^x-oauth-scopes:\s*/i, '').trim();
        if (!scopes.includes('write:packages')) {
          console.error(`\n✖ GHCR_PAT is missing the write:packages scope.`);
          console.error(`  Current scopes: ${scopes || '(none)'}`);
          console.error('  Go to https://github.com/settings/tokens and update your token');
          console.error('  to include the "write:packages" scope, then update .env.deploy.');
          process.exit(1);
        }
        console.log(`  Token scopes: ${scopes}`);
      } else {
        // Fine-grained PATs don't return X-OAuth-Scopes — try a direct
        // GHCR push-scope token exchange to verify write access.
        console.log('  Could not read X-OAuth-Scopes (fine-grained PAT?). Testing push token...');
        try {
          const tokenResp = execSync(
            'curl -sf -u "alternatefutures:$GHCR_PAT" ' +
            '"https://ghcr.io/token?scope=repository:alternatefutures/infrastructure-proxy-pingap:push"',
            { stdio: 'pipe', timeout: 15_000, env: { ...process.env, GHCR_PAT: ghcrPat } }
          ).toString();
          const token = JSON.parse(tokenResp)?.token;
          if (!token) throw new Error('No token returned');
          console.log('  Push-scope token exchange succeeded.');
        } catch {
          console.error('\n✖ GHCR_PAT cannot push images to ghcr.io.');
          console.error('  Ensure the token has write:packages scope (classic PAT) or');
          console.error('  "Write" access to packages (fine-grained PAT).');
          console.error('  Update at: https://github.com/settings/tokens');
          process.exit(1);
        }
      }
    } catch (e: any) {
      // Never log the raw error — it may contain the token in the command string
      const safeMsg = (e?.message || String(e)).replace(ghcrPat, '***');
      console.log(`  Token scope check inconclusive: ${safeMsg}`);
      console.log('  Will verify on push.');
    }
    console.log('');
  }

  // Load wallet + certificate
  console.log('Loading wallet and certificate...');
  const { wallet, client, chainSDK } = await loadWalletAndClient();
  const accounts = await wallet.getAccounts();
  const owner = accounts[0]?.address;
  if (!owner) throw new Error('Could not determine wallet address');
  console.log(`Owner: ${owner}`);
  RUN_OWNER = owner;
  RUN_CHAIN_SDK = chainSDK;

  const certificate = await loadCertificate(wallet, client, chainSDK);
  console.log('Certificate loaded.\n');

  // Check if provider-services CLI is available for manifest sending.
  // This mirrors the CI/CD path and can be more reliable on some providers.
  USE_CLI_MANIFEST = await hasProviderServicesCli();
  if (USE_CLI_MANIFEST) {
    console.log('✓ provider-services CLI detected — will use CLI for manifest sending (recommended).');
    console.log('  This mirrors the CI/CD manifest sending path.\n');
  } else {
    console.log('⚠ provider-services CLI not found — using JS SDK for manifest sending.');
    console.log('  If deployments fail with "kube: lease not found", install provider-services:');
    console.log('  https://github.com/akash-network/provider/releases\n');
  }

  // ── STEP 0.5: Build + push service images ──
  // Must happen BEFORE deploying auth/api so Akash pulls the latest code.
  // This prevents stale-Prisma-client bugs where the container image was
  // built before a schema migration was added.
  buildAndPushServiceImages();

  // Track providers to build exclusion lists
  const usedProviders = new Set<string>();

  // In burn-in mode, we should not rewrite repo files (pingap.toml, workflows, DEPLOYMENTS.md)
  const writeFiles = !closeOnSuccess && !skipProxy;

  // ── STEP 1: Close all ──
  await closeAllDeployments(chainSDK, owner);

  // ── STEP 2: Deploy PostgreSQL ──
  const database = await deployDatabase(chainSDK, owner, certificate, new Set());
  usedProviders.add(database.provider);

  // ── STEP 3: Deploy data services ──
  const data = await deployData(chainSDK, owner, certificate, new Set([database.provider]));
  usedProviders.add(data.provider);

  // Construct DATABASE_URL
  const dbPassword = mustDbPassword();
  const databaseUrl = `postgresql://alternatefutures:${dbPassword}@${database.dbHost}:${database.dbPort}/alternatefutures`;
  console.log(`\n  DATABASE_URL: ${redactDatabaseUrl(databaseUrl)}`);

  // Construct IPFS API URL + OTel endpoint
  const ipfsApiUrl = `http://${data.ipfsApiHost}:${data.ipfsApiPort}`;
  const otelEndpoint = data.otelHost && data.otelPort ? `http://${data.otelHost}:${data.otelPort}` : '';
  console.log(`  IPFS_API_URL: ${ipfsApiUrl}`);
  console.log(`  OTEL_ENDPOINT: ${otelEndpoint || '(not found)'}`);

  // ── STEP 4: Deploy auth ──
  const auth = await deployAuth(
    chainSDK,
    owner,
    certificate,
    new Set([database.provider, data.provider]),
    databaseUrl
  );
  usedProviders.add(auth.provider);

  // ── STEP 4.5: Run database migrations + seed ──
  // Must happen AFTER postgres is running and BEFORE API deploy (so API can
  // also assume tables exist). This is the critical step that was missing
  // from the original script — without it, auth returns 500 on any DB operation.
  await runDatabaseMigrations(databaseUrl);

  // ── STEP 5: Deploy API ──
  const api = await deployApi(
    chainSDK,
    owner,
    certificate,
    new Set([database.provider, data.provider, auth.provider]),
    databaseUrl,
    ipfsApiUrl,
    otelEndpoint
  );
  usedProviders.add(api.provider);

  // ── STEP 6: Update config files (BEFORE proxy deploy) ──
  // Update pingap.toml with the real auth + API ingress URLs BEFORE building
  // the proxy Docker image. This prevents the circular routing bug from the
  // incident report (Phase 5): if pingap.toml has the custom domain names
  // as upstreams, Cloudflare resolves them back to the proxy IP → infinite loop.
  let proxy: ProxyResult | null = null;
  if (!skipProxy && writeFiles) {
    // We need a placeholder proxy result for updateConfigFiles — we'll update
    // DEPLOYMENTS.md again after the proxy is deployed with the real DSEQ/IP.
    // For now, just update pingap.toml with the correct ingress URLs.
    hr('STEP 6: Update pingap.toml with new ingress URLs');

    const pingapPath = path.join(ROOT, 'infrastructure-proxy/pingap.toml');
    const pingapLines = mustReadFile(pingapPath).split('\n');

    const findLineAfterForProxy = (lines: string[], sectionMarker: string, linePrefix: string): number => {
      const sectionIdx = lines.findIndex((l) => l.trim() === sectionMarker);
      if (sectionIdx === -1) return -1;
      for (let i = sectionIdx + 1; i < lines.length; i++) {
        if (lines[i].trim().startsWith(linePrefix)) return i;
        if (lines[i].startsWith('[') && i > sectionIdx + 1) break;
      }
      return -1;
    };

    const updateHostHeaderForProxy = (lines: string[], sectionMarker: string, newHost: string): void => {
      const sectionIdx = lines.findIndex((l) => l.trim() === sectionMarker);
      if (sectionIdx === -1) return;
      for (let i = sectionIdx + 1; i < lines.length; i++) {
        if (lines[i].trim().startsWith('proxy_set_headers')) {
          lines[i] = lines[i].replace(/Host: [^"]+/, `Host: ${newHost}`);
          return;
        }
        if (lines[i].startsWith('[') && i > sectionIdx + 1) break;
      }
    };

    if (auth.ingressUrl) {
      // Use the raw provider ingress URL, NOT the custom domain
      const authIngress = auth.ingressUrl.includes('.ingress.')
        ? auth.ingressUrl
        : auth.ingressUrl; // already raw if it contains .ingress.
      const authAddrsIdx = findLineAfterForProxy(pingapLines, '[upstreams.auth]', 'addrs');
      if (authAddrsIdx !== -1) {
        pingapLines[authAddrsIdx] = `addrs = ["${authIngress}:80"]`;
        console.log(`  Auth upstream: ${authIngress}:80`);
      }
      updateHostHeaderForProxy(pingapLines, '[locations.auth]', authIngress);
    }

    if (api.apiIngressUrl) {
      const apiIngress = api.apiIngressUrl.includes('.ingress.')
        ? api.apiIngressUrl
        : api.apiIngressUrl;
      const apiAddrsIdx = findLineAfterForProxy(pingapLines, '[upstreams.api]', 'addrs');
      if (apiAddrsIdx !== -1) {
        pingapLines[apiAddrsIdx] = `addrs = ["${apiIngress}:80"]`;
        console.log(`  API upstream: ${apiIngress}:80`);
      }
      updateHostHeaderForProxy(pingapLines, '[locations.api]', apiIngress);
    }

    fs.writeFileSync(pingapPath, pingapLines.join('\n'));
    console.log('  ✓ Updated: infrastructure-proxy/pingap.toml');

    // ── STEP 6.5: Build + push proxy image ──
    hr('STEP 6.5: Build + push proxy image');
    const proxyImageTag = buildAndPushProxyImage();
    console.log(`  Using proxy image tag: ${proxyImageTag}`);
    process.env._PROXY_IMAGE_TAG = proxyImageTag;

    // ── STEP 7: Deploy SSL proxy ──
    proxy = await deployProxy(chainSDK, owner, certificate, usedProviders);
  } else if (!skipProxy) {
    // Deploy proxy without updating config files (burn-in mode)
    proxy = await deployProxy(chainSDK, owner, certificate, usedProviders);
  } else {
    hr('STEP 6-7: Deploy SSL proxy (skipped)');
    console.log('  AKASH_REDEPLOY_SKIP_PROXY=1 so the SSL proxy step is skipped.');
  }

  // ── STEP 8: Update remaining config files ──
  if (writeFiles && proxy) {
    updateConfigFiles(database, data, api, auth, proxy);
  } else if (!writeFiles) {
    hr('STEP 8: Update config files (skipped)');
    console.log('  Burn-in mode: file updates are disabled (no repo writes).');
  } else if (!proxy) {
    hr('STEP 8: Update config files (skipped)');
    console.log('  Proxy was skipped, so config updates are not applied.');
  }

  // ── STEP 8.5: Persist deployment info to .env.deploy ──
  if (!closeOnSuccess) {
    hr('STEP 8.5: Persist deployment info to .env.deploy');
    persistDeploymentInfo(database, data, auth, api, proxy, databaseUrl, dbPassword);
  }

  // ── STEP 9: Print summary ──
  printSummary(database, data, api, auth, proxy, databaseUrl, { skipManualSteps: closeOnSuccess || skipProxy });

  if (closeOnSuccess) {
    hr('BURN-IN MODE: Closing deployments');
    console.log('  AKASH_REDEPLOY_CLOSE_ON_SUCCESS=1 so deployments from this run will be closed.');
    await cleanupRunDeployments('cleanup-success');
  }
}

main().catch(async (e) => {
  console.error('\nFATAL ERROR:', e?.message || e);
  // Best-effort cleanup: close deployments created in THIS run so we don't
  // strand billing if a later step fails.
  await cleanupRunDeployments('cleanup');

  console.error('\nIf any deployments remain active, you can list/close them manually:');
  console.error('- npx tsx scripts/list-deployments.ts');
  console.error('- npx tsx scripts/close-deployment.ts <DSEQ>');
  process.exit(1);
});
