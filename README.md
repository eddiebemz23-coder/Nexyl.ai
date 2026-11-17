# Nexyl.ai

A full-stack JavaScript AI assistant: **vanilla JS frontend**, **JavaScript backend**, **PostgreSQL** database.

Nexyl is a hybrid assistant. Its engine routes every message through a pipeline of skills (calculator, memory, summariser, clock, knowledge search) and can optionally hand open-ended questions to a large language model. It is **not** a newly trained neural network. The "AI" is the engine design plus whichever LLM you plug in.

```
 Browser (public/)                API (src/)                          PostgreSQL
┌──────────────────┐  fetch/SSE  ┌──────────────────────────┐  pg     ┌────────────────┐
│ chat UI, auth,   │ ──────────▶ │ /api/auth     JWT + bcrypt│ ──────▶ │ users          │
│ streaming render │ ◀────────── │ /api/...      chat routes │         │ conversations  │
└──────────────────┘             │        │                  │         │ messages (JSONB)│
                                 │        ▼                  │         │ memories       │
                                 │  Nexyl engine (src/engine) │         │ kb_articles +  │
                                 │  skills ─▶ KB search ─▶ LLM│        │  GIN tsvector  │
                                 └──────────────────────────┘         │ feedback       │
                                                                      └────────────────┘
```

The routes above are mounted twice, over the same core:

| Transport | Entry | Runs | Serves the frontend |
|---|---|---|---|
| Express | `src/server.js` → `src/routes/*` | locally, in Docker | `express.static(public/)` |
| Neon Function (Hono) | `src/function/index.mjs` | Neon Functions | assets inlined by `npm run function:build` |

Both call `src/services.js`, which holds the SQL, the validation rules and the SSE event sequence. That is deliberate: Neon Functions are invoked through a web-standard `fetch` handler instead of a listening socket, so Express cannot be the entrypoint there — but neither transport is allowed to drift from the other, and CI runs the identical suite against both.

## Quick start

Requirements: Node 20.6+ and PostgreSQL 13+.

```bash
npm install
cp .env.example .env            # then edit DATABASE_URL and JWT_SECRET
docker compose up -d            # optional: starts Postgres with a "nexyl" database
npm run migrate                 # creates tables and seeds the knowledge base
npm start                       # → http://localhost:3000
```

No Docker? Create the database yourself first: `createdb nexyl`.

## Tests

One suite, 27 assertions, three targets:

```bash
npm test                        # Express against your DATABASE_URL
npm run function:build          # inline public/ into the Function entry once
npm run test:function           # the Neon Function entry, bridged onto a local port
npm run test:neon -- --base=https://<your-function-url>   # a live deployment
```

`scripts/smoke-test.js` reads `llm` from the target's `/api/health` rather than from your shell, so the open-ended question asserts a canned fallback or a real model reply depending on what the machine under test actually has.

## Container

The image is just the server — schema and knowledge base stay an explicit step:

```bash
docker build -t nexyl-ai .
docker run -p 3000:3000 -e DATABASE_URL=... -e JWT_SECRET=... nexyl-ai
```

`docker compose` defaults to the database alone, matching the quick start above. To bring up both:

```bash
JWT_SECRET=$(openssl rand -hex 32) docker compose --profile app up -d --build
```

That runs `scripts/migrate.js` before starting the server, and interpolates `GEMINI_API_KEY` from your shell or a `.env` file if you want open-ended chat in the container.

## Deploying to Neon

Neon hosts the database (Lakebase Postgres) and, through Functions, the app itself. The frontend travels with the API, so there is one origin and no CORS to configure.

Prerequisites: a Neon account the CLI can use (`neon login` — that is a browser step for a human), and a project in a Functions-supported region.

```bash
neon link --org-id <org> --project-id <project> --no-env-pull
npm run migrate:neon                       # schema + seed against the branch, direct endpoint
npm run neon:deploy                        # build assets, prepare .env.neon, apply neon.ts
```

`neon:deploy` prints the Function URL, which serves both the app and the API. Then:

