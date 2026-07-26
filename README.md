# public-ai-proxy

A Cloudflare Worker that proxies requests to the [PublicAI](https://publicai.co) API with rate limiting, CORS handling, verification logging, and URL content extraction. Built to support citation verification on Wikipedia.

## Features

- **API Proxying** — Forwards chat completion requests to PublicAI's `/v1/chat/completions` endpoint
- **HuggingFace Proxy** — `/hf` route proxies to HuggingFace Inference Providers (`router.huggingface.co`) with a model allowlist
- **Lift Wing Proxy** — `/liftwing` route proxies to Wikimedia's Lift Wing LLM service (`api.wikimedia.org`), which hosts open-weight Qwen models with an OpenAI-compatible API
- **Rate Limiting** — Per-IP rate limiting (20 requests/minute) using in-memory buckets
- **CORS** — Configured for Wikipedia origins (`en.wikipedia.org`, `www.wikipedia.org`, `commons.wikimedia.org`)
- **Verification Logging** — `/log` endpoint records citation verification results to a Neon PostgreSQL database
- **URL Fetching** — `?fetch=<url>` extracts text content from external pages (scripts, styles, nav stripped; 100k char limit)
- **Debug Endpoints** — `?ping` for reachability checks, `?neon=test` for database connectivity

## Endpoints

| Method | Path / Param | Description |
|--------|-------------|-------------|
| `POST` | `/` | Proxies request body to PublicAI chat completions |
| `POST` | `/hf` | Proxies chat completions to HuggingFace Inference Providers (allowlisted models only) |
| `POST` | `/liftwing` | Proxies chat completions to Wikimedia Lift Wing (allowlisted Qwen models only) |
| `POST` | `/log` | Logs a citation verification result to the database |
| `GET` | `/?fetch=<url>` | Fetches and extracts text content from a URL |
| `GET` | `/?ping` | Returns timestamp, IP, and CORS status |
| `GET` | `/?neon=test` | Tests the Neon database connection |

## Setup

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
