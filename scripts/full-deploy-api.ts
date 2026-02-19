/**
 * Full API deployment: close old, create new, get bids, pick provider, create lease, send manifest.
 * Usage: npx tsx scripts/full-deploy-api.ts [preferred-provider]
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
const { CloseDeploymentTool } = await import('../src/tools/close-deployment.js')
const { CreateDeploymentTool } = await import('../src/tools/create-deployment.js')
const { GetBidsTool } = await import('../src/tools/get-bids.js')
const { CreateLeaseTool } = await import('../src/tools/create-lease.js')
const { SendManifestTool } = await import('../src/tools/send-manifest.js')

const PREFERRED_PROVIDER = process.argv[2] || null
const OLD_DSEQ = 25585819

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

console.log('Initializing wallet...')
const { wallet, client, chainSDK } = await loadWalletAndClient()
const certificate = await loadCertificate(wallet, client, chainSDK)
const ctx = { wallet, client, certificate, chainSDK, reloadCertificate: async () => certificate }
const accounts = await wallet.getAccounts()
const OWNER = accounts[0].address
console.log(`Owner: ${OWNER}`)

// Step 1: Close old deployment
console.log(`\n--- Step 1: Closing old deployment DSEQ ${OLD_DSEQ}... ---`)
try {
  const closeResult = await CloseDeploymentTool.handler({ dseq: OLD_DSEQ }, ctx)
  console.log('Close result:', closeResult.content[0].type === 'text' ? closeResult.content[0].text : '')
} catch (e: any) {
  console.log('Close failed (may already be closed):', e.message)
}

// Step 2: Create new deployment
console.log('\n--- Step 2: Creating new deployment... ---')
const createResult = await CreateDeploymentTool.handler(
  { rawSDL, deposit: 5000000, currency: 'uakt' },
  ctx
)
const createText = createResult.content[0].type === 'text' ? createResult.content[0].text : ''
const createData = JSON.parse(createText)
if (!createData.success) {
  console.error('Failed to create deployment:', createText)
  process.exit(1)
}
const DSEQ = createData.dseq
console.log(`Created deployment DSEQ ${DSEQ}`)

// Step 3: Wait for bids
console.log('\n--- Step 3: Waiting 20s for bids... ---')
await new Promise(r => setTimeout(r, 20000))

const bidsResult = await GetBidsTool.handler({ dseq: DSEQ, owner: OWNER }, ctx)
const bidsText = bidsResult.content[0].type === 'text' ? bidsResult.content[0].text : ''
const bidsData = JSON.parse(bidsText) as any[]

if (!Array.isArray(bidsData) || bidsData.length === 0) {
  console.error('No bids received!')
  process.exit(1)
}

// Sort by price
const sorted = bidsData.sort((a, b) => parseFloat(a.price?.amount || '999') - parseFloat(b.price?.amount || '999'))
console.log(`Got ${sorted.length} bids:`)
for (const b of sorted) {
  const org = b.provider?.attributes?.find((a: any) => a.key === 'organization')?.value || '?'
  console.log(`  ${b.bidId.provider} — ${parseFloat(b.price.amount).toFixed(2)} uakt/block — ${org}`)
}

// Pick provider: preferred if available, otherwise cheapest
let bid = sorted[0]
if (PREFERRED_PROVIDER) {
  const preferred = sorted.find((b: any) => b.bidId.provider === PREFERRED_PROVIDER)
  if (preferred) {
    bid = preferred
    console.log(`\nUsing preferred provider: ${PREFERRED_PROVIDER}`)
  } else {
    console.log(`\nPreferred provider not found in bids, using cheapest`)
  }
}

const provider = bid.bidId.provider
const gseq = bid.bidId.gseq
const oseq = bid.bidId.oseq
const org = bid.provider?.attributes?.find((a: any) => a.key === 'organization')?.value || '?'
console.log(`Selected: ${provider} — ${org} — ${parseFloat(bid.price.amount).toFixed(2)} uakt/block`)

// Step 4: Create lease
console.log('\n--- Step 4: Creating lease... ---')
const leaseResult = await CreateLeaseTool.handler(
  { dseq: DSEQ, owner: OWNER, provider, gseq, oseq },
  ctx
)
console.log('Lease:', leaseResult.content[0].type === 'text' ? leaseResult.content[0].text : '')

// Step 5: Send manifest
console.log('\n--- Step 5: Sending manifest... ---')
const manifestResult = await SendManifestTool.handler(
  { sdl: rawSDL, owner: OWNER, dseq: DSEQ, gseq, oseq, provider },
  ctx
)
console.log('Manifest:', manifestResult.content[0].type === 'text' ? manifestResult.content[0].text : '')

console.log(`\n✅ API deployed! DSEQ=${DSEQ}, Provider=${provider}`)
console.log(`\nUpdate .env.deploy:`)
console.log(`  API_DSEQ=${DSEQ}`)
console.log(`  API_PROVIDER=${provider}`)
