import { WebSocketServer } from 'ws'
import { randomBytes } from 'crypto'
import { loadModel, completion, unloadModel } from '@qvac/sdk'
import { QWEN3_600M_INST_Q4 } from '@qvac/sdk'
import { connectToProvider, destroySwarm } from './quote-channel.js'
import {
  loadKeypairSigner,
  createSolanaClients,
  fetchProvider,
  createJob,
  computeResponseHash,
  pollJobUntilProviderDone,
  confirmJob,
  refundJob,
} from './solana.js'

// Initialise Solana clients once at startup (no-op if env vars not set).
const solanaClients = createSolanaClients()
const consumer = await loadKeypairSigner(process.env.SOLANA_KEYPAIR_PATH ?? null).catch(() => null)
if (consumer) {
  console.log(`  Consumer wallet: ${consumer.address}`)
} else {
  console.log(`  Consumer wallet: not configured (SOLANA_KEYPAIR_PATH unset or invalid)`)
}

// Per-provider Hyperswarm quote connections, keyed by providerAuthority.
const quoteConnections = new Map()
// Status cache: authority → { status: 'online'|'offline', ts }
const statusCache = new Map()
const STATUS_TTL = 30_000
// In-flight ping deduplication: authority → Promise<'online'|'offline'>
const pingInflight = new Map()

function registerQuoteConn(authority, conn) {
  conn._socket.once('close', () => {
    quoteConnections.delete(authority)
    statusCache.set(authority, { status: 'offline', ts: Date.now() })
  })
  quoteConnections.set(authority, conn)
}

async function getQuoteConn(providerAuthority) {
  if (!quoteConnections.has(providerAuthority)) {
    const conn = await connectToProvider(providerAuthority)
    registerQuoteConn(providerAuthority, conn)
  }
  return quoteConnections.get(providerAuthority)
}

async function pingProvider(authority, timeoutMs = 5_000) {
  const cached = statusCache.get(authority)
  if (cached && Date.now() - cached.ts < STATUS_TTL) return cached.status

  if (pingInflight.has(authority)) return pingInflight.get(authority)

  const p = (async () => {
    try {
      if (quoteConnections.has(authority)) {
        statusCache.set(authority, { status: 'online', ts: Date.now() })
        return 'online'
      }
      const conn = await connectToProvider(authority, timeoutMs)
      registerQuoteConn(authority, conn)
      statusCache.set(authority, { status: 'online', ts: Date.now() })
      return 'online'
    } catch {
      statusCache.set(authority, { status: 'offline', ts: Date.now() })
      return 'offline'
    } finally {
      pingInflight.delete(authority)
    }
  })()

  pingInflight.set(authority, p)
  return p
}

// Per-session job nonce counters, keyed by consumer address.
const nonceCounters = new Map()

// Hard cap on per-job amount when running in demo mode (no Phantom prompt).
// Phantom mode is exempt because the user reviews the amount in-wallet.
const DEMO_MAX_LAMPORTS = 100_000_000n // 0.1 SOL

/**
 * Request a Phantom signature from the browser.
 * Sends a sign_request with the unsigned tx bytes; waits for sign_response.
 * Returns the signed tx base64 string (bridge submits).
 */
function requestSignatureFromBrowser(ws, signListeners, txBase64, description) {
  return new Promise((resolve, reject) => {
    const txId = randomBytes(8).toString('hex')
    const timer = setTimeout(() => {
      signListeners.delete(txId)
      reject(new Error('Phantom signing timed out — no response after 2 minutes'))
    }, 120_000)
    signListeners.set(txId, {
      resolve: (signedTxBase64) => { clearTimeout(timer); signListeners.delete(txId); resolve(signedTxBase64) },
      reject: (err) => { clearTimeout(timer); signListeners.delete(txId); reject(err) },
    })
    ws.send(JSON.stringify({ type: 'sign_request', txId, txBase64, description }))
  })
}

const PORT = 3000

// Origin allow-list — browsers do not enforce CORS on WebSockets, so any
// website the user visits could otherwise open ws://127.0.0.1:3000 and submit
// transactions on their behalf. Connections without a matching Origin header
// are rejected.
const ALLOWED_ORIGINS = new Set([
  'https://www.qvacmarketplace.io',
  'https://qvacmarketplace.io',
  'http://localhost:3001',
  'http://127.0.0.1:3001',
])

