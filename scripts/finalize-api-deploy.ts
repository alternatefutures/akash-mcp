/**
 * Finalize API deployment: get bids, create lease, send manifest.
 * Usage: npx tsx scripts/finalize-api-deploy.ts
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
const { GetBidsTool } = await import('../src/tools/get-bids.js')
const { CreateLeaseTool } = await import('../src/tools/create-lease.js')
const { SendManifestTool } = await import('../src/tools/send-manifest.js')

const DSEQ = Number(process.argv[2] || 25585819)
const OWNER = 'akash1degudmhf24auhfnqtn99mkja3xt7clt9um77tn'

const sdlPath = resolve(mcpRoot, '../service-cloud-api/deploy-api.yaml')
let rawSDL = readFileSync(sdlPath, 'utf-8')

rawSDL = rawSDL
  .replace('__DATABASE_URL__', process.env.API_DATABASE_URL || process.env.DATABASE_URL || '')
  .replace('your_jwt_secret_min_32_chars_please_change_this_in_production', process.env.JWT_SECRET || '')
  .replace('your_resend_api_key', process.env.RESEND_API_KEY || '')
  .replace('__AKASH_MNEMONIC__', process.env.AKASH_MNEMONIC || '')
  .replace('__RPC_ENDPOINT__', process.env.RPC_ENDPOINT || 'https://rpc.akashnet.net:443')
  .replace('__PHALA_API_KEY__', process.env.PHALA_API_KEY || '')
  .replace('__IPFS_API_URL__', process.env.IPFS_API_URL || '')
  .replace('__OTEL_ENDPOINT__', process.env.OTEL_EXPORTER_OTLP_ENDPOINT || '')

console.log(`Finalizing deployment DSEQ ${DSEQ}...`)

const { wallet, client, chainSDK } = await loadWalletAndClient()
const certificate = await loadCertificate(wallet, client, chainSDK)
const ctx = { wallet, client, certificate, chainSDK, reloadCertificate: async () => certificate }

// Step 1: Wait for and get bids
console.log('\n--- Step 1: Fetching bids (waiting 15s for providers to bid)... ---')
await new Promise(r => setTimeout(r, 15000))

const bidsResult = await GetBidsTool.handler({ dseq: DSEQ, owner: OWNER }, ctx)
const bidsText = bidsResult.content[0].type === 'text' ? bidsResult.content[0].text : ''
const bidsData = JSON.parse(bidsText) as any[]

if (!Array.isArray(bidsData) || bidsData.length === 0) {
  console.error('No bids received. Try again in a few seconds.')
  process.exit(1)
}

// Sort by price (cheapest first) and show summary
const sorted = bidsData.sort((a, b) => parseFloat(a.price?.amount || '999') - parseFloat(b.price?.amount || '999'))
console.log(`Got ${sorted.length} bids:`)
for (const b of sorted.slice(0, 5)) {
  const org = b.provider?.attributes?.find((a: any) => a.key === 'organization')?.value || 'unknown'
  console.log(`  ${b.bidId.provider} — ${parseFloat(b.price.amount).toFixed(2)} uakt/block — ${org}`)
}

// Pick cheapest bid
const bid = sorted[0]
const provider = bid.bidId.provider
const gseq = bid.bidId.gseq
const oseq = bid.bidId.oseq

console.log(`\nSelected provider: ${provider} (gseq=${gseq}, oseq=${oseq}, price=${parseFloat(bid.price.amount).toFixed(2)} uakt/block)`)

// Step 2: Create lease
console.log('\n--- Step 2: Creating lease... ---')
const leaseResult = await CreateLeaseTool.handler(
  { dseq: DSEQ, owner: OWNER, provider, gseq, oseq },
  ctx
)
const leaseText = leaseResult.content[0].type === 'text' ? leaseResult.content[0].text : ''
console.log('Lease:', leaseText)

// Step 3: Send manifest
console.log('\n--- Step 3: Sending manifest... ---')
const manifestResult = await SendManifestTool.handler(
  { sdl: rawSDL, owner: OWNER, dseq: DSEQ, gseq, oseq, provider },
  ctx
)
const manifestText = manifestResult.content[0].type === 'text' ? manifestResult.content[0].text : ''
console.log('Manifest:', manifestText)

console.log(`\n✅ Deployment DSEQ ${DSEQ} finalized with provider ${provider}`)
console.log(`Update .env.deploy with:\n  API_DSEQ=${DSEQ}\n  API_PROVIDER=${provider}`)
