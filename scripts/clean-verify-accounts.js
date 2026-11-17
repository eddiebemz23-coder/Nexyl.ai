// Removes the throwaway accounts that verification runs leave behind, with their cascaded rows.
//
//   node scripts/clean-verify-accounts.js                              # preview the default account
//   node scripts/clean-verify-accounts.js --like='smoke+%'             # preview every match
//   node scripts/clean-verify-accounts.js --like='smoke+%' --delete    # remove them
//   node --env-file=.env.neon scripts/clean-verify-accounts.js --like='smoke+%' --delete
//
// The smoke test cleans up after itself, but a run that aborts mid-way (a dropped network
// connection to a deployed target) leaves its account in the target's database.
// Prefer the direct endpoint: this script selects an id and then deletes by that id, and a pooled
// proxy could route those statements through different connections with different snapshot state.
// DATABASE_URL_UNPOOLED is only ever present in .env.neon, so local runs are unaffected.
if (process.env.DATABASE_URL_UNPOOLED) process.env.DATABASE_URL = process.env.DATABASE_URL_UNPOOLED;

const db = require('../src/db');

const counts = {
  conversations: 'SELECT count(*)::int AS n FROM conversations WHERE user_id = $1',
  messages:
    'SELECT count(*)::int AS n FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.user_id = $1',
  memories: 'SELECT count(*)::int AS n FROM memories WHERE user_id = $1',
  feedback: 'SELECT count(*)::int AS n FROM feedback WHERE user_id = $1',
};

const like = process.argv.find((a) => a.startsWith('--like='))?.slice(7);
// Every account these scripts create is on example.com, so the domain suffix is a hard rail: a
// mistyped pattern can only match test addresses, never a real user. Accounts registered through
// the app itself use any other domain and are unreachable from here.
const where = like ? "email LIKE $1 AND email LIKE '%@example.com'" : 'email = $1';
const target = like ?? 'deploy.check@example.com';

async function owned(id) {
  const out = {};
  for (const [table, sql] of Object.entries(counts)) out[table] = (await db.query(sql, [id])).rows[0].n;
  return out;
}

async function main() {
  const accounts = (await db.query(`SELECT id, email, name FROM users WHERE ${where}`, [target])).rows;
  if (!accounts.length) {
    console.error(`no verification account matches ${target} — nothing to do`);
    process.exitCode = 1;
    return;
  }
  console.log(`${accounts.length} account(s) match ${target}`);

  for (const account of accounts) {
    console.log(`\n${account.email} · name ${account.name} · ${JSON.stringify(await owned(account.id))}`);
    if (!process.argv.includes('--delete')) {
      console.log('  preview only: rerun with --delete to remove it and its cascaded rows');
      continue;
    }
    await db.query('DELETE FROM users WHERE id = $1', [account.id]);
    console.log('  deleted (conversations, messages, memories and feedback cascade with it):',
      JSON.stringify(await owned(account.id)));
  }

  console.log(`\nmatching accounts remaining: ${(await db.query(`SELECT count(*)::int AS n FROM users WHERE ${where}`, [target])).rows[0].n}`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => db.pool.end());
