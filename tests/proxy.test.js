/**
 * Security and request-shaping tests for the real server/proxy.js implementation.
 */
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import proxy from '../server/proxy.js';

globalThis.crypto ||= webcrypto;
const keyPair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
publicJwk.kid = 'test-firebase-key';
publicJwk.use = 'sig';
publicJwk.alg = 'RS256';
let upstreamCalls = [];
let jwksCalls = 0;
globalThis.fetch = async (url, init = {}) => {
  if (String(url).includes('securetoken@system.gserviceaccount.com')) {
    jwksCalls += 1;
    return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' } });
  }
  upstreamCalls.push({ url, init, body: JSON.parse(init.body) });
  return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
};

const b64url = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');
async function createFirebaseToken(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', kid: publicJwk.kid };
  const claims = {
    iss: 'https://securetoken.google.com/novaos-test', aud: 'novaos-test', sub: 'firebase-user-123',
    iat: now, exp: now + 3600, auth_time: now, ...overrides
  };
  const signingInput = `${b64url(header)}.${b64url(claims)}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keyPair.privateKey, new TextEncoder().encode(signingInput));
  return `${signingInput}.${Buffer.from(signature).toString('base64url')}`;
}

const messages = [{ role: 'user', content: 'hi' }];
const call = (body, { origin = 'http://localhost:8000', method = 'POST', env = {}, ip = '1.1.1.1', token = '' } = {}) => {
  const headers = { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}), 'cf-connecting-ip': ip, ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  return proxy.fetch(new Request('http://proxy/api/chat', { method, headers, body: method === 'POST' ? JSON.stringify(body) : undefined }), { OPENAI_API_KEY: 'sk-test', ...env });
};

let response = await call({ messages, stream: true });
assert.equal(response.status, 200);
assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'http://localhost:8000');
console.log('✅ PASS: localhost development origin is accepted and reflected exactly');

response = await call({ messages }, { origin: 'https://evil.example' });
assert.equal(response.status, 403);
console.log('✅ PASS: unapproved website origin is rejected');

response = await call({ messages }, { origin: '' });
assert.equal(response.status, 403);
console.log('✅ PASS: requests without an Origin header are rejected by default');

response = await call({ messages }, { origin: 'http://localhost:8000', env: { ENVIRONMENT: 'production' } });
assert.equal(response.status, 403);
console.log('✅ PASS: production mode disables the localhost development exception');

response = await call({ messages }, { origin: 'https://app.example', env: { ALLOWED_ORIGINS: 'https://app.example' } });
assert.equal(response.status, 503);
console.log('✅ PASS: hosted origins fail closed until Firebase proxy authentication is configured');

response = await call({ messages }, { origin: 'https://app.example', env: { ALLOWED_ORIGINS: 'https://app.example', FIREBASE_PROJECT_ID: 'novaos-test' } });
assert.equal(response.status, 401);
console.log('✅ PASS: hosted origin cannot use the proxy without a Firebase ID token');

const validToken = await createFirebaseToken();
upstreamCalls = [];
response = await call({ messages, stream: true, max_tokens: 999999, temperature: 9, model: 'gpt-4o', tools: [{ type: 'function', function: { name: 'x' } }], tool_choice: 'auto' }, {
  origin: 'https://app.example', env: { ALLOWED_ORIGINS: 'https://app.example', FIREBASE_PROJECT_ID: 'novaos-test' }, token: validToken, ip: '2.2.2.2'
});
assert.equal(response.status, 200);
const upstreamBody = upstreamCalls[0].body;
assert.equal(upstreamBody.max_tokens, 2048);
assert.equal(upstreamBody.temperature, 2);
assert.ok(upstreamBody.tools && upstreamBody.tool_choice === 'auto');
assert.equal(upstreamCalls[0].init.headers.Authorization, 'Bearer sk-test');
console.log('✅ PASS: Firebase JWT is verified; token caps, model request and tool calls are forwarded safely');

const badToken = await createFirebaseToken({ aud: 'wrong-project' });
response = await call({ messages }, { origin: 'https://app.example', env: { ALLOWED_ORIGINS: 'https://app.example', FIREBASE_PROJECT_ID: 'novaos-test' }, token: badToken, ip: '2.3.3.3' });
assert.equal(response.status, 401);
console.log('✅ PASS: Firebase tokens for a different project are rejected');

response = await call({ messages, model: 'o1-pro' }, { env: { ALLOWED_MODELS: 'gpt-4o-mini' }, ip: '3.3.3.3' });
assert.equal(response.status, 400);
console.log('✅ PASS: model allow-list blocks unapproved models');

const oversizedBody = JSON.stringify({ messages, payload: 'x'.repeat(8 * 1024 * 1024) });
response = await proxy.fetch(new Request('http://proxy/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:8000' }, body: oversizedBody }), { OPENAI_API_KEY: 'sk-test' });
assert.equal(response.status, 413);
console.log('✅ PASS: streamed request-body reader enforces the 8 MB limit');

response = await call({ messages: [] }, { ip: '4.4.4.4' });
assert.equal(response.status, 400);
response = await call({ messages }, { env: { OPENAI_API_KEY: '' }, ip: '5.5.5.5' });
assert.equal(response.status, 500);
console.log('✅ PASS: malformed payloads and missing upstream secrets are handled');

response = await call({ messages }, { env: { UPSTREAM_LLM_URL: 'http://169.254.169.254/latest/meta-data' }, ip: '6.6.6.6' });
assert.equal(response.status, 500);
console.log('✅ PASS: non-HTTPS upstream URLs are rejected (SSRF hardening)');

let lastResponse;
for (let i = 0; i < 5; i++) lastResponse = await call({ messages }, { env: { RATE_LIMIT_PER_MIN: '3' }, ip: '9.9.9.9' });
assert.equal(lastResponse.status, 429);
console.log('✅ PASS: per-IP fallback rate limit returns 429');
console.log(`ℹ️ Firebase signing keys fetched ${jwksCalls} time(s), then cached.`);