```bash
npm run test:neon -- --base=https://<branch>-api.compute.<cell>.<region>.aws.neon.tech
```

What each piece does:

- `neon.ts` declares the `api` function, its entry `src/function/index.mjs`, and the env keys it uploads. It is Neon's Terraform-equivalent config; `neon config plan` shows the diff before you apply it.
- `scripts/neon-env.mjs` keeps the connection strings `neon env pull` wrote and tops `.env.neon` up with the LLM settings copied from `.env` (`GEMINI_API_KEY`, `OPENAI_API_KEY`, model and provider overrides), a small `PG_POOL_MAX`, and a freshly minted `JWT_SECRET` — generated once and then preserved, so rotating a deploy never invalidates signed-in sessions. It prints key names and lengths, never values.
- `--no-env-pull` on `neon deploy` is not cosmetic: with the default, deploy overwrites `DATABASE_URL` in your local `.env` and quietly points development at the production database.

Runtime shape worth knowing before you change this app:

- The Function's URL is public and unauthenticated at the network layer. Route-level JWT checks are the only gate, so keep `requireAuth`/`signedIn` in front of anything that touches another user's rows.
- Compute is per isolate and evictable. The rate limiter is a per-isolate counter, not a global one — the app tolerates that at prototype scale; a real limit needs Redis or a gateway.
- `DATABASE_URL` (pooled) is injected at runtime; never declare it in `neon.ts`. Migrations use `DATABASE_URL_UNPOOLED`, because `schema.sql` is one multi-statement query and a pooled proxy can route it across connections.
- SSE streams stay open while bytes flow, with a 15-minute silence timeout. A chat turn finishes far inside that.
- On the Free plan the AI Gateway is provisioned but does not serve model requests, which is irrelevant here: Nexyl calls Gemini directly.

## Icons

Every favicon, PWA icon and the `.ico` is generated from the logo geometry — nothing is hand-traced:

```bash
npm run icons        # writes public/icons/
```

`scripts/build-icons.js` holds the same path data the page uses, rasterises it with signed distances, and writes PNG, ICO and `site.webmanifest`. Re-run it whenever the logo changes; CI does not check the output for byte-identical regeneration, because PNG encoding is not guaranteed stable across Node builds.

## What Nexyl can do

| Try saying | Skill | How it works |
|---|---|---|
| `calculate (12 + 8) * 3 / 4`, `2^10`, `sqrt(144)` | Calculator | Hand-written parser, no `eval` |
| `remember that my favourite colour is teal` | Memory | Stored per user in `memories` |
| `what do you remember about me` / `forget everything` | Memory | Reads or clears `memories` |
| `what is PostgreSQL`, `how does the Nexyl engine work` | Knowledge base | Postgres full-text search (`tsvector` + GIN, `ts_rank_cd`) |
| `summarize: <long text>` | Summariser | Extractive, word-frequency scoring |
| `what time is it` | Clock | Uses your browser's timezone |
| anything else | LLM (optional) | Enabled by `GEMINI_API_KEY` or `OPENAI_API_KEY` |

Every reply stores metadata (`intent`, `sources`, `latency_ms`, `engine`) in `messages.meta` and shows it as chips under the answer.

## Configuration (`.env`)

| Variable | Purpose | Default |
|---|---|---|
| `DATABASE_URL` | Postgres connection string | `postgres://postgres@localhost:5432/nexyl` |
| `JWT_SECRET` | Signs login tokens. **Set a long random value.** | random per start |
| `PORT` | HTTP port (Express only; Neon Functions ignore it) | `3000` |
| `GEMINI_API_KEY` | Enables the LLM fallback for open-ended chat | unset (off) |
| `NEXYL_LLM_MODEL` | Gemini model name used by the fallback | `gemini-flash-lite-latest` |
| `LLM_BASE_URL` | Override the Gemini endpoint | `https://generativelanguage.googleapis.com/v1beta` |
| `OPENAI_API_KEY` | Second fallback provider (Chat Completions) | unset (off) |
| `NEXYL_OPENAI_MODEL` | OpenAI model name | `gpt-4.1-mini` |
| `OPENAI_BASE_URL` | Override the OpenAI endpoint | `https://api.openai.com/v1` |
| `NEXYL_LLM_PROVIDER` | `gemini` or `openai`. Overrides the preference order; an unknown name disables the fallback. | unset |
| `PG_POOL_MAX` | Connection cap per process/isolate | `10` (`3` on Neon) |

