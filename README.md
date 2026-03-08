# public-ai-proxy

A Cloudflare Worker that proxies requests to the [PublicAI](https://publicai.co) API with rate limiting, CORS handling, verification logging, and URL content extraction. Built to support citation verification on Wikipedia.

## Features

- **API Proxying** — Forwards chat completion requests to PublicAI's `/v1/chat/completions` endpoint
- **Rate Limiting** — Per-IP rate limiting (20 requests/minute) using in-memory buckets
- **CORS** — Configured for Wikipedia origins (`en.wikipedia.org`, `www.wikipedia.org`, `commons.wikimedia.org`)
- **Verification Logging** — `/log` endpoint records citation verification results to a Neon PostgreSQL database
- **URL Fetching** — `?fetch=<url>` extracts text content from external pages (scripts, styles, nav stripped; 12k char limit)
- **Debug Endpoints** — `?ping` for reachability checks, `?neon=test` for database connectivity

## Endpoints

| Method | Path / Param | Description |
|--------|-------------|-------------|
| `POST` | `/` | Proxies request body to PublicAI chat completions |
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
wrangler secret put DATABASE_URL    # Neon PostgreSQL connection string
```

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
