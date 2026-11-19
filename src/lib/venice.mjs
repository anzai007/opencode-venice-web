/**
 * Venice web client: session file handling, Clerk JWT minting, Cloudflare-safe
 * request headers, client attestation and the upstream inference call.
 *
 * The web app authenticates with a long lived Clerk `__client` cookie, which is
 * exchanged for a ~60 second session JWT. This module owns that exchange and
 * keeps the cookie rotation that Clerk performs while it happens.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import {
  apiBase,
  attestationTtlMs,
  clerkBase,
  clerkVersion,
  isServerless,
  middlefaceVersion,
  requestTimeoutMs,
  sessionFile,
  tokenRefreshSkewMs,
  transport,
} from './config.mjs'
import { curlFetch, findCurl, isCloudflareBlock } from './curl.mjs'

const INFERENCE_PATH = '/api/inference/chat/agents/ad-hoc'
/** Venice's own agent, which makes images; `paidImagesMode=block` keeps it on free models (docs/PROTOCOL.md §5b). */
const AGENT_IMAGE_PATH = '/api/inference/chat/agents/venice?paidImagesMode=block'

let state = null
let tokenFlight = null
let attestation = null

/** An upstream error that means "the user must sign in again". */
export class SignInError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SignInError'
    this.signIn = 'expired'
  }
}

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** Reads session credentials from serverless environment variables, if configured. */
function readSessionFromEnv() {
  let data = null
  if (process.env.VENICE_SESSION_B64) {
    const raw = Buffer.from(process.env.VENICE_SESSION_B64.trim(), 'base64').toString('utf8')
    data = JSON.parse(raw)
  } else if (process.env.VENICE_SESSION_JSON) {
    data = JSON.parse(process.env.VENICE_SESSION_JSON)
  } else if (process.env.VENICE_CLIENT_COOKIE) {
    data = {
      client: process.env.VENICE_CLIENT_COOKIE.trim(),
      userAgent: (process.env.VENICE_USER_AGENT ?? '').trim() || DEFAULT_USER_AGENT,
      uid: process.env.VENICE_UID || undefined,
      sessionId: process.env.VENICE_SESSION_ID || undefined,
      email: process.env.VENICE_EMAIL || undefined,
    }
  }
  if (!data) return null
  data.envKey = createHash('sha256').update(String(data.client ?? '')).digest('hex').slice(0, 16)
  return data
}

export async function readSession() {
  const envSession = readSessionFromEnv()
  if (envSession) {
    try {
      const disk = JSON.parse(await readFile(sessionFile, 'utf8'))
      if (disk?.envKey === envSession.envKey && disk.client && disk.userAgent) {
        return disk
      }
    } catch {
      /* cold start or no writable disk cache yet */
    }
    if (!envSession.client || !envSession.userAgent) {
      throw new SignInError('session env var is incomplete; check VENICE_SESSION_B64 / VENICE_SESSION_JSON')
    }
    return envSession
  }

  const raw = await readFile(sessionFile, 'utf8')
  const data = JSON.parse(raw)
  if (!data.client || !data.userAgent) {
    throw new SignInError(`session file is incomplete (${sessionFile}); run the login command again`)
  }
  return data
}

export async function loadSession({ force = false } = {}) {
  if (state && !force) return state
  state = await readSession()
  return state
}

export async function saveSession() {
  if (!state) return
  const tmp = `${sessionFile}.${randomUUID()}.tmp`
  try {
    await mkdir(path.dirname(sessionFile), { recursive: true })
    await writeFile(tmp, JSON.stringify(state, null, 1), { mode: 0o600 })
    await rename(tmp, sessionFile)
  } catch (error) {
    if (!isServerless) throw error
  }
}

export function resetSessionCache() {
  state = null
  tokenFlight = null
  attestation = null
  cachedVeniceUserId = null
}

