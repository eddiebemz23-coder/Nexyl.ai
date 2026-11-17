// Skills: small, deterministic abilities the Nexyl engine can route to.
const db = require('../db');
const math = require('./math');

/* ---------- Math ---------- */
const MATH_CHARS = /^[\d\s+\-*/%^().,a-z]+$/i;
function extractMath(text) {
  let s = text.trim().replace(/[?=]+$/, '').trim();
  const lead = /^(?:please\s+)?(?:calculate|compute|calc|solve|evaluate|what(?:'s| is)|how much is)\s+/i;
  const hadLead = lead.test(s);
  s = s.replace(lead, '').replace(/\bx\b/gi, '*').replace(/×/g, '*').replace(/÷/g, '/').replace(/,/g, '');
  if (!MATH_CHARS.test(s)) return null;
  if (!/\d/.test(s)) return null;
  // Require an operator or function unless the user explicitly asked to calculate.
  if (!hadLead && !/[-+*/%^]|\b(sqrt|abs|round|floor|ceil|sin|cos|tan|ln|log)\s*\(/i.test(s)) return null;
  return s;
}
function doMath(text) {
  const expr = extractMath(text);
  if (!expr) return null;
  try {
    const value = math.evaluate(expr);
    return { text: `${expr.replace(/\s+/g, ' ')} = **${math.format(value)}**`, meta: { intent: 'math', expression: expr } };
  } catch (err) {
    return { text: `I tried to calculate that but hit a problem: ${err.message}.`, meta: { intent: 'math', error: err.message } };
  }
}

/* ---------- Time ---------- */
function doTime(text, ctx) {
  if (!/\b(what('s| is)? (the )?(current )?(time|date|day)|today'?s date|what day is it|current time)\b/i.test(text)) return null;
  const tz = ctx.timezone || 'UTC';
  const now = new Date();
  let formatted;
  try {
    formatted = new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'full', timeStyle: 'short', timeZone: tz,
    }).format(now);
  } catch {
    formatted = now.toUTCString();
  }
  return { text: `It's **${formatted}** (${tz}).`, meta: { intent: 'time', timezone: tz } };
}

/* ---------- Memory ---------- */
async function doRemember(text, ctx) {
  const m = text.match(/^\s*(?:please\s+)?(?:remember|note|save|keep in mind)(?:\s+that)?[:\s]+(.{3,500})$/is);
  if (!m) return null;
  const fact = m[1].trim().replace(/\s+/g, ' ');
  await db.query('INSERT INTO memories (user_id, fact) VALUES ($1, $2)', [ctx.userId, fact]);
  return { text: `Got it. I'll remember that: *${fact}*`, meta: { intent: 'remember' } };
}

async function doRecall(text, ctx) {
  if (!/\b(what do you (remember|know) about me|my memories|what have i told you|list (my )?memories)\b/i.test(text)) return null;
  const { rows } = await db.query(
    'SELECT fact FROM memories WHERE user_id = $1 ORDER BY id DESC LIMIT 20', [ctx.userId]);
  if (!rows.length) {
    return { text: 'I don\'t have any memories saved for you yet. Try: "remember that I prefer dark mode".', meta: { intent: 'recall', count: 0 } };
  }
  return {
    text: 'Here\'s what I remember about you:\n\n' + rows.map((r) => `- ${r.fact}`).join('\n'),
    meta: { intent: 'recall', count: rows.length },
  };
}

async function doForget(text, ctx) {
  if (!/^\s*(forget everything|clear (my )?memories|forget all)\b/i.test(text)) return null;
  const { rowCount } = await db.query('DELETE FROM memories WHERE user_id = $1', [ctx.userId]);
  return { text: `Done. I've forgotten ${rowCount} saved ${rowCount === 1 ? 'memory' : 'memories'}.`, meta: { intent: 'forget', count: rowCount } };
}

/* ---------- Summarize (extractive) ---------- */
const STOP = new Set('a an the and or but if then of to in on for with at by from is are was were be been it this that as not no so we you i they he she his her their our your its has have had do does did can could will would should about into over than also very just'.split(' '));
function doSummarize(text) {
  const m = text.match(/^\s*(?:please\s+)?(?:summari[sz]e|tl;?dr|shorten)[:\s]+([\s\S]{40,})$/i);
  if (!m) return null;
  const body = m[1].trim();
  const sentences = body.match(/[^.!?\n]+[.!?]*/g)?.map((s) => s.trim()).filter((s) => s.length > 15) || [];
  if (sentences.length <= 2) {
    return { text: `That's already short: *${body}*`, meta: { intent: 'summarize' } };
  }
  const freq = {};
  for (const w of body.toLowerCase().match(/[a-z']+/g) || []) if (!STOP.has(w) && w.length > 2) freq[w] = (freq[w] || 0) + 1;
  const scored = sentences.map((s, idx) => {
    const words = s.toLowerCase().match(/[a-z']+/g) || [];
    const score = words.reduce((a, w) => a + (freq[w] || 0), 0) / Math.sqrt(words.length || 1);
    return { s, idx, score };
  });
  const k = Math.max(2, Math.min(4, Math.round(sentences.length / 4)));
  const top = scored.sort((a, b) => b.score - a.score).slice(0, k).sort((a, b) => a.idx - b.idx);
  return {
    text: '**Summary**\n\n' + top.map((t) => `- ${t.s}`).join('\n'),
    meta: { intent: 'summarize', from: sentences.length, to: top.length },
  };
}

/* ---------- Small talk ---------- */
function doSmallTalk(text, ctx) {
  const t = text.trim().toLowerCase();
  const name = ctx.userName ? ctx.userName.split(' ')[0] : 'there';
  if (/^(hi|hello|hey|yo|good (morning|afternoon|evening)|sup)\b/.test(t) && t.length < 40) {
    return { text: `Hey ${name}! I'm **Nexyl**. Ask me a question, give me something to calculate, or tell me something to remember.`, meta: { intent: 'greeting' } };
  }
  if (/\b(who are you|what are you|your name|what can you do)\b/.test(t)) {
    return {
      text: 'I\'m **Nexyl AI**, a full-stack JavaScript assistant running on Express and PostgreSQL. I can answer from my knowledge base, do maths, remember facts about you, summarise text, and (when an LLM key is configured) chat about almost anything.',
      meta: { intent: 'identity' },
    };
  }
  if (/^(thanks|thank you|thx|cheers)\b/.test(t)) {
    return { text: 'Anytime! 🙌', meta: { intent: 'thanks' } };
  }
  if (/^(bye|goodbye|see you|cya)\b/.test(t)) {
    return { text: 'See you soon, ' + name + '!', meta: { intent: 'bye' } };
  }
  return null;
}

/* ---------- Knowledge base (Postgres full-text search) ---------- */
// Measured on the seeded base: genuine questions rank 1.3–4.6, while an unrelated prompt that
// merely shares a common word ("write a four-line poem about rain" → 0.2) ranks far below. Without
// a floor the OR fallback dumps an article for any creative request and the LLM never sees it.
const MIN_KB_RANK = 0.6;

async function searchKB(text) {
  const q = text.replace(/^(what|who|how|why|when|where)('s| is| are| does| do| to)?\s+(a |an |the )?/i, '').replace(/[?!.]+$/, '').trim() || text;
  const { rows } = await db.query(
    `SELECT id, title, body,
            ts_rank_cd(tsv, websearch_to_tsquery('english', $1)) AS rank
       FROM kb_articles
      WHERE tsv @@ websearch_to_tsquery('english', $1)
      ORDER BY rank DESC
      LIMIT 3`, [q]);
  if (!rows.length) {
    // Looser OR-match fallback so natural-language questions still hit.
    const terms = (q.toLowerCase().match(/[a-z0-9+#.]+/g) || []).filter((w) => !STOP.has(w) && w.length > 2);
    if (!terms.length) return null;
    const loose = await db.query(
      `SELECT id, title, body,
              ts_rank_cd(tsv, to_tsquery('english', $1)) AS rank
         FROM kb_articles
        WHERE tsv @@ to_tsquery('english', $1)
        ORDER BY rank DESC LIMIT 3`,
      [terms.map((w) => w.replace(/[^a-z0-9]/g, '')).filter(Boolean).join(' | ')]);
    return strong(loose.rows);
  }
  return strong(rows);
}

function strong(rows) {
  const kept = rows.filter((r) => Number(r.rank) >= MIN_KB_RANK);
  return kept.length ? kept : null;
}

async function doKnowledge(text) {
  const rows = await searchKB(text);
  if (!rows) return null;
  const top = rows[0];
  const extra = rows.slice(1).map((r) => r.title);
  let answer = `**${top.title}**\n\n${top.body}`;
  if (extra.length) answer += `\n\n*Related:* ${extra.join(' · ')}`;
  return {
    text: answer,
    meta: { intent: 'knowledge', sources: rows.map((r) => ({ id: r.id, title: r.title, score: Number(Number(r.rank).toFixed(3)) })) },
  };
}

module.exports = { doMath, doTime, doRemember, doRecall, doForget, doSummarize, doSmallTalk, doKnowledge };
