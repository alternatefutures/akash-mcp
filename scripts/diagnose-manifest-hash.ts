#!/usr/bin/env npx tsx
/**
 * Diagnose manifest hash mismatch between JS SDK and Go provider.
 *
 * This script:
 *   1. Parses an SDL with the JS SDK
 *   2. Computes the manifest hash (JS side)
 *   3. Computes the manifest JSON body
 *   4. Queries the on-chain deployment version hash (if DSEQ provided)
 *   5. Compares hashes and prints full manifest body for manual inspection
 *   6. Optionally sends the manifest and logs the FULL response (even on 200)
 *
 * Usage:
 *   cd akash-mcp
 *
 *   # Just print manifest + hash for an SDL (no deployment needed):
 *   npx tsx scripts/diagnose-manifest-hash.ts --sdl ../service-cloud-api/deploy-yugabyte.yaml
 *
 *   # Also compare against on-chain hash for an existing deployment:
 *   npx tsx scripts/diagnose-manifest-hash.ts --sdl ../service-cloud-api/deploy-yugabyte.yaml --dseq 25422159
 *
 *   # Full test: send manifest + log response body:
 *   npx tsx scripts/diagnose-manifest-hash.ts --sdl ../service-cloud-api/deploy-yugabyte.yaml --dseq 25422159 --provider akash1lp4y4... --send
 */

import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';
import { SDL } from '@akashnetwork/chain-sdk';
import { loadWalletAndClient } from '../src/utils/load-wallet.js';
import { loadCertificate } from '../src/utils/load-certificate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, '../.env') });
config({ path: path.resolve(__dirname, '../.env.deploy') });

// ─── Parse CLI args ────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}
const hasFlag = (name: string) => args.includes(`--${name}`);

const sdlPath = getArg('sdl');
const dseq = getArg('dseq');
const providerAddr = getArg('provider');
const shouldSend = hasFlag('send');

if (!sdlPath) {
  console.error('Usage: npx tsx scripts/diagnose-manifest-hash.ts --sdl <path> [--dseq <n>] [--provider <addr>] [--send]');
  process.exit(1);
}