/** Only venice.ai and its Clerk backend are ever contacted. */
function assertDestination(url) {
  const origin = new URL(url).origin
  if (origin !== clerkBase && origin !== apiBase) throw new Error(`unexpected upstream: ${origin}`)
}

/** Which client talks to `url`: curl for the inference host (see config `transport`), fetch otherwise. */
export function transportFor(url) {
  if (new URL(url).origin !== apiBase || transport === 'fetch') return 'fetch'
  if (transport === 'curl') return 'curl'
  return findCurl() ? 'curl' : 'fetch'
}

/**
 * Fetch with the headers the Venice web app sends. Only the `__client` cookie is
 * sent, so Cloudflare's `cf_clearance` (which is bound to the browser) cannot
 * invalidate the session.
 */
export async function veneziaFetch(url, init = {}) {
  assertDestination(url)
  const session = await loadSession()
  const headers = new Headers(init.headers)
  headers.set('user-agent', session.userAgent)
  headers.set('origin', 'https://venice.ai')
  headers.set('referer', 'https://venice.ai/')
  headers.set('cookie', `__client=${session.client}`)

  const signal = init.signal ?? AbortSignal.timeout(requestTimeoutMs)
  const client = transportFor(url)
  const response =
    client === 'curl'
      ? await curlFetch(url, { method: init.method, headers, body: init.body, signal })
      : await fetch(url, { ...init, headers, redirect: 'error', signal })

  // Clerk rotates __client while it is used; keep the newer value.
  const rotated = response.headers.getSetCookie().find((cookie) => cookie.startsWith('__client='))
  if (rotated) {
    const value = rotated.slice('__client='.length).split(';')[0]
    if (value && value !== session.client) {
      session.client = value
      await saveSession()
    }
  }

  if (isCloudflareBlock(response.status, response.headers)) {
    await response.body?.cancel()
    const hint =
      client === 'curl'
        ? 'refresh the cookies (login command)'
        : 'Node fetch is blocked on this route; install curl or set VENICE_WEB_TRANSPORT=curl'
    throw new SignInError(`Venice asked for a Cloudflare challenge (${client}); ${hint}`)
  }

  return response
}

/** Reads the active session id and account from Clerk. */
async function ensureSessionIdentity(session) {
  const response = await veneziaFetch(`${clerkBase}/v1/client${clerkVersion}`)
  if (!response.ok) throw new SignInError(`Clerk rejected the stored session (HTTP ${response.status})`)
  const data = await response.json()
  const sessions = (data.response?.sessions ?? data.client?.sessions ?? []).filter((item) => item.status === 'active')
  const chosen = (session.uid && sessions.find((item) => item.user?.id === session.uid)) || sessions[0]
  if (!chosen) throw new SignInError('no active Venice session in the stored cookies')
  session.sessionId = chosen.id
  session.uid = chosen.user?.id ?? session.uid
  session.email =
    chosen.user?.email_addresses?.find((item) => item.id === chosen.user?.primary_email_address_id)?.email_address ??
    session.email
  return session
}

/**
 * Mints (or reuses) a Clerk session JWT. Single-flight: concurrent requests wait
 * for the same token instead of minting several.
 */
