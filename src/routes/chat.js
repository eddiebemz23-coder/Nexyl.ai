const express = require('express');
const db = require('../db');
const { requireAuth, rateLimit } = require('../auth');
const engine = require('../engine/nexl');

const router = express.Router();
router.use(requireAuth);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MESSAGE = 4000;
const sendLimiter = rateLimit({ windowMs: 60_000, max: 40 });

function validId(req, res, next) {
  if (!UUID_RE.test(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
  next();
}

async function ownConversation(id, userId) {
  const { rows } = await db.query('SELECT id, title FROM conversations WHERE id = $1 AND user_id = $2', [id, userId]);
  return rows[0] || null;
}

/* ---------- Conversations ---------- */
router.get('/conversations', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      `SELECT c.id, c.title, c.updated_at,
              (SELECT count(*) FROM messages m WHERE m.conversation_id = c.id)::int AS message_count
         FROM conversations c WHERE c.user_id = $1
        ORDER BY c.updated_at DESC LIMIT 100`, [req.user.id]);
    res.json({ conversations: rows });
  } catch (err) { next(err); }
});

router.post('/conversations', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'INSERT INTO conversations (user_id) VALUES ($1) RETURNING id, title, updated_at', [req.user.id]);
    res.status(201).json({ conversation: { ...rows[0], message_count: 0 } });
  } catch (err) { next(err); }
});

router.patch('/conversations/:id', validId, async (req, res, next) => {
  try {
    const title = String(req.body.title || '').trim().slice(0, 80);
    if (!title) return res.status(400).json({ error: 'Title is required.' });
    const { rows } = await db.query(
      'UPDATE conversations SET title = $1 WHERE id = $2 AND user_id = $3 RETURNING id, title',
      [title, req.params.id, req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Conversation not found.' });
    res.json({ conversation: rows[0] });
  } catch (err) { next(err); }
});

router.delete('/conversations/:id', validId, async (req, res, next) => {
  try {
    const { rowCount } = await db.query('DELETE FROM conversations WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    if (!rowCount) return res.status(404).json({ error: 'Conversation not found.' });
    res.status(204).end();
  } catch (err) { next(err); }
});

/* ---------- Messages ---------- */
router.get('/conversations/:id/messages', validId, async (req, res, next) => {
  try {
    if (!(await ownConversation(req.params.id, req.user.id))) return res.status(404).json({ error: 'Conversation not found.' });
    const { rows } = await db.query(
      `SELECT m.id, m.role, m.content, m.meta, m.created_at, f.rating
         FROM messages m
         LEFT JOIN feedback f ON f.message_id = m.id AND f.user_id = $2
        WHERE m.conversation_id = $1 ORDER BY m.id`, [req.params.id, req.user.id]);
    res.json({ messages: rows });
  } catch (err) { next(err); }
});

// Sends a user message and streams the assistant reply as Server-Sent Events.
// Events: `user` (saved user message), `token` (text chunk), `done` (final message), `error`.
router.post('/conversations/:id/messages', validId, sendLimiter, async (req, res, next) => {
  const content = String(req.body.content || '').trim();
  if (!content) return res.status(400).json({ error: 'Message cannot be empty.' });
  if (content.length > MAX_MESSAGE) return res.status(400).json({ error: `Message is too long (max ${MAX_MESSAGE} characters).` });

  let convo;
  try {
    convo = await ownConversation(req.params.id, req.user.id);
  } catch (err) { return next(err); }
  if (!convo) return res.status(404).json({ error: 'Conversation not found.' });

  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    const { rows: [userMsg] } = await db.query(
      `INSERT INTO messages (conversation_id, role, content) VALUES ($1, 'user', $2)
       RETURNING id, role, content, meta, created_at`, [convo.id, content]);
    send('user', userMsg);

    const { rows: history } = await db.query(
      'SELECT role, content FROM messages WHERE conversation_id = $1 ORDER BY id', [convo.id]);

    const result = await engine.respond({
      userId: req.user.id,
      userName: req.user.name,
      timezone: String(req.body.timezone || 'UTC').slice(0, 64),
      history,
      message: content,
    });

    // Stream the reply in small word-groups so the UI feels live.
    const parts = result.text.match(/\S+\s*/g) || [result.text];
    for (let i = 0; i < parts.length; i += 2) {
      send('token', { text: parts.slice(i, i + 2).join('') });
      await new Promise((r) => setTimeout(r, 18));
    }

    const { rows: [botMsg] } = await db.query(
      `INSERT INTO messages (conversation_id, role, content, meta) VALUES ($1, 'assistant', $2, $3)
       RETURNING id, role, content, meta, created_at`, [convo.id, result.text, result.meta]);

    const isFirst = history.length === 1;
    const title = isFirst ? engine.titleFrom(content) : convo.title;
    await db.query('UPDATE conversations SET updated_at = now(), title = $2 WHERE id = $1', [convo.id, title]);

    send('done', { message: botMsg, conversation: { id: convo.id, title } });
  } catch (err) {
    console.error('[chat] error:', err);
    send('error', { error: 'Something went wrong while generating a reply.' });
  } finally {
    res.end();
  }
});

/* ---------- Feedback ---------- */
router.post('/messages/:id/feedback', async (req, res, next) => {
  try {
    const messageId = Number(req.params.id);
    const rating = Number(req.body.rating);
    if (!Number.isInteger(messageId) || ![-1, 0, 1].includes(rating)) return res.status(400).json({ error: 'Invalid feedback.' });

    const { rows } = await db.query(
      `SELECT m.id FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE m.id = $1 AND c.user_id = $2 AND m.role = 'assistant'`, [messageId, req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Message not found.' });

    if (rating === 0) {
      await db.query('DELETE FROM feedback WHERE message_id = $1 AND user_id = $2', [messageId, req.user.id]);
    } else {
      await db.query(
        `INSERT INTO feedback (message_id, user_id, rating) VALUES ($1, $2, $3)
         ON CONFLICT (message_id, user_id) DO UPDATE SET rating = EXCLUDED.rating`,
        [messageId, req.user.id, rating]);
    }
    res.json({ ok: true, rating });
  } catch (err) { next(err); }
});

/* ---------- Memories ---------- */
router.get('/memories', async (req, res, next) => {
  try {
    const { rows } = await db.query(
      'SELECT id, fact, created_at FROM memories WHERE user_id = $1 ORDER BY id DESC LIMIT 100', [req.user.id]);
    res.json({ memories: rows });
  } catch (err) { next(err); }
});

router.delete('/memories/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
    const { rowCount } = await db.query('DELETE FROM memories WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    if (!rowCount) return res.status(404).json({ error: 'Memory not found.' });
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
