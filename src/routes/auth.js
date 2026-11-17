const express = require('express');
const services = require('../services');
const { requireAuth, rateLimit } = require('../auth');

const router = express.Router();
const limiter = rateLimit({ windowMs: 60_000, max: 20 });

// Every service call resolves to { status?, body? }; this is the only place that shape
// is translated into an Express response.
const send = (res, { status = 200, body } = {}) => (body === undefined ? res.status(status).end() : res.status(status).json(body));
const handler = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((result) => send(res, result)).catch(next);

router.post('/register', limiter, handler((req) => services.register(req.body)));
router.post('/login', limiter, handler((req) => services.login(req.body)));
router.get('/me', requireAuth, handler((req) => services.me(req.user.id)));

module.exports = router;
