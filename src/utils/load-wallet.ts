import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import { createStargateClient, createChainNodeSDK } from '@akashnetwork/chain-sdk';
import type { ChainNodeSDK, StargateTxClient } from '../types/index.js';

interface WalletAndClient {
  wallet: DirectSecp256k1HdWallet;
  client: StargateTxClient;
  chainSDK: ChainNodeSDK;
}

export async function loadWalletAndClient(): Promise<WalletAndClient> {
  // IMPORTANT:
  // Read environment variables at call-time (not module import time), so scripts
  // can safely call `dotenv.config()` before invoking this function.
  const mnemonic = (process.env.AKASH_MNEMONIC || '').trim();
  if (!mnemonic) {
    throw new Error(
      'AKASH_MNEMONIC is not set. Set it in the shell environment or in akash-mcp/.env (and load it via dotenv).'
    );
  }

  const wallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonic, {
    prefix: 'akash',
  });

  const rpcEndpoint = process.env.RPC_ENDPOINT || 'https://rpc.akashnet.net:443';
  const grpcEndpoint = process.env.GRPC_ENDPOINT || 'https://akash-grpc.publicnode.com:443';

  // Create the stargate client using chain-sdk (includes proper type registry)
  const stargateClient = createStargateClient({
    baseUrl: rpcEndpoint,
    signer: wallet,
    defaultGasPrice: '0.025uakt',
    gasMultiplier: 2.0, // Increased from default 1.3 to handle deployment updates
  });

  // Create the chain SDK for queries and transactions
  // Use configured gRPC endpoint (public Akash gRPC endpoints use TLS on port 443)
  const chainSDK = createChainNodeSDK({
    query: {
      baseUrl: grpcEndpoint,
    },
    tx: {
      signer: stargateClient,
    },
  });

  return {
    wallet,
    client: stargateClient,
    chainSDK,
  };
}
