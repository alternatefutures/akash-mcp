/**
 * Quick script to redeploy ONLY the SSL proxy with updated pingap.toml.
 * Run: cd akash-mcp && npx tsx /tmp/redeploy-proxy.ts
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
const ROOT = path.resolve(__dirname, '../..');

config({ path: path.resolve(__dirname, '../.env') });
config({ path: path.resolve(__dirname, '../.env.deploy') });

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function toPipedPem(pem: string): string {
  return pem.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '|').replace(/\|+$/g, '').replace(/^\|+/g, '');
}

async function main() {
  const { wallet, client, chainSDK } = await loadWalletAndClient();
  const accounts = await wallet.getAccounts();
  const owner = accounts[0].address;
  const certificate = await loadCertificate(wallet, client, chainSDK);
  console.log(`Owner: ${owner}`);

  // Close orphaned deployments from previous attempts
  for (const oldDseq of [25474494, 25474615, 25474627, 25474654, 25481537, 25481549]) {
    console.log(`Closing DSEQ ${oldDseq}...`);
    try {
      await chainSDK.akash.deployment.v1beta4.closeDeployment({
        id: { owner, dseq: BigInt(oldDseq) }
      });
      console.log(`  Closed ${oldDseq}.`);
    } catch(e: any) {
      console.log(`  (already closed or not found)`);
    }
  }

  await sleep(5000);

  // Read and prepare SDL
  let sdlContent = fs.readFileSync(path.join(ROOT, 'infrastructure-proxy/deploy-akash-ip-lease.yaml'), 'utf8');

  // Inject image tag
  const IMAGE_TAG = 'main';
  sdlContent = sdlContent.replace(
    /image:\s+ghcr\.io\/alternatefutures\/infrastructure-proxy-pingap:[^\s]+/,
    `image: ghcr.io/alternatefutures/infrastructure-proxy-pingap:${IMAGE_TAG}`
  );

  // Inject GHCR credentials
  const ghcrPat = process.env.GHCR_PAT;
  sdlContent = sdlContent.replace(
    /^(\s+)(image:\s+ghcr\.io\/alternatefutures\/[^\n]+)$/gm,
    (_: string, indent: string, imageLine: string) => {
      return `${indent}${imageLine}\n${indent}credentials:\n${indent}  host: ghcr.io\n${indent}  username: alternatefutures\n${indent}  password: ${ghcrPat}`;
    }
  );

  // Inject TLS material
  const certFile = path.join(ROOT, 'infrastructure-proxy/certs/origin.crt');
  const keyFile = path.join(ROOT, 'infrastructure-proxy/certs/origin.key');
  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    const certPiped = toPipedPem(fs.readFileSync(certFile, 'utf8'));
    const keyPiped = toPipedPem(fs.readFileSync(keyFile, 'utf8'));
    sdlContent = sdlContent.replace('<REPLACE_WITH_ORIGIN_CERT>', certPiped);
    sdlContent = sdlContent.replace('<REPLACE_WITH_ORIGIN_KEY>', keyPiped);
  } else {
    throw new Error('Missing TLS cert files');
  }

  // Verify placeholders were replaced
  if (sdlContent.includes('<REPLACE_WITH_ORIGIN_CERT>') || sdlContent.includes('<REPLACE_WITH_ORIGIN_KEY>')) {
    throw new Error('SDL TLS placeholders were not replaced!');
  }

  console.log(`\nDeploying proxy with image: ${IMAGE_TAG}`);

  const sdl = SDL.fromString(sdlContent, 'beta3');
  const groups = sdl.groups();
  const hash = await sdl.manifestVersion();

  const statusRes: any = await chainSDK.cosmos.base.tendermint.v1beta1.getLatestBlock({});
  const dseq = Number(statusRes.block?.header?.height || 0);
  console.log(`Creating deployment DSEQ: ${dseq}`);

  await chainSDK.akash.deployment.v1beta4.createDeployment({
    id: { owner, dseq: BigInt(dseq) },
    groups,
    hash,
    deposit: { amount: { denom: 'uakt', amount: '5000000' }, sources: [1] }
  });

  console.log('Deployment created. Waiting 30s for bids...');
  await sleep(30000);

  const bidsRes: any = await chainSDK.akash.market.v1beta5.getBids({
    filters: { owner, dseq: BigInt(dseq) }
  });

  const bids = bidsRes.bids || [];
  console.log(`Received ${bids.length} bid(s).`);

  const EXCLUDE = new Set([
    'akash15tl6v6gd0nte0syyxnv57zmmspgju4c3xfmdhk',  // hurricane - SSL bad cert when sending manifest
  ]);

  const usable = bids.filter((b: any) => {
    const p = b.bid?.id?.provider;
    return p && !EXCLUDE.has(p);
  });

  console.log(`Usable bids: ${usable.length}`);
  for (const b of usable) {
    console.log(`  ${b.bid?.id?.provider} — ${b.bid?.price?.amount} ${b.bid?.price?.denom}`);
  }

  if (usable.length === 0) {
    console.error('No usable bids! Cleaning up...');
    await chainSDK.akash.deployment.v1beta4.closeDeployment({ id: { owner, dseq: BigInt(dseq) } });
    process.exit(1);
  }

  // Prefer leet.haus
  const preferred = usable.find((b: any) => b.bid?.id?.provider === 'akash1kqzpqqhm39umt06wu8m4hx63v5hefhrfmjf9dj');
  const selected = preferred || usable[0];

  const provider = selected.bid.id.provider;
  const gseq = Number(selected.bid.id.gseq || 1);
  const oseq = Number(selected.bid.id.oseq || 1);
  console.log(`\nSelected provider: ${provider}`);

  await chainSDK.akash.market.v1beta5.createLease({
    bidId: { owner, dseq: BigInt(dseq), provider, gseq, oseq }
  });
  console.log('Lease created.');

  await sleep(10000);

  const providerInfo: any = await chainSDK.akash.provider.v1beta4.getProvider({ owner: provider });
  const providerHostUri = providerInfo?.provider?.hostUri;
  console.log(`Provider host: ${providerHostUri}`);

  console.log('Sending manifest...');
  const lease = { id: { owner, dseq, gseq, oseq, provider } } as any;
  await sendManifest(sdl, lease, certificate, chainSDK);
  console.log('Manifest sent!');

  console.log('Waiting 20s for IP lease assignment...');
  await sleep(20000);

  // Check lease status for IP
  const agent = new https.Agent({ cert: certificate.cert, key: certificate.privateKey, rejectUnauthorized: false, servername: 'localhost' });
  const uri = new URL(providerHostUri);

  const leaseStatus: any = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: uri.hostname,
      port: uri.port ? parseInt(uri.port, 10) : 8443,
      path: `/lease/${dseq}/${gseq}/${oseq}/status`,
      method: 'GET',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      agent
    }, res => {
      let data = '';
      res.on('data', (c: any) => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.end();
  });

  let proxyIp = '';
  if (leaseStatus?.ips) {
    for (const [svc, ipInfo] of Object.entries(leaseStatus.ips) as any) {
      if (Array.isArray(ipInfo)) {
        for (const ip of ipInfo) {
          if (ip.IP) { proxyIp = ip.IP; break; }
        }
      }
    }
  }

  console.log(`\n========================================`);
  console.log(`  PROXY DEPLOYED`);
  console.log(`========================================`);
  console.log(`  DSEQ:     ${dseq}`);
  console.log(`  Provider: ${provider}`);
  console.log(`  IP:       ${proxyIp || '(check Akash console)'}`);
  console.log(`\n  Update Cloudflare DNS A record → ${proxyIp}`);
}

main().catch(e => { console.error('FATAL:', e.message || e); process.exit(1); });
