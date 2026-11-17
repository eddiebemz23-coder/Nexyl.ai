// Installs a secret into the two git-ignored env files without ever printing it.
//
//   node scripts/set-env-key.mjs OPENAI_API_KEY ./openai.key
//
// The value is read from a file rather than a command-line argument, because argv ends up in
// shell history and process listings. The source file is deleted afterwards. Tracked files are
// refused outright: .env and .env.neon are gitignored, and anything else would risk a commit.
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [key, valueFile] = process.argv.slice(2);
if (!/^[A-Z][A-Z0-9_]{2,}$/.test(key || '')) {
  console.error('usage: node scripts/set-env-key.mjs <KEY_NAME> <file-with-value>');
  process.exit(1);
}
if (!valueFile || !existsSync(valueFile)) {
  console.error(`[set-env-key] value file not found: ${valueFile}`);
  process.exit(1);
}

const value = readFileSync(valueFile, 'utf8').trim();
if (!value || /\s/.test(value)) {
  console.error('[set-env-key] value file must hold exactly one non-empty line, no surrounding whitespace');
  process.exit(1);
}

const root = fileURLToPath(new URL('..', import.meta.url));
for (const target of ['.env', '.env.neon']) {
  const path = `${root}${target}`;
  if (!existsSync(path)) {
    console.warn(`[set-env-key] skipped ${target} (missing)`);
    continue;
  }
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const i = lines.findIndex((l) => l.trimStart().startsWith(`${key}=`));
  if (i >= 0) lines[i] = `${key}=${value}`;
  else lines.splice(lines.filter((l) => l.trim()).length, 0, `${key}=${value}`);
  writeFileSync(path, lines.join('\n'));
  console.log(`[set-env-key] ${target}: ${key} set (${value.length} chars)`);
}

rmSync(valueFile);
console.log(`[set-env-key] removed ${valueFile}`);
