# public-ai-proxy

A Cloudflare Workers proxy for PublicAI API with rate limiting and CORS support.

## Setup

### 1. Install Wrangler

```bash
npm install -g wrangler
```

### 2. Configure the PublicAI API Key

You need to set your PublicAI API key as a secret in Cloudflare Workers:

```bash
wrangler secret put publicai
```

When prompted, enter your PublicAI API key.

**Important:** The secret name must be exactly `publicai` (lowercase) to match the code.

### 3. Deploy

```bash
wrangler deploy
```

## Configuration

- **Rate Limiting:** 20 requests per minute per IP
- **Allowed Origins:** en.wikipedia.org, www.wikipedia.org
- **Supported Methods:** POST (for API), GET (for URL fetching)

## Troubleshooting

### 401 Unauthorized Error

If you're getting a 401 error like:
```
PublicAI API request failed (401): Authorization Failed
```

This means your PublicAI API key is not configured or is invalid. To fix:

1. Check if the secret is set:
   ```bash
   wrangler secret list
   ```

2. Set or update the secret:
   ```bash
   wrangler secret put publicai
   ```

3. Redeploy:
   ```bash
   wrangler deploy
   ```

### Verify Your API Key

Make sure your PublicAI API key is valid by testing it directly:

```bash
curl -X POST https://api.publicai.co/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{"model":"gpt-4","messages":[{"role":"user","content":"Hello"}]}'
```

If this fails with 401, your API key is invalid and you need to get a new one from PublicAI.
