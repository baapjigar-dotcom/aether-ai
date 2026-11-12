/**
 * NovaOS AI — Cloudflare Worker-style server-side LLM proxy.
 * Non-local origins require a verified Firebase Auth ID token by default.
 * Localhost is allowed unauthenticated for development; never use that exception in production.
 */
const buckets = new Map();
let firebaseJwksCache = { keys: [], expiresAt: 0 };
const FIREBASE_JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

function isLocalOrigin(origin) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin);
}
function json(status, payload, headers = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
function base64UrlDecode(value) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return bytes;
}
function decodeJwtPart(value) {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(value)));
}

async function getFirebaseJwks() {
  if (firebaseJwksCache.keys.length && Date.now() < firebaseJwksCache.expiresAt) return firebaseJwksCache.keys;
  const response = await fetch(FIREBASE_JWKS_URL, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('Unable to load Firebase signing keys');
  const body = await response.json();
  if (!Array.isArray(body.keys)) throw new Error('Firebase signing keys response was invalid');
  const cacheControl = response.headers.get('cache-control') || '';
  const maxAge = Number(cacheControl.match(/max-age=(\d+)/i)?.[1] || 3600);
  firebaseJwksCache = { keys: body.keys, expiresAt: Date.now() + Math.min(maxAge, 3600) * 1000 };
  return firebaseJwksCache.keys;
}

async function verifyFirebaseIdToken(token, projectId) {
  if (!token || !projectId) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const header = decodeJwtPart(parts[0]);
    const claims = decodeJwtPart(parts[1]);
    if (header.alg !== 'RS256' || !header.kid) return null;
    const now = Math.floor(Date.now() / 1000);
    if (claims.iss !== `https://securetoken.google.com/${projectId}` || claims.aud !== projectId) return null;
    if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 128) return null;
    if (!Number.isFinite(claims.exp) || claims.exp <= now) return null;
    if (!Number.isFinite(claims.iat) || claims.iat > now + 300) return null;
    if (!Number.isFinite(claims.auth_time) || claims.auth_time > now + 300) return null;

    const jwks = await getFirebaseJwks();
    const jwk = jwks.find((key) => key.kid === header.kid && key.kty === 'RSA' && key.use === 'sig');
    if (!jwk) return null;
    const publicKey = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const signature = base64UrlDecode(parts[2]);
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, signature, signingInput);
    return valid ? claims : null;
  } catch {
    return null;
  }
}

function getClientIp(request) {
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') ||
    (request.headers.get('x-forwarded-for') || '').split(',').pop().trim() || 'unknown';
}
async function isRateLimited(ip, env) {
  const limit = Math.max(1, Math.min(1000, Number.parseInt(env.RATE_LIMIT_PER_MIN, 10) || 30));
  // Cloudflare Rate Limiting binding is preferred for distributed deployments.
  if (env.RATE_LIMITER && typeof env.RATE_LIMITER.limit === 'function') {
    const result = await env.RATE_LIMITER.limit({ key: ip });
    return !result.success;
  }
  const now = Date.now();
  if (buckets.size > 10000) {
    for (const [key, bucket] of buckets) if (now > bucket.resetAt) buckets.delete(key);
    while (buckets.size > 10000) buckets.delete(buckets.keys().next().value);
  }
  let bucket = buckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + 60000 };
    buckets.set(ip, bucket);
  }
  bucket.count += 1;
  return bucket.count > limit;
}


async function readBodyWithLimit(request, maxBytes) {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        const error = new Error('Request body exceeds the configured size limit.');
        error.code = 'BODY_TOO_LARGE';
        throw error;
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

function safeUpstreamUrl(value) {
  const url = new URL(value || 'https://api.openai.com/v1/chat/completions');
  const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) throw new Error('UPSTREAM_LLM_URL must use HTTPS (HTTP is allowed only for localhost development)');
  return url.toString();
}

