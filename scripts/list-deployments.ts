import { loadWalletAndClient } from '../src/utils/load-wallet.js';
import { config } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(__dirname, '../.env') });
config({ path: path.resolve(__dirname, '../.env.deploy') });

async function main() {
  console.log('=== Listing Active Deployments ===\n');

  try {
    const { wallet, chainSDK } = await loadWalletAndClient();
    const accounts = await wallet.getAccounts();
    const address = accounts[0].address;

    console.log(`Owner Address: ${address}\n`);

    // Get all deployments for this owner
    const deploymentsRes = await chainSDK.akash.deployment.v1beta4.getDeployments({
      filters: {
        owner: address,
        state: 'active',
      },
    });

    if (!deploymentsRes.deployments || deploymentsRes.deployments.length === 0) {
      console.log('No active deployments found');
      return;
    }

    console.log(`Found ${deploymentsRes.deployments.length} active deployment(s):\n`);

    for (const depWrapper of deploymentsRes.deployments) {
      const dep = depWrapper.deployment;
      if (!dep?.id) continue;

      const dseq = Number(dep.id.dseq);
      console.log(`- DSEQ: ${dseq}`);
    }
  } catch (error: any) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
