// End-to-end smoke test: boots the real app against the real database and exercises the API.
// Usage: npm test   (requires DATABASE_URL pointing at a migrated database)
process.env.JWT_SECRET = process.env.JWT_SECRET || 'smoke-test-secret';
const app = require('../src/server');
const db = require('../src/db');

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok ? '' : `  ← ${detail}`}`);
};

async function sse(res) {
  const text = await res.text();
  const events = [];
  for (const block of text.split('\n\n')) {
    const ev = /^event: (.+)$/m.exec(block)?.[1];
    const data = /^data: (.+)$/m.exec(block)?.[1];
    if (ev) events.push({ event: ev, data: JSON.parse(data) });
  }
  return events;
}

(async () => {
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const email = `smoke+${Date.now()}@example.com`;
  const api = async (path, { method = 'GET', body, token } = {}) =>
    fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });

  try {
    console.log('\nAuth');
    let r = await api('/api/auth/register', { method: 'POST', body: { name: 'Smoke Test', email, password: 'short' } });
    check('rejects short password', r.status === 400);
    r = await api('/api/auth/register', { method: 'POST', body: { name: 'Smoke Test', email, password: 'password123' } });
    const reg = await r.json();
    check('registers a user', r.status === 201 && !!reg.token);
    r = await api('/api/auth/register', { method: 'POST', body: { name: 'Smoke Test', email, password: 'password123' } });
    check('rejects duplicate email', r.status === 409);
    r = await api('/api/auth/login', { method: 'POST', body: { email, password: 'wrong-password' } });
    check('rejects wrong password', r.status === 401);
    r = await api('/api/auth/login', { method: 'POST', body: { email, password: 'password123' } });
    const token = (await r.json()).token;
    check('logs in', !!token);
    r = await api('/api/conversations');
    check('protects routes without a token', r.status === 401);

    console.log('\nConversations');
    r = await api('/api/conversations', { method: 'POST', token });
    const convo = (await r.json()).conversation;
    check('creates a conversation', r.status === 201 && !!convo.id);

    const ask = async (content) => {
      const res = await api(`/api/conversations/${convo.id}/messages`, { method: 'POST', token, body: { content, timezone: 'Africa/Kampala' } });
      const events = await sse(res);
      return events.find((e) => e.event === 'done')?.data;
    };

    console.log('\nEngine');
    const cases = [
      ['hello', 'greeting', (t) => /Nexl/.test(t)],
      ['calculate (12 + 8) * 3 / 4', 'math', (t) => t.includes('**15**')],
      ['2^10', 'math', (t) => t.includes('**1024**')],
      ['-3 + sqrt(16) * 2', 'math', (t) => t.includes('**5**')],
      ['10/0', 'math', (t) => /Division by zero/.test(t)],
      ['what is PostgreSQL', 'knowledge', (t) => /relational database/.test(t)],
      ['how does full text search work in postgres', 'knowledge', (t) => /tsvector/.test(t)],
      ['what time is it', 'time', (t) => /Africa\/Kampala/.test(t)],
      ['remember that my favourite colour is teal', 'remember', (t) => /teal/.test(t)],
      ['what do you remember about me', 'recall', (t) => /teal/.test(t)],
      ['summarize: PostgreSQL is a database. It is reliable and open source. Many companies use it for production workloads every day. It supports JSON documents and full text search. It also offers strong transactional guarantees for critical data.', 'summarize', (t) => /Summary/.test(t)],
      ['zzqxv blorp wibble', 'fallback', () => true],
    ];
    for (const [q, intent, verify] of cases) {
      const done = await ask(q);
      const ok = done && done.message.meta.intent === intent && verify(done.message.content);
      check(`"${q.slice(0, 44)}" → ${intent}`, ok, done ? `got ${done.message.meta.intent}: ${done.message.content.slice(0, 80)}` : 'no done event');
    }

    console.log('\nPersistence');
    r = await api(`/api/conversations/${convo.id}/messages`, { token });
    const { messages } = await r.json();
    check('stores every message', messages.length === cases.length * 2, `got ${messages.length}`);
    r = await api('/api/conversations', { token });
    const list = (await r.json()).conversations;
    check('auto-titles the conversation', list[0]?.title === 'hello', list[0]?.title);

    const botMsg = messages.find((m) => m.role === 'assistant');
    r = await api(`/api/messages/${botMsg.id}/feedback`, { method: 'POST', token, body: { rating: 1 } });
    check('saves feedback', r.status === 200);
    r = await api('/api/memories', { token });
    check('lists memories', (await r.json()).memories.length === 1);

    console.log('\nSecurity');
    r = await api('/api/auth/register', { method: 'POST', body: { name: 'Other User', email: `o${email}`, password: 'password123' } });
    const other = (await r.json()).token;
    r = await api(`/api/conversations/${convo.id}/messages`, { token: other });
    check("blocks reading another user's conversation", r.status === 404);
    r = await api(`/api/conversations/not-a-uuid/messages`, { token });
    check('rejects malformed ids', r.status === 400);
    r = await api(`/api/conversations/${convo.id}/messages`, { method: 'POST', token, body: { content: 'x'.repeat(5000) } });
    check('rejects oversized messages', r.status === 400);

    console.log('\nCleanup');
    r = await api(`/api/conversations/${convo.id}`, { method: 'DELETE', token });
    check('deletes a conversation', r.status === 204);
    await db.query('DELETE FROM users WHERE email LIKE $1', ['%' + email]);
  } catch (err) {
    failed++;
    console.error('Unexpected error:', err);
  } finally {
    server.close();
    await db.pool.end();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
