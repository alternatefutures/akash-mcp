import { z } from 'zod';
import type { ToolDefinition, ToolContext } from '../types/index.js';
import { createOutput } from '../utils/create-output.js';

const parameters = z.object({
  address: z.string().min(1, 'Akash account address is required'),
  dseq: z.number().int().positive(),
  amount: z.string().min(1, 'Amount to add is required'),
  denom: z.string().default('uakt').describe('Token denomination: uakt (AKT) or uact (ACT, post-BME)'),
});

export const AddFundsTool: ToolDefinition<typeof parameters> = {
  name: 'add-funds',
  description: 'Deposit additional tokens into a deployment escrow account. Supports uakt (AKT) and uact (ACT, post-BME).',
  parameters,
  handler: async (params, context) => {
    const { address, dseq, amount, denom } = params;
    const { chainSDK } = context;

    try {
      // 1. Validate deployment exists
      const deploymentRes = await chainSDK.akash.deployment.v1beta4.getDeployment({
        id: {
          owner: address,
          dseq: BigInt(dseq),
        },
      });

      if (!deploymentRes.deployment) {
        return createOutput({ error: `Deployment with owner ${address} and dseq ${dseq} not found.` });
      }

      // 2. Deposit funds using escrow accountDeposit
      // The escrow account xid is typically the deployment ID in a specific format
      // Format: owner/dseq
      const result = await chainSDK.akash.escrow.v1.accountDeposit({
        signer: address,
        id: {
          scope: 1, // deployment scope
          xid: `${address}/${dseq}`,
        },
        deposit: {
          amount: { denom, amount: amount.toString() },
          sources: [2, 1], // Source.grant = 2, Source.balance = 1 (try authz grant first)
        },
      });

      return createOutput({
        success: true,
        result: result,
      });
    } catch (error: any) {
      return createOutput({ error: error.message || 'Failed to add funds to deployment.' });
    }
  },
};
