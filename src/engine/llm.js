// Optional LLM provider via the Google Gemini API. If GEMINI_API_KEY is set, Nexyl uses it for
// open-ended questions that none of the local skills could answer. Otherwise this is a no-op.

const SYSTEM_PROMPT =
  'You are Nexyl AI, a friendly, concise assistant inside a web chat app built with JavaScript and PostgreSQL. ' +
  'Answer clearly in a few short paragraphs. Use Markdown sparingly. If you are unsure, say so.';

const API_HOST = process.env.LLM_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';

function enabled() {
  return Boolean(process.env.GEMINI_API_KEY);
}

async function complete({ history, memories = [] }) {
  // Pinned 2.5 slugs return 404 for keys issued after their retirement; the -latest alias survives that.
  const model = process.env.NEXYL_LLM_MODEL || 'gemini-flash-lite-latest';
  const system =
    SYSTEM_PROMPT +
    (memories.length ? '\n\nThings the user asked you to remember:\n' + memories.map((m) => `- ${m}`).join('\n') : '');

  const res = await fetch(`${API_HOST}/models/${model}:generateContent`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': process.env.GEMINI_API_KEY,
    },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: history.slice(-12).map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      generationConfig: { maxOutputTokens: 700 },
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`LLM request failed (${res.status}) ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  const parts = ((data.candidates || [])[0] || {}).content?.parts || [];
  const text = parts.filter((p) => p.text).map((p) => p.text).join('');
  if (!text) throw new Error('LLM returned no text (blocked or truncated)');
  return { text, model };
}

module.exports = { enabled, complete };
