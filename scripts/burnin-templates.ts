#!/usr/bin/env npx tsx
/**
 * Template Burn-In — test each user-facing service template against Akash
 * providers to discover which are cheap + reliable for each workload profile.
 *
 * This is independent from the infrastructure redeploy-all burn-in. Instead
 * of deploying the full stack (postgres→data→auth→api chain), it tests each
 * template individually: spin up → verify ready → record provider + bid → close.
 *
 * Templates tested (from service-cloud-api/src/templates/definitions/):
 *   1. redis        — Redis 7 Alpine (0.25 CPU, 256Mi, 5Gi persistent)
 *   2. postgres     — PostgreSQL 16 Alpine (0.5 CPU, 1Gi, 10Gi persistent)
 *   3. node-ws-gameserver — Node.js WebSocket relay (0.5 CPU, 512Mi)
 *   4. bun-ws-gameserver  — Bun WebSocket relay (0.5 CPU, 512Mi)
 *
 * Results are written to the same provider registry + bids log used by
 * redeploy-all so the platform can look up providers for any service.
 *
 * Environment variables:
 *   BURNIN_ITERATIONS          — number of full loops (default: 10)
 *   BURNIN_TEMPLATES           — comma-separated subset (default: all 4)
 *   AKASH_PROVIDER_REGISTRY_PATH — path to registry JSON
 *   AKASH_PROVIDER_BIDS_LOG_PATH — path to bids JSONL
 *
 * Usage:
 *   cd akash-mcp
 *   npx tsx scripts/burnin-templates.ts
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
import {
  getFailingProvidersForService,
  getKnownWorkingProvidersForService,
  recordProviderResult,
} from '../src/utils/provider-registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment
config({ path: path.resolve(__dirname, '../.env') });
config({ path: path.resolve(__dirname, '../.env.deploy') });

// ─── Config ──────────────────────────────────────────────────────────────────

const ITERATIONS = parseInt(process.env.BURNIN_ITERATIONS || '10', 10);
const DEPOSIT_UAKT = 500000;
const BID_WAIT_MS = 30_000;
const SERVICE_READY_ATTEMPTS = 20;
const SERVICE_READY_INTERVAL_MS = 15_000;
const MAX_PROVIDER_ATTEMPTS = 3;
const INTER_TEMPLATE_DELAY_MS = 10_000;
const INTER_ITERATION_DELAY_MS = 15_000;

const PROVIDER_BIDS_LOG_PATH =
  process.env.AKASH_PROVIDER_BIDS_LOG_PATH ||
  path.resolve(__dirname, '../.local/provider-bids.jsonl');

// Known-bad providers (same list as redeploy-all.ts)
const ALWAYS_EXCLUDE = new Set([
  'akash1smapjx8m8363nmdvc2yr9atlqy8vcql73m9l0v',
  'akash1pnae60m3nnnq89437kg892k50wjqx90zcysgzv',
  'akash1rr5pzy4kz2wwwtntt5vz4as0afw0ljrfmhty8q',
  'akash1vg3gk6dynh9ys45tzjyedp0dl52s93kap75x3n',
  'akash1tweev0k42guyv3a2jtgphmgfrl2h5y2884vh9d',
  'akash1qmumr9mdnu9e8ymyr3nnf3qyjfkugj79eh6jzq',
  'akash1sjwuwre4qprcaa34f6324yz7m8nn0awvc75gp5',
]);

// ─── Lockfile (reuse the same lock as redeploy-all to prevent conflicts) ─────

const LOCKFILE_PATH = path.resolve(__dirname, '../.local/redeploy.lock');

function killStaleInstances(): void {
  try {
    if (!fs.existsSync(LOCKFILE_PATH)) return;
    const raw = fs.readFileSync(LOCKFILE_PATH, 'utf-8').trim();
    const stalePid = parseInt(raw, 10);
    if (!stalePid || stalePid === process.pid) return;
    try {
      process.kill(stalePid, 0);
    } catch {
      console.log(`  Stale lockfile (PID ${stalePid} already exited) — removing.`);
      try { fs.unlinkSync(LOCKFILE_PATH); } catch { /* ignore */ }
      return;
    }
    console.log(`  ✖ Killing previous instance (PID ${stalePid})...`);
    try { process.kill(-stalePid, 'SIGKILL'); } catch {
      try { process.kill(stalePid, 'SIGKILL'); } catch { /* gone */ }
    }
    try {
      execSync('sleep 1', { stdio: 'pipe' });
    } catch { /* ignore */ }
    console.log('  Previous instance terminated.');
  } catch { /* ignore */ }
}

