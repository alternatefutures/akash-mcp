import { loadWalletAndClient } from '../src/utils/load-wallet.js';

const BAD_PROVIDER = 'akash1adyrcsp2ptwd83txgv555eqc0vhfufc37wx040'; // airitdecomp.net

async function main() {
  console.log('=== Closing All Deployments on Bad Provider ===\n');
  console.log(`Bad Provider: ${BAD_PROVIDER}\n`);

  try {
    const { wallet, chainSDK } = await loadWalletAndClient();
    const accounts = await wallet.getAccounts();
    const address = accounts[0].address;

    console.log(`Owner Address: ${address}\n`);

    // Get all active deployments
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

    console.log(`Found ${deploymentsRes.deployments.length} active deployment(s)\n`);

    const deploymentsToClose: number[] = [];

    for (const depWrapper of deploymentsRes.deployments) {
      const dep = depWrapper.deployment;
      if (!dep?.id) continue;

      const dseq = Number(dep.id.dseq);

      // Get leases to check provider
      const leasesRes = await chainSDK.akash.market.v1beta5.getLeases({
        filters: {
          owner: address,
          dseq: BigInt(dseq),
        },
      });

      if (leasesRes.leases && leasesRes.leases.length > 0) {
        const lease = leasesRes.leases[0].lease;
        if (lease?.id?.provider === BAD_PROVIDER) {
          console.log(`DSEQ ${dseq}: On bad provider - will close`);
          deploymentsToClose.push(dseq);
        } else {
          console.log(`DSEQ ${dseq}: On ${lease?.id?.provider || 'unknown'} - keeping`);
        }
      } else {
        // No lease = probably stuck, close it
        console.log(`DSEQ ${dseq}: No lease found - will close`);
        deploymentsToClose.push(dseq);
      }
    }

    console.log(`\n--- Closing ${deploymentsToClose.length} deployment(s) ---\n`);

    for (const dseq of deploymentsToClose) {
      try {
        console.log(`Closing DSEQ ${dseq}...`);
        await chainSDK.akash.deployment.v1beta4.closeDeployment({
          id: {
            owner: address,
            dseq: BigInt(dseq),
          },
        });
        console.log(`✅ Closed DSEQ ${dseq}`);
      } catch (error: any) {
        console.log(`❌ Failed to close DSEQ ${dseq}: ${error.message}`);
      }
    }

    console.log('\n=== Done ===');
  } catch (error: any) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
