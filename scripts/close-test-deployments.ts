import { loadWalletAndClient } from '../src/utils/load-wallet.js';

// Test deployments to close (freeing resources for production)
const TEST_DSEQS = [25399676, 25399741, 25399822];

async function main() {
  console.log('=== Closing Test Deployments ===\n');
  console.log(`DSEQs to close: ${TEST_DSEQS.join(', ')}\n`);

  try {
    const { wallet, chainSDK } = await loadWalletAndClient();
    const accounts = await wallet.getAccounts();
    const address = accounts[0].address;
    console.log(`Owner Address: ${address}\n`);

    // Check balance before
    const balanceRes = await chainSDK.cosmos.bank.v1beta1.getBalance({
      address,
      denom: 'uakt',
    });
    const balance = Number(balanceRes.balance?.amount || 0);
    console.log(`Balance before: ${(balance / 1_000_000).toFixed(2)} AKT\n`);

    let closed = 0;
    for (const dseq of TEST_DSEQS) {
      try {
        console.log(`Closing DSEQ ${dseq}...`);
        await chainSDK.akash.deployment.v1beta4.closeDeployment({
          id: { owner: address, dseq: BigInt(dseq) },
        });
        console.log(`  ✅ Closed`);
        closed++;
      } catch (error: any) {
        console.log(`  ⚠️  Failed: ${error.message}`);
      }
    }

    console.log(`\n${closed}/${TEST_DSEQS.length} deployments closed.`);

    // Check balance after
    const balanceAfter = await chainSDK.cosmos.bank.v1beta1.getBalance({
      address,
      denom: 'uakt',
    });
    const newBalance = Number(balanceAfter.balance?.amount || 0);
    console.log(`Balance after: ${(newBalance / 1_000_000).toFixed(2)} AKT`);
    console.log(`Recovered: ${((newBalance - balance) / 1_000_000).toFixed(2)} AKT\n`);

    // List remaining active deployments
    console.log('=== Remaining Active Deployments ===\n');
    const deploymentsRes = await chainSDK.akash.deployment.v1beta4.getDeployments({
      filters: { owner: address, state: 'active' },
    });

    if (!deploymentsRes.deployments || deploymentsRes.deployments.length === 0) {
      console.log('No active deployments remaining. Ready for fresh production deploy.');
    } else {
      console.log(`${deploymentsRes.deployments.length} active deployment(s):`);
      for (const depWrapper of deploymentsRes.deployments) {
        const dep = depWrapper.deployment;
        if (dep?.id) {
          console.log(`  DSEQ: ${Number(dep.id.dseq)}`);
        }
      }
    }
  } catch (error: any) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
