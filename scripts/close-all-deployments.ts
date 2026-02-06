import { loadWalletAndClient } from '../src/utils/load-wallet.js';

async function main() {
  console.log('=== Closing ALL Active Deployments ===\n');

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
      console.log('No active deployments found. Nothing to close.');
      return;
    }

    console.log(`Found ${deploymentsRes.deployments.length} active deployment(s)\n`);

    let closed = 0;
    let failed = 0;

    for (const depWrapper of deploymentsRes.deployments) {
      const dep = depWrapper.deployment;
      if (!dep?.id) continue;

      const dseq = Number(dep.id.dseq);

      // Get lease info for logging
      let providerInfo = '';
      try {
        const leasesRes = await chainSDK.akash.market.v1beta5.getLeases({
          filters: {
            owner: address,
            dseq: BigInt(dseq),
          },
        });
        if (leasesRes.leases?.[0]?.lease?.id?.provider) {
          providerInfo = ` (provider: ${leasesRes.leases[0].lease.id.provider})`;
        }
      } catch {
        // ignore lease lookup errors
      }

      try {
        console.log(`Closing DSEQ ${dseq}${providerInfo}...`);
        await chainSDK.akash.deployment.v1beta4.closeDeployment({
          id: {
            owner: address,
            dseq: BigInt(dseq),
          },
        });
        console.log(`  ✅ Closed DSEQ ${dseq}`);
        closed++;
      } catch (error: any) {
        console.log(`  ❌ Failed to close DSEQ ${dseq}: ${error.message}`);
        failed++;
      }
    }

    console.log(`\n=== Done: ${closed} closed, ${failed} failed ===`);
  } catch (error: any) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
