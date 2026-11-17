// Nexyl.ai on Neon Functions.
//
// Neon Functions are invoked through a web-standard fetch handler instead of a listening
// socket, so Express cannot be the entrypoint here. This is a Hono app over the same
// src/services.js core that src/routes/* uses, which keeps one set of SQL, validation and
// SSE semantics for both hosts. Build with `npm run function:build`, deploy with `neon deploy`.
import { Hono } from 'hono';
import services from '../services.js';
import auth from '../auth.js';
import { assets } from './assets.generated.mjs';

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; script-src 'self'; connect-src 'self'",
};

const MAX_BODY = 64 * 1024;
const ASSET_BY_PATH = new Map(assets.map((a) => [a.path, a]));
// Connection is a forbidden response header in the fetch runtime.
const { Connection: _dropped, ...SSE_HEADERS } = services.SSE_HEADERS;

const authLimiter = auth.limiter({ windowMs: 60_000, max: 20 });
const sendLimiter = auth.limiter({ windowMs: 60_000, max: 40 });

const app = new Hono();

app.use('*', async (c, next) => {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.header(name, value);
  await next();
});

function caller(c) {
  return c.req.header('x-forwarded-for')?.split(',')[0].trim() || c.req.header('x-real-ip') || 'anonymous';
}

// Responses built by hand (the event stream and the inlined frontend) skip Hono's context, so
// they need the security headers merged in here rather than by the middleware above.
const secureHeaders = (extra) => ({ ...SECURITY_HEADERS, ...extra });

function limited(c, gate, path) {
  const verdict = gate(`${caller(c)}:${path}`);
  if (verdict.allowed) return null;
  c.header('Retry-After', verdict.retryAfterSec);
  return c.json({ error: 'Too many attempts. Try again shortly.' }, 429);
}

async function readBody(c) {
  const raw = await c.req.text();
  if (!raw.trim()) return {};
  if (raw.length > MAX_BODY) throw new services.ApiError(413, 'Request body is too large.');
  try {
    return JSON.parse(raw);
  } catch {
    throw new services.ApiError(400, 'Invalid JSON body.');
  }
}

function failure(c, err) {
  if (err instanceof services.ApiError) return c.json({ error: err.message }, err.status);
  console.error('[function] unhandled:', err);
  return c.json({ error: 'Internal server error.' }, 500);
}

const reply = (c, promise) =>
  promise.then((r) => (r.body === undefined ? c.body(null, r.status ?? 204) : c.json(r.body, r.status ?? 200))).catch((err) => failure(c, err));

const signedIn = async (c, next) => {
  const user = auth.verifyHeader(c.req.header('authorization'));
  if (!user) return c.json({ error: 'Not signed in' }, 401);
  c.set('user', user);
  await next();
};

/* ---------- Health ---------- */
app.get('/api/health', (c) => reply(c, services.health()));

/* ---------- Auth ---------- */
app.post('/api/auth/register', (c) => {
  const gate = limited(c, authLimiter, '/api/auth/register');
  if (gate) return gate;
  return reply(c, readBody(c).then((body) => services.register(body)));
});

app.post('/api/auth/login', (c) => {
  const gate = limited(c, authLimiter, '/api/auth/login');
  if (gate) return gate;
  return reply(c, readBody(c).then((body) => services.login(body)));
});

app.get('/api/auth/me', signedIn, (c) => reply(c, services.me(c.get('user').id)));

/* ---------- Conversations, messages, feedback, memories ---------- */
app.use('/api/conversations*', signedIn);
app.use('/api/messages*', signedIn);
app.use('/api/memories*', signedIn);

app.get('/api/conversations', (c) => reply(c, services.listConversations(c.get('user').id)));
app.post('/api/conversations', (c) => reply(c, services.createConversation(c.get('user').id)));
app.patch('/api/conversations/:id', (c) =>
  readBody(c).then((body) => reply(c, services.renameConversation(c.req.param('id'), c.get('user').id, body.title)))
);
app.delete('/api/conversations/:id', (c) => reply(c, services.deleteConversation(c.req.param('id'), c.get('user').id)));
app.get('/api/conversations/:id/messages', (c) => reply(c, services.listMessages(c.req.param('id'), c.get('user').id)));

app.post('/api/messages/:id/feedback', (c) =>
  readBody(c).then((body) => reply(c, services.saveFeedback(c.req.param('id'), c.get('user').id, body.rating)))
);

app.get('/api/memories', (c) => reply(c, services.listMemories(c.get('user').id)));
app.delete('/api/memories/:id', (c) => reply(c, services.deleteMemory(c.req.param('id'), c.get('user').id)));

// Streams the turn as Server-Sent Events: `user`, `token`…, then `done` or `error`.
app.post('/api/conversations/:id/messages', async (c) => {
  const gate = limited(c, sendLimiter, `/api/conversations/${c.req.param('id')}/messages`);
  if (gate) return gate;

  const user = c.get('user');
  let prep;
  let body = {};
  try {
    body = await readBody(c);
    prep = await services.prepareMessage({ id: c.req.param('id'), userId: user.id, content: body.content });
  } catch (err) {
    return failure(c, err);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const events = services.messageEvents({
          ...prep,
          userId: user.id,
          userName: user.name,
          timezone: String(body.timezone || 'UTC').slice(0, 64),
        });
        for await (const event of events) {
          controller.enqueue(encoder.encode(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`));
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, { headers: secureHeaders(SSE_HEADERS) });
});

/* ---------- Frontend ---------- */
app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

app.get('*', (c) => {
  const path = c.req.path === '/' ? '/index.html' : decodeURIComponent(c.req.path);
  const asset = ASSET_BY_PATH.get(path);
  if (!asset) return c.notFound();

  const bytes = Uint8Array.from(atob(asset.b64), (ch) => ch.charCodeAt(0));
  const cache = path === '/index.html' ? 'no-cache' : 'public, max-age=300';
  return new Response(bytes, { headers: secureHeaders({ 'content-type': asset.type, 'cache-control': cache }) });
});

export default app;