export default {
  async fetch(request, env = {}) {
    const origin = request.headers.get('Origin') || '';
    const allowList = String(env.ALLOWED_ORIGINS || '').split(',').map((item) => item.trim()).filter(Boolean);
    if (allowList.includes('*')) return json(500, { error: { message: 'Wildcard origins are not supported.' } });

    const localOrigin = isLocalOrigin(origin) && env.ENVIRONMENT !== 'production' && env.ALLOW_LOCAL_ORIGINS !== 'false';
    const originAllowed = Boolean(origin) && (localOrigin || allowList.includes(origin));
    const cors = { 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Vary': 'Origin', 'Cache-Control': 'no-store' };
    if (origin && originAllowed) cors['Access-Control-Allow-Origin'] = origin;
    if (!originAllowed && env.ALLOW_NO_ORIGIN !== 'true') return json(403, { error: { message: 'Origin is missing or not allowed. Configure ALLOWED_ORIGINS for this deployment.' } }, cors);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json(405, { error: { message: 'Method Not Allowed' } }, cors);

    const projectId = String(env.FIREBASE_PROJECT_ID || '').trim();
    const mustAuthenticate = env.REQUIRE_FIREBASE_AUTH === 'true' || (!localOrigin && env.REQUIRE_FIREBASE_AUTH !== 'false');
    let authenticatedUser = null;
    if (mustAuthenticate) {
      if (!projectId) return json(503, { error: { message: 'Proxy authentication is not configured. Set FIREBASE_PROJECT_ID.' } }, cors);
      const authorization = request.headers.get('Authorization') || '';
      const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
      authenticatedUser = await verifyFirebaseIdToken(token, projectId);
      if (!authenticatedUser) return json(401, { error: { message: 'A valid Firebase sign-in is required to use this proxy.' } }, cors);
    }

    const ip = getClientIp(request);
    try {
      if (await isRateLimited(authenticatedUser?.sub || ip, env)) return json(429, { error: { message: 'Rate limit exceeded. Try again in a minute.' } }, { ...cors, 'Retry-After': '60' });
    } catch {
      return json(503, { error: { message: 'Rate limiter is unavailable. Please retry shortly.' } }, cors);
    }

    if (!env.OPENAI_API_KEY) return json(500, { error: { message: 'Proxy is missing the OPENAI_API_KEY environment variable.' } }, cors);

    let rawBody;
    try {
      const contentLength = Number.parseInt(request.headers.get('content-length') || '0', 10);
      if (contentLength > 8 * 1024 * 1024) return json(413, { error: { message: 'Request too large (8 MB maximum).' } }, cors);
      rawBody = await readBodyWithLimit(request, 8 * 1024 * 1024);
    } catch (error) {
      if (error?.code === 'BODY_TOO_LARGE') return json(413, { error: { message: 'Request too large (8 MB maximum).' } }, cors);
      return json(400, { error: { message: 'Unable to read request body.' } }, cors);
    }
    let body;
    try { body = JSON.parse(rawBody); } catch { return json(400, { error: { message: 'Invalid JSON body.' } }, cors); }

    if (!body || !Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 80) {
      return json(400, { error: { message: 'messages must be a non-empty array (max 80).' } }, cors);
    }
    const validRoles = new Set(['system', 'user', 'assistant', 'tool']);
    if (body.messages.some((message) => !message || !validRoles.has(message.role) || !Object.hasOwn(message, 'content'))) {
      return json(400, { error: { message: 'Each message must have a supported role and content.' } }, cors);
    }

    const model = String(body.model || env.DEFAULT_MODEL || 'gpt-4o-mini').trim();
    if (!model || model.length > 120 || /[\r\n]/.test(model)) return json(400, { error: { message: 'Invalid model identifier.' } }, cors);
    const allowedModels = String(env.ALLOWED_MODELS || '').split(',').map((item) => item.trim()).filter(Boolean);
    if (allowedModels.length && !allowedModels.includes(model)) return json(400, { error: { message: `Model "${model}" is not allowed on this proxy.` } }, cors);

    if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 16)) return json(400, { error: { message: 'tools must be an array containing at most 16 definitions.' } }, cors);
    const cap = Math.max(1, Math.min(32768, Number.parseInt(env.MAX_TOKENS_CAP, 10) || 2048));
    const requestedTokens = Number.parseInt(body.max_tokens, 10);
    const temperature = Number(body.temperature ?? 0.7);
    const upstreamBody = {
      model,
      messages: body.messages,
      temperature: Number.isFinite(temperature) ? Math.min(Math.max(temperature, 0), 2) : 0.7,
      max_tokens: Number.isFinite(requestedTokens) ? Math.min(Math.max(requestedTokens, 1), cap) : Math.min(1024, cap),
      stream: Boolean(body.stream)
    };
    if (Array.isArray(body.tools) && body.tools.length) {
      upstreamBody.tools = body.tools;
      if (body.tool_choice === 'auto' || body.tool_choice === 'none' || body.tool_choice === 'required' || (body.tool_choice && typeof body.tool_choice === 'object')) upstreamBody.tool_choice = body.tool_choice;
    }

    let upstreamUrl;
    try { upstreamUrl = safeUpstreamUrl(env.UPSTREAM_LLM_URL); }
    catch (error) { return json(500, { error: { message: error.message } }, cors); }

    try {
      const upstream = await fetch(upstreamUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.OPENAI_API_KEY}` },
        body: JSON.stringify(upstreamBody),
        signal: request.signal
      });
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { ...cors, 'Content-Type': upstream.headers.get('Content-Type') || 'application/json', 'Cache-Control': 'no-store' }
      });
    } catch {
      return json(502, { error: { message: 'The upstream AI provider could not be reached.' } }, cors);
    }
  }
};
