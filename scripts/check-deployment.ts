import { loadWalletAndClient } from '../src/utils/load-wallet.js';

const DSEQ = parseInt(process.argv[2] || '25411473'); // Default to service-cloud-api

async function main() {
  console.log(`=== Checking Deployment DSEQ: ${DSEQ} ===\n`);

  try {
    const { wallet, chainSDK } = await loadWalletAndClient();
    const accounts = await wallet.getAccounts();
    const address = accounts[0].address;

    console.log(`Owner Address: ${address}\n`);

    // Get deployment details
    const deploymentRes = await chainSDK.akash.deployment.v1beta4.getDeployment({
      id: {
        owner: address,
        dseq: BigInt(DSEQ),
      },
    });

    if (!deploymentRes.deployment) {
      console.log('❌ Deployment NOT FOUND');
      return;
    }

    const deployment = deploymentRes.deployment;
    const escrowAccount = deploymentRes.escrowAccount;
    const stateMap: Record<number, string> = {
      0: 'INVALID',
      1: 'ACTIVE',
      2: 'CLOSED',
    };

    console.log(`Status: ${stateMap[deployment.state] || 'UNKNOWN'}`);

    if (escrowAccount?.balance) {
      const escrowBalance = parseInt(escrowAccount.balance.amount);
      console.log(`Escrow Balance: ${(escrowBalance / 1_000_000).toFixed(6)} AKT`);
    }

    // Get leases for this deployment
    console.log('\n--- Leases ---');
    const leasesRes = await chainSDK.akash.market.v1beta5.getLeases({
      filters: {
        owner: address,
        dseq: BigInt(DSEQ),
      },
    });

    if (!leasesRes.leases || leasesRes.leases.length === 0) {
      console.log('No leases found');
      return;
    }

    for (const leaseWrapper of leasesRes.leases) {
      const lease = leaseWrapper.lease;
      if (!lease?.id) continue;

      const leaseStateMap: Record<number, string> = {
        0: 'INVALID',
        1: 'ACTIVE',
        2: 'INSUFFICIENT_FUNDS',
        3: 'CLOSED',
      };

      console.log(`\nLease GSEQ: ${lease.id.gseq}, OSEQ: ${lease.id.oseq}`);
      console.log(`Provider: ${lease.id.provider}`);
      console.log(`State: ${leaseStateMap[lease.state] || 'UNKNOWN'}`);

      // Get provider details
      try {
        const providerRes = await chainSDK.akash.provider.v1beta4.getProvider({
          owner: lease.id.provider,
        });

        if (providerRes.provider) {
          console.log(`Provider Host URI: ${providerRes.provider.hostUri}`);

          // Try to get the service URLs
          console.log('\n--- Service Info ---');
          console.log('To get service URLs, run:');
          console.log(`  Owner: ${address}`);
          console.log(`  DSEQ: ${DSEQ}`);
          console.log(`  GSEQ: ${lease.id.gseq}`);
          console.log(`  OSEQ: ${lease.id.oseq}`);
          console.log(`  Provider: ${lease.id.provider}`);
        }
      } catch (e: any) {
        console.log(`Could not fetch provider details: ${e.message}`);
      }
    }

    console.log('\n=== Check Complete ===');
  } catch (error: any) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
