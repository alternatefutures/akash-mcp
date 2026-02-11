/**
 * Fetch container logs for the proxy deployment from the provider.
 */
import https from 'https';
import { config } from 'dotenv';
import { loadWalletAndClient } from '../src/utils/load-wallet.js';
import { loadCertificate } from '../src/utils/load-certificate.js';

config({ path: '.env' });
config({ path: '.env.deploy' });

const DSEQ = 25474654;
const GSEQ = 1;
const OSEQ = 1;
const PROVIDER_HOST = 'provider.dal.leet.haus';
const PROVIDER_PORT = 8443;
const SERVICE = 'ssl-proxy';

async function main() {
  const { wallet } = await loadWalletAndClient();
  const cert = await loadCertificate(wallet);

  const agent = new https.Agent({
    cert: cert.cert,
    key: cert.privateKey,
    rejectUnauthorized: false,
    servername: 'localhost'
  });

  // First check lease status
  console.log('--- LEASE STATUS ---');
  const status = await fetchJson(agent, `/lease/${DSEQ}/${GSEQ}/${OSEQ}/status`);
  console.log(JSON.stringify(status, null, 2));

  // Fetch service logs
  console.log('\n--- SERVICE LOGS ---');
  try {
    const logs = await fetchText(agent, `/lease/${DSEQ}/${GSEQ}/${OSEQ}/logs?service=${SERVICE}&tail=100`);
    console.log(logs);
  } catch (e: any) {
    console.log(`Log fetch failed: ${e.message}`);
  }
}

function fetchJson(agent: https.Agent, path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: PROVIDER_HOST,
      port: PROVIDER_PORT,
      path,
      method: 'GET',
      headers: { Accept: 'application/json' },
      agent
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    });
    req.on('error', reject);
    req.end();
  });
}

function fetchText(agent: https.Agent, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: PROVIDER_HOST,
      port: PROVIDER_PORT,
      path,
      method: 'GET',
      headers: { Accept: 'text/plain' },
      agent
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.end();
  });
}

main().catch(e => { console.error('FATAL:', e.message || e); process.exit(1); });
