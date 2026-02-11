/**
 * fix-api-proxy.ts — Redeploy JUST the API + proxy to fix the leet.haus
 * HTTP→HTTPS redirect issue. Keeps DB, auth, and data services as-is.
 *
 * What this does:
 * 1. Closes the current API and proxy deployments
 * 2. Deploys API with a direct TCP forwarded port (bypasses provider nginx)
 * 3. Updates pingap.toml to use the TCP port for API upstream
 * 4. Builds + pushes a new proxy image
 * 5. Deploys the proxy with the updated config
 *
 * Usage: cd akash-mcp && npx tsx scripts/fix-api-proxy.ts
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import { execSync } from 'child_process';
import { config } from 'dotenv';
import { SDL } from '@akashnetwork/chain-sdk';
import { loadWalletAndClient } from '../src/utils/load-wallet.js';
import { loadCertificate } from '../src/utils/load-certificate.js';
import { sendManifest } from '../src/tools/send-manifest.js';

const ROOT = path.resolve('/Users/og/Documents/Projects/AlternateFutures');
config({ path: path.resolve('.env') });
config({ path: path.resolve('.env.deploy') });

function mustEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing env var: ${key}`);
  return v;
}
function optEnv(key: string, fallback = ''): string {
  return process.env[key] || fallback;
}
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
function hr(msg: string) { console.log(`\n${'='.repeat(60)}\n  ${msg}\n${'='.repeat(60)}`); }
function toPipedPem(pem: string): string {
  return pem.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '|').replace(/\|+$/g, '').replace(/^\|+/g, '');
}

// ─── Provider exclusion ───
const ALWAYS_EXCLUDE = new Set([
  'akash1aaul837r7en7hpk9wv2svg8u78fdq0t2j2e82z', // SSL alert 42
  'akash1hgulk6aekakqzc0v6wukrd3dy9n90f5gkl4ezk', // SSL alert 42
  'akash15tl6v6gd0nte0syyxnv57zmmspgju4c3xfmdhk', // SSL alert 42
]);

// ─── Current deployment DSEQs (from .env.deploy) ───
// Already closed: 25474472 (API), 25474494/615/627/654/703 (proxy attempts)
// No DSEQs to close — all were cleaned up in previous runs
const OLD_API_DSEQ = 0;  // Skip
const OLD_PROXY_DSEQS: number[] = [];

async function fetchLeaseStatus(
  providerHost: string,
  providerPort: number,
  dseq: number,
  gseq: number,
  oseq: number,
  cert: any
): Promise<any> {
  const agent = new https.Agent({ cert: cert.cert, key: cert.privateKey, rejectUnauthorized: false, servername: 'localhost' });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: providerHost, port: providerPort,
      path: `/lease/${dseq}/${gseq}/${oseq}/status`,
      method: 'GET',
      headers: { Accept: 'application/json' },
      agent,
    }, res => {
      let data = '';
      res.on('data', (c: any) => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(new Error('timeout')); });
    req.end();
  });
}

async function waitForReady(
  providerHostUri: string,
  dseq: number,
  gseq: number,
  oseq: number,
  cert: any,
  label: string,
  maxWait = 120_000
): Promise<any> {
  const uri = new URL(providerHostUri);
  const host = uri.hostname;
  const port = parseInt(uri.port || '8443', 10);
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    try {
      const status = await fetchLeaseStatus(host, port, dseq, gseq, oseq, cert);
      if (status?.services) {
        let allReady = true;
        for (const [svc, info] of Object.entries(status.services) as any) {
          const ready = info.ready_replicas || 0;
          const available = info.available_replicas || 0;
          const total = info.total || 0;
          console.log(`  [${label}] ${svc}: ready=${ready}/${total}, available=${available}/${total}`);
          if (total === 0 || (ready === 0 && available === 0)) allReady = false;
        }
        if (allReady) return status;
      }
    } catch (e: any) {
      console.log(`  [${label}] Lease status check: ${e.message?.slice(0, 80)}`);
    }
    await sleep(10_000);
  }
  throw new Error(`[${label}] Timed out waiting for services to become ready (${maxWait / 1000}s)`);
}

async function deploySDLAndWait(
  sdlContent: string,
  chainSDK: any,
  owner: string,
  certificate: any,
  label: string,
  excludeProviders: Set<string>,
  deposit = 5_000_000,
): Promise<{ dseq: number; gseq: number; oseq: number; provider: string; providerHostUri: string; status: any }> {
  const sdl = SDL.fromString(sdlContent, 'beta3');
  const groups = sdl.groups();
  const hash = await sdl.manifestVersion();

  const statusRes: any = await chainSDK.cosmos.base.tendermint.v1beta1.getLatestBlock({});
  const dseq = Number(statusRes.block?.header?.height || 0);
  console.log(`  [${label}] Creating deployment DSEQ: ${dseq}`);

  await chainSDK.akash.deployment.v1beta4.createDeployment({
    id: { owner, dseq: BigInt(dseq) },
    groups, hash,
    deposit: { amount: { denom: 'uakt', amount: String(deposit) }, sources: [1] },
  });
  console.log(`  [${label}] Deployment created. Waiting 30s for bids...`);
  await sleep(30_000);

  const bidsRes: any = await chainSDK.akash.market.v1beta5.getBids({
    filters: { owner, dseq: BigInt(dseq) },
  });
  const bids = bidsRes.bids || [];
  console.log(`  [${label}] Received ${bids.length} bid(s).`);

  const usable = bids.filter((b: any) => {
    const p = b.bid?.id?.provider;
    return p && !excludeProviders.has(p) && !ALWAYS_EXCLUDE.has(p);
  });
  console.log(`  [${label}] Usable bids: ${usable.length}`);
  usable.forEach((b: any) => console.log(`    ${b.bid?.id?.provider}`));

  if (usable.length === 0) {
    console.error(`  [${label}] No usable bids! Closing deployment.`);
    await chainSDK.akash.deployment.v1beta4.closeDeployment({ id: { owner, dseq: BigInt(dseq) } });
    throw new Error(`No usable bids for ${label}`);
  }

  // Pick cheapest usable bid
  const selected = usable.sort((a: any, b: any) =>
    parseFloat(a.bid?.price?.amount || '999') - parseFloat(b.bid?.price?.amount || '999')
  )[0];

  const provider = selected.bid.id.provider;
  const gseq = Number(selected.bid.id.gseq || 1);
  const oseq = Number(selected.bid.id.oseq || 1);
  console.log(`  [${label}] Selected provider: ${provider}`);

  await chainSDK.akash.market.v1beta5.createLease({
    bidId: { owner, dseq: BigInt(dseq), provider, gseq, oseq },
  });
  console.log(`  [${label}] Lease created.`);
  await sleep(10_000);

  const providerInfo: any = await chainSDK.akash.provider.v1beta4.getProvider({ owner: provider });
  const providerHostUri = providerInfo?.provider?.hostUri;
  console.log(`  [${label}] Provider host: ${providerHostUri}`);

  console.log(`  [${label}] Sending manifest...`);
  const lease = { id: { owner, dseq, gseq, oseq, provider } } as any;
  await sendManifest(sdl, lease, certificate, chainSDK);
  console.log(`  [${label}] Manifest sent!`);

  console.log(`  [${label}] Waiting for services to become ready...`);
  const status = await waitForReady(providerHostUri, dseq, gseq, oseq, certificate, label);
  return { dseq, gseq, oseq, provider, providerHostUri, status };
}

async function main() {
  hr('FIX: Redeploy API + Proxy');
  console.log('  This script redeploys just the API and proxy.');
  console.log('  DB, auth, and data services are kept as-is.\n');

  const { wallet, chainSDK } = await loadWalletAndClient();
  const accounts = await wallet.getAccounts();
  const owner = accounts[0].address;
  const certificate = await loadCertificate(wallet);
  console.log(`  Owner: ${owner}`);

  // ── Step 1: Close old API + proxy ──
  hr('Step 1: Close old API + proxy');
  for (const oldDseq of [OLD_API_DSEQ, ...OLD_PROXY_DSEQS]) {
    console.log(`  Closing DSEQ ${oldDseq}...`);
    try {
      await chainSDK.akash.deployment.v1beta4.closeDeployment({
        id: { owner, dseq: BigInt(oldDseq) },
      });
      console.log(`    Closed.`);
    } catch (e: any) {
      console.log(`    (already closed or not found)`);
    }
  }
  await sleep(5000);

  // ── Step 2: Deploy API ──
  hr('Step 2: Deploy API (with direct TCP port)');

  // Prepare env vars (same as redeploy-all.ts deployApi)
  const databaseUrl = mustEnv('DATABASE_URL');
  const ipfsApiUrl = mustEnv('IPFS_API_URL');
  // OTEL endpoint from data services deployment (Jaeger OTLP on akashprovid.com)
  const otelEndpoint = optEnv('OTEL_EXPORTER_OTLP_ENDPOINT', 'http://provider.akashprovid.com:31988');
  const jwtSecret = mustEnv('JWT_SECRET');
  const resendApiKey = optEnv('RESEND_API_KEY');
  const arweaveWallet = optEnv('ARWEAVE_WALLET', 'your_arweave_wallet');
  const filecoinWalletKey = optEnv('FILECOIN_WALLET_KEY', 'your_filecoin_wallet_key');
  const sentryDsn = optEnv('SENTRY_DSN', 'your_sentry_dsn');
  const akashMnemonic = optEnv('AKASH_MNEMONIC');
  const rpcEndpoint = optEnv('RPC_ENDPOINT', 'https://rpc.akashnet.net:443');
  const grpcEndpoint = optEnv('GRPC_ENDPOINT', 'https://akash-grpc.publicnode.com:443');
  const akashMcpPath = optEnv('AKASH_MCP_PATH', '/app/akash-mcp/dist/index.js');

  // Build cert JSON for MCP
  const certJson = JSON.stringify({ cert: certificate.cert, publicKey: certificate.publicKey, privateKey: certificate.privateKey });
  const akashCertJsonB64 = Buffer.from(certJson).toString('base64');

  let sdlContent = fs.readFileSync(path.join(ROOT, 'service-cloud-api/deploy-api.yaml'), 'utf8');

  // Use pre-pushed image (built earlier)
  const apiTag = 'deploy-1770805399882';
  console.log(`  Using pre-pushed API image: ${apiTag}`);
  sdlContent = sdlContent.replace(/service-cloud-api:latest/g, `service-cloud-api:${apiTag}`);

  // Replace env placeholders
  sdlContent = sdlContent.replace(/__DATABASE_URL__/g, databaseUrl);
  sdlContent = sdlContent.replace(/__IPFS_API_URL__/g, ipfsApiUrl);
  sdlContent = sdlContent.replace(/__OTEL_ENDPOINT__/g, otelEndpoint);
  sdlContent = sdlContent.replace(/your_jwt_secret_min_32_chars_please_change_this_in_production/g, jwtSecret);
  sdlContent = sdlContent.replace(/your_resend_api_key/g, resendApiKey);
  sdlContent = sdlContent.replace(/your_arweave_wallet/g, arweaveWallet);
  sdlContent = sdlContent.replace(/your_filecoin_wallet_key/g, filecoinWalletKey);
  sdlContent = sdlContent.replace(/your_sentry_dsn/g, sentryDsn);
  sdlContent = sdlContent.replace(/__AKASH_MNEMONIC__/g, akashMnemonic);
  sdlContent = sdlContent.replace(/__RPC_ENDPOINT__/g, rpcEndpoint);
  sdlContent = sdlContent.replace(/__GRPC_ENDPOINT__/g, grpcEndpoint);
  sdlContent = sdlContent.replace(/__AKASH_MCP_PATH__/g, akashMcpPath);
  sdlContent = sdlContent.replace(/__AKASH_CERT_JSON__/g, akashCertJsonB64);

  // Inject GHCR credentials
  const ghcrPat = mustEnv('GHCR_PAT');
  sdlContent = sdlContent.replace(
    /^(\s+)(image:\s+ghcr\.io\/alternatefutures\/[^\n]+)$/gm,
    (_: string, indent: string, imageLine: string) =>
      `${indent}${imageLine}\n${indent}credentials:\n${indent}  host: ghcr.io\n${indent}  username: alternatefutures\n${indent}  password: ${ghcrPat}`
  );

  const apiResult = await deploySDLAndWait(sdlContent, chainSDK, owner, certificate, 'api', new Set());

  // Extract API ingress and TCP forwarded port
  let apiIngressUrl = '';
  let apiTcpHost = '';
  let apiTcpPort = 0;

  if (apiResult.status?.services) {
    for (const [, info] of Object.entries(apiResult.status.services) as any) {
      const uris = info?.uris || [];
      for (const uri of uris) {
        if (uri.includes('.ingress.')) apiIngressUrl = uri;
        else if (!apiIngressUrl) apiIngressUrl = uri;
      }
    }
  }
  if (apiResult.status?.forwarded_ports?.api) {
    for (const fp of apiResult.status.forwarded_ports.api) {
      if (fp.port === 4000 && fp.proto === 'TCP') {
        apiTcpHost = fp.host;
        apiTcpPort = fp.externalPort;
        break;
      }
    }
  }

  console.log(`\n  API ingress: ${apiIngressUrl}`);
  console.log(`  API TCP forwarded: ${apiTcpHost}:${apiTcpPort}`);

  // ── Step 3: Update pingap.toml ──
  hr('Step 3: Update pingap.toml');
  const pingapPath = path.join(ROOT, 'infrastructure-proxy/pingap.toml');
  let pingapContent = fs.readFileSync(pingapPath, 'utf8');

  // Determine API upstream: prefer TCP forwarded port, fall back to HTTP ingress
  let apiUpstreamAddr: string;
  let apiHostHeader: string;

  if (apiTcpHost && apiTcpPort) {
    // TCP forwarded port — connects directly to container, bypasses provider nginx
    apiUpstreamAddr = `${apiTcpHost}:${apiTcpPort}`;
    apiHostHeader = `${apiTcpHost}:${apiTcpPort}`;
    console.log(`  Using TCP forwarded port: ${apiUpstreamAddr}`);
  } else if (apiIngressUrl) {
    // Fall back to HTTP ingress (may not work on leet.haus)
    apiUpstreamAddr = `${apiIngressUrl}:80`;
    apiHostHeader = apiIngressUrl;
    console.log(`  WARNING: No TCP port found. Using HTTP ingress: ${apiUpstreamAddr}`);
  } else {
    throw new Error('Could not determine API upstream address');
  }

  // Rewrite the entire upstreams.api section
  pingapContent = pingapContent.replace(
    /# API Service Backend[^\[]*\[upstreams\.api\][^\[]*/s,
    `# API Service Backend (DSEQ ${apiResult.dseq} — TCP forwarded port)\n` +
    `[upstreams.api]\n` +
    `addrs = ["${apiUpstreamAddr}"]\n` +
    `connection_timeout = "10s"\n` +
    `health_check_connection_timeout = "10s"\n\n`
  );

  // Update API location Host header
  pingapContent = pingapContent.replace(
    /(# Route: API Service\n\[locations\.api\]\n[^]*?proxy_set_headers = \[")[^"]*(".*?"[^"]*?"[^"]*?"[^"]*?"\])/s,
    (match, prefix, suffix) => {
      return `${prefix}Host: ${apiHostHeader}${suffix}`;
    }
  );

  // Also update the X-Forwarded-Host in proxy_set_headers
  pingapContent = pingapContent.replace(
    /(\[locations\.api\][^]*?proxy_set_headers = \[.*?)X-Forwarded-Host: [^"]+/s,
    '$1X-Forwarded-Host: api.alternatefutures.ai'
  );

  fs.writeFileSync(pingapPath, pingapContent);
  console.log('  ✓ Updated: infrastructure-proxy/pingap.toml');

  // ── Step 4: Build + push proxy image ──
  hr('Step 4: Build + push proxy image');
  const proxyTag = `deploy-${Date.now()}`;
  try {
    execSync(
      `docker buildx build --no-cache --platform linux/amd64 ` +
      `-f infrastructure-proxy/Dockerfile ` +
      `-t ghcr.io/alternatefutures/infrastructure-proxy-pingap:${proxyTag} ` +
      `-t ghcr.io/alternatefutures/infrastructure-proxy-pingap:latest ` +
      `--push infrastructure-proxy/`,
      { cwd: ROOT, stdio: 'pipe', timeout: 120_000 }
    );
    console.log(`  Proxy image pushed: ${proxyTag}`);
  } catch (e: any) {
    console.error(`  Proxy build failed: ${e.message?.slice(0, 200)}`);
    throw e;
  }

  // ── Step 5: Deploy proxy ──
  hr('Step 5: Deploy proxy');
  let proxySdl = fs.readFileSync(path.join(ROOT, 'infrastructure-proxy/deploy-akash-ip-lease.yaml'), 'utf8');

  // Inject image tag
  proxySdl = proxySdl.replace(
    /infrastructure-proxy-pingap:[^\s]+/,
    `infrastructure-proxy-pingap:${proxyTag}`
  );

  // Inject GHCR credentials
  proxySdl = proxySdl.replace(
    /^(\s+)(image:\s+ghcr\.io\/alternatefutures\/[^\n]+)$/gm,
    (_: string, indent: string, imageLine: string) =>
      `${indent}${imageLine}\n${indent}credentials:\n${indent}  host: ghcr.io\n${indent}  username: alternatefutures\n${indent}  password: ${ghcrPat}`
  );

  // Inject TLS material
  const certFile = path.join(ROOT, 'infrastructure-proxy/certs/origin.crt');
  const keyFile = path.join(ROOT, 'infrastructure-proxy/certs/origin.key');
  if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
    throw new Error('Missing TLS cert files at infrastructure-proxy/certs/');
  }
  const certPiped = toPipedPem(fs.readFileSync(certFile, 'utf8'));
  const keyPiped = toPipedPem(fs.readFileSync(keyFile, 'utf8'));
  proxySdl = proxySdl.replace('<REPLACE_WITH_ORIGIN_CERT>', certPiped);
  proxySdl = proxySdl.replace('<REPLACE_WITH_ORIGIN_KEY>', keyPiped);

  const proxyResult = await deploySDLAndWait(proxySdl, chainSDK, owner, certificate, 'SSL-proxy', new Set(), 5_000_000);

  // Get proxy IP
  let proxyIp = '';
  if (proxyResult.status?.ips) {
    for (const [, ipInfo] of Object.entries(proxyResult.status.ips) as any) {
      if (Array.isArray(ipInfo)) {
        for (const ip of ipInfo) {
          if (ip.IP) { proxyIp = ip.IP; break; }
        }
      }
      if (proxyIp) break;
    }
  }

  // If no IP yet, wait a bit more
  if (!proxyIp) {
    console.log('  [SSL-proxy] Waiting for IP lease assignment...');
    await sleep(20_000);
    const uri = new URL(proxyResult.providerHostUri);
    const ipStatus = await fetchLeaseStatus(uri.hostname, parseInt(uri.port || '8443', 10), proxyResult.dseq, proxyResult.gseq, proxyResult.oseq, certificate);
    if (ipStatus?.ips) {
      for (const [, ipInfo] of Object.entries(ipStatus.ips) as any) {
        if (Array.isArray(ipInfo)) {
          for (const ip of ipInfo) {
            if (ip.IP) { proxyIp = ip.IP; break; }
          }
        }
        if (proxyIp) break;
      }
    }
  }

  // ── Step 6: Update .env.deploy ──
  hr('Step 6: Update .env.deploy');
  const envDeployPath = path.resolve('.env.deploy');
  let envContent = fs.readFileSync(envDeployPath, 'utf8');
  envContent = envContent.replace(/API_DSEQ=\d+/, `API_DSEQ=${apiResult.dseq}`);
  envContent = envContent.replace(/API_PROVIDER=\S+/, `API_PROVIDER=${apiResult.provider}`);
  envContent = envContent.replace(/PROXY_DSEQ=\d+/, `PROXY_DSEQ=${proxyResult.dseq}`);
  envContent = envContent.replace(/PROXY_PROVIDER=\S+/, `PROXY_PROVIDER=${proxyResult.provider}`);
  fs.writeFileSync(envDeployPath, envContent);
  console.log('  ✓ Updated: .env.deploy');

  // ── Summary ──
  hr('DONE — Summary');
  console.log(`
  API:
    DSEQ:           ${apiResult.dseq}
    Provider:       ${apiResult.provider}
    Ingress:        ${apiIngressUrl}
    TCP Port:       ${apiTcpHost}:${apiTcpPort}
    Proxy upstream: ${apiUpstreamAddr}

  Proxy:
    DSEQ:     ${proxyResult.dseq}
    Provider: ${proxyResult.provider}
    IP:       ${proxyIp || '(check Akash console)'}

  ${proxyIp ? `Update Cloudflare DNS A record → ${proxyIp}` : ''}
  `);

  // Quick verification
  if (proxyIp) {
    console.log('  Testing API through proxy...');
    await sleep(10_000);
    try {
      const testResult = execSync(
        `curl -s -w "\\nHTTP %{http_code}" --max-time 15 --insecure ` +
        `-X POST "https://${proxyIp}/graphql" ` +
        `-H "Host: api.alternatefutures.ai" ` +
        `-H "Content-Type: application/json" ` +
        `-d '{"query":"{ __typename }"}'`,
        { timeout: 20_000 }
      ).toString();
      console.log(`  Proxy test:\n${testResult}`);
    } catch (e: any) {
      console.log(`  Proxy test failed: ${e.message?.slice(0, 100)}`);
    }
  }
}

main().catch(e => { console.error('\nFATAL:', e?.message || e); process.exit(1); });