**Provider choice.** `src/engine/llm.js` holds one small adapter per API dialect (`gemini`, `openai`) behind a single `{ enabled(), complete(), providerName(), configured() }` interface, so skills and routes never mention a vendor. With both keys set Gemini wins; `NEXYL_LLM_PROVIDER` forces the other. `/api/health` reports `llm_provider` (which one answers) and `llm_keys` (which ones a deploy actually carried — provider names, never values), and each answer records `provider` plus `model` in `messages.meta`. A provider that errors (quota, outage) makes the engine return its canned fallback rather than failing the request.

`.env.neon` is a second, git-ignored file written by `neon env pull` and `scripts/neon-env.mjs`; it is the deploy-time input for Function env, not something the local server reads.

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
| GET | `/api/health` | DB + engine status, plus which LLM provider keys are loaded |

## Project layout

```
db/schema.sql             tables, indexes, weighted tsvector function
db/seed-kb.js             starter knowledge base articles
neon.ts                   Neon infrastructure-as-code: the api function and its env keys
scripts/migrate.js        applies schema + seeds (idempotent)
scripts/smoke-test.js     end-to-end API + engine tests (npm test)
scripts/build-icons.js    rasterises the logo into public/icons (npm run icons)
scripts/build-function.mjs inlines public/ into the Function entry (npm run function:build)
scripts/neon-env.mjs      prepares .env.neon for deploy (npm run neon:env)
src/server.js             Express app, security headers, static hosting
src/services.js           the API core both transports share: SQL, validation, SSE events
src/auth.js               JWT + rate limiter, shared by both transports
src/routes/               auth.js, chat.js (Express adapters)
src/function/index.mjs    Hono adapter + inlined frontend (Neon Functions entrypoint)
src/engine/               nexyl.js (pipeline), skills.js, math.js, llm.js
public/                   index.html, styles.css, app.js
public/icons/             favicon.ico, PNG sizes, apple-touch, logo.svg, site.webmanifest
Dockerfile                production image (node:24-alpine, non-root, healthcheck)
docker-compose.yml        db service, plus an optional `--profile app`
.github/workflows/ci.yml  migrate + smoke test against Postgres 16, both transports
```

## Extending Nexyl

**Add knowledge:** append to `db/seed-kb.js` and run `npm run migrate`, or `INSERT` into `kb_articles`. The search vector is generated automatically.

**Add a skill:** write `async function doThing(message, ctx)` in `src/engine/skills.js` that returns `{ text, meta: { intent } }` or `null`, then add it to the `pipeline` array in `src/engine/nexyl.js`. Order matters: the first skill that answers wins.

**Add an endpoint:** put the work in `src/services.js`, then expose it in both adapters — `src/routes/chat.js` and `src/function/index.mjs`. The Function's `neon:deploy` rebuilds and re-uploads; a child branch gets its own copy of both.

## Before going to production

This is a prototype. Things to harden:

- Serve behind HTTPS and set a strong `JWT_SECRET` (the deploy script mints one; a hand-written `.env` often still holds the placeholder).
- The rate limiter is in-memory and per process/isolate; use Redis or a gateway for a real limit across instances.
- JWTs live in `localStorage`; consider httpOnly cookies plus CSRF protection.
- Add a migration tool (e.g. node-pg-migrate) once the schema starts changing.
- The knowledge base is small and hand-written; for real retrieval add embeddings (`pgvector`).
- On Neon, put the Function behind a custom domain you control if you intend to share it — the generated `*.compute.*.neon.tech` URL is public and permanent for that branch.
