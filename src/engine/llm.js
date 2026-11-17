// Optional LLM provider via OpenRouter. If OPENROUTER_API_KEY is set, Nexl uses it for
// open-ended questions that none of the local skills could answer. Otherwise this is a no-op.

const SYSTEM_PROMPT =
  'You are Nexl AI, a friendly, concise assistant inside a web chat app built with JavaScript and PostgreSQL. ' +
  'Answer clearly in a few short paragraphs. Use Markdown sparingly. If you are unsure, say so.';

const BASE_URL = process.env.LLM_BASE_URL || 'https://openrouter.ai/api/v1';

function enabled() {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

async function complete({ history, memories = [] }) {
  const model = process.env.NEXL_LLM_MODEL || 'anthropic/claude-sonnet-5.5';
  const system =
    SYSTEM_PROMPT +
    (memories.length ? '\n\nThings the user asked you to remember:\n' + memories.map((m) => `- ${m}`).join('\n') : '');

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      'x-title': 'Nexl AI',
    },
    body: JSON.stringify({
      model,
      max_tokens: 700,
      messages: [
        { role: 'system', content: system },
        ...history.slice(-12).map((m) => ({ role: m.role, content: m.content })),
      ],
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`LLM request failed (${res.status}) ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  const text = (data.choices || []).map((c) => (c.message && c.message.content) || '').join('');
  return { text, model };
}

module.exports = { enabled, complete };
