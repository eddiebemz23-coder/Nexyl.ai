// Optional LLM fallback for questions no local skill answered. Four providers speak three
// dialects of the same chat API; each owns its request/response handling and the engine tries
// them in preference order until one answers, so a key with no credits cannot break chat.

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

// OpenAI's Chat Completions dialect, which Groq also speaks.
async function chatCompletions({ host, key, model, history, memories }) {
  const res = await fetch(`${host}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      messages: [{ role: 'system', content: context(memories) }, ...messages(history)],
    }),
  });
  if (!res.ok) return failure(res);
  const data = await res.json();
  return { text: ((data.choices || [])[0] || {}).message?.content || '', model };
}

const openaiDialect = (name, keyEnv, modelEnv, defaultModel, hostEnv, defaultHost) => ({
  name,
  key: () => process.env[keyEnv],
  model: () => process.env[modelEnv] || defaultModel,
  complete({ history, memories }) {
    return chatCompletions({
      host: process.env[hostEnv] || defaultHost,
      key: this.key(),
      model: this.model(),
      history,
      memories,
    });
  },
});

// Groq's catalogue rotates: the classic llama slugs 404 for newer keys, so the default is a
// model this key was observed serving. OpenAI and Anthropic keys here have no credit balance.
const groq = openaiDialect('groq', 'GROQ_API_KEY', 'NEXYL_GROQ_MODEL', 'qwen/qwen3.8-27b', 'GROQ_BASE_URL', 'https://api.groq.com/openai/v1');
const openai = openaiDialect('openai', 'OPENAI_API_KEY', 'NEXYL_OPENAI_MODEL', 'gpt-4.1-mini', 'OPENAI_BASE_URL', 'https://api.openai.com/v1');

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

const anthropic = {
  name: 'anthropic',
  key: () => process.env.ANTHROPIC_API_KEY,
  model: () => process.env.NEXYL_ANTHROPIC_MODEL || 'claude-sonnet-4-6',
  async complete({ history, memories }) {
    const model = this.model();
    const host = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1';
    const res = await fetch(`${host}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': this.key(), 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: MAX_OUTPUT_TOKENS, system: context(memories), messages: messages(history) }),
    });
    if (!res.ok) return failure(res);
    const data = await res.json();
    return { text: (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(''), model };
  },
};

// Preference order: the providers observed answering first, credit-less keys last so they are
// only reached when everything above them fails.
const providers = [groq, gemini, openai, anthropic];

const configuredProviders = () => providers.filter((p) => p.key());

// NEXYL_LLM_PROVIDER pins one provider by name; otherwise the first configured one leads.
function active() {
  const wanted = (process.env.NEXYL_LLM_PROVIDER || '').trim().toLowerCase();
  const pool = configuredProviders();
  if (!wanted) return pool[0] || null;
  return pool.find((p) => p.name === wanted) || null;
}

function enabled() {
  return active() !== null;
}

// Which providers hold a key. Names only, so a deploy can prove a secret landed without
// any endpoint that could echo a value back.
function configured() {
  return configuredProviders().map((p) => p.name);
}

async function complete({ history, memories = [] }) {
  const wanted = (process.env.NEXYL_LLM_PROVIDER || '').trim().toLowerCase();
  const chain = wanted ? configuredProviders().filter((p) => p.name === wanted) : configuredProviders();
  if (!chain.length) throw new Error('No LLM provider is configured');

  let lastError;
  for (const provider of chain) {
    try {
      const { text, model } = await provider.complete({ history, memories });
      if (!text) throw new Error('LLM returned no text (blocked or truncated)');
      return { text, model, provider: provider.name };
    } catch (err) {
      lastError = err;
      console.error(`[llm] ${provider.name} failed:`, err.message);
    }
  }
  throw lastError;
}

module.exports = { enabled, complete, configured, providerName: () => active()?.name || null };
