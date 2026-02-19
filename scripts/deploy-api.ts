/**
 * Create a new API deployment on Akash.
 * Uses akash-mcp internals (JS SDK, no CLI binary needed).
 *
 * Usage: npx tsx scripts/deploy-api.ts
 */

import dotenv from 'dotenv'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { readFileSync } from 'fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const mcpRoot = resolve(__dirname, '..')

dotenv.config({ path: resolve(mcpRoot, '.env.deploy') })

const { loadWalletAndClient } = await import('../src/utils/load-wallet.js')
const { loadCertificate } = await import('../src/utils/load-certificate.js')
const { GetBalancesTool } = await import('../src/tools/get-balances.js')
const { CreateDeploymentTool } = await import('../src/tools/create-deployment.js')

const sdlPath = resolve(mcpRoot, '../service-cloud-api/deploy-api.yaml')
let rawSDL = readFileSync(sdlPath, 'utf-8')

// Substitute secrets from .env.deploy
rawSDL = rawSDL
  .replace('__DATABASE_URL__', process.env.API_DATABASE_URL || process.env.DATABASE_URL || '')
  .replace('your_jwt_secret_min_32_chars_please_change_this_in_production', process.env.JWT_SECRET || '')
  .replace('your_resend_api_key', process.env.RESEND_API_KEY || '')
  .replace('__AKASH_MNEMONIC__', process.env.AKASH_MNEMONIC || '')
  .replace('__RPC_ENDPOINT__', process.env.RPC_ENDPOINT || 'https://rpc.akashnet.net:443')
  .replace('__PHALA_API_KEY__', process.env.PHALA_API_KEY || '')
  .replace('__IPFS_API_URL__', process.env.IPFS_API_URL || '')
  .replace('__OTEL_ENDPOINT__', process.env.OTEL_EXPORTER_OTLP_ENDPOINT || '')

console.log('Initializing wallet and certificate...')
const { wallet, client, chainSDK } = await loadWalletAndClient()
const certificate = await loadCertificate(wallet, client, chainSDK)
const ctx = { wallet, client, certificate, chainSDK, reloadCertificate: async () => certificate }

// Check balance first
console.log('Checking wallet balance...')
const balanceResult = await GetBalancesTool.handler({}, ctx)
console.log('Balance:', JSON.stringify(balanceResult, null, 2))

// Create deployment with 5 AKT deposit
const deposit = 5000000 // 5 AKT in uakt
console.log(`\nCreating API deployment with ${deposit / 1000000} AKT deposit...`)
console.log(`Image: ghcr.io/alternatefutures/service-cloud-api:latest`)

const result = await CreateDeploymentTool.handler(
  { rawSDL, deposit, currency: 'uakt' },
  ctx
)

console.log('\nDeployment result:', JSON.stringify(result, null, 2))
