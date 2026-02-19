/**
 * Check API deployment status and get service URIs.
 * Usage: npx tsx scripts/check-api-status.ts
 */

import dotenv from 'dotenv'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const mcpRoot = resolve(__dirname, '..')

dotenv.config({ path: resolve(mcpRoot, '.env.deploy') })

const { loadWalletAndClient } = await import('../src/utils/load-wallet.js')
const { loadCertificate } = await import('../src/utils/load-certificate.js')
const { GetServicesTool } = await import('../src/tools/get-services.js')

const DSEQ = Number(process.env.API_DSEQ)
const PROVIDER = process.env.API_PROVIDER!
const OWNER = 'akash1degudmhf24auhfnqtn99mkja3xt7clt9um77tn'

console.log(`Checking DSEQ ${DSEQ} on ${PROVIDER}...`)

const { wallet, client, chainSDK } = await loadWalletAndClient()
const certificate = await loadCertificate(wallet, client, chainSDK)
const ctx = { wallet, client, certificate, chainSDK, reloadCertificate: async () => certificate }

const result = await GetServicesTool.handler(
  { dseq: DSEQ, owner: OWNER, provider: PROVIDER, gseq: 1, oseq: 1 },
  ctx
)

const text = result.content[0].type === 'text' ? result.content[0].text : ''
console.log(JSON.stringify(JSON.parse(text), null, 2))