const wss = new WebSocketServer({
  port: PORT,
  host: '127.0.0.1',
  verifyClient: ({ origin }, cb) => {
    if (!origin || !ALLOWED_ORIGINS.has(origin)) {
      console.warn(`  rejected ws connection from origin: ${origin ?? '(none)'}`)
      return cb(false, 403, 'Origin not allowed')
    }
    cb(true)
  },
})

console.log(``)
console.log(`  ██████╗ ██╗   ██╗ █████╗  ██████╗`)
console.log(`  ██╔══██╗██║   ██║██╔══██╗██╔════╝`)
console.log(`  ██║  ██║██║   ██║███████║██║     `)
console.log(`  ██║  ██║╚██╗ ██╔╝██╔══██║██║     `)
console.log(`  ██████╔╝ ╚████╔╝ ██║  ██║╚██████╗`)
console.log(`  ╚═════╝   ╚═══╝  ╚═╝  ╚═╝ ╚═════╝`)
console.log(``)
console.log(`  QVAC Bridge v1.0`)
console.log(`  ─────────────────────────────────`)
console.log(`  WebSocket : ws://127.0.0.1:${PORT}`)
console.log(`  Security  : localhost only`)
console.log(`  Waiting for browser connection...`)
console.log(``)

// track active sessions
const sessions = new Map()

