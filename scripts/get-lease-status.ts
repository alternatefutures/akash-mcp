#!/usr/bin/env npx tsx
import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, '../.env') });

import { loadWalletAndClient } from '../src/utils/load-wallet.js';
import { loadCertificate } from '../src/utils/load-certificate.js';

const DSEQ = parseInt(process.argv[2] || '0');
const PROVIDER = process.argv[3] || '';

if (!DSEQ) {
  console.error('Usage: npx tsx scripts/get-lease-status.ts <DSEQ> [provider]');
  process.exit(1);
}

async function main() {
  const { wallet, client, chainSDK } = await loadWalletAndClient();
  const accounts = await wallet.getAccounts();
  const owner = accounts[0].address;
  const certificate = await loadCertificate(wallet, client, chainSDK);

  // Get lease info
  const leasesRes = await chainSDK.akash.market.v1beta5.getLeases({
    filters: { owner, dseq: BigInt(DSEQ), ...(PROVIDER ? { provider: PROVIDER } : {}) },
  });
  const lease = leasesRes.leases?.[0]?.lease;
  if (!lease?.id) { console.log('No lease found'); return; }

  const provider = lease.id.provider;
  const gseq = Number(lease.id.gseq || 1);
  const oseq = Number(lease.id.oseq || 1);

  // Get provider URI
  const providerRes = await chainSDK.akash.provider.v1beta4.getProvider({ owner: provider });
  const hostUri = providerRes.provider?.hostUri;
  console.log('Provider:', provider);
  console.log('Provider URI:', hostUri);

  if (!hostUri) { console.log('No provider URI'); return; }

  // Check if provider is reachable
  const uri = new URL(hostUri);
  const agent = new https.Agent({ cert: certificate.cert, key: certificate.privateKey, rejectUnauthorized: false, servername: 'localhost' });

  try {
    const result = await new Promise<string>((resolve, reject) => {
      const req = https.request({
        hostname: uri.hostname,
        port: uri.port ? parseInt(uri.port) : 8443,
        path: `/lease/${DSEQ}/${gseq}/${oseq}/status`,
        method: 'GET',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        agent,
        timeout: 15000,
      }, (res) => {
        let data = '';
        res.on('data', (chunk: any) => data += chunk);
        res.on('end', () => resolve(`HTTP ${res.statusCode}: ${data}`));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
      req.end();
    });
    console.log('\nLease status:', result);
  } catch (e: any) {
    console.log('\nProvider unreachable:', e.message);
  }

  // Also try to get logs
  try {
    const result = await new Promise<string>((resolve, reject) => {
      const req = https.request({
        hostname: uri.hostname,
        port: uri.port ? parseInt(uri.port) : 8443,
        path: `/lease/${DSEQ}/${gseq}/${oseq}/logs?follow=false&tail=20`,
        method: 'GET',
        headers: { Accept: 'application/json' },
        agent,
        timeout: 15000,
      }, (res) => {
        let data = '';
        res.on('data', (chunk: any) => data += chunk);
        res.on('end', () => resolve(`HTTP ${res.statusCode}: ${data.substring(0, 2000)}`));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
      req.end();
    });
    console.log('\nLogs:', result);
  } catch (e: any) {
    console.log('\nLogs unavailable:', e.message);
  }
}

main().catch(e => console.error('Error:', e.message));
