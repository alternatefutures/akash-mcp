import { loadWalletAndClient } from '../src/utils/load-wallet.js';

const DSEQ = 25415866; // Yugabyte deployment on dcnorse (lease not found)

async function main() {
  console.log(`=== Closing Deployment DSEQ: ${DSEQ} ===\n`);

  try {
    const { wallet, chainSDK } = await loadWalletAndClient();
    const accounts = await wallet.getAccounts();
    const address = accounts[0].address;

    console.log(`Owner Address: ${address}`);
    console.log(`Closing deployment ${DSEQ}...\n`);

    // Close the deployment
    const result = await chainSDK.akash.deployment.v1beta4.closeDeployment({
      id: {
        owner: address,
        dseq: BigInt(DSEQ),
      },
    });

    console.log('✅ Deployment closed successfully!');
    console.log('Transaction result:', JSON.stringify(result, null, 2));
    console.log('\nYou can now redeploy through the UI to get a different provider.');
  } catch (error: any) {
    console.error('❌ Error closing deployment:', error.message);
    process.exit(1);
  }
}

main();
