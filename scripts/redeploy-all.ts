#!/usr/bin/env npx tsx
/**
 * Full Clean Redeploy - Close ALL Akash deployments and redeploy everything.
 *
 * Deployment order (each depends on the previous):
 *   1. Close all active deployments
 *   2. Deploy PostgreSQL (standalone)
 *   3. Deploy data services (IPFS + Jaeger + OTel)
 *   4. Deploy auth (standalone, with DATABASE_URL + secrets injected via env vars)
 *   5. Deploy API (standalone)
 *   6. Deploy SSL proxy (Pingap with dedicated IP lease)
 *   7. Update config files (pingap.toml, DEPLOYMENTS.md, workflows)
 *
 * Note: Infisical is SKIPPED. Secrets are injected directly as SDL env vars.
 * The auth service has a built-in fallback that reads from env vars when
 * Infisical credentials are not provided.
 *
 * Required:
 *   - akash-mcp/.env       (AKASH_MNEMONIC)
 *   - akash-mcp/.env.deploy (all deployment secrets - see .env.deploy.example)
 *   - infrastructure-proxy/certs/origin.crt + origin.key (Cloudflare Origin Certificate)
 *
 * Usage:
 *   cd akash-mcp && npx tsx scripts/redeploy-all.ts
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
import { hasProviderServicesCli, sendManifestCli } from '../src/utils/send-manifest-cli.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');

// Load environment
config({ path: path.resolve(__dirname, '../.env') });
config({ path: path.resolve(__dirname, '../.env.deploy') });

// ─── Known-bad providers ────────────────────────────────────────────────────
const ALWAYS_EXCLUDE = new Set([
  'akash1smapjx8m8363nmdvc2yr9atlqy8vcql73m9l0v', // Broken hostname
  'akash1pnae60m3nnnq89437kg892k50wjqx90zcysgzv', // ahn2-na.akash.pub - controller stuck, never creates k8s resources
  'akash1rr5pzy4kz2wwwtntt5vz4as0afw0ljrfmhty8q', // No named storage vol support - only created 2/8 services
  'akash1vg3gk6dynh9ys45tzjyedp0dl52s93kap75x3n', // zanthem.cloud - creates 2/8 svcs then loses lease
  'akash1tweev0k42guyv3a2jtgphmgfrl2h5y2884vh9d', // dcnorse.eu - lease not found after manifest
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
// using the JS SDK's `sendManifest()`.  This avoids the canonical-JSON hash
// mismatch between the JS SDK and the Go provider binary.
let USE_CLI_MANIFEST = false;

// ─── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
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

async function closeDeploymentQuiet(chainSDK: any, owner: string, dseq: number, label: string) {
  try {
    await chainSDK.akash.deployment.v1beta4.closeDeployment({
      id: { owner, dseq: BigInt(dseq) },
    });
    console.log(`  [${label}] Closed DSEQ ${dseq}`);
  } catch (e: any) {
    console.log(`  [${label}] Warning: Failed to close DSEQ ${dseq}: ${e.message || e}`);
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
  console.log(`\n  [${label}] Parsing SDL...`);
  const sdl = SDL.fromString(sdlContent, 'beta3');
  const groups = sdl.groups();
  const hash = await sdl.manifestVersion();

  // Get current block height for DSEQ
  const statusResponse = await chainSDK.cosmos.base.tendermint.v1beta1.getLatestBlock({});
  const dseq = Number(statusResponse.block?.header?.height || 0);
  if (!dseq) throw new Error('Could not determine block height for DSEQ');

  console.log(`  [${label}] Creating deployment (DSEQ: ${dseq})...`);
  await chainSDK.akash.deployment.v1beta4.createDeployment({
    id: { owner, dseq: BigInt(dseq) },
    groups,
    hash,
    deposit: {
      amount: { denom: 'uakt', amount: String(depositUakt) },
      sources: [1],
    },
  });
  console.log(`  [${label}] Deployment created. DSEQ: ${dseq}`);

  // Wait for bids
  console.log(`  [${label}] Waiting 30s for bids...`);
  await sleep(30_000);

  const bidsResponse = await chainSDK.akash.market.v1beta5.getBids({
    filters: { owner, dseq: BigInt(dseq) },
  });

  const bids = bidsResponse.bids || [];
  if (bids.length === 0) throw new Error(`[${label}] No bids received.`);

  console.log(`  [${label}] Received ${bids.length} bid(s).`);

  // Merge always-exclude with deployment-specific excludes
  const allExclude = new Set([...excludeProviders, ...ALWAYS_EXCLUDE]);

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

  // Prefer known-good providers first, then fall back to any usable bid
  const preferred = usableBids.find((b: any) =>
    PREFERRED_PROVIDERS.includes(b.bid?.id?.provider)
  );
  const selected = preferred || usableBids[0];

  if (!selected?.bid?.id) {
    throw new Error(`[${label}] No usable bids after exclusions.`);
  }
  if (preferred) {
    console.log(`  [${label}] ✓ Using PREFERRED provider.`);
  } else {
    console.log(`  [${label}] ⚠ No preferred provider available, using first usable bid.`);
  }

  const bidId = selected.bid.id;
  const provider = bidId.provider;
  const gseq = Number(bidId.gseq || 1);
  const oseq = Number(bidId.oseq || 1);
  const bseq = Number(bidId.bseq || 0);

  console.log(`  [${label}] Selected provider: ${provider}`);

  // Create lease
  console.log(`  [${label}] Creating lease...`);
  await chainSDK.akash.market.v1beta5.createLease({
    bidId: { owner, dseq: BigInt(dseq), gseq, oseq, provider, bseq },
  });
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
  // CRITICAL: When USE_CLI_MANIFEST is true, we use the Go CLI binary to avoid
  // the JS SDK ↔ Go provider canonical-JSON hash mismatch that causes providers
  // to silently reject manifests (resulting in persistent "kube: lease not found").
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
  const providerHostUri = providerRes.provider?.hostUri;
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

  return { dseq, provider, gseq, oseq, providerHostUri };
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

  const deploymentsRes = await chainSDK.akash.deployment.v1beta4.getDeployments({
    filters: { owner, state: 'active' },
  });

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
      await chainSDK.akash.deployment.v1beta4.closeDeployment({
        id: { owner, dseq: BigInt(dseq) },
      });
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

  const dbPassword = mustEnv('YSQL_PASSWORD');
  let sdlContent = mustReadFile(path.join(ROOT, 'service-cloud-api/infra/postgres-standalone.yaml'));
  sdlContent = sdlContent.replace(/\$\{POSTGRES_PASSWORD\}/g, dbPassword);

  const triedProviders = new Set<string>();
  let lastError: any = null;

  for (let attempt = 1; attempt <= MAX_PROVIDER_FAILOVERS; attempt++) {
    const attemptExclude = new Set<string>([...excludeProviders, ...triedProviders]);
    console.log(`\n  [postgres] Provider attempt ${attempt}/${MAX_PROVIDER_FAILOVERS}...`);

    const result = await deploySDL(sdlContent, attemptExclude, 5_000_000, chainSDK, owner, certificate, 'postgres', path.join(ROOT, 'service-cloud-api/infra/postgres-standalone.yaml'));
    try {
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

      return { ...result, dbHost, dbPort };
    } catch (e: any) {
      lastError = e;
      console.log(
        `  [postgres] ❌ Failed on provider ${result.provider} (DSEQ ${result.dseq}): ${e.message || e}`
      );
      triedProviders.add(result.provider);
      await closeDeploymentQuiet(chainSDK, owner, result.dseq, 'postgres');
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
  hr('STEP 3: Deploy data services (IPFS + Jaeger + OTel)');

  let sdlContent = mustReadFile(path.join(ROOT, 'service-cloud-api/deploy-data.yaml'));
  sdlContent = injectGhcrCredentials(sdlContent);

  const triedProviders = new Set<string>();
  let lastError: any = null;

  for (let attempt = 1; attempt <= MAX_PROVIDER_FAILOVERS; attempt++) {
    const attemptExclude = new Set<string>([...excludeProviders, ...triedProviders]);
    console.log(`\n  [data] Provider attempt ${attempt}/${MAX_PROVIDER_FAILOVERS}...`);

    const result = await deploySDL(sdlContent, attemptExclude, 5_000_000, chainSDK, owner, certificate, 'data', 'inline');
    try {
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
        const otelPorts = status.forwarded_ports['otel-collector'] || [];
        for (const fp of otelPorts) {
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

      return { ...result, ipfsIngressUrl, ipfsApiHost, ipfsApiPort, otelHost, otelPort, jaegerIngressUrl };
    } catch (e: any) {
      lastError = e;
      console.log(`  [data] ❌ Failed on provider ${result.provider} (DSEQ ${result.dseq}): ${e.message || e}`);
      triedProviders.add(result.provider);
      await closeDeploymentQuiet(chainSDK, owner, result.dseq, 'data');
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

  let sdlContent = mustReadFile(path.join(ROOT, 'service-auth/deploy-akash.yaml'));

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
    `      # Database - YugabyteDB deployment (direct env var, no Infisical)\n` +
      `      - DATABASE_URL=${databaseUrl}\n` +
      `      # Secrets injected directly (Infisical skipped)\n` +
      `      - JWT_SECRET=${jwtSecret}\n` +
      `      - JWT_REFRESH_SECRET=${jwtRefreshSecret}\n` +
      `      - RESEND_API_KEY=${resendApiKey}`
  );

  const triedProviders = new Set<string>();
  let lastError: any = null;

  for (let attempt = 1; attempt <= MAX_PROVIDER_FAILOVERS; attempt++) {
    const attemptExclude = new Set<string>([...excludeProviders, ...triedProviders]);
    console.log(`\n  [auth] Provider attempt ${attempt}/${MAX_PROVIDER_FAILOVERS}...`);

    const result = await deploySDL(sdlContent, attemptExclude, 5_000_000, chainSDK, owner, certificate, 'auth', 'inline');
    try {
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
      if (status?.services) {
        for (const [, info] of Object.entries(status.services) as any) {
          if (info?.uris?.length) {
            ingressUrl = info.uris[0];
            break;
          }
        }
      }

      console.log(`  Auth ingress: ${ingressUrl || '(not found)'}`);
      if (!ingressUrl) {
        throw new Error('[auth] Could not detect ingress URL from lease status.');
      }

      return { ...result, ingressUrl };
    } catch (e: any) {
      lastError = e;
      console.log(`  [auth] ❌ Failed on provider ${result.provider} (DSEQ ${result.dseq}): ${e.message || e}`);
      triedProviders.add(result.provider);
      await closeDeploymentQuiet(chainSDK, owner, result.dseq, 'auth');
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

  let sdlContent = mustReadFile(path.join(ROOT, 'service-cloud-api/deploy-api.yaml'));
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
  if (sentryDsn) {
    sdlContent = sdlContent.replace(/your_sentry_dsn/g, sentryDsn);
  }

  sdlContent = injectGhcrCredentials(sdlContent);

  const triedProviders = new Set<string>();
  let lastError: any = null;

  for (let attempt = 1; attempt <= MAX_PROVIDER_FAILOVERS; attempt++) {
    const attemptExclude = new Set<string>([...excludeProviders, ...triedProviders]);
    console.log(`\n  [api] Provider attempt ${attempt}/${MAX_PROVIDER_FAILOVERS}...`);

    const result = await deploySDL(sdlContent, attemptExclude, 5_000_000, chainSDK, owner, certificate, 'api', 'inline');
    try {
      const status = await waitForServices(
        result.providerHostUri,
        result.dseq,
        result.gseq,
        result.oseq,
        certificate,
        'api'
      );

      let apiIngressUrl = '';
      if (status?.services) {
        for (const [, info] of Object.entries(status.services) as any) {
          if (info?.uris?.length) {
            apiIngressUrl = info.uris[0];
            break;
          }
        }
      }

      console.log(`  API ingress: ${apiIngressUrl || '(not found)'}`);
      if (!apiIngressUrl) {
        throw new Error('[api] Could not detect ingress URL from lease status.');
      }

      return { ...result, apiIngressUrl };
    } catch (e: any) {
      lastError = e;
      console.log(`  [api] ❌ Failed on provider ${result.provider} (DSEQ ${result.dseq}): ${e.message || e}`);
      triedProviders.add(result.provider);
      await closeDeploymentQuiet(chainSDK, owner, result.dseq, 'api');
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

  const certFile = path.join(ROOT, 'infrastructure-proxy/certs/origin.crt');
  const keyFile = path.join(ROOT, 'infrastructure-proxy/certs/origin.key');
  const sdlTemplateFile = path.join(ROOT, 'infrastructure-proxy/deploy-akash-ip-lease.yaml');

  const originCert = mustReadFile(certFile);
  const originKey = mustReadFile(keyFile);

  let sdlContent = mustReadFile(sdlTemplateFile);
  sdlContent = sdlContent.replace('<REPLACE_WITH_ORIGIN_CERT>', toPipedPem(originCert));
  sdlContent = sdlContent.replace('<REPLACE_WITH_ORIGIN_KEY>', toPipedPem(originKey));

  if (sdlContent.includes('<REPLACE_WITH_ORIGIN_CERT>') || sdlContent.includes('<REPLACE_WITH_ORIGIN_KEY>')) {
    throw new Error('SDL TLS placeholders were not replaced.');
  }

  const triedProviders = new Set<string>();
  let lastError: any = null;

  for (let attempt = 1; attempt <= MAX_PROVIDER_FAILOVERS; attempt++) {
    const attemptExclude = new Set<string>([...excludeProviders, ...triedProviders]);
    console.log(`\n  [SSL-proxy] Provider attempt ${attempt}/${MAX_PROVIDER_FAILOVERS}...`);

    const result = await deploySDL(sdlContent, attemptExclude, 5_000_000, chainSDK, owner, certificate, 'SSL-proxy', 'inline');

    try {
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
      console.log(
        `  [SSL-proxy] ❌ Failed on provider ${result.provider} (DSEQ ${result.dseq}): ${e.message || e}`
      );
      triedProviders.add(result.provider);
      await closeDeploymentQuiet(chainSDK, owner, result.dseq, 'SSL-proxy');
      console.log(`  [SSL-proxy] Retrying with a different provider in 10s...`);
      await sleep(10_000);
    }
  }

  throw lastError || new Error('[SSL-proxy] Failed after provider failover attempts.');
}

// ─── Step 5: Update config files ────────────────────────────────────────────

function updateConfigFiles(
  database: DatabaseResult,
  data: DataResult,
  api: ApiResult,
  auth: AuthResult,
  proxy: ProxyResult
) {
  hr('STEP 7: Update config files');

  // 6a. Update pingap.toml using line-by-line replacement for reliability
  const pingapPath = path.join(ROOT, 'infrastructure-proxy/pingap.toml');
  const pingapLines = mustReadFile(pingapPath).split('\n');

  // Helper: find the line index starting with a given prefix after a section header
  function findLineAfter(lines: string[], sectionMarker: string, linePrefix: string): number {
    const sectionIdx = lines.findIndex((l) => l.trim() === sectionMarker);
    if (sectionIdx === -1) return -1;
    for (let i = sectionIdx + 1; i < lines.length; i++) {
      if (lines[i].trim().startsWith(linePrefix)) return i;
      // Stop if we hit the next section
      if (lines[i].startsWith('[') && i > sectionIdx + 1) break;
    }
    return -1;
  }

  // Helper: find proxy_set_headers line in a location section and replace Host value
  function updateHostHeader(lines: string[], sectionMarker: string, newHost: string): void {
    const sectionIdx = lines.findIndex((l) => l.trim() === sectionMarker);
    if (sectionIdx === -1) return;
    for (let i = sectionIdx + 1; i < lines.length; i++) {
      if (lines[i].trim().startsWith('proxy_set_headers')) {
        // Replace the Host: value in the proxy_set_headers array
        lines[i] = lines[i].replace(/Host: [^"]+/, `Host: ${newHost}`);
        return;
      }
      if (lines[i].startsWith('[') && i > sectionIdx + 1) break;
    }
  }

  if (auth.ingressUrl) {
    // Update [upstreams.auth] addrs and sni
    const authAddrsIdx = findLineAfter(pingapLines, '[upstreams.auth]', 'addrs');
    if (authAddrsIdx !== -1) {
      pingapLines[authAddrsIdx] = `addrs = ["${auth.ingressUrl}:443"]`;
    }
    const authSniIdx = findLineAfter(pingapLines, '[upstreams.auth]', 'sni');
    if (authSniIdx !== -1) {
      pingapLines[authSniIdx] = `sni = "${auth.ingressUrl}"`;
    }
    updateHostHeader(pingapLines, '[locations.auth]', auth.ingressUrl);
  }

  if (api.apiIngressUrl) {
    // Update [upstreams.api] addrs and sni
    const apiAddrsIdx = findLineAfter(pingapLines, '[upstreams.api]', 'addrs');
    if (apiAddrsIdx !== -1) {
      pingapLines[apiAddrsIdx] = `addrs = ["${api.apiIngressUrl}:443"]`;
    }
    const apiSniIdx = findLineAfter(pingapLines, '[upstreams.api]', 'sni');
    if (apiSniIdx !== -1) {
      pingapLines[apiSniIdx] = `sni = "${api.apiIngressUrl}"`;
    }
    updateHostHeader(pingapLines, '[locations.api]', api.apiIngressUrl);
  }

  if (data.ipfsIngressUrl) {
    // Update [upstreams.ipfs] addrs and sni
    const ipfsAddrsIdx = findLineAfter(pingapLines, '[upstreams.ipfs]', 'addrs');
    if (ipfsAddrsIdx !== -1) {
      pingapLines[ipfsAddrsIdx] = `addrs = ["${data.ipfsIngressUrl}:443"]`;
    }
    const ipfsSniIdx = findLineAfter(pingapLines, '[upstreams.ipfs]', 'sni');
    if (ipfsSniIdx !== -1) {
      pingapLines[ipfsSniIdx] = `sni = "${data.ipfsIngressUrl}"`;
    }
    updateHostHeader(pingapLines, '[locations.website]', data.ipfsIngressUrl);
    updateHostHeader(pingapLines, '[locations.docs]', data.ipfsIngressUrl);
    updateHostHeader(pingapLines, '[locations.app]', data.ipfsIngressUrl);
  }

  fs.writeFileSync(pingapPath, pingapLines.join('\n'));
  console.log('  Updated: infrastructure-proxy/pingap.toml');

  // 6b. Update service-auth update-manifest.yml
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
| yugabyte (db) | ${database.dseq} | \`${database.provider}\` | ${now} | 3-node YugabyteDB cluster |
| data services | ${data.dseq} | \`${data.provider}\` | ${now} | IPFS + Jaeger + OTel Collector |
| api | ${api.dseq} | \`${api.provider}\` | ${now} | GraphQL API |
| service-auth | ${auth.dseq} | \`${auth.provider}\` | ${now} | Standalone auth service |
| infrastructure-proxy (SSL) | ${proxy.dseq} | \`${proxy.provider}\` | ${now} | Pingap SSL proxy, dedicated IP ${proxy.ip || 'TBD'} |

## Endpoints

- **API**: https://api.alternatefutures.ai (via SSL proxy)
- **Auth**: https://auth.alternatefutures.ai (via SSL proxy)
- **Web App**: https://app.alternatefutures.ai (Vercel)
- **YugabyteDB Admin**: https://yb.alternatefutures.ai
- **IPFS Gateway**: https://ipfs.alternatefutures.ai
- **OTel Metrics**: https://otel-metrics.alternatefutures.ai

## Database Connection

YugabyteDB is exposed globally via TCP from the yugabyte deployment:
- **Host**: ${database.dbHost}
- **Port**: ${database.dbPort}
- **Connection string**: \`postgresql://yugabyte:<YSQL_PASSWORD>@${database.dbHost}:${database.dbPort}/alternatefutures\`

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
| \`akash1smapjx8m8363nmdvc2yr9atlqy8vcql73m9l0v\` | Broken hostname (\`provider.provider.akash-provider.xyz\`) |

## Provider Reference

| Provider | DSEQ | Service |
|----------|------|---------|
| \`${database.provider}\` | ${database.dseq} | yugabyte (db) |
| \`${data.provider}\` | ${data.dseq} | data services (ipfs/jaeger/otel) |
| \`${api.provider}\` | ${api.dseq} | api |
| \`${auth.provider}\` | ${auth.dseq} | service-auth |
| \`${proxy.provider}\` | ${proxy.dseq} | infrastructure-proxy (SSL) |

---

*Last updated: ${now}*
`;

  fs.writeFileSync(deploymentsPath, deploymentsContent);
  console.log('  Updated: DEPLOYMENTS.md');

  // 6e. Update .github/DEPLOYMENTS.md
  const ghDeploymentsPath = path.join(ROOT, '.github/DEPLOYMENTS.md');

  const ghDeploymentsContent = `# Akash Network Deployments

This file tracks active deployments on Akash Network. All information here is public blockchain data.

## Active Deployments

### yugabyte (database)
| Field | Value |
|-------|-------|
| **DSEQ** | ${database.dseq} |
| **Provider** | \`${database.provider}\` |
| **Services** | 3-node YugabyteDB cluster |
| **Custom Domains** | yb.alternatefutures.ai |
| **Status** | Running |

### data services (IPFS + Jaeger + OTel)
| Field | Value |
|-------|-------|
| **DSEQ** | ${data.dseq} |
| **Provider** | \`${data.provider}\` |
| **Services** | IPFS + Jaeger + OTel Collector |
| **Custom Domains** | ipfs.alternatefutures.ai, jaeger.alternatefutures.ai, otel-metrics.alternatefutures.ai |
| **Status** | Running |

### api
| Field | Value |
|-------|-------|
| **DSEQ** | ${api.dseq} |
| **Provider** | \`${api.provider}\` |
| **Image** | \`ghcr.io/alternatefutures/service-cloud-api:latest\` |
| **Custom Domain** | api.alternatefutures.ai (via SSL proxy) |
| **Status** | Running |
| **CI/CD** | \`deploy-akash.yml\` (full) / \`update-manifest.yml\` (in-place) |

### service-auth (Authentication)
| Field | Value |
|-------|-------|
| **DSEQ** | ${auth.dseq} |
| **Provider** | \`${auth.provider}\` |
| **Image** | \`ghcr.io/alternatefutures/service-auth:main-*\` |
| **Custom Domain** | auth.alternatefutures.ai (via SSL proxy) |
| **Status** | Running |
| **CI/CD** | \`deploy-akash.yml\` (full) / \`update-manifest.yml\` (in-place) |

### infrastructure-proxy (SSL Proxy)
| Field | Value |
|-------|-------|
| **DSEQ** | ${proxy.dseq} |
| **Provider** | \`${proxy.provider}\` |
| **Image** | \`ghcr.io/alternatefutures/infrastructure-proxy-pingap:main\` |
| **Dedicated IP** | ${proxy.ip || 'TBD'} |
| **Domains Routed** | auth, api, app, docs.alternatefutures.ai |
| **Status** | Running |

## Database (YugabyteDB)

YugabyteDB is deployed separately and exposed globally via TCP:
| Field | Value |
|-------|-------|
| **Host** | ${database.dbHost} |
| **Port** | ${database.dbPort} |
| **Database** | alternatefutures |
| **User** | yugabyte |
| **Connection** | \`postgresql://yugabyte:<password>@${database.dbHost}:${database.dbPort}/alternatefutures\` |

## Secrets Management

No Infisical deployment. Secrets are injected directly as SDL environment variables at deploy time.
The auth service reads JWT_SECRET, RESEND_API_KEY, etc. from env vars (built-in fallback).

## Akash Account

- **Address**: \`akash1degudmhf24auhfnqtn99mkja3xt7clt9um77tn\`
- **Network**: Mainnet
- **Explorer**: [Cloudmos](https://deploy.cloudmos.io/addresses/akash1degudmhf24auhfnqtn99mkja3xt7clt9um77tn)

## Infrastructure & SSL

All custom domains route through the SSL proxy (Pingap on Cloudflare's Pingora framework) at \`${proxy.ip || 'TBD'}\`.

| Domain | Routing | SSL |
|--------|---------|-----|
| auth.alternatefutures.ai | SSL proxy (${proxy.ip || 'TBD'}) | Cloudflare Origin Cert |
| api.alternatefutures.ai | SSL proxy (${proxy.ip || 'TBD'}) | Cloudflare Origin Cert |
| app.alternatefutures.ai | Vercel | Vercel managed |
| yb.alternatefutures.ai | SSL proxy (${proxy.ip || 'TBD'}) | Cloudflare Origin Cert |
| ipfs.alternatefutures.ai | SSL proxy (${proxy.ip || 'TBD'}) | Cloudflare Origin Cert |
| jaeger.alternatefutures.ai | SSL proxy (${proxy.ip || 'TBD'}) | Cloudflare Origin Cert |
| otel-metrics.alternatefutures.ai | SSL proxy (${proxy.ip || 'TBD'}) | Cloudflare Origin Cert |

## Quick Reference: DSEQ to Service

| DSEQ | Service | Primary URL |
|------|---------|-------------|
| ${database.dseq} | yugabyte (db) | yb.alternatefutures.ai |
| ${data.dseq} | data services | ipfs.alternatefutures.ai |
| ${api.dseq} | api | api.alternatefutures.ai |
| ${auth.dseq} | service-auth | auth.alternatefutures.ai |
| ${proxy.dseq} | infrastructure-proxy (SSL) | ${proxy.ip || 'TBD'} |

## Blocked Providers

| Provider | Reason |
|----------|--------|
| \`akash1smapjx8m8363nmdvc2yr9atlqy8vcql73m9l0v\` | Broken hostname |

## View Deployments

Deployments can be viewed on Cloudmos:
\`\`\`
https://deploy.cloudmos.io/deployment/akash1degudmhf24auhfnqtn99mkja3xt7clt9um77tn/{dseq}
\`\`\`

---

*Last updated: ${now}*
`;

  fs.writeFileSync(ghDeploymentsPath, ghDeploymentsContent);
  console.log('  Updated: .github/DEPLOYMENTS.md');
}

// ─── Step 6: Print summary ──────────────────────────────────────────────────

function printSummary(
  database: DatabaseResult,
  data: DataResult,
  api: ApiResult,
  auth: AuthResult,
  proxy: ProxyResult,
  databaseUrl: string
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
    DSEQ:     ${proxy.dseq}
    Provider: ${proxy.provider}
    IP:       ${proxy.ip || '(check Akash Console)'}
`);

  hr('MANUAL STEPS REQUIRED');

  console.log(`
  1. UPDATE GITHUB SECRETS:
     Set AUTH_DATABASE_URL to:
     ${databaseUrl}
     If you use API workflows, also set DATABASE_URL to the same value.

  2. UPDATE CLOUDFLARE DNS (if proxy IP changed):
     A records for *.alternatefutures.ai -> ${proxy.ip || 'TBD'}

  3. REBUILD & PUSH PROXY IMAGE (to apply updated pingap.toml):
     cd infrastructure-proxy
     docker build -t ghcr.io/alternatefutures/infrastructure-proxy-pingap:main .
     docker push ghcr.io/alternatefutures/infrastructure-proxy-pingap:main
     Then trigger the update-manifest workflow for the proxy, OR
     use the akash-mcp to send an updated manifest.

  4. COMMIT THE UPDATED CONFIG FILES:
     git add -A && git commit -m "Update deployment configs after full redeploy"
`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('========================================');
  console.log('  FULL CLEAN REDEPLOY - AlternateFutures');
  console.log('========================================\n');

  // Validate required environment variables upfront
  console.log('Validating environment variables...');
  const requiredVars = [
    'YSQL_PASSWORD',
    'JWT_SECRET',
    'GHCR_PAT',
  ];

  const missing = requiredVars.filter((v) => !process.env[v]);
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
    'infrastructure-proxy/certs/origin.crt',
    'infrastructure-proxy/certs/origin.key',
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

  // Load wallet + certificate
  console.log('Loading wallet and certificate...');
  const { wallet, client, chainSDK } = await loadWalletAndClient();
  const accounts = await wallet.getAccounts();
  const owner = accounts[0]?.address;
  if (!owner) throw new Error('Could not determine wallet address');
  console.log(`Owner: ${owner}`);

  const certificate = await loadCertificate(wallet, client, chainSDK);
  console.log('Certificate loaded.\n');

  // Check if provider-services CLI is available for manifest sending.
  // The Go CLI avoids the JS/Go canonical-JSON hash mismatch that causes
  // persistent "kube: lease not found" errors across all providers.
  USE_CLI_MANIFEST = await hasProviderServicesCli();
  if (USE_CLI_MANIFEST) {
    console.log('✓ provider-services CLI detected — will use CLI for manifest sending (recommended).');
    console.log('  This avoids the JS SDK ↔ Go provider manifest hash mismatch.\n');
  } else {
    console.log('⚠ provider-services CLI not found — using JS SDK for manifest sending.');
    console.log('  If deployments fail with "kube: lease not found", install provider-services:');
    console.log('  https://github.com/akash-network/provider/releases\n');
  }

  // Track providers to build exclusion lists
  const usedProviders = new Set<string>();

  // ── STEP 1: Close all ──
  await closeAllDeployments(chainSDK, owner);

  // ── STEP 2: Deploy PostgreSQL ──
  const database = await deployDatabase(chainSDK, owner, certificate, new Set());
  usedProviders.add(database.provider);

  // ── STEP 3: Deploy data services ──
  const data = await deployData(chainSDK, owner, certificate, new Set([database.provider]));
  usedProviders.add(data.provider);

  // Construct DATABASE_URL
  const dbPassword = mustEnv('YSQL_PASSWORD');
  const databaseUrl = `postgresql://alternatefutures:${dbPassword}@${database.dbHost}:${database.dbPort}/alternatefutures`;
  console.log(`\n  DATABASE_URL: ${databaseUrl}`);

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

  // ── STEP 6: Deploy SSL proxy ──
  // Exclude all other providers (proxy must be separate to avoid NAT hairpin)
  const proxy = await deployProxy(chainSDK, owner, certificate, usedProviders);

  // ── STEP 7: Update config files ──
  updateConfigFiles(database, data, api, auth, proxy);

  // ── STEP 8: Print summary ──
  printSummary(database, data, api, auth, proxy, databaseUrl);
}

main().catch((e) => {
  console.error('\nFATAL ERROR:', e?.message || e);
  console.error('\nIf a deployment was partially created, you may need to close it manually.');
  console.error('Use: npx tsx scripts/list-deployments.ts');
  console.error('Then: npx tsx scripts/close-deployment.ts (after updating the DSEQ)');
  process.exit(1);
});
