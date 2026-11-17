// Starter knowledge base for the Nexl engine. Add your own articles here or via SQL.
module.exports = [
  {
    title: 'What is Nexl AI',
    tags: ['nexl', 'about', 'assistant'],
    body:
      'Nexl AI is a full-stack JavaScript assistant. The frontend is a vanilla JS chat app, the backend is an Express API, and all data lives in PostgreSQL. ' +
      'Its brain, the Nexl engine, combines intent detection, a calculator, long-term memory, Postgres full-text knowledge search, and an optional large language model for open-ended questions.',
  },
  {
    title: 'How the Nexl engine works',
    tags: ['nexl', 'engine', 'architecture', 'pipeline'],
    body:
      'Every message flows through a pipeline: intent detection first, then specialised skills (math, memory, time, summarize), then knowledge-base retrieval using PostgreSQL full-text search, and finally an optional LLM fallback. ' +
      'Each reply stores metadata such as the detected intent and sources so you can see why Nexl answered the way it did.',
  },
  {
    title: 'What is PostgreSQL',
    tags: ['postgres', 'postgresql', 'database', 'sql'],
    body:
      'PostgreSQL is an open-source relational database known for reliability, standards compliance and extensibility. It supports JSONB documents, full-text search, window functions, and strong transactional guarantees (ACID).',
  },
  {
    title: 'PostgreSQL full-text search',
    tags: ['postgres', 'search', 'tsvector', 'fts'],
    body:
      'Full-text search in PostgreSQL uses tsvector to store normalised document tokens and tsquery to express searches. A GIN index on the tsvector column makes lookups fast, and ts_rank orders results by relevance.',
  },
  {
    title: 'What is Express.js',
    tags: ['express', 'nodejs', 'javascript', 'backend', 'http'],
    body:
      'Express is a minimal web framework for Node.js. It provides routing, middleware, and helpers for building HTTP APIs. Middleware functions run in order and can modify the request, end the response, or pass control onward.',
  },
  {
    title: 'What is a REST API',
    tags: ['rest', 'api', 'http', 'backend'],
    body:
      'A REST API exposes resources over HTTP using standard verbs: GET reads, POST creates, PUT or PATCH updates, DELETE removes. Good REST APIs use clear resource URLs, meaningful status codes, and stateless requests.',
  },
  {
    title: 'JSON Web Tokens',
    tags: ['jwt', 'auth', 'security', 'token'],
    body:
      'A JSON Web Token (JWT) is a signed token carrying claims such as a user id and expiry. The server verifies the signature on each request instead of looking up a session. Keep secrets long and random, set short expiries, and never store passwords in a token.',
  },
  {
    title: 'Password hashing',
    tags: ['security', 'bcrypt', 'passwords', 'auth'],
    body:
      'Passwords should never be stored in plain text. Use a slow, salted hash such as bcrypt, scrypt or argon2 so that stolen databases are expensive to crack. Nexl AI uses bcrypt with a cost factor of 10.',
  },
  {
    title: 'What is JavaScript',
    tags: ['javascript', 'js', 'programming', 'language'],
    body:
      'JavaScript is a dynamic, multi-paradigm programming language that runs in browsers and, through Node.js, on servers. It features first-class functions, prototypes, promises and async/await for asynchronous code.',
  },
  {
    title: 'What is machine learning',
    tags: ['machine learning', 'ml', 'ai', 'artificial intelligence'],
    body:
      'Machine learning is a field of AI in which models learn patterns from data instead of being explicitly programmed. Common approaches are supervised learning (labelled examples), unsupervised learning (finding structure) and reinforcement learning (learning from rewards).',
  },
  {
    title: 'What is a large language model',
    tags: ['llm', 'language model', 'ai', 'transformer'],
    body:
      'A large language model (LLM) is a neural network, usually based on the transformer architecture, trained on huge amounts of text to predict the next token. With instruction tuning it can answer questions, write code and follow directions.',
  },
  {
    title: 'What is SSE streaming',
    tags: ['sse', 'streaming', 'server-sent events', 'http'],
    body:
      'Server-Sent Events let a server push a stream of text events to the browser over one HTTP response. Nexl AI uses a streamed response so replies appear token by token instead of all at once.',
  },
  {
    title: 'Getting started with Nexl AI',
    tags: ['nexl', 'help', 'start', 'commands', 'usage'],
    body:
      'Try these: ask "what is PostgreSQL", calculate "(12 + 8) * 3 / 4", say "remember that my favourite colour is teal", ask "what do you remember about me", ask "what time is it", or type "summarize:" followed by any text.',
  },
];
