/**
 * Send manifest for the API deployment that already has a lease.
 * Usage: npx tsx scripts/send-manifest-api.ts
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
const { SendManifestTool } = await import('../src/tools/send-manifest.js')

const DSEQ = 25585819
const OWNER = 'akash1degudmhf24auhfnqtn99mkja3xt7clt9um77tn'
const PROVIDER = 'akash1chnhnu50f6hv98xl0m7xm95vel457ysp32uwpj'
const GSEQ = 1
const OSEQ = 1

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

console.log(`Sending manifest for DSEQ ${DSEQ} to provider ${PROVIDER}...`)
const result = await SendManifestTool.handler(
  { sdl: rawSDL, owner: OWNER, dseq: DSEQ, gseq: GSEQ, oseq: OSEQ, provider: PROVIDER },
  ctx
)

const text = result.content[0].type === 'text' ? result.content[0].text : ''
console.log('Result:', text)
