require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL || 'postgres://postgres@localhost:5432/nexyl',
  max: 10,
});

pool.on('error', (err) => console.error('[db] idle client error', err.message));

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
