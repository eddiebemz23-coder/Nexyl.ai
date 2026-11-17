# Nexl AI

A full-stack JavaScript AI assistant prototype: **vanilla JS frontend**, **Express backend**, **PostgreSQL** database.

Nexl is a hybrid assistant. Its engine routes every message through a pipeline of skills (calculator, memory, summariser, clock, knowledge search) and can optionally hand open-ended questions to a large language model. It is **not** a newly trained neural network. The "AI" is the engine design plus whichever LLM you plug in.

```
 Browser (public/)                Express API (src/)                    PostgreSQL
┌──────────────────┐  fetch/SSE  ┌──────────────────────────┐  pg     ┌────────────────┐
│ chat UI, auth,   │ ──────────▶ │ /api/auth     JWT + bcrypt│ ──────▶ │ users          │
│ streaming render │ ◀────────── │ /api/...      chat routes │         │ conversations  │
└──────────────────┘             │        │                  │         │ messages (JSONB)│
                                 │        ▼                  │         │ memories       │
                                 │  Nexl engine (src/engine) │         │ kb_articles +  │
                                 │  skills ─▶ KB search ─▶ LLM│        │  GIN tsvector  │
                                 └──────────────────────────┘         │ feedback       │
                                                                      └────────────────┘
```

## Quick start

Requirements: Node 18+ and PostgreSQL 13+.

```bash
npm install
cp .env.example .env            # then edit DATABASE_URL and JWT_SECRET
docker compose up -d            # optional: starts Postgres with a "nexl" database
npm run migrate                 # creates tables and seeds the knowledge base
npm start                       # → http://localhost:3000
```

No Docker? Create the database yourself first: `createdb nexl`.

Run the end-to-end tests (needs the migrated database): `npm test`

## What Nexl can do

| Try saying | Skill | How it works |
|---|---|---|
| `calculate (12 + 8) * 3 / 4`, `2^10`, `sqrt(144)` | Calculator | Hand-written parser, no `eval` |
| `remember that my favourite colour is teal` | Memory | Stored per user in `memories` |
| `what do you remember about me` / `forget everything` | Memory | Reads or clears `memories` |
| `what is PostgreSQL`, `how does the Nexl engine work` | Knowledge base | Postgres full-text search (`tsvector` + GIN, `ts_rank_cd`) |
| `summarize: <long text>` | Summariser | Extractive, word-frequency scoring |
| `what time is it` | Clock | Uses your browser's timezone |
| anything else | LLM (optional) | Enabled by `OPENROUTER_API_KEY` |

Every reply stores metadata (`intent`, `sources`, `latency_ms`, `engine`) in `messages.meta` and shows it as chips under the answer.

## Configuration (`.env`)

| Variable | Purpose | Default |
|---|---|---|
| `DATABASE_URL` | Postgres connection string | `postgres://postgres@localhost:5432/nexl` |
| `JWT_SECRET` | Signs login tokens. **Set a long random value.** | random per start |
| `PORT` | HTTP port | `3000` |
| `OPENROUTER_API_KEY` | Enables the LLM fallback for open-ended chat | unset (off) |
| `NEXL_LLM_MODEL` | OpenRouter model slug used by the fallback | `anthropic/claude-sonnet-5.5` |
| `LLM_BASE_URL` | Override the provider endpoint | `https://openrouter.ai/api/v1` |

## API

All routes except `/api/auth/*` and `/api/health` need `Authorization: Bearer <token>`.

| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/register` | `{name, email, password}` → `{token, user}` |
| POST | `/api/auth/login` | `{email, password}` → `{token, user}` |
| GET | `/api/auth/me` | Current user |
| GET / POST | `/api/conversations` | List / create |
| PATCH / DELETE | `/api/conversations/:id` | Rename / delete |
| GET | `/api/conversations/:id/messages` | Message history |
| POST | `/api/conversations/:id/messages` | `{content, timezone}` → **SSE stream** (`user`, `token`, `done`, `error`) |
| POST | `/api/messages/:id/feedback` | `{rating: 1 \| -1 \| 0}` |
| GET / DELETE | `/api/memories[/:id]` | List / forget memories |
| GET | `/api/health` | DB + engine status |

## Project layout

```
db/schema.sql          tables, indexes, weighted tsvector function
db/seed-kb.js          starter knowledge base articles
scripts/migrate.js     applies schema + seeds (idempotent)
scripts/smoke-test.js  end-to-end API + engine tests (npm test)
src/server.js          Express app, security headers, static hosting
src/auth.js            JWT + rate limiter
src/routes/            auth.js, chat.js
src/engine/            nexl.js (pipeline), skills.js, math.js, llm.js
public/                index.html, styles.css, app.js
```

## Extending Nexl

**Add knowledge:** append to `db/seed-kb.js` and run `npm run migrate`, or `INSERT` into `kb_articles`. The search vector is generated automatically.

**Add a skill:** write `async function doThing(message, ctx)` in `src/engine/skills.js` that returns `{ text, meta: { intent } }` or `null`, then add it to the `pipeline` array in `src/engine/nexl.js`. Order matters: the first skill that answers wins.

## Before going to production

This is a prototype. Things to harden:

- Serve behind HTTPS and set a strong `JWT_SECRET`.
- The rate limiter is in-memory and per process; use Redis or a gateway for multiple instances.
- JWTs live in `localStorage`; consider httpOnly cookies plus CSRF protection.
- Add a migration tool (e.g. node-pg-migrate) once the schema starts changing.
- The knowledge base is small and hand-written; for real retrieval add embeddings (`pgvector`).
