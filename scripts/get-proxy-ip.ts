#!/usr/bin/env npx tsx
import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, '../.env') });

import { loadWalletAndClient } from '../src/utils/load-wallet.js';
import { loadCertificate } from '../src/utils/load-certificate.js';

const DSEQ = 25423216;
const PROVIDER = 'akash1zlsep362zz46qlwzttm06t8lv9qtg8gtaya97u';

async function main() {
  const { wallet, client, chainSDK } = await loadWalletAndClient();
  const certificate = await loadCertificate(wallet, client, chainSDK);
  const providerRes = await chainSDK.akash.provider.v1beta4.getProvider({ owner: PROVIDER });
  const hostUri = providerRes.provider?.hostUri;
  console.log('Provider URI:', hostUri);

  const uri = new URL(hostUri!);
  const agent = new https.Agent({ cert: certificate.cert, key: certificate.privateKey, rejectUnauthorized: false, servername: 'localhost' });

  const result = await new Promise<string>((resolve, reject) => {
    const req = https.request({
      hostname: uri.hostname,
      port: uri.port ? parseInt(uri.port) : 8443,
      path: `/lease/${DSEQ}/1/1/status`,
      method: 'GET',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      agent,
    }, (res) => {
      let data = '';
      res.on('data', (chunk: any) => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.end();
  });

  const status = JSON.parse(result);
  console.log('\n=== Full lease status ===');
  console.log(JSON.stringify(status, null, 2));
}

main().catch(e => console.error('Error:', e.message));
