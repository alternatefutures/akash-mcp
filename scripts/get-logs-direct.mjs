#!/usr/bin/env node
import { config } from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'
import https from 'https'
import WebSocket from 'ws'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
config({ path: path.resolve(__dirname, '../.env') })
config({ path: path.resolve(__dirname, '../.env.deploy') })

import { loadWalletAndClient } from '../dist/utils/load-wallet.js'
import { loadCertificate } from '../dist/utils/load-certificate.js'

function usage() {
  console.error(
    'Usage: node scripts/get-logs-direct.mjs <DSEQ> [serviceName] [tail]'
  )
}

const DSEQ = parseInt(process.argv[2] || '0', 10)
const SERVICE = process.argv[3] || ''
const TAIL = parseInt(process.argv[4] || '200', 10)

if (!DSEQ) {
  usage()
  process.exit(1)
}

async function queryLeaseLogs({
  providerHostUri,
  certificate,
  dseq,
  gseq,
  oseq,
  service,
  tail,
}) {
  const uri = new URL(providerHostUri)

  let logsPath = `/lease/${dseq}/${gseq}/${oseq}/logs?follow=false&tail=${tail}`
  if (service) {
    logsPath += `&services=${encodeURIComponent(service)}`
  }

  const wsUrl = `wss://${uri.hostname}:${uri.port || 8443}${logsPath}`

  return await new Promise((resolve, reject) => {
    const logLines = []
    let resolved = false

    const agent = new https.Agent({
      cert: certificate.cert,
      key: certificate.privateKey,
      rejectUnauthorized: false,
      servername: 'localhost',
    })

    const ws = new WebSocket(wsUrl, {
      agent,
      headers: { Host: 'localhost' },
    })

    const timeout = setTimeout(() => {
      if (resolved) return
      resolved = true
      try {
        ws.close()
      } catch {}
      resolve(logLines.length ? logLines.join('\n') : 'No logs received (timeout)')
    }, 12000)

    ws.on('message', (data) => {
      const line = data.toString()
      try {
        const msg = JSON.parse(line)
        if (msg?.name && msg?.message) {
          logLines.push(`[${msg.name}] ${msg.message}`)
          return
        }
        if (msg?.Name && msg?.Message) {
          logLines.push(`[${msg.Name}] ${msg.Message}`)
          return
        }
      } catch {
        // ignore
      }
      logLines.push(line)
    })

    ws.on('close', (code) => {
      clearTimeout(timeout)
      if (resolved) return
      resolved = true
      if (logLines.length) resolve(logLines.join('\n'))
      else resolve(`No logs available (connection closed with code ${code})`)
    })

    ws.on('error', (err) => {
      clearTimeout(timeout)
      if (resolved) return
      resolved = true
      reject(err)
    })
  })
}

async function main() {
  const { wallet, client, chainSDK } = await loadWalletAndClient()
  const accounts = await wallet.getAccounts()
  const owner = accounts[0].address
  const certificate = await loadCertificate(wallet, client, chainSDK)

  const leasesRes = await chainSDK.akash.market.v1beta5.getLeases({
    filters: { owner, dseq: BigInt(DSEQ) },
  })
  const lease = leasesRes.leases?.[0]?.lease
  if (!lease?.id) {
    console.error('No lease found for this DSEQ (already closed or not owned by wallet).')
    process.exit(1)
  }

  const provider = lease.id.provider
  const gseq = Number(lease.id.gseq || 1)
  const oseq = Number(lease.id.oseq || 1)

  const providerRes = await chainSDK.akash.provider.v1beta4.getProvider({
    owner: provider,
  })
  const hostUri = providerRes.provider?.hostUri
  if (!hostUri) {
    console.error('Provider hostUri not found.')
    process.exit(1)
  }

  const logs = await queryLeaseLogs({
    providerHostUri: hostUri,
    certificate,
    dseq: DSEQ,
    gseq,
    oseq,
    service: SERVICE || undefined,
    tail: Number.isFinite(TAIL) && TAIL > 0 ? TAIL : 200,
  })

  console.log(logs)
}

main().catch((e) => {
  console.error('Error:', e?.message || String(e))
  process.exit(1)
})

