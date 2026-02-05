import { loadWalletAndClient } from '../src/utils/load-wallet.js';

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
      console.log(`--- DSEQ: ${dseq} ---`);

      // Get leases
      const leasesRes = await chainSDK.akash.market.v1beta5.getLeases({
        filters: {
          owner: address,
          dseq: BigInt(dseq),
        },
      });

      if (leasesRes.leases && leasesRes.leases.length > 0) {
        for (const leaseWrapper of leasesRes.leases) {
          const lease = leaseWrapper.lease;
          if (!lease?.id) continue;

          console.log(`Provider: ${lease.id.provider}`);

          // Get provider details
          try {
            const providerRes = await chainSDK.akash.provider.v1beta4.getProvider({
              owner: lease.id.provider,
            });

            if (providerRes.provider?.hostUri) {
              console.log(`Provider URI: ${providerRes.provider.hostUri}`);
            }
          } catch (e) {
            // ignore
          }
        }
      }
      console.log();
    }
  } catch (error: any) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
