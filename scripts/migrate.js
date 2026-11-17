// Applies db/schema.sql and (re)seeds the knowledge base. Idempotent.
const fs = require('fs');
const path = require('path');

// schema.sql is sent as one multi-statement query, which a pooled proxy may route across
// connections; prefer the direct endpoint when the host provides one.
if (process.env.DATABASE_URL_UNPOOLED) process.env.DATABASE_URL = process.env.DATABASE_URL_UNPOOLED;

const db = require('../src/db');
const articles = require('../db/seed-kb');

async function main() {
  const schema = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8');
  await db.query(schema);
  console.log('[migrate] schema applied');

  for (const a of articles) {
    await db.query(
      `INSERT INTO kb_articles (title, body, tags) VALUES ($1, $2, $3)
       ON CONFLICT (title) DO UPDATE SET body = EXCLUDED.body, tags = EXCLUDED.tags`,
      [a.title, a.body, a.tags]
    );
  }
  console.log(`[migrate] knowledge base seeded (${articles.length} articles)`);
  await db.pool.end();
}

main().catch((err) => {
  console.error('[migrate] failed:', err.message);
  process.exit(1);
});
