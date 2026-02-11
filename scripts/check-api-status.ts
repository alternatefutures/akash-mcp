/**
 * Check API deployment status to get forwarded ports
 */
import https from 'https';
import { config } from 'dotenv';
import { loadWalletAndClient } from '../src/utils/load-wallet.js';
import { loadCertificate } from '../src/utils/load-certificate.js';

config({ path: '.env' });
config({ path: '.env.deploy' });

const DSEQ = 25474472; // API DSEQ from deployment
const GSEQ = 1;
const OSEQ = 1;
const PROVIDER_HOST = 'provider.dal.leet.haus';
const PROVIDER_PORT = 8443;

async function main() {
  const { wallet } = await loadWalletAndClient();
  const cert = await loadCertificate(wallet);

  const agent = new https.Agent({
    cert: cert.cert,
    key: cert.privateKey,
    rejectUnauthorized: false,
    servername: 'localhost'
  });

  const status = await new Promise<any>((resolve, reject) => {
    const req = https.request({
      hostname: PROVIDER_HOST,
      port: PROVIDER_PORT,
      path: `/lease/${DSEQ}/${GSEQ}/${OSEQ}/status`,
      method: 'GET',
      headers: { Accept: 'application/json' },
      agent
    }, res => {
      let data = '';
      res.on('data', (c: any) => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    });
    req.on('error', reject);
    req.end();
  });

  console.log(JSON.stringify(status, null, 2));
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
