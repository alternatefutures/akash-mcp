import { loadWalletAndClient } from '../src/utils/load-wallet.js';
import { loadCertificate } from '../src/utils/load-certificate.js';
import https from 'https';
import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, '../.env') });
config({ path: path.resolve(__dirname, '../.env.deploy') });

const dseq = 25483265;
const gseq = 1;
const oseq = 1;

async function main() {
  const { wallet, client, chainSDK } = await loadWalletAndClient();
  const accounts = await wallet.getAccounts();
  const owner = accounts[0].address;
  const certificate = await loadCertificate(wallet, client, chainSDK);

  // Get provider from lease
  const leaseRes: any = await chainSDK.akash.market.v1beta5.getLeases({
    filters: { owner, dseq: BigInt(dseq) }
  });
  const lease = leaseRes.leases?.[0];
  if (!lease) { console.log('No lease found for DSEQ', dseq); process.exit(1); }
  const provider = lease.lease?.id?.provider || lease.lease?.leaseId?.provider;
  console.log('Provider:', provider);

  const providerInfo: any = await chainSDK.akash.provider.v1beta4.getProvider({ owner: provider });
  const providerHostUri = providerInfo?.provider?.hostUri;
  console.log('Provider URI:', providerHostUri);

  const uri = new URL(providerHostUri);
  const agent = new https.Agent({ cert: certificate.cert, key: certificate.privateKey, rejectUnauthorized: false });

  function query(urlPath: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: uri.hostname,
        port: uri.port ? parseInt(uri.port) : 8443,
        path: urlPath,
        method: 'GET',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        agent,
      }, (res) => {
        let data = '';
        res.on('data', (c: any) => data += c);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(data); } });
      });
      req.on('error', reject);
      req.end();
    });
  }

  console.log('\n=== Lease Status ===');
  const status = await query(`/lease/${dseq}/${gseq}/${oseq}/status`);
  console.log(JSON.stringify(status, null, 2));

  console.log('\n=== Kube Events ===');
  const events = await query(`/lease/${dseq}/${gseq}/${oseq}/kubeevents`);
  const evList = events?.events || events;
  if (Array.isArray(evList)) {
    for (const e of evList.slice(-15)) {
      console.log(`  ${e.type || ''} ${e.reason || ''}: ${e.note || e.message || ''}`);
    }
  } else {
    console.log(JSON.stringify(events, null, 2).substring(0, 2000));
  }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