function acquireLockfile(): void {
  fs.mkdirSync(path.dirname(LOCKFILE_PATH), { recursive: true });
  fs.writeFileSync(LOCKFILE_PATH, String(process.pid));
}

function releaseLockfile(): void {
  try {
    const content = fs.readFileSync(LOCKFILE_PATH, 'utf-8').trim();
    if (parseInt(content, 10) === process.pid) fs.unlinkSync(LOCKFILE_PATH);
  } catch { /* ignore */ }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function hr(title: string) {
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(70));
}

function appendBidsLog(entry: any) {
  try {
    fs.mkdirSync(path.dirname(PROVIDER_BIDS_LOG_PATH), { recursive: true });
    fs.appendFileSync(PROVIDER_BIDS_LOG_PATH, JSON.stringify(entry) + '\n');
  } catch { /* best-effort */ }
}

// ─── SDL generators for each template ────────────────────────────────────────
// These produce the exact same YAML that service-cloud-api's generateSDLFromTemplate
// would produce, but inlined here so we don't need cross-repo imports.

interface TemplateSpec {
  id: string;
  name: string;
  sdl: string;
  /** Service name inside the SDL (used for lease status checks) */
  serviceName: string;
  /** If the template has a health check, the path to probe */
  healthPath?: string;
  healthPort?: number;
}

