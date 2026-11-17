// Framework-free API core: the SQL, validation and reply streaming that both transports use.
// src/routes/* (Express, local + Docker) and src/function (Hono, Neon Functions) are thin
// adapters over this, so behaviour cannot drift between the two hosts.
//
// Functions throw ApiError for anything the client should see as a JSON error response;
// the adapters map that onto their own response type.

const bcrypt = require('bcryptjs');
const db = require('./db');
const engine = require('./engine/nexyl');
const llm = require('./engine/llm');
const { sign } = require('./auth');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MESSAGE = 4000;

class ApiError extends Error {
  constructor(status, message, headers) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

function mustUuid(id) {
  if (!UUID_RE.test(String(id))) throw new ApiError(400, 'Invalid id');
}

function str(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

async function ownConversation(id, userId) {
  const { rows } = await db.query('SELECT id, title FROM conversations WHERE id = $1 AND user_id = $2', [id, userId]);
  return rows[0] || null;
}

/* ---------- Health ---------- */
async function health() {
  try {
    await db.query('SELECT 1');
    return { body: { status: 'ok', engine: engine.ENGINE_VERSION, llm: llm.enabled(), llm_provider: llm.providerName(), db: 'up' } };
  } catch {
    return { status: 503, body: { status: 'degraded', db: 'down' } };
  }
}

/* ---------- Auth ---------- */
async function register({ name, email, password }) {
  name = str(name, 60);
  email = str(email, 320).toLowerCase();
  if (name.length < 2) throw new ApiError(400, 'Name must be 2–60 characters.');
  if (!EMAIL_RE.test(email)) throw new ApiError(400, 'Enter a valid email address.');
  if (String(password ?? '').length < 8) throw new ApiError(400, 'Password must be at least 8 characters.');

  const hash = await bcrypt.hash(String(password), 10);
  const { rows } = await db.query(
    `INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO NOTHING
     RETURNING id, name, email`,
    [name, email, hash]
  );
  if (!rows.length) throw new ApiError(409, 'An account with that email already exists.');
  return { status: 201, body: { token: sign(rows[0]), user: rows[0] } };
}

async function login({ email, password }) {
  email = str(email, 320).toLowerCase();
  const { rows } = await db.query('SELECT id, name, email, password_hash FROM users WHERE email = $1', [email]);
  const user = rows[0];
  const ok = user && (await bcrypt.compare(String(password ?? ''), user.password_hash));
  if (!ok) throw new ApiError(401, 'Incorrect email or password.');
  delete user.password_hash;
  return { body: { token: sign(user), user } };
}

async function me(userId) {
  const { rows } = await db.query('SELECT id, name, email FROM users WHERE id = $1', [userId]);
  if (!rows.length) throw new ApiError(401, 'Account no longer exists.');
  return { body: { user: rows[0] } };
}

/* ---------- Conversations ---------- */
async function listConversations(userId) {
  const { rows } = await db.query(
    `SELECT c.id, c.title, c.updated_at,
            (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id)::int AS message_count
       FROM conversations c WHERE c.user_id = $1
      ORDER BY c.updated_at DESC LIMIT 100`,
    [userId]
  );
  return { body: { conversations: rows } };
}

async function createConversation(userId) {
  const { rows } = await db.query(
    'INSERT INTO conversations (user_id) VALUES ($1) RETURNING id, title, updated_at',
    [userId]
  );
  return { status: 201, body: { conversation: { ...rows[0], message_count: 0 } } };
}

async function renameConversation(id, userId, title) {
  mustUuid(id);
  title = str(title, 80);
  if (!title) throw new ApiError(400, 'Title is required.');
  const { rows } = await db.query(
    'UPDATE conversations SET title = $1 WHERE id = $2 AND user_id = $3 RETURNING id, title',
    [title, id, userId]
  );
  if (!rows.length) throw new ApiError(404, 'Conversation not found.');
  return { body: { conversation: rows[0] } };
}

async function deleteConversation(id, userId) {
  mustUuid(id);
  const { rowCount } = await db.query('DELETE FROM conversations WHERE id = $1 AND user_id = $2', [id, userId]);
  if (!rowCount) throw new ApiError(404, 'Conversation not found.');
  return { status: 204 };
}

/* ---------- Messages ---------- */
async function listMessages(id, userId) {
  mustUuid(id);
  if (!(await ownConversation(id, userId))) throw new ApiError(404, 'Conversation not found.');
  const { rows } = await db.query(
    `SELECT m.id, m.role, m.content, m.meta, m.created_at, f.rating
       FROM messages m
       LEFT JOIN feedback f ON f.message_id = m.id AND f.user_id = $2
      WHERE m.conversation_id = $1 ORDER BY m.id`,
    [id, userId]
  );
  return { body: { messages: rows } };
}

// Validates ownership before the first SSE byte, so failures still come back as plain JSON.
async function prepareMessage({ id, userId, content }) {
  mustUuid(id);
  content = String(content ?? '').trim();
  if (!content) throw new ApiError(400, 'Message cannot be empty.');
  if (content.length > MAX_MESSAGE) throw new ApiError(400, `Message is too long (max ${MAX_MESSAGE} characters).`);
  const convo = await ownConversation(id, userId);
  if (!convo) throw new ApiError(404, 'Conversation not found.');
  return { convo, content };
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

// Streams {event, data} pairs for one turn: `user`, `token`…, `done`, or `error`.
async function* messageEvents({ convo, content, userId, userName, timezone }) {
  try {
    const {
      rows: [userMsg],
    } = await db.query(
      `INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', $2)
       RETURNING id, role, content, meta, created_at`,
      [convo.id, content]
    );
    yield { event: 'user', data: userMsg };

    const { rows: history } = await db.query('SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY id', [convo.id]);

    const result = await engine.respond({ userId, userName, timezone, history, message: content });

    // Stream the reply in small word-groups so the UI feels live.
    const parts = result.text.match(/\S+\s*/g) || [result.text];
    for (let i = 0; i < parts.length; i += 2) {
      yield { event: 'token', data: { text: parts.slice(i, i + 2).join('') } };
      await new Promise((r) => setTimeout(r, 18));
    }

    const {
      rows: [botMsg],
    } = await db.query(
      `INSERT INTO messages (conversation_id, role, content, meta) VALUES ($1, 'assistant', $2, $3)
       RETURNING id, role, content, meta, created_at`,
      [convo.id, result.text, result.meta]
    );

    const isFirst = history.length === 1;
    const title = isFirst ? engine.titleFrom(content) : convo.title;
    await db.query('UPDATE conversations SET updated_at = now(), title = $2 WHERE id = $1', [convo.id, title]);

    yield { event: 'done', data: { message: botMsg, conversation: { id: convo.id, title } } };
  } catch (err) {
    console.error('[chat] error:', err);
    yield { event: 'error', data: { error: 'Something went wrong while generating a reply.' } };
  }
}

/* ---------- Feedback ---------- */
async function saveFeedback(messageId, userId, rating) {
  messageId = Number(messageId);
  rating = Number(rating);
  if (!Number.isInteger(messageId) || ![-1, 0, 1].includes(rating)) throw new ApiError(400, 'Invalid feedback.');

  const { rows } = await db.query(
    `SELECT m.id FROM messages m JOIN conversations c ON c.id = m.conversation_id
      WHERE m.id = $1 AND c.user_id = $2 AND m.role = 'assistant'`,
    [messageId, userId]
  );
  if (!rows.length) throw new ApiError(404, 'Message not found.');

  if (rating === 0) {
    await db.query('DELETE FROM feedback WHERE message_id = $1 AND user_id = $2', [messageId, userId]);
  } else {
    await db.query(
      `INSERT INTO feedback (message_id, user_id, rating) VALUES ($1, $2, $3)
       ON CONFLICT (message_id, user_id) DO UPDATE SET rating = EXCLUDED.rating`,
      [messageId, userId, rating]
    );
  }
  return { body: { ok: true, rating } };
}

/* ---------- Memories ---------- */
async function listMemories(userId) {
  const { rows } = await db.query('SELECT id, fact, created_at FROM memories WHERE user_id = $1 ORDER BY id DESC LIMIT 100', [userId]);
  return { body: { memories: rows } };
}

async function deleteMemory(id, userId) {
  id = Number(id);
  if (!Number.isInteger(id)) throw new ApiError(400, 'Invalid id');
  const { rowCount } = await db.query('DELETE FROM memories WHERE id = $1 AND user_id = $2', [id, userId]);
  if (!rowCount) throw new ApiError(404, 'Memory not found.');
  return { status: 204 };
}

module.exports = {
  ApiError,
  SSE_HEADERS,
  MAX_MESSAGE,
  health,
  register,
  login,
  me,
  listConversations,
  createConversation,
  renameConversation,
  deleteConversation,
  listMessages,
  prepareMessage,
  messageEvents,
  saveFeedback,
  listMemories,
  deleteMemory,
};
