// The Nexl engine: routes each message through an ordered pipeline of skills.
//
//   message ─▶ forget ─▶ remember ─▶ recall ─▶ summarize ─▶ math ─▶ time
//           ─▶ small talk ─▶ knowledge base (Postgres FTS) ─▶ LLM (optional) ─▶ fallback
//
// The first skill that produces an answer wins. Everything it decides is returned in `meta`.

const db = require('../db');
const skills = require('./skills');
const llm = require('./llm');

const ENGINE_VERSION = 'nexl-1.0';

const FALLBACK =
  "I don't have a good answer for that yet. I'm strongest at: knowledge questions (try \"what is PostgreSQL\"), " +
  'maths ("calculate 15% of 240" → "0.15 * 240"), remembering things, and summarising text. ' +
  'Add an `ANTHROPIC_API_KEY` to the server\'s `.env` to unlock open-ended chat.';

async function respond({ userId, userName, timezone, history, message }) {
  const started = Date.now();
  const ctx = { userId, userName, timezone };

  const pipeline = [
    () => skills.doForget(message, ctx),
    () => skills.doRemember(message, ctx),
    () => skills.doRecall(message, ctx),
    () => skills.doSummarize(message),
    () => skills.doMath(message),
    () => skills.doTime(message, ctx),
    () => skills.doSmallTalk(message, ctx),
    () => skills.doKnowledge(message),
  ];

  let result = null;
  for (const step of pipeline) {
    result = await step();
    if (result) break;
  }

  if (!result && llm.enabled()) {
    try {
      const { rows } = await db.query(
        'SELECT fact FROM memories WHERE user_id = $1 ORDER BY id DESC LIMIT 20', [userId]);
      const out = await llm.complete({ history, memories: rows.map((r) => r.fact) });
      result = { text: out.text, meta: { intent: 'llm', model: out.model } };
    } catch (err) {
      console.error('[engine] LLM error:', err.message);
      result = { text: FALLBACK, meta: { intent: 'fallback', llm_error: true } };
    }
  }

  if (!result) result = { text: FALLBACK, meta: { intent: 'fallback' } };

  result.meta = { ...result.meta, engine: ENGINE_VERSION, latency_ms: Date.now() - started };
  return result;
}

// Suggest a conversation title from the first user message.
function titleFrom(message) {
  const clean = message.replace(/\s+/g, ' ').trim();
  return clean.length > 48 ? clean.slice(0, 45).trimEnd() + '…' : clean || 'New chat';
}

module.exports = { respond, titleFrom, ENGINE_VERSION };
