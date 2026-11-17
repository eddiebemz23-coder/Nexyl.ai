// Prepares .env.neon — the gitignored file `neon deploy --env` uploads as Function env.
//
// Neon writes the branch's own connection strings into this file, so this keeps those lines
// and tops it up with the secrets the Function needs: it copies the LLM settings out of .env
// and mints a strong JWT_SECRET once (it is never rotated by a later run, or every session
// would be invalidated). Nothing here prints a value.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const root = fileURLToPath(new URL('..', import.meta.url));
const neonFile = `${root}.env.neon`;

if (!existsSync(neonFile)) {
  console.error('[neon-env] .env.neon is missing. Run `neon link` first, it writes the connection strings.');
  process.exit(1);
}

const local = existsSync(`${root}.env`) ? dotenv.parse(readFileSync(`${root}.env`)) : {};

// Whatever the local app uses to reach a model travels with the deploy, otherwise the two
// environments would answer open-ended questions through different providers.
const wanted = { PG_POOL_MAX: '3' };
for (const key of [
  'GEMINI_API_KEY', 'NEXYL_LLM_MODEL',
  'OPENAI_API_KEY', 'NEXYL_OPENAI_MODEL',
  'GROQ_API_KEY', 'NEXYL_GROQ_MODEL',
  'ANTHROPIC_API_KEY', 'NEXYL_ANTHROPIC_MODEL',
  'NEXYL_LLM_PROVIDER',
]) {
  if (local[key]) wanted[key] = local[key];
}
wanted.NEXYL_LLM_MODEL ||= 'gemini-flash-lite-latest';

if (!wanted.GEMINI_API_KEY && !wanted.OPENAI_API_KEY && !wanted.GROQ_API_KEY && !wanted.ANTHROPIC_API_KEY) {
  console.warn('[neon-env] no LLM key in .env — the deployed app will answer with local skills only.');
}

const lines = readFileSync(neonFile, 'utf8').split(/\r?\n/);
const existing = new Map();
for (const line of lines) {
  const i = line.indexOf('=');
  if (i > 0 && !line.trimStart().startsWith('#')) existing.set(line.slice(0, i).trim(), line.slice(i + 1));
}

// Reusing the deployed secret keeps signed sessions valid across deploys.
if (!existing.get('JWT_SECRET')) wanted.JWT_SECRET = randomBytes(32).toString('hex');
else console.log('[neon-env] keeping the JWT_SECRET already present in .env.neon');

for (const [key, value] of Object.entries(wanted)) existing.set(key, value);

const keptOrder = lines.filter((l) => l.includes('=') && !l.trimStart().startsWith('#')).map((l) => l.slice(0, l.indexOf('=')).trim());
const ordered = [...new Set([...keptOrder, ...existing.keys()])].filter((k) => existing.has(k));
writeFileSync(neonFile, ordered.map((k) => `${k}=${existing.get(k)}`).join('\n') + '\n');

console.log(`[neon-env] wrote ${ordered.length} keys to .env.neon:`);
for (const k of ordered) console.log(`  ${k} (${String(existing.get(k)).length} chars)`);
