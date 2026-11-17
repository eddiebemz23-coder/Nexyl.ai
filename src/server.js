require('dotenv').config();
const path = require('path');
const express = require('express');
const services = require('./services');
const { ENGINE_VERSION } = require('./engine/nexyl');
const llm = require('./engine/llm');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' }));

// Basic security headers
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; script-src 'self'; connect-src 'self'",
  });
  next();
});

app.get('/api/health', (req, res, next) =>
  Promise.resolve(services.health()).then((r) => res.status(r.status || 200).json(r.body)).catch(next)
);

app.use('/api/auth', require('./routes/auth'));
app.use('/api', require('./routes/chat'));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use(express.static(path.join(__dirname, '../public')));

// Central error handler
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body.' });
  if (err instanceof services.ApiError) return res.status(err.status).json({ error: err.message });
  console.error('[server] unhandled:', err);
  if (res.headersSent) return res.end();
  res.status(500).json({ error: 'Internal server error.' });
});

const PORT = Number(process.env.PORT) || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Nexyl AI (${ENGINE_VERSION}) running → http://localhost:${PORT}`);
    console.log(`LLM fallback: ${llm.providerName() || 'disabled (set GEMINI_API_KEY or OPENAI_API_KEY)'}`);
  });
}

module.exports = app;