function makeTemplates(): TemplateSpec[] {
  // Generate a random password for postgres burn-in (not a real deployment)
  const pgPassword = crypto.randomBytes(16).toString('hex');

  return [
    {
      id: 'tpl-redis',
      name: 'Redis',
      serviceName: 'redis',
      sdl: `---
version: "2.0"

services:
  redis:
    image: redis:7-alpine
    env:
      - REDIS_ARGS=--save 60 1 --loglevel warning
    command:
      - sh
      - -c
      - "redis-server"
    expose:
      - port: 6379
        as: 6379
        to:
          - global: true
    params:
      storage:
        redisdata:
          mount: /data
          readOnly: false

profiles:
  compute:
    redis:
      resources:
        cpu:
          units: 0.25
        memory:
          size: 256Mi
        storage:
          - size: 1Gi
          - name: redisdata
            size: 5Gi
            attributes:
              persistent: true
              class: beta3

  placement:
    dcloud:
      signedBy:
        anyOf:
          - akash1365yvmc4s7awdyj3n2sav7xfx76adc6dnmlx63
      pricing:
        redis:
          denom: uakt
          amount: 500

deployment:
  redis:
    dcloud:
      profile: redis
      count: 1
`,
    },
    {
      id: 'tpl-postgres',
      name: 'PostgreSQL',
      serviceName: 'postgres',
      sdl: `---
version: "2.0"

services:
  postgres:
    image: postgres:16-alpine
    env:
      - POSTGRES_DB=appdb
      - POSTGRES_USER=postgres
      - POSTGRES_PASSWORD=${pgPassword}
      - PGDATA=/var/lib/postgresql/data/pgdata
    expose:
      - port: 5432
        as: 5432
        to:
          - global: true
    params:
      storage:
        pgdata:
          mount: /var/lib/postgresql/data
          readOnly: false

profiles:
  compute:
    postgres:
      resources:
        cpu:
          units: 0.5
        memory:
          size: 1Gi
        storage:
          - size: 1Gi
          - name: pgdata
            size: 10Gi
            attributes:
              persistent: true
              class: beta3

  placement:
    dcloud:
      signedBy:
        anyOf:
          - akash1365yvmc4s7awdyj3n2sav7xfx76adc6dnmlx63
      pricing:
        postgres:
          denom: uakt
          amount: 1500

deployment:
  postgres:
    dcloud:
      profile: postgres
      count: 1
`,
    },
    {
      id: 'tpl-node-ws-gameserver',
      name: 'Node.js Game Server',
      serviceName: 'node-ws-gameserver',
      healthPath: '/health',
      healthPort: 8080,
      sdl: `---
version: "2.0"

services:
  node-ws-gameserver:
    image: ghcr.io/mavisakalyan/node-ws-gameserver:latest
    env:
      - PORT=8080
      - ALLOWED_ORIGINS=*
      - KEEPALIVE_MS=30000
      - MAX_MESSAGES_PER_SECOND=60
      - MAX_PLAYERS_PER_ROOM=50
    command:
      - sh
      - -c
      - "node dist/index.js"
    expose:
      - port: 8080
        as: 80
        to:
          - global: true

profiles:
  compute:
    node-ws-gameserver:
      resources:
        cpu:
          units: 0.5
        memory:
          size: 512Mi
        storage:
          - size: 1Gi

  placement:
    dcloud:
      signedBy:
        anyOf:
          - akash1365yvmc4s7awdyj3n2sav7xfx76adc6dnmlx63
      pricing:
        node-ws-gameserver:
          denom: uakt
          amount: 1000

deployment:
  node-ws-gameserver:
    dcloud:
      profile: node-ws-gameserver
      count: 1
`,
    },
    {
      id: 'tpl-bun-ws-gameserver',
      name: 'Bun Game Server',
      serviceName: 'bun-ws-gameserver',
      healthPath: '/health',
      healthPort: 8080,
      sdl: `---
version: "2.0"

services:
  bun-ws-gameserver:
    image: ghcr.io/mavisakalyan/bun-ws-gameserver:latest
    env:
      - PORT=8080
      - ALLOWED_ORIGINS=*
      - KEEPALIVE_MS=30000
      - MAX_MESSAGES_PER_SECOND=60
      - MAX_PLAYERS_PER_ROOM=50
    command:
      - sh
      - -c
      - "bun src/index.ts"
    expose:
      - port: 8080
        as: 80
        to:
          - global: true

profiles:
  compute:
    bun-ws-gameserver:
      resources:
        cpu:
          units: 0.5
        memory:
          size: 512Mi
        storage:
          - size: 1Gi

  placement:
    dcloud:
      signedBy:
        anyOf:
          - akash1365yvmc4s7awdyj3n2sav7xfx76adc6dnmlx63
      pricing:
        bun-ws-gameserver:
          denom: uakt
          amount: 1000

deployment:
  bun-ws-gameserver:
    dcloud:
      profile: bun-ws-gameserver
      count: 1
`,
    },
  ];
}

// ─── Core deployment + verify ────────────────────────────────────────────────