async function main() {
  // 1. Parse SDL
  const sdlContent = fs.readFileSync(path.resolve(sdlPath!), 'utf8');
  const sdl = SDL.fromString(sdlContent, 'beta3');

  // 2. Compute JS-side manifest and hash
  const manifestJSON = sdl.manifestSortedJSON();
  const manifestHash = await sdl.manifestVersion();
  const hashHex = Buffer.from(manifestHash).toString('hex');
  const hashBase64 = Buffer.from(manifestHash).toString('base64');

  console.log('=== JS SDK Manifest Diagnostics ===\n');
  console.log(`SDL file:       ${sdlPath}`);
  console.log(`Manifest bytes: ${Buffer.byteLength(manifestJSON)}`);
  console.log(`Hash (hex):     ${hashHex}`);
  console.log(`Hash (base64):  ${hashBase64}`);
  console.log('');

  // 3. Print first 2000 chars of manifest body (or full if short)
  console.log('=== Manifest JSON (first 2000 chars) ===');
  console.log(manifestJSON.substring(0, 2000));
  if (manifestJSON.length > 2000) {
    console.log(`\n... (${manifestJSON.length - 2000} more chars, total ${manifestJSON.length})`);
  }
  console.log('');

  // 4. Print groups() structure (what gets stored on-chain)
  const groups = sdl.groups();
  console.log('=== Groups structure (first 1000 chars) ===');
  const groupsStr = JSON.stringify(groups, null, 2);
  console.log(groupsStr.substring(0, 1000));
  if (groupsStr.length > 1000) console.log(`\n... (truncated, total ${groupsStr.length} chars)`);
  console.log('');

  // 5. If DSEQ provided, query on-chain hash and compare
  if (dseq) {
    console.log('=== On-Chain Hash Comparison ===');
    const { chainSDK } = await loadWalletAndClient();
    const accounts = (await (await import('@cosmjs/proto-signing')).DirectSecp256k1HdWallet.fromMnemonic(
      (process.env.AKASH_MNEMONIC || '').trim(), { prefix: 'akash' }
    )).getAccounts();
    const owner = accounts[0].address;

    try {
      const depRes = await chainSDK.akash.deployment.v1beta4.getDeployment({
        id: { owner, dseq: BigInt(dseq) },
      });

      const onChainGroups = depRes.deployment?.groups || [];
      console.log(`On-chain groups count: ${onChainGroups.length}`);

      // The on-chain deployment stores the version/hash
      // Try to extract it from the raw response
      const depAny = depRes as any;
      const onChainVersion = depAny?.deployment?.deployment?.version ||
                              depAny?.deployment?.version ||
                              depAny?.version;
      if (onChainVersion) {
        let onChainHex: string;
        if (onChainVersion instanceof Uint8Array) {
          onChainHex = Buffer.from(onChainVersion).toString('hex');
        } else if (typeof onChainVersion === 'string') {
          // Might be base64-encoded
          onChainHex = Buffer.from(onChainVersion, 'base64').toString('hex');
        } else {
          onChainHex = `(unexpected type: ${typeof onChainVersion})`;
        }
        console.log(`On-chain hash (hex): ${onChainHex}`);
        console.log(`JS SDK hash (hex):   ${hashHex}`);
        console.log(`Match: ${onChainHex === hashHex ? '✅ YES' : '❌ NO — THIS IS THE BUG'}`);
      } else {
        console.log('Could not extract on-chain version hash from deployment response.');
        console.log('Deployment response keys:', JSON.stringify(Object.keys(depRes.deployment || {})));
        // Dump raw response for inspection
        console.log('Raw deployment (first 500 chars):', JSON.stringify(depRes).substring(0, 500));
      }
    } catch (e: any) {
      console.log(`Failed to query deployment: ${e.message}`);
      console.log('(Deployment may be closed or DSEQ is wrong)');
    }
    console.log('');
  }

  // 6. If --send, actually send the manifest and log the full response
  if (shouldSend && dseq && providerAddr) {
    console.log('=== Sending Manifest (with full response logging) ===');
    const { wallet, client, chainSDK } = await loadWalletAndClient();
    const certificate = await loadCertificate(wallet, client, chainSDK);
    const accounts = await wallet.getAccounts();
    const owner = accounts[0].address;

    // Get provider host URI
    const provRes = await chainSDK.akash.provider.v1beta4.getProvider({ owner: providerAddr });
    const hostUri = provRes.provider?.hostUri;
    if (!hostUri) {
      console.error('Could not resolve provider hostUri');
      process.exit(1);
    }

    const uri = new URL(hostUri);
    const port = uri.port ? parseInt(uri.port, 10) : 8443;
    const reqPath = `/deployment/${dseq}/manifest`;

    console.log(`Provider: ${hostUri}`);
    console.log(`PUT https://${uri.hostname}:${port}${reqPath}`);
    console.log(`Body size: ${Buffer.byteLength(manifestJSON)} bytes`);
    console.log('');

    const agent = new https.Agent({
      cert: certificate.cert,
      key: certificate.privateKey,
      rejectUnauthorized: false,
      servername: 'localhost',
    });

    const result = await new Promise<{ status: number; headers: any; body: string }>((resolve, reject) => {
      const req = https.request(
        {
          hostname: uri.hostname,
          port,
          path: reqPath,
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'Content-Length': Buffer.byteLength(manifestJSON),
          },
          agent,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: data }));
        }
      );
      req.on('error', reject);
      req.write(manifestJSON);
      req.end();
    });

    console.log(`Response status: ${result.status}`);
    console.log(`Response headers: ${JSON.stringify(result.headers, null, 2)}`);
    console.log(`Response body: "${result.body}"`);
    console.log(`Body length: ${result.body.length} bytes`);

    if (result.status === 200 && result.body.length === 0) {
      console.log('\n⚠ Provider returned 200 with EMPTY body.');
      console.log('  This means the request was queued but NOT necessarily validated.');
      console.log('  The provider validates the manifest hash ASYNCHRONOUSLY.');
      console.log('  If "kube: lease not found" persists, the hash likely mismatches.');
    } else if (result.status === 200 && result.body.length > 0) {
      console.log('\n✅ Provider returned 200 with body — check body for details.');
    } else {
      console.log(`\n❌ Provider returned HTTP ${result.status}.`);
    }

    // Also try querying lease status after a short wait
    console.log('\n--- Lease status check (15s wait) ---');
    await new Promise(r => setTimeout(r, 15_000));

    const leaseResult = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = https.request(
        {
          hostname: uri.hostname,
          port,
          path: `/lease/${dseq}/1/1/status`,
          method: 'GET',
          headers: { Accept: 'application/json' },
          agent,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => resolve({ status: res.statusCode || 0, body: data }));
        }
      );
      req.on('error', reject);
      req.end();
    });

    console.log(`Lease status: ${leaseResult.status}`);
    console.log(`Lease body: ${leaseResult.body.substring(0, 500)}`);
    if (leaseResult.body.includes('lease not found')) {
      console.log('\n❌ CONFIRMED: "kube: lease not found" — manifest was silently rejected by provider.');
      console.log('   Most likely cause: manifest version hash mismatch (JS SDK ≠ Go provider).');
    }
  }

  // 7. Summary
  console.log('\n=== Recommended Next Steps ===');
  console.log('');
  console.log('1. If on-chain hash MATCHES JS hash:');
  console.log('   → Problem is Go provider re-serializes manifest and computes DIFFERENT hash.');
  console.log('   → Fix: Use provider-services CLI to send manifests (Go → Go, always matches).');
  console.log('');
  console.log('2. If on-chain hash DOES NOT MATCH JS hash:');
  console.log('   → Problem is in createDeployment serialization.');
  console.log('   → Fix: Also use akash CLI for deployment creation.');
  console.log('');
  console.log('3. Write full manifest JSON to file for comparison:');
  const outPath = path.resolve(__dirname, '../.local/last-manifest.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, manifestJSON);
  console.log(`   Saved to: ${outPath}`);
  console.log('   Compare against `provider-services` output with:');
  console.log('     provider-services manifest-version <sdl-file>');
}

main().catch((e) => {
  console.error('\nERROR:', e.message || e);
  process.exit(1);
});
