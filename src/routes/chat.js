const express = require('express');
const services = require('../services');
const { requireAuth, rateLimit } = require('../auth');

const router = express.Router();
router.use(requireAuth);

const sendLimiter = rateLimit({ windowMs: 60_000, max: 40 });
const send = (res, { status = 200, body } = {}) => (body === undefined ? res.status(status).end() : res.status(status).json(body));
const handler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res)).then((result) => send(res, result)).catch(next);

router.get('/conversations', handler((req) => services.listConversations(req.user.id)));
router.post('/conversations', handler((req) => services.createConversation(req.user.id)));
router.patch('/conversations/:id', handler((req) => services.renameConversation(req.params.id, req.user.id, req.body.title)));
router.delete('/conversations/:id', handler((req) => services.deleteConversation(req.params.id, req.user.id)));
router.get('/conversations/:id/messages', handler((req) => services.listMessages(req.params.id, req.user.id)));

router.post('/messages/:id/feedback', handler((req) => services.saveFeedback(req.params.id, req.user.id, req.body.rating)));
router.get('/memories', handler((req) => services.listMemories(req.user.id)));
router.delete('/memories/:id', handler((req) => services.deleteMemory(req.params.id, req.user.id)));

// Sends a user message and streams the assistant reply as Server-Sent Events.
// Events: `user` (saved user message), `token` (text chunk), `done` (final message), `error`.
router.post('/conversations/:id/messages', sendLimiter, async (req, res, next) => {
  let prep;
  try {
    prep = await services.prepareMessage({ id: req.params.id, userId: req.user.id, content: req.body.content });
  } catch (err) {
    return next(err);
  }

  res.set(services.SSE_HEADERS);
  res.flushHeaders();
  const write = ({ event, data }) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    const events = services.messageEvents({
      ...prep,
      userId: req.user.id,
      userName: req.user.name,
      timezone: String(req.body.timezone || 'UTC').slice(0, 64),
    });
    for await (const event of events) write(event);
  } finally {
    res.end();
  }
});

module.exports = router;