async function queryLeaseStatus(
  providerHostUri: string,
  dseq: number,
  gseq: number,
  oseq: number,
  certificate: any,
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
          if (res.statusCode !== 200)
            return reject(new Error(`Lease status HTTP ${res.statusCode}: ${data}`));
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function closeDeployment(chainSDK: any, owner: string, dseq: number, label: string) {
  try {
    await chainSDK.akash.deployment.v1beta4.closeDeployment({
      id: { owner, dseq: BigInt(dseq) },
    });
    console.log(`    [${label}] Closed DSEQ ${dseq}`);
  } catch (e: any) {
    console.log(`    [${label}] Warning: close DSEQ ${dseq} failed: ${e.message || e}`);
  }
}

interface DeployAndTestResult {
  ok: boolean;
  provider?: string;
  bidAmount?: string;
  bidDenom?: string;
  dseq?: number;
  error?: string;
}

async function deployAndTest(
  tpl: TemplateSpec,
  chainSDK: any,
  owner: string,
  certificate: any,
  attempt: number,
  excludeProviders: Set<string>,
): Promise<DeployAndTestResult> {
  const label = tpl.id;
  let dseq = 0;
  let provider = '';
  let bidAmount: string | undefined;
  let bidDenom: string | undefined;

  try {
    // Parse SDL
    const sdl = SDL.fromString(tpl.sdl, 'beta3');
    const groups = sdl.groups();
    const hash = await sdl.manifestVersion();

    // Get block height for DSEQ
    const statusResponse = await chainSDK.cosmos.base.tendermint.v1beta1.getLatestBlock({});
    dseq = Number(statusResponse.block?.header?.height || 0);
    if (!dseq) throw new Error('Could not determine block height');

    console.log(`    Creating deployment (DSEQ: ${dseq})...`);
    await chainSDK.akash.deployment.v1beta4.createDeployment({
      id: { owner, dseq: BigInt(dseq) },
      groups,
      hash,
      deposit: { amount: { denom: 'uakt', amount: String(DEPOSIT_UAKT) }, sources: [1] },
    });

    // Wait for bids
    console.log(`    Waiting ${BID_WAIT_MS / 1000}s for bids...`);
    await sleep(BID_WAIT_MS);

    const bidsResponse = await chainSDK.akash.market.v1beta5.getBids({
      filters: { owner, dseq: BigInt(dseq) },
    });

    const bids = bidsResponse.bids || [];
    if (bids.length === 0) throw new Error('No bids received');
    console.log(`    Received ${bids.length} bid(s).`);

    const getBidPrice = (b: any) => {
      const price = b?.bid?.price;
      const amount = price?.amount != null ? String(price.amount) : undefined;
      const denom = price?.denom != null ? String(price.denom) : undefined;
      const num = amount != null ? Number(amount) : NaN;
      return { amount, denom, num: Number.isFinite(num) ? num : undefined };
    };

    // Filter bids
    const registryExclude = getFailingProvidersForService({ service: label, minFails: 2 });
    const allExclude = new Set([...excludeProviders, ...ALWAYS_EXCLUDE, ...registryExclude]);

    const usableBids = bids.filter((b: any) => {
      const p = b.bid?.id?.provider;
      return p && !allExclude.has(p);
    });

    if (usableBids.length === 0) throw new Error('No usable bids after exclusions');

    // Select: prefer cheapest known-working, then cheapest overall
    const knownWorking = getKnownWorkingProvidersForService({ service: label });
    const sortByPrice = (arr: any[]) =>
      arr.slice().sort((a, b) => {
        const pa = getBidPrice(a).num ?? Infinity;
        const pb = getBidPrice(b).num ?? Infinity;
        return pa - pb;
      });

    const usableWorking = usableBids.filter((b: any) => knownWorking.has(b.bid?.id?.provider));
    const cheapestWorking = sortByPrice(usableWorking)[0];
    const cheapestAny = sortByPrice(usableBids)[0];
    const selected = cheapestWorking || cheapestAny;

    if (!selected?.bid?.id) throw new Error('No usable bids');

    const bidId = selected.bid.id;
    provider = bidId.provider;
    const gseq = Number(bidId.gseq || 1);
    const oseq = Number(bidId.oseq || 1);
    const bseq = Number(bidId.bseq || 0);
    { const p = getBidPrice(selected); bidAmount = p.amount; bidDenom = p.denom; }

    const mode = cheapestWorking ? 'cheapest_known_working' : 'cheapest';
    console.log(`    Selected: ${provider} (${bidAmount} ${bidDenom || 'uakt'}) [${mode}]`);

    // Log bids
    appendBidsLog({
      at: new Date().toISOString(),
      service: label,
      dseq,
      excluded: Array.from(allExclude),
      usableBids: usableBids.map((b: any) => {
        const p = getBidPrice(b);
        return { provider: b?.bid?.id?.provider, amount: p.amount, denom: p.denom };
      }),
      selected: { provider, amount: bidAmount, denom: bidDenom },
      selectionMode: mode,
    });

    // Create lease
    console.log(`    Creating lease...`);
    await chainSDK.akash.market.v1beta5.createLease({
      bidId: { owner, dseq: BigInt(dseq), gseq, oseq, provider, bseq },
    });

    // Wait for lease visibility
    console.log(`    Waiting for lease visibility...`);
    for (let i = 1; i <= 10; i++) {
      try {
        const leasesRes = await chainSDK.akash.market.v1beta5.getLeases({
          filters: { owner, dseq: BigInt(dseq), provider },
        });
        const lease = leasesRes.leases?.[0]?.lease;
        if (lease?.id) break;
      } catch { /* keep polling */ }
      await sleep(4_000);
    }

    await sleep(10_000); // provider lease watcher settle

    // Send manifest
    console.log(`    Sending manifest...`);
    const manifestHash = await sdl.manifestVersion();
    for (let retry = 1; retry <= 3; retry++) {
      try {
        await sendManifest(sdl, { id: { owner, dseq, gseq, oseq, provider } } as any, certificate, chainSDK);
        console.log(`    Manifest sent.`);
        break;
      } catch (e: any) {
        console.log(`    Manifest attempt ${retry}/3 failed: ${e.message || e}`);
        if (retry === 3) throw e;
        await sleep(10_000);
      }
    }

    // Provider ACK check
    const providerRes = await chainSDK.akash.provider.v1beta4.getProvider({ owner: provider });
    const providerHostUri = providerRes.provider?.hostUri || '';
    if (!providerHostUri) throw new Error('Could not resolve provider hostUri');

    let acked = false;
    for (let i = 1; i <= 3; i++) {
      try {
        const status = await queryLeaseStatus(providerHostUri, dseq, gseq, oseq, certificate);
        if (status) { acked = true; break; }
      } catch { /* retry */ }
      await sleep(5_000);
    }
    if (!acked) throw new Error('Provider never acknowledged lease');
    console.log(`    Provider acknowledged.`);

    // Wait for services to become ready
    console.log(`    Waiting for services to become ready...`);
    for (let i = 1; i <= SERVICE_READY_ATTEMPTS; i++) {
      try {
        const status = await queryLeaseStatus(providerHostUri, dseq, gseq, oseq, certificate);
        const services = status?.services || {};
        const svc = services[tpl.serviceName];
        const ready = svc?.ready || 0;
        const total = svc?.total || 0;
        const available = svc?.available || 0;

        if (i <= 3 || i % 5 === 0 || ready >= total) {
          console.log(`      Attempt ${i}/${SERVICE_READY_ATTEMPTS}: ${tpl.serviceName} ready=${ready}/${total} available=${available}`);
        }

        if (ready >= total && total > 0) {
          console.log(`    ✓ ${tpl.name} is ready!`);

          // Record success
          recordProviderResult({
            service: label,
            provider,
            outcome: 'ok',
            dseq,
            bidAmount,
            bidDenom,
          });

          // Close immediately (burn-in mode)
          await closeDeployment(chainSDK, owner, dseq, label);
          return { ok: true, provider, bidAmount, bidDenom, dseq };
        }
      } catch (e: any) {
        if (i <= 3) console.log(`      Attempt ${i}: status check error: ${e.message}`);
      }
      await sleep(SERVICE_READY_INTERVAL_MS);
    }

    throw new Error(`Timed out waiting for ${tpl.serviceName} to become ready`);
  } catch (e: any) {
    const reason = e.message || String(e);
    console.log(`    ✖ Failed: ${reason}`);

    // Record failure (if we got far enough to have a provider)
    if (provider) {
      recordProviderResult({
        service: label,
        provider,
        outcome: 'fail',
        reason,
        dseq: dseq || undefined,
        bidAmount,
        bidDenom,
      });
    }

    // Close deployment if created
    if (dseq) {
      await closeDeployment(chainSDK, owner, dseq, label);
    }

    return { ok: false, provider: provider || undefined, bidAmount, bidDenom, dseq: dseq || undefined, error: reason };
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   Template Burn-In — AlternateFutures        ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  // Stale process guard
  console.log('Checking for stale processes...');
  killStaleInstances();
  acquireLockfile();
  const onExit = () => releaseLockfile();
  process.on('exit', onExit);
  process.on('SIGINT', () => { onExit(); process.exit(130); });
  process.on('SIGTERM', () => { onExit(); process.exit(143); });

  // Build template list
  let templates = makeTemplates();
  const filter = process.env.BURNIN_TEMPLATES;
  if (filter) {
    const ids = new Set(filter.split(',').map(s => s.trim()));
    templates = templates.filter(t => ids.has(t.id) || ids.has(t.id.replace('tpl-', '')));
  }

  console.log(`\nTemplates:  ${templates.map(t => t.name).join(', ')}`);
  console.log(`Iterations: ${ITERATIONS}`);
  console.log(`Registry:   ${process.env.AKASH_PROVIDER_REGISTRY_PATH || '(default)'}`);
  console.log(`Bids log:   ${PROVIDER_BIDS_LOG_PATH}\n`);

  // Load wallet
  console.log('Loading wallet and certificate...');
  const { wallet, client, chainSDK } = await loadWalletAndClient();
  const accounts = await wallet.getAccounts();
  const owner = accounts[0]?.address;
  if (!owner) throw new Error('Could not determine wallet address');
  console.log(`Owner: ${owner}`);

  const certificate = await loadCertificate(wallet, client, chainSDK);
  console.log('Certificate loaded.\n');

  // Close any existing deployments first
  console.log('Closing any existing deployments...');
  try {
    const deploymentsRes = await chainSDK.akash.deployment.v1beta4.getDeployments({
      filters: { owner, state: 'active' },
    });
    const active = deploymentsRes.deployments || [];
    if (active.length > 0) {
      console.log(`  Found ${active.length} active deployment(s). Closing...`);
      for (const depWrapper of active) {
        const dep = depWrapper.deployment;
        if (!dep?.id) continue;
        const d = Number((dep.id.dseq as any).low ?? dep.id.dseq);
        await closeDeployment(chainSDK, owner, d, 'pre-cleanup');
      }
      await sleep(10_000);
    } else {
      console.log('  No active deployments.');
    }
  } catch (e: any) {
    console.log(`  Warning: could not check existing deployments: ${e.message}`);
  }

  // ── Run burn-in loop ──────────────────────────────────────────────────────

  const stats: Record<string, { ok: number; fail: number }> = {};
  for (const t of templates) stats[t.id] = { ok: 0, fail: 0 };

  for (let iter = 1; iter <= ITERATIONS; iter++) {
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`  ITERATION ${iter}/${ITERATIONS}  —  ${new Date().toISOString()}`);
    console.log('═'.repeat(70));

    for (const tpl of templates) {
      hr(`${tpl.name} (${tpl.id})`);

      let success = false;
      for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS; attempt++) {
        console.log(`  Provider attempt ${attempt}/${MAX_PROVIDER_ATTEMPTS}...`);
        const result = await deployAndTest(tpl, chainSDK, owner, certificate, attempt, new Set());

        if (result.ok) {
          stats[tpl.id].ok++;
          success = true;
          break;
        } else {
          // Exclude this provider on next attempt
          if (result.provider) {
            console.log(`    Retrying with different provider in 10s...`);
            await sleep(10_000);
          } else {
            break; // No provider even bid — skip
          }
        }
      }

      if (!success) {
        stats[tpl.id].fail++;
        console.log(`  ⚠ ${tpl.name}: all ${MAX_PROVIDER_ATTEMPTS} provider attempts failed this iteration.`);
      }

      // Small delay between templates
      if (tpl !== templates[templates.length - 1]) {
        await sleep(INTER_TEMPLATE_DELAY_MS);
      }
    }

    console.log(`\n  Iteration ${iter} complete.`);

    if (iter < ITERATIONS) {
      console.log(`  Sleeping ${INTER_ITERATION_DELAY_MS / 1000}s before next iteration...`);
      await sleep(INTER_ITERATION_DELAY_MS);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log(`\n${'═'.repeat(70)}`);
  console.log('  TEMPLATE BURN-IN COMPLETE');
  console.log('═'.repeat(70));
  console.log(`\n  ${ITERATIONS} iterations × ${templates.length} templates\n`);

  for (const tpl of templates) {
    const s = stats[tpl.id];
    const pct = ITERATIONS > 0 ? Math.round((s.ok / ITERATIONS) * 100) : 0;
    console.log(`  ${tpl.name.padEnd(25)} ok=${s.ok}  fail=${s.fail}  success=${pct}%`);
  }

  console.log(`\n  Registry: ${process.env.AKASH_PROVIDER_REGISTRY_PATH || '(default)'}`);
  console.log(`  Bids log: ${PROVIDER_BIDS_LOG_PATH}`);
  console.log('');
}

main().catch(async (e) => {
  console.error('\nFATAL ERROR:', e?.message || e);
  releaseLockfile();
  process.exit(1);
});
