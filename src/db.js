require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL || 'postgres://postgres@localhost:5432/nexyl',
  // Each Neon Function isolate keeps its own pool, so the hosted app caps it lower than a
  // single Express process would.
  max: Number(process.env.PG_POOL_MAX) || 10,
});

pool.on('error', (err) => console.error('[db] idle client error', err.message));

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