export async function mintToken({ force = false } = {}) {
  const session = await loadSession()
  if (!force && session.access && session.expires > Date.now() + tokenRefreshSkewMs) return session.access
  if (tokenFlight) return tokenFlight

  tokenFlight = (async () => {
    try {
      if (!session.sessionId) await ensureSessionIdentity(session)
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await veneziaFetch(
          `${clerkBase}/v1/client/sessions/${encodeURIComponent(session.sessionId)}/tokens${clerkVersion}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: 'organization_id=&tab_state=focused&force_origin=true',
          },
        )
        if (response.status === 401 && attempt === 0) {
          await ensureSessionIdentity(session)
          continue
        }
        if (!response.ok) throw new SignInError(`could not mint a Venice session token (HTTP ${response.status})`)
        const { jwt } = await response.json()
        const claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'))
        if (claims.sub && session.uid && claims.sub !== session.uid) {
          throw new SignInError('the signed-in account changed; sign in again')
        }
        session.access = jwt
        session.expires = claims.exp * 1000
        await saveSession()
        return jwt
      }
      throw new Error('could not mint a Venice session token')
    } finally {
      tokenFlight = null
    }
  })()

  return tokenFlight
}

/** Some inference requests carry a short-lived client attestation token. */
async function attestationToken(headers) {
  if (attestation && attestation.expires > Date.now()) return attestation.value
  const response = await veneziaFetch(`${apiBase}/api/app/user/client_attestation/mint`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ env: {} }),
  })
  if (!response.ok) return null
  const data = await response.json().catch(() => null)
  if (!data?.token) return null
  attestation = { value: data.token, expires: Date.now() + attestationTtlMs }
  return data.token
}

/**
 * A `FormData` as bytes plus its `multipart/form-data; boundary=…` type. curl
 * reads the body from stdin, so the multipart encoding is done here, by the
 * same encoder `fetch()` uses.
 */
export async function multipartBody(form) {
  const request = new Request('http://localhost/', { method: 'POST', body: form })
  return { body: Buffer.from(await request.arrayBuffer()), contentType: request.headers.get('content-type') }
}

/**
 * Calls the web inference endpoint, retrying once with a freshly minted token on
 * 401 (a rotated or revoked session).
 *
 * `files` (`{ mediaId, mimeType, data }`) turn the request into the multipart
 * form the web client sends with images: the JSON body in `request` and every
 * image in its own `media.<media_id>` field (docs/PROTOCOL.md §2b).
 */
export async function upstreamChat(body, route = INFERENCE_PATH, signal, files = []) {
  const session = await loadSession()
  const timeout = signal ? AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]) : AbortSignal.timeout(requestTimeoutMs)

  let payload = JSON.stringify(body)
  let contentType = 'application/json'
  if (files.length) {
    const form = new FormData()
    form.append('request', payload)
    for (const file of files) form.append(`media.${file.mediaId}`, new Blob([file.data], { type: file.mimeType }), 'image')
    ;({ body: payload, contentType } = await multipartBody(form))
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const access = await mintToken({ force: attempt > 0 })
    const headers = {
      authorization: `Bearer ${access}`,
      'content-type': contentType,
      // no `accept: text/event-stream`: Cloudflare blocks the route with it, and
      // the backend streams SSE without it anyway
      'x-venice-middleface-version': middlefaceVersion,
      'x-venice-request-timestamp-ms': String(Date.now()),
    }
    if (route.startsWith('/api/inference/')) {
      const token = await attestationToken(headers)
      if (token) headers['x-venice-client-attestation'] = token
    }
    const response = await veneziaFetch(apiBase + route, {
      method: 'POST',
      headers,
      body: payload,
      signal: timeout,
    })
    if (response.status === 401 && attempt === 0) {
      await response.body?.cancel()
      continue
    }
    return response
  }
  throw new Error('Venice request failed')
}

/** Small health probe used by `doctor` and `/health`. */
export async function probeAccount() {
  const session = await loadSession()
  await ensureSessionIdentity(session)
  return { email: session.email, uid: session.uid, sessionId: session.sessionId }
}

/**
 * Issues an authenticated GET request against `outerface.venice.ai`, retrying
 * once with a freshly minted Clerk JWT on HTTP 401.
 */
async function authedVeniceGet(route, signal) {
  const timeout = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)])
    : AbortSignal.timeout(requestTimeoutMs)

  for (let attempt = 0; attempt < 2; attempt++) {
    const access = await mintToken({ force: attempt > 0 })
    const headers = {
      authorization: `Bearer ${access}`,
      'x-venice-middleface-version': middlefaceVersion,
      'x-venice-request-timestamp-ms': String(Date.now()),
    }
    const response = await veneziaFetch(apiBase + route, {
      method: 'GET',
      headers,
      signal: timeout,
    })
    if (response.status === 401 && attempt === 0) {
      await response.body?.cancel()
      continue
    }
    return response
  }
  throw new Error('Venice request failed')
}

/** Fetches the public character catalogue with optional query filters. */
export async function fetchCharacters(query = {}, signal) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, String(value))
    }
  }
  const qs = params.toString()
  return authedVeniceGet(`/api/characters${qs ? `?${qs}` : ''}`, signal)
}

/** Fetches the signed-in user's own created characters. */
export async function fetchMyCharacters(signal) {
  return authedVeniceGet('/api/characters/me', signal)
}

/** Fetches a single character's details (including `jsonData` by default). */
export async function fetchCharacterDetail(characterId, { includeJsonData = true, signal } = {}) {
  const id = encodeURIComponent(characterId)
  return authedVeniceGet(`/api/characters/${id}?includeJsonData=${Boolean(includeJsonData)}`, signal)
}

/** Fetches a character's avatar image binary response. */
export async function fetchCharacterPhoto(characterId, signal) {
  const id = encodeURIComponent(characterId)
  return authedVeniceGet(`/api/characters/${id}/photo`, signal)
}

/** Fetches featured minds (GET /api/v2/agents/featured). */
export async function fetchFeaturedMinds(signal) {
  return authedVeniceGet('/api/v2/agents/featured', signal)
}

/** Searches minds with optional category, query, sort, and pagination filters. */
export async function fetchMindsSearch(query = {}, signal) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, String(value))
    }
  }
  const qs = params.toString()
  return authedVeniceGet(`/api/v2/agents/search${qs ? `?${qs}` : ''}`, signal)
}

/** Fetches the signed-in user's favorite minds. */
export async function fetchFavoriteMinds(query = {}, signal) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, String(value))
    }
  }
  const qs = params.toString()
  return authedVeniceGet(`/api/v2/agents/favorites${qs ? `?${qs}` : ''}`, signal)
}

/** Fetches full detail of a mind by its slug (GET /api/v2/agents/:slug). */
export async function fetchMindDetail(slug, signal) {
  const id = encodeURIComponent(slug)
  return authedVeniceGet(`/api/v2/agents/${id}`, signal)
}

/** Fetches a mind's avatar image. */
export async function fetchMindAvatar(slug, hash, signal) {
  const id = encodeURIComponent(slug)
  const qs = hash ? `?h=${encodeURIComponent(hash)}` : ''
  return authedVeniceGet(`/api/v2/agents/${id}/avatar${qs}`, signal)
}

/** Fetches a mind's cover banner image. */
export async function fetchMindCover(slug, hash, signal) {
  const id = encodeURIComponent(slug)
  const qs = hash ? `?h=${encodeURIComponent(hash)}` : ''
  return authedVeniceGet(`/api/v2/agents/${id}/cover${qs}`, signal)
}

let cachedVeniceUserId = null

/** Resolves the Venice user profile UUID from /api/user/session. */
export async function getVeniceUserId(signal) {
  if (cachedVeniceUserId) return cachedVeniceUserId
  const response = await authedVeniceGet('/api/user/session', signal)
  if (!response.ok) return null
  const data = await response.json().catch(() => null)
  if (data?.token) {
    try {
      const claims = JSON.parse(Buffer.from(data.token.split('.')[1], 'base64url').toString('utf8'))
      if (claims.userId) {
        cachedVeniceUserId = claims.userId
        return claims.userId
      }
    } catch {}
  }
  return null
}

/** Fetches minds created by the signed-in user. */
export async function fetchMyMinds(query = {}, signal) {
  const userId = await getVeniceUserId(signal)
  if (!userId) {
    return new Response(JSON.stringify({ data: [], limit: 20, nextCursor: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return fetchMindsSearch({ ...query, creatorId: userId }, signal)
}

export { AGENT_IMAGE_PATH, INFERENCE_PATH }
