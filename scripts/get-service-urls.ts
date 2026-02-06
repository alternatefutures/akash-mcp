import { loadWalletAndClient } from '../src/utils/load-wallet.js';
import { loadCertificate } from '../src/utils/load-certificate.js';
import https from 'https';

const DSEQ = parseInt(process.argv[2] || '25411473');

async function main() {
  console.log(`=== Getting Service URLs for DSEQ: ${DSEQ} ===\n`);

  try {
    const { wallet, chainSDK } = await loadWalletAndClient();
    const certificate = await loadCertificate(wallet, chainSDK);
    const accounts = await wallet.getAccounts();
    const address = accounts[0].address;

    console.log(`Owner Address: ${address}\n`);

    // Get leases
    const leasesRes = await chainSDK.akash.market.v1beta5.getLeases({
      filters: {
        owner: address,
        dseq: BigInt(DSEQ),
      },
    });

    if (!leasesRes.leases || leasesRes.leases.length === 0) {
      console.log('No leases found for this deployment');
      return;
    }

    const lease = leasesRes.leases[0].lease;
    if (!lease?.id) {
      console.log('Invalid lease');
      return;
    }

    console.log(`Lease: GSEQ=${lease.id.gseq}, OSEQ=${lease.id.oseq}`);
    console.log(`Provider: ${lease.id.provider}\n`);

    // Get provider URI
    const providerRes = await chainSDK.akash.provider.v1beta4.getProvider({
      owner: lease.id.provider,
    });

    if (!providerRes.provider?.hostUri) {
      console.log('Could not get provider URI');
      return;
    }

    const providerUri = providerRes.provider.hostUri;
    console.log(`Provider URI: ${providerUri}\n`);

    // Query lease status to get service URLs
    const leasePath = `/lease/${DSEQ}/${lease.id.gseq}/${lease.id.oseq}/status`;

    const agent = new https.Agent({
      cert: certificate.cert,
      key: certificate.privateKey,
      rejectUnauthorized: false,
      servername: 'localhost',
    });

    const uri = new URL(providerUri);

    const leaseStatus = await new Promise<any>((resolve, reject) => {
      const req = https.request(
        {
          hostname: uri.hostname,
          port: uri.port,
          path: leasePath,
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          agent: agent,
        },
        (res) => {
          if (res.statusCode !== 200) {
            return reject(`Could not query lease status: ${res.statusCode}`);
          }

          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => resolve(JSON.parse(data)));
        }
      );

      req.on('error', reject);
      req.end();
    });

    console.log('--- Service URLs ---');
    if (leaseStatus.services) {
      for (const [serviceName, serviceInfo] of Object.entries(leaseStatus.services) as any) {
        console.log(`\nService: ${serviceName}`);
        if (serviceInfo.uris && serviceInfo.uris.length > 0) {
          for (const uri of serviceInfo.uris) {
            console.log(`  URL: http://${uri}`);
          }
        } else {
          console.log('  No URIs found');
        }
      }
    } else {
      console.log('No services found in lease status');
      console.log('Raw response:', JSON.stringify(leaseStatus, null, 2));
    }

  } catch (error: any) {
    console.error('Error:', error.message || error);
    process.exit(1);
  }
}

main();
