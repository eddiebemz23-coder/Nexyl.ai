// Optional LLM fallback for questions no local skill answered. Two providers speak different
// dialects of the same chat API, so each owns its own request/response handling.

const SYSTEM_PROMPT =
  'You are Nexyl AI, a friendly, concise assistant inside a web chat app built with JavaScript and PostgreSQL. ' +
  'Answer clearly in a few short paragraphs. Use Markdown sparingly. If you are unsure, say so.';

const MAX_TURNS = 12;
const MAX_OUTPUT_TOKENS = 700;

const context = (memories) =>
  SYSTEM_PROMPT +
  (memories.length ? '\n\nThings the user asked you to remember:\n' + memories.map((m) => `- ${m}`).join('\n') : '');

const messages = (history) => history.slice(-MAX_TURNS).map((m) => ({ role: m.role, content: m.content }));

async function failure(res) {
  const detail = (await res.text().catch(() => '')).slice(0, 200);
  throw new Error(`LLM request failed (${res.status}) ${detail}`);
}

const gemini = {
  name: 'gemini',
  key: () => process.env.GEMINI_API_KEY,
  // Pinned 2.5 slugs return 404 for keys issued after their retirement; the -latest alias survives that.
  model: () => process.env.NEXYL_LLM_MODEL || 'gemini-flash-lite-latest',
  async complete({ history, memories }) {
    const model = this.model();
    const host = process.env.LLM_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';
    const res = await fetch(`${host}/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.key() },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: context(memories) }] },
        contents: messages(history).map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        })),
        generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
      }),
    });
    if (!res.ok) return failure(res);
    const data = await res.json();
    const parts = ((data.candidates || [])[0] || {}).content?.parts || [];
    return { text: parts.filter((p) => p.text).map((p) => p.text).join(''), model };
  },
};

const openai = {
  name: 'openai',
  key: () => process.env.OPENAI_API_KEY,
  model: () => process.env.NEXYL_OPENAI_MODEL || 'gpt-4.1-mini',
  async complete({ history, memories }) {
    const model = this.model();
    const host = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
    const res = await fetch(`${host}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.key()}` },
      body: JSON.stringify({
        model,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [{ role: 'system', content: context(memories) }, ...messages(history)],
      }),
    });
    if (!res.ok) return failure(res);
    const data = await res.json();
    return { text: ((data.choices || [])[0] || {}).message?.content || '', model };
  },
};

const providers = [gemini, openai];

// NEXYL_LLM_PROVIDER picks one by name; otherwise the first configured provider wins.
function active() {
  const wanted = (process.env.NEXYL_LLM_PROVIDER || '').trim().toLowerCase();
  const pool = providers.filter((p) => p.key());
  if (!wanted) return pool[0] || null;
  return pool.find((p) => p.name === wanted) || null;
}

function enabled() {
  return active() !== null;
}

// Which providers hold a key. Names only, so a deploy can prove a secret landed without
// any endpoint that could echo a value back.
function configured() {
  return providers.filter((p) => p.key()).map((p) => p.name);
}

async function complete({ history, memories = [] }) {
  const provider = active();
  if (!provider) throw new Error('No LLM provider is configured');
  const { text, model } = await provider.complete({ history, memories });
  if (!text) throw new Error('LLM returned no text (blocked or truncated)');
  return { text, model, provider: provider.name };
}

module.exports = { enabled, complete, configured, providerName: () => active()?.name || null };
