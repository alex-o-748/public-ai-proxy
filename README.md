# public-ai-proxy

A Cloudflare Worker that proxies requests to the [PublicAI](https://publicai.co) API with rate limiting, CORS handling, verification logging, and URL content extraction. Built to support citation verification on Wikipedia.

## Features

- **API Proxying** — Forwards chat completion requests to PublicAI's `/v1/chat/completions` endpoint
- **HuggingFace Proxy** — `/hf` route proxies to HuggingFace Inference Providers (`router.huggingface.co`) with a model allowlist
- **Lift Wing Proxy** — `/liftwing` route proxies to Wikimedia's Lift Wing LLM service (`api.wikimedia.org`), which hosts open-weight Qwen models with an OpenAI-compatible API
- **Rate Limiting** — Per-IP rate limiting (20 requests/minute) using in-memory buckets
- **CORS** — Configured for Wikipedia origins (`en.wikipedia.org`, `www.wikipedia.org`, `commons.wikimedia.org`)
- **Verification Logging** — `/log` endpoint records citation verification results to a Neon PostgreSQL database
- **Feedback** — `/feedback` endpoint records user ratings and verdict corrections to a Neon PostgreSQL database
- **URL Fetching** — `?fetch=<url>` extracts text content from external pages (scripts, styles, nav stripped; 100k char limit)
- **Debug Endpoints** — `?ping` for reachability checks, `?neon=test` for database connectivity

## Endpoints

| Method | Path / Param | Description |
|--------|-------------|-------------|
| `POST` | `/` | Proxies request body to PublicAI chat completions |
| `POST` | `/hf` | Proxies chat completions to HuggingFace Inference Providers (allowlisted models only) |
| `POST` | `/liftwing` | Proxies chat completions to Wikimedia Lift Wing (allowlisted Qwen models only) |
| `POST` | `/log` | Logs a citation verification result to the database |
| `POST` | `/feedback` | Logs a user rating or verdict correction for a check |
| `GET` | `/?fetch=<url>` | Fetches and extracts text content from a URL |
| `GET` | `/?ping` | Returns timestamp, IP, and CORS status |
| `GET` | `/?neon=test` | Tests the Neon database connection |

## Setup

Deployed Worker URL: `https://publicai-proxy.alaexis.workers.dev`

### Prerequisites

- [Node.js](https://nodejs.org)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler`)
- A Cloudflare account
- A [Neon](https://neon.tech) PostgreSQL database

### Secrets

Configure these via `wrangler secret put`:

```sh
wrangler secret put publicai        # PublicAI API bearer token
wrangler secret put HF_TOKEN        # HuggingFace Inference Providers token (for /hf)
wrangler secret put DATABASE_URL    # Neon PostgreSQL connection string
wrangler secret put LIFTWING_TOKEN  # (optional) Lift Wing approved-bot JWT (for /liftwing)
```

`LIFTWING_TOKEN` is optional: the Lift Wing public API works anonymously, but
anonymous traffic shares a coarse rate limit. Once the Wikimedia ML team grants
an approved-bot JWT, set it here to use the higher tier.

The `DATABASE_URL` should be a standard PostgreSQL connection string:
```
postgres://user:pass@ep-cool-123.us-east-2.aws.neon.tech/dbname?sslmode=require
```

### Database

Create the verification logs table in your Neon database:

```sql
CREATE TABLE verification_logs (
  id SERIAL PRIMARY KEY,
  article_url TEXT,
  article_title TEXT,
  citation_number INT,
  source_url TEXT,
  provider TEXT,
  verdict TEXT,
  confidence REAL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

Then apply this migration to add feedback support (richer `/log` fields, a
stable `check_id` to join on, and the new `feedback` table):

```sql
ALTER TABLE verification_logs
  ADD COLUMN IF NOT EXISTS check_id TEXT,
  ADD COLUMN IF NOT EXISTS kind TEXT DEFAULT 'source',
  ADD COLUMN IF NOT EXISTS model TEXT,
  ADD COLUMN IF NOT EXISTS claim_text TEXT,
  ADD COLUMN IF NOT EXISTS llm_comments TEXT,
  ADD COLUMN IF NOT EXISTS reason_type TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS verification_logs_check_id_idx
  ON verification_logs (check_id);

CREATE TABLE IF NOT EXISTS feedback (
  id SERIAL PRIMARY KEY,
  ts TIMESTAMPTZ DEFAULT now(),
  check_id TEXT,
  rating SMALLINT,
  corrected_verdict TEXT,
  wiki_section TEXT,
  client_id TEXT
);

CREATE INDEX IF NOT EXISTS feedback_check_id_idx ON feedback (check_id);
```

`feedback.check_id` is intentionally not a foreign key: `/log` and
`/feedback` are independent fire-and-forget POSTs, and a rating shouldn't be
rejected just because its matching log row is missing or arrived late. Join
the two with a `LEFT JOIN ... USING (check_id)`.

Then apply this migration to record the article revision a check ran
against:

```sql
ALTER TABLE verification_logs
  ADD COLUMN IF NOT EXISTS revision_id BIGINT;
```

`revision_id` is nullable with no default and is not backfilled: existing
rows genuinely don't know their revision, and `NULL` must stay
distinguishable from a recorded revision — never backfill it with `0` or a
guess. Apply this migration before deploying the Worker version that writes
`revision_id`; the column must exist before the new `INSERT` runs (that
write happens inside `ctx.waitUntil()`, so a missing-column error there is
swallowed silently rather than surfaced).

Then apply this migration to record the quote the model pulled from the
source, and how well that quote matched the source text:

```sql
ALTER TABLE verification_logs
  ADD COLUMN IF NOT EXISTS source_quote TEXT,
  ADD COLUMN IF NOT EXISTS quote_status TEXT;
```

`quote_status` holds one of `exact`, `normalized`, `partial`, `not-found`,
`too-short`, `empty`, or `no-source`; the Worker coerces anything else to
`NULL` rather than storing it, so a client typo never seeds a junk value into
a column that gets grouped by. The client always sends one of the seven, so
**`quote_status` being `NULL` on a new row means the value was dropped
somewhere** — that is the check to run after deploying. As with `revision_id`,
both columns must exist before the new `INSERT` ships (the error would
otherwise be swallowed by `waitUntil()`, silently killing *all* `/log` writes,
not just these two fields), and neither is backfilled: rows written earlier
never carried these values and they are unrecoverable.

### HuggingFace Proxy (`/hf`)

The `/hf` endpoint forwards OpenAI-compatible chat completion requests to `https://router.huggingface.co/v1/chat/completions` using the `HF_TOKEN` secret.

- **Allowlisted models** — only models in `HF_ALLOWED_MODELS` are accepted (currently `openai/gpt-oss-20b`, `Qwen/Qwen3-32B`, `deepseek-ai/DeepSeek-V3.2-Exp`); requests with other models return `400`. Provider suffixes after `:` are stripped before checking.
- **Body limit** — requests larger than 200 KB return `413`.
- **Token cap** — `max_tokens` is clamped to `16384`. Reasoning models (gpt-oss, Qwen3) spend output tokens on chain-of-thought before the answer, so a low cap can truncate the response before any answer content is produced; a generous ceiling is safe because these models stop early when done.
- **Upstream timeout** — 60 s; aborted requests return `504`.
- **Error mapping** — upstream `401`/`403` become `502`; upstream `5xx` become `502`; `429` is passed through with `retry-after`.

Update the allowlist in `src/index.js` (`HF_ALLOWED_MODELS`) to enable additional models.

### Lift Wing Proxy (`/liftwing`)

The `/liftwing` endpoint forwards OpenAI-compatible chat completion requests to Wikimedia's Lift Wing LLM service. Lift Wing routes by model name in the URL path, so the request is sent to `https://api.wikimedia.org/service/lw/inference/v1/models/<model>/openai/v1/chat/completions`.

- **Allowlisted models** — only models in `LIFTWING_ALLOWED_MODELS` are accepted (currently `llm-qwen3-14b`, `llm-qwen36-27b`); requests with other models return `400`.
- **Body limit** — requests larger than 200 KB return `413`.
- **Token cap** — `max_tokens` is clamped to `16384`. Reasoning models (gpt-oss, Qwen3) spend output tokens on chain-of-thought before the answer, so a low cap can truncate the response before any answer content is produced; a generous ceiling is safe because these models stop early when done.
- **Upstream timeout** — 120 s; aborted requests return `504`. (Higher than `/hf`'s 60 s because Lift Wing runs at ~35 tok/s, so a long reasoning generation can take longer to complete.)
- **Error mapping** — upstream `401`/`403` become `502`; upstream `5xx` become `502`; `429` is passed through with `retry-after`.
- **Auth** — anonymous by default; if the `LIFTWING_TOKEN` secret is set it is sent as a `Bearer` token to use the approved-bot rate-limit tier. An `Api-User-Agent` header identifies the proxy to Wikimedia.
- **`<think>` stripping** — Qwen3 reasoning models may prepend `<think>…</think>` chain-of-thought before the answer. For non-streaming responses, these blocks are stripped from each choice's message content so callers receive clean, parseable output. Streaming responses (`stream: true`) pass through untouched — the client should strip the tags itself.
- **Structured output** — `response_format` (e.g. JSON schema) in the request body is forwarded as-is; whether constrained decoding is honored depends on the upstream vLLM configuration.

Update the allowlist in `src/index.js` (`LIFTWING_ALLOWED_MODELS`) to enable additional models.

### Verification Logging & Feedback (`/log`, `/feedback`)

Both endpoints are unauthenticated and publicly reachable from Wikipedia, so
all fields are treated as untrusted input: wrong types are coerced to `null`
and strings are truncated rather than rejected, since malformed telemetry
from one client shouldn't break logging for everyone else. Neither endpoint
ever records a username or IP address.

- **`/log`** — fire-and-forget; a bad or oversized body still gets a `200`
  so a telemetry failure never surfaces to the user. Inserts use
  `ON CONFLICT (check_id) DO NOTHING` so a duplicate id can't throw.
  `confidence` is coerced with `Number()` and dropped to `null` if it isn't
  finite (an LLM occasionally returns a string like `"High"`).
- **`/feedback`** — a rating is a deliberate user action, so the insert is
  awaited: `200` on success, `413`/`400` on an oversized or non-JSON body,
  `500` on a genuine insert failure. A single `check_id` can have multiple
  feedback rows (e.g. a thumbs-down followed by a separate corrected-verdict
  row) — these are never merged or upserted.

Update the allowlists in `src/index.js` (`KIND_VALUES`, `VERDICT_VALUES`) if
the client adds new `kind` or verdict values.

## Development

```sh
wrangler dev        # Start local dev server
```

## Deployment

```sh
wrangler deploy     # Deploy to Cloudflare Workers
```

## License

See repository for license details.