wss.on('connection', (ws) => {
  const id = randomBytes(4).toString('hex').toUpperCase()
  console.log(`  [${id}] browser connected`)

  // session state per browser connection
  sessions.set(id, {
    modelId: null,
    providerKey: null,
    busy: false,
    signListeners: new Map(),
  })

  const session = sessions.get(id)

  const send = (data) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(data))
    }
  }

  ws.on('message', async (raw) => {
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      send({ type: 'error', message: 'Invalid JSON' })
      return
    }

    // --- SIGN_RESPONSE / SIGN_REJECTED messages (Phantom flow) ---
    if (msg.type === 'sign_response') {
      const listener = session.signListeners.get(msg.txId)
      if (listener) listener.resolve(msg.signedTxBase64)
      return
    }
    if (msg.type === 'sign_rejected') {
      const listener = session.signListeners.get(msg.txId)
      if (listener) listener.reject(new Error('Transaction rejected in Phantom'))
      return
    }

    // --- PROMPT message ---
    if (msg.type === 'prompt') {
      if (session.busy) {
        send({ type: 'error', message: 'Still generating previous response' })
        return
      }

      // Accept either new providerAuthority (Solana address) or legacy providerPublicKey (QVAC hex key).
      const { providerAuthority, providerPublicKey: legacyKey, messages, consumerPubkey } = msg
      // usePhantomFlow: browser sent its Phantom pubkey → sign via browser round-trip
      const usePhantomFlow = !!consumerPubkey && !!providerAuthority
      // useSolanaFlow: either Phantom or local consumer.json is available
      const useSolanaFlow = !!providerAuthority && (usePhantomFlow || !!consumer)

      if (!providerAuthority && !legacyKey) {
        send({ type: 'error', message: 'providerAuthority or providerPublicKey is required' })
        return
      }
      if (!messages || messages.length === 0) {
        send({ type: 'error', message: 'No messages provided' })
        return
      }

      session.busy = true

      try {
        // Step 1: resolve qvacPeerId — always look up from chain when providerAuthority given.
        // This is the key the QVAC SDK needs, NOT the Solana authority address.
        let qvacPeerIdHex = legacyKey?.trim()
        let providerInfo = null

        if (providerAuthority) {
          providerInfo = await fetchProvider(solanaClients.rpc, providerAuthority)
          qvacPeerIdHex = Buffer.from(providerInfo.qvacPeerId).toString('hex')
          console.log(`  [${id}] qvacPeerId: ${qvacPeerIdHex.substring(0, 16)}…`)
        }

        // Step 2: quote + job creation — only when consumer wallet is configured.
        let quoteConn = null
        let quoteData = null

        // Resolved consumer address: Phantom pubkey OR local keypair address.
        const consumerAddr = usePhantomFlow ? consumerPubkey : consumer?.address
        // remoteSign: sends unsigned tx to browser → browser signs via Phantom → returns signed bytes.
        // quoteData is null when remoteSign is defined but will be set before it is called —
        // JS closures capture by reference so reading it here is safe.
        const remoteSign = usePhantomFlow
          ? (txBase64, description) => {
              const sol = quoteData ? (Number(quoteData.amount) / 1e9).toFixed(6) : null
              const label = description === 'create job'
                ? `Escrow ${sol} SOL to provider`
                : `Release ${sol} SOL to provider`
              send({ type: 'status', stage: 'signing', text: `Waiting for Phantom approval — ${label}…` })
              return requestSignatureFromBrowser(ws, session.signListeners, txBase64, label)
            }
          : null

        if (useSolanaFlow && providerInfo) {
          send({ type: 'status', stage: 'quote', text: 'Requesting price quote from provider…' })

          // Dial quote channel and request a quote.
          quoteConn = await getQuoteConn(providerAuthority)
          quoteData = await quoteConn.requestQuote(consumerAddr)
          console.log(`  [${id}] quote: ${quoteData.amount} lamports, valid until ${quoteData.validUntil}`)

          // In demo mode the bridge auto-signs without a wallet prompt, so a
          // malicious provider could quote any amount. Reject anything above
          // the configured ceiling. Phantom mode shows the amount in-wallet.
          if (!usePhantomFlow && BigInt(quoteData.amount) > DEMO_MAX_LAMPORTS) {
            throw new Error(
              `Provider quoted ${quoteData.amount} lamports — exceeds demo-mode cap of ${DEMO_MAX_LAMPORTS}. Use Phantom for higher amounts.`,
            )
          }

          send({ type: 'status', stage: 'job', text: 'Creating on-chain job…' })

          // Compute nonce (per-consumer, monotonically increasing).
          // Seed from Date.now() on first use so restarts never collide with
          // on-chain PDAs from previous sessions (which may still be Pending).
          const nonce = nonceCounters.get(consumerAddr) ?? BigInt(Date.now())
          nonceCounters.set(consumerAddr, nonce + 1n)

          // Create job on Solana.
          const { jobPda, requestHashHex } = await createJob({
            rpc: solanaClients.rpc,
            sendAndConfirm: solanaClients.sendAndConfirm,
            consumer: usePhantomFlow ? null : consumer,
            consumerAddress: usePhantomFlow ? consumerPubkey : undefined,
            providerPda: providerInfo.providerPda,
            providerAuthority,
            quote: quoteData,
            messages,
            nonce,
            remoteSign,
          })

          // Notify provider the job exists.
          await quoteConn.notifyJobCreated(quoteData.requestId, jobPda, requestHashHex)
          console.log(`  [${id}] job acked: ${jobPda}`)
          session.currentJobPda = jobPda
          session.currentNonce = nonce

          // The quote response carries the provider's live qvacPeerId, which may
          // differ from the on-chain record if the provider restarted with a new
          // DHT seed before rotating on-chain. The Hyperswarm connection is keyed
          // to the authority address, so this value is authentic.
          if (quoteData.qvacPeerId) {
            qvacPeerIdHex = quoteData.qvacPeerId
          }
        }

        // connect or reconnect if provider changed
        const needsConnect =
          session.providerKey !== qvacPeerIdHex || !session.modelId

        if (needsConnect) {
          // unload old model if switching provider
          if (session.modelId) {
            console.log(`  [${id}] switching provider, unloading old model`)
            await unloadModel({ modelId: session.modelId }).catch(() => {})
            session.modelId = null
            session.providerKey = null
          }

          console.log(`  [${id}] connecting to ${qvacPeerIdHex?.substring(0, 16)}...`)
          send({ type: 'status', stage: 'connecting', text: 'Connecting to provider via P2P...' })

          session.modelId = await loadModel({
            modelSrc: QWEN3_600M_INST_Q4,
            modelType: 'llamacpp-completion',
            delegate: {
              providerPublicKey: qvacPeerIdHex,
              timeout: 60_000,
              fallbackToLocal: false
            }
          })

          session.providerKey = qvacPeerIdHex
          console.log(`  [${id}] connected — model: ${session.modelId}`)
          send({ type: 'connected', providerAuthority: providerAuthority ?? qvacPeerIdHex })
        }

        send({ type: 'status', stage: 'generating', text: 'Generating response...' })

        const response = completion({
          modelId: session.modelId,
          history: messages,
          stream: true
        })

        const tokenParts = []
        for await (const token of response.tokenStream) {
          tokenParts.push(token)
          send({ type: 'token', token })
        }

        const stats = await response.stats
        send({ type: 'done', stats })
        console.log(`  [${id}] response complete`)

        // Phase 4 — notify provider + provider submits provider_complete.
        if (useSolanaFlow && quoteConn && session.currentJobPda) {
          const responseHash = await computeResponseHash(tokenParts.join(''), session.currentNonce)
          const responseHashHex = Buffer.from(responseHash).toString('hex')

          send({ type: 'status', stage: 'settling', text: 'Notifying provider of completion…' })
          quoteConn.notifyResponseObserved(session.currentJobPda, responseHashHex)
          console.log(`  [${id}] response_observed sent, waiting for provider_complete…`)

          // Phase 5 — poll until ProviderDone, then confirm.
          send({ type: 'status', stage: 'settling', text: 'Waiting for provider confirmation…' })
          const jobData = await pollJobUntilProviderDone(solanaClients.rpc, session.currentJobPda)
          console.log(`  [${id}] provider_complete confirmed, submitting consumer_confirm…`)

          send({ type: 'status', stage: 'settling', text: 'Releasing escrow…' })
          const txSig = await confirmJob({
            rpc: solanaClients.rpc,
            sendAndConfirm: solanaClients.sendAndConfirm,
            signer: usePhantomFlow ? null : consumer,
            job: session.currentJobPda,
            provider: providerInfo.providerPda,
            consumer: usePhantomFlow ? consumerPubkey : consumer.address,
            providerAuthority,
            remoteSign,
          })

          send({ type: 'settled', txSignature: txSig, amount: jobData.amount.toString() })
          console.log(`  [${id}] settled: ${txSig}`)
          session.currentJobPda = null
        }

      } catch (err) {
        console.error(`  [${id}] error:`, err.message)
        if (err.cause) console.error(`  [${id}] cause:`, err.cause)

        // reset connection on error
        session.modelId = null
        session.providerKey = null

        // Map well-known errors to user-safe messages. Anything else gets a
        // generic message so we don't leak filesystem paths, internal addresses,
        // or stack details to the browser.
        const m = err.message ?? ''
        let userMessage = 'Something went wrong while contacting the provider.'
        if (m.includes('timeout') || m.includes('TIMEOUT')) {
          userMessage = 'Connection to provider timed out. Make sure the provider is running and the key is correct.'
        } else if (m.includes('ECONNRESET') || m.includes('connection reset')) {
          userMessage = 'Provider disconnected. They may have stopped their node.'
        } else if (m.includes('DHT')) {
          userMessage = 'Could not find provider on the network. Check the public key.'
        } else if (m.includes('exceeds demo-mode cap')) {
          userMessage = m // safe — generated by us above
        } else if (m.includes('Phantom')) {
          userMessage = m // safe — generated by us above
        }

        send({ type: 'error', message: userMessage })
      }

      session.busy = false
    }

    // --- REFUND message ---
    if (msg.type === 'refund') {
      if (!consumer) {
        send({ type: 'error', message: 'Consumer wallet not configured' })
        return
      }
      const { jobPda } = msg
      if (!jobPda) {
        send({ type: 'error', message: 'jobPda is required' })
        return
      }
      try {
        const txSig = await refundJob({
          rpc: solanaClients.rpc,
          sendAndConfirm: solanaClients.sendAndConfirm,
          consumer,
          jobPda,
        })
        send({ type: 'refunded', txSignature: txSig, jobPda })
        console.log(`  refund: ${jobPda} → ${txSig}`)
      } catch (err) {
        send({ type: 'error', message: err.message })
      }
    }

    // --- DISCONNECT message ---
    if (msg.type === 'disconnect') {
      if (session.modelId) {
        await unloadModel({ modelId: session.modelId }).catch(() => {})
        session.modelId = null
        session.providerKey = null
      }
      console.log(`  [${id}] disconnected from provider`)
      send({ type: 'provider_disconnected' })
    }

    // --- CHECK_STATUS message ---
    if (msg.type === 'check_status') {
      const { providers = [] } = msg
      if (!providers.length) return
      const results = {}
      await Promise.all(providers.map(async (authority) => {
        results[authority] = await pingProvider(authority)
      }))
      send({ type: 'status_results', results })
    }
  })

  ws.on('close', async () => {
    console.log(`  [${id}] browser disconnected`)
    if (session.modelId) {
      await unloadModel({ modelId: session.modelId }).catch(() => {})
    }
    sessions.delete(id)
  })

  ws.on('error', (err) => {
    console.error(`  [${id}] ws error:`, err.message)
  })
})

wss.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`  ERROR: Port ${PORT} is already in use.`)
    console.error(`  Is another bridge already running?`)
  } else {
    console.error(`  Bridge error:`, err.message)
  }
  process.exit(1)
})

process.on('SIGINT', async () => {
  console.log(`\n  Shutting down bridge...`)
  wss.close()
  await destroySwarm().catch(() => {})
  process.exit(0)
})
