#!/usr/bin/env npx tsx
/**
 * Deploy the infrastructure SSL proxy (Pingap) to Akash using an IP Lease.
 *
 * What this does:
 * - Reads Cloudflare Origin cert/key from local files (gitignored)
 * - Injects them into `infrastructure-proxy/deploy-akash-ip-lease.yaml`
 * - Creates a new deployment (new DSEQ)
 * - Waits for bids, selects a provider (excluding known-bad providers)
 * - Creates the lease
 * - Sends the manifest to the provider via mTLS
 * - Prints service URIs and tries to extract the leased public IP
 *
 * Required local files (NOT committed):
 * - infrastructure-proxy/certs/origin.crt
 * - infrastructure-proxy/certs/origin.key
 *
 * Optional env:
 * - DEPOSIT_UAKT: deposit amount (default 5000000)
 * - EXCLUDE_PROVIDERS: comma-separated provider addresses to skip
 * - PROXY_IMAGE: override image (default ghcr.io/alternatefutures/infrastructure-proxy-pingap:main)
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';
import { SDL } from '@akashnetwork/chain-sdk';

import { loadWalletAndClient } from '../src/utils/load-wallet.js';
import { loadCertificate } from '../src/utils/load-certificate.js';
import { sendManifest } from '../src/tools/send-manifest.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function toPipedPem(pem: string) {
  return pem.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '|').replace(/\|+$/g, '').replace(/^\|+/g, '');
}

function mustReadFile(filePath: string) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing required file: ${filePath}`);
  }
  return fs.readFileSync(filePath, 'utf8');
}

async function queryLeaseStatus(providerHostUri: string, dseq: number, gseq: number, oseq: number, certificate: any) {
  const leasePath = `/lease/${dseq}/${gseq}/${oseq}/status`;
  const uri = new URL(providerHostUri);

  const agent = new https.Agent({
    cert: certificate.cert,
    key: certificate.privateKey,
    rejectUnauthorized: false,
    // Use 'localhost' as SNI to trigger mTLS mode on providers
    servername: 'localhost',
  });

  return await new Promise<any>((resolve, reject) => {
    const req = https.request(
      {
        hostname: uri.hostname,
        port: uri.port ? parseInt(uri.port, 10) : 8443,
        path: leasePath,
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        agent,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`Lease status HTTP ${res.statusCode}: ${data}`));
          }
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

async function main() {
  const depositUakt = parseInt(process.env.DEPOSIT_UAKT || '5000000', 10);
  const proxyImage = process.env.PROXY_IMAGE || 'ghcr.io/alternatefutures/infrastructure-proxy-pingap:main';

  const excludeProviders = new Set(
    (process.env.EXCLUDE_PROVIDERS ||
      // Default excludes:
      // - auth provider (avoid NAT hairpin to auth ingress)
      // - europlots (historically problematic for proxy routing)
      'akash1xmjzu9dczlg9fa4v3pfvwzn7ty89r003laj4ac,akash18ga02jzaq8cw52anyhzkwta5wygufgu6zsz6xc')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );

  const certFile = path.resolve(__dirname, '../../infrastructure-proxy/certs/origin.crt');
  const keyFile = path.resolve(__dirname, '../../infrastructure-proxy/certs/origin.key');
  const sdlTemplateFile = path.resolve(__dirname, '../../infrastructure-proxy/deploy-akash-ip-lease.yaml');

  console.log('=== Deploy SSL Proxy (IP Lease) ===\n');
  console.log('SDL template:', sdlTemplateFile);
  console.log('Cert file:', certFile);
  console.log('Key file:', keyFile);
  console.log('Proxy image:', proxyImage);
  console.log('Deposit (uakt):', depositUakt);
  console.log('Excluded providers:', Array.from(excludeProviders).join(', ') || '(none)');

  // Load wallet + chain client
  const { wallet, chainSDK } = await loadWalletAndClient();
  const accounts = await wallet.getAccounts();
  const owner = accounts[0]?.address;
  if (!owner) throw new Error('Could not determine wallet address');
  console.log('\nOwner:', owner);

  // Ensure we have a valid certificate (mTLS)
  const certificate = await loadCertificate(wallet, chainSDK);
  console.log('Certificate loaded');

  // Read and inject TLS into SDL
  const originCert = mustReadFile(certFile);
  const originKey = mustReadFile(keyFile);

  let rawSDL = mustReadFile(sdlTemplateFile);
  rawSDL = rawSDL.replace(/image:\s+ghcr\.io\/[^/]+\/infrastructure-proxy-pingap:\S+/g, `image: ${proxyImage}`);
  rawSDL = rawSDL.replace('<REPLACE_WITH_ORIGIN_CERT>', toPipedPem(originCert));
  rawSDL = rawSDL.replace('<REPLACE_WITH_ORIGIN_KEY>', toPipedPem(originKey));

  if (rawSDL.includes('<REPLACE_WITH_ORIGIN_CERT>') || rawSDL.includes('<REPLACE_WITH_ORIGIN_KEY>')) {
    throw new Error('SDL TLS placeholders were not replaced (unexpected template format).');
  }

  // Create deployment
  console.log('\n1) Creating deployment...');
  const sdl = SDL.fromString(rawSDL, 'beta3');
  const groups = sdl.groups();
  const hash = await sdl.manifestVersion();

  const statusResponse = await chainSDK.cosmos.base.tendermint.v1beta1.getLatestBlock({});
  const dseq = Number(statusResponse.block?.header?.height || 0);
  if (!dseq) throw new Error('Could not determine block height for DSEQ');

  await chainSDK.akash.deployment.v1beta4.createDeployment({
    id: { owner, dseq: BigInt(dseq) },
    groups,
    hash,
    deposit: {
      amount: { denom: 'uakt', amount: String(depositUakt) },
      sources: [1], // Source.balance
    },
  });

  console.log('Created deployment. DSEQ:', dseq);

  // Wait for bids and pick a provider
  console.log('\n2) Waiting for bids (30s)...');
  await sleep(30_000);

  const bidsResponse = await chainSDK.akash.market.v1beta5.getBids({
    filters: { owner, dseq: BigInt(dseq) },
  });

  const bids = bidsResponse.bids || [];
  if (bids.length === 0) {
    throw new Error('No bids received. Try again in ~30s or increase deposit.');
  }

  // Choose first non-excluded provider (could be enhanced to choose cheapest)
  const selected = bids.find((b: any) => {
    const provider = b.bid?.id?.provider;
    return provider && !excludeProviders.has(provider);
  });

  if (!selected?.bid?.id) {
    const providers = bids.map((b: any) => b.bid?.id?.provider).filter(Boolean);
    throw new Error(
      `No usable bids after exclusions. Providers that bid: ${providers.join(', ')}. Adjust EXCLUDE_PROVIDERS and retry.`
    );
  }

  const bidId = selected.bid.id;
  const provider = bidId.provider;
  const gseq = Number(bidId.gseq || 1);
  const oseq = Number(bidId.oseq || 1);
  const bseq = Number(bidId.bseq || 0);

  console.log('Selected provider:', provider);
  console.log(`Lease ID: dseq=${dseq} gseq=${gseq} oseq=${oseq} bseq=${bseq}`);

  // Create lease
  console.log('\n3) Creating lease...');
  await chainSDK.akash.market.v1beta5.createLease({
    bidId: {
      owner,
      dseq: BigInt(dseq),
      gseq,
      oseq,
      provider,
      bseq,
    },
  });
  console.log('Lease created');

  // Send manifest
  console.log('\n4) Sending manifest...');
  await sendManifest(sdl, { id: { owner, dseq, gseq, oseq, provider } } as any, certificate, chainSDK);
  console.log('Manifest sent');

  // Provider hostUri
  const providerRes = await chainSDK.akash.provider.v1beta4.getProvider({ owner: provider });
  const hostUri = providerRes.provider?.hostUri;
  if (!hostUri) throw new Error('Could not resolve provider hostUri');
  console.log('Provider hostUri:', hostUri);

  // Poll lease status to extract IP/URIs
  console.log('\n5) Waiting for service readiness...');
  for (let attempt = 1; attempt <= 12; attempt++) {
    await sleep(10_000);
    try {
      const status = await queryLeaseStatus(hostUri, dseq, gseq, oseq, certificate);
      const text = JSON.stringify(status);
      const ipMatch = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);

      console.log(`Attempt ${attempt}/12: lease status OK`);

      if (status?.services) {
        for (const [svc, info] of Object.entries(status.services) as any) {
          const uris = info?.uris || [];
          if (uris.length) {
            console.log(`- Service ${svc} URIs:`);
            for (const u of uris) console.log(`  - ${u}`);
          }
        }
      }

      if (ipMatch) {
        console.log('\n✅ Leased public IP detected:', ipMatch[0]);
        console.log('\nNext: set Cloudflare A records to that IP (orange-cloud/proxied).');
        console.log('At minimum: auth.alternatefutures.ai →', ipMatch[0]);
        return;
      }
    } catch (e: any) {
      console.log(`Attempt ${attempt}/12: not ready yet (${e.message || e})`);
    }
  }

  console.log('\nLease did not report an IP within the timeout.');
  console.log('Open the deployment in Akash Console to view the leased IP, or re-run this script to poll longer.');
}

main().catch((e) => {
  console.error('\nERROR:', e?.message || e);
  process.exit(1);
});

