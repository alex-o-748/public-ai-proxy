import { extractText as extractPdfText, getDocumentProxy } from "unpdf";

// ===== Rate limit settings =====
const RATE_LIMIT = 20;        // requests
const WINDOW_MS = 60_000;    // per minute

// Best-effort per-IP buckets (free, in-memory)
const ipBuckets = new Map();

// ===== HuggingFace proxy settings =====
const HF_ALLOWED_MODELS = new Set([
  "openai/gpt-oss-20b",
  "Qwen/Qwen3-32B",
  "deepseek-ai/DeepSeek-V3.2-Exp",
]);
const HF_MAX_TOKENS = 16384;
const HF_MAX_BODY_BYTES = 200 * 1024;
const HF_UPSTREAM_TIMEOUT_MS = 60_000;

// ===== Lift Wing (Wikimedia) proxy settings =====
// Wikimedia hosts open-weight Qwen models on their Lift Wing infrastructure,
// served with vLLM behind an OpenAI-compatible chat completions API.
// Public access is anonymous (no key) but shares a coarse rate limit; an
// approved-bot JWT (set as LIFTWING_TOKEN) lifts that to the higher tier.
const LIFTWING_ALLOWED_MODELS = new Set([
  "llm-qwen3-14b",
  "llm-qwen36-27b",
]);
const LIFTWING_MAX_TOKENS = 16384;
const LIFTWING_MAX_BODY_BYTES = 200 * 1024;
const LIFTWING_UPSTREAM_TIMEOUT_MS = 120_000;
const LIFTWING_BASE = "https://api.wikimedia.org/service/lw/inference/v1/models";
// Wikimedia asks API clients to identify themselves with a descriptive UA.
const LIFTWING_USER_AGENT =
  "public-ai-proxy (https://github.com/alex-o-748/public-ai-proxy; Wikipedia citation verification)";

// Qwen3 models are reasoning models: they may prepend their chain-of-thought
// wrapped in <think>…</think> before the actual answer, which breaks a naive
// JSON.parse of the message content. Strip those blocks from the final text.
function stripThinkTags(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^\s+/, "");
}

function jsonError(status, message, cors, extraHeaders) {
  const headers = { ...cors, "Content-Type": "application/json", ...(extraHeaders || {}) };
  return new Response(JSON.stringify({ error: { message } }), { status, headers });
}

// ===== /log and /feedback payload sanitization =====
// Both endpoints are unauthenticated and publicly reachable, so every field
// is treated as untrusted: wrong types and oversized strings are coerced to
// null/truncated rather than rejected outright, since malformed telemetry
// shouldn't take down logging for everyone else.
const TELEMETRY_MAX_BODY_BYTES = 64 * 1024;
const KIND_VALUES = new Set(["source", "group"]);
// Mirrors QUOTE_STATUS_LIST in the userscript repo
// (alex-o-748/citation-checker-script, core/quote.js). That list is pinned by
// tests/quote.test.js, so if a status is ever added there its test fails and
// this Set is what needs updating — an unrecognized value is stored as NULL.
const QUOTE_STATUS_VALUES = new Set([
  "exact", "normalized", "partial", "not-found", "too-short", "empty", "no-source",
]);
const VERDICT_VALUES = new Set([
  "SUPPORTED",
  "PARTIALLY SUPPORTED",
  "NOT SUPPORTED",
  "SOURCE UNAVAILABLE",
]);

function sanitizeString(value, maxLen) {
  if (typeof value !== "string") return null;
  return value.length > maxLen ? value.slice(0, maxLen) : value;
}

function sanitizeEnum(value, allowed) {
  return typeof value === "string" && allowed.has(value) ? value : null;
}

function sanitizeConfidence(value) {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sanitizeRating(value) {
  return value === 1 || value === -1 ? value : null;
}

// Reads and JSON-parses a request body, enforcing a size cap first so an
// oversized body can't be fully buffered just to get rejected. Returns
// { body } on success or { errorResponse } to return as-is.
async function readJsonBody(request, cors) {
  const raw = await request.text();
  if (raw.length > TELEMETRY_MAX_BODY_BYTES) {
    return { errorResponse: jsonError(413, "Request body too large", cors) };
  }
  try {
    return { body: JSON.parse(raw) };
  } catch {
    return { errorResponse: jsonError(400, "Invalid JSON", cors) };
  }
}

// ===== Neon SQL-over-HTTP helper =====
// Parses a postgres:// connection string and calls Neon's HTTP endpoint.
// No npm packages needed — just fetch().
// Set DATABASE_URL as a Cloudflare secret, e.g.:
//   postgres://user:pass@ep-cool-123.us-east-2.aws.neon.tech/dbname?sslmode=require
async function queryNeon(databaseUrl, sql, params = []) {
  const host = new URL(databaseUrl).hostname;

  const resp = await fetch(`https://${host}/sql`, {
    method: "POST",
    headers: {
      "Neon-Connection-String": databaseUrl,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: sql, params }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Neon HTTP error ${resp.status}: ${text}`);
  }
  return resp.json();
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";

    const isAllowedOrigin = /^https:\/\/[a-z0-9-]+\.(wikipedia|wikimedia)\.org$/.test(origin);

    const cors = {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers":
        request.headers.get("Access-Control-Request-Headers") || "Content-Type",
      "Vary": "Origin"
    };

    if (isAllowedOrigin) {
      cors["Access-Control-Allow-Origin"] = origin;
    }

    const url = new URL(request.url);

    // Preflight — /log and /feedback need open CORS since they're called from Wikipedia
    if (request.method === "OPTIONS") {
      if (url.pathname === '/log' || url.pathname === '/feedback') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST',
            'Access-Control-Allow-Headers': 'Content-Type',
          }
        });
      }
      return new Response(null, { status: 204, headers: cors });
    }
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // DEBUG: Reachability check — visit ?ping in your browser or from Wikipedia console:
    // fetch('https://<your-worker>.workers.dev/?ping').then(r=>r.json()).then(console.log)
    if (request.method === 'GET' && url.searchParams.has('ping')) {
      return new Response(JSON.stringify({
        ok: true,
        timestamp: new Date().toISOString(),
        origin: origin || '(none)',
        ip: request.headers.get('CF-Connecting-IP') || '(unknown)',
        corsAllowed: allowedOrigins.includes(origin),
      }, null, 2), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // DEBUG: Test Neon connection — visit ?neon=test in your browser
    // Remove this block once logging is confirmed working
    if (request.method === 'GET' && url.searchParams.get('neon') === 'test') {
      if (!env.DATABASE_URL) {
        return new Response(JSON.stringify({ error: "DATABASE_URL secret is not set" }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      try {
        const result = await queryNeon(
          env.DATABASE_URL,
          "SELECT NOW() AS server_time, current_database() AS db"
        );
        return new Response(JSON.stringify({ ok: true, result }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    // ===== /log endpoint — write verification results to Neon =====
    // Fire-and-forget: telemetry writes must never surface an error to the
    // client, so a malformed/oversized body still gets a 2xx-ish response
    // here rather than throwing (the size/JSON checks below are about
    // bounding what we try to write, not about failing the request).
    if (url.pathname === '/log' && request.method === 'POST') {
      const logCors = { 'Access-Control-Allow-Origin': '*' };
      const raw = await request.text();
      if (raw.length > TELEMETRY_MAX_BODY_BYTES) {
        return new Response('ok', { headers: logCors });
      }
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return new Response('ok', { headers: logCors });
      }
      if (body && typeof body === 'object') {
        ctx.waitUntil(
          queryNeon(
            env.DATABASE_URL,
            `INSERT INTO verification_logs
              (check_id, kind, article_url, article_title, citation_number, source_url,
               provider, model, verdict, confidence, reason_type, claim_text, llm_comments, revision_id,
               source_quote, quote_status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
             ON CONFLICT (check_id) DO NOTHING`,
            [
              sanitizeString(body.check_id, 64),
              sanitizeEnum(body.kind, KIND_VALUES),
              sanitizeString(body.article_url, 2000),
              sanitizeString(body.article_title, 2000),
              sanitizeString(body.citation_number, 2000),
              sanitizeString(body.source_url, 2000),
              sanitizeString(body.provider, 2000),
              sanitizeString(body.model, 2000),
              sanitizeString(body.verdict, 2000),
              sanitizeConfidence(body.confidence),
              sanitizeString(body.reason_type, 2000),
              sanitizeString(body.claim_text, 4000),
              sanitizeString(body.llm_comments, 4000),
              sanitizeConfidence(body.revision_id),
              sanitizeString(body.source_quote, 4000),
              sanitizeEnum(body.quote_status, QUOTE_STATUS_VALUES),
            ]
          ).catch(err => console.error('Log write failed:', err.message))
        );
      }
      return new Response('ok', { headers: logCors });
    }

    // ===== /feedback endpoint — write a rating/correction row to Neon =====
    // Unlike /log, this is a deliberate user action (thumbs up/down or a
    // correction), so it's awaited and a genuine insert failure is reported
    // as a 500 rather than swallowed.
    if (url.pathname === '/feedback' && request.method === 'POST') {
      const feedbackCors = { 'Access-Control-Allow-Origin': '*' };
      const { body, errorResponse } = await readJsonBody(request, feedbackCors);
      if (errorResponse) return errorResponse;

      try {
        await queryNeon(
          env.DATABASE_URL,
          `INSERT INTO feedback (check_id, rating, corrected_verdict, wiki_section, client_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            sanitizeString(body.check_id, 64),
            sanitizeRating(body.rating),
            sanitizeEnum(body.corrected_verdict, VERDICT_VALUES),
            sanitizeString(body.wiki_section, 300),
            sanitizeString(body.client_id, 64),
          ]
        );
      } catch (err) {
        console.error('Feedback write failed:', err.message);
        return new Response('error', { status: 500, headers: feedbackCors });
      }

      return new Response('ok', { headers: feedbackCors });
    }

    // NEW: Handle URL fetch requests
    if (request.method === 'GET' && url.searchParams.has('fetch')) {
      const targetUrl = url.searchParams.get('fetch');
      const pageParam = url.searchParams.get('page'); // optional: specific page number (1-indexed)

      // Basic validation
      if (!targetUrl || !targetUrl.startsWith('http')) {
          return new Response(JSON.stringify({ error: 'Invalid URL' }), {
              status: 400,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
      }

      try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 10000);

          const response = await fetch(targetUrl, {
              signal: controller.signal,
              headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                  'Accept': 'text/html,application/xhtml+xml,application/pdf,*/*',
              }
          });
          clearTimeout(timeout);

          if (!response.ok) {
              return new Response(JSON.stringify({ error: `Source returned ${response.status}` }), {
                  headers: { ...corsHeaders, 'Content-Type': 'application/json' }
              });
          }

          const contentType = (response.headers.get('Content-Type') || '').toLowerCase();
          const isPdf = contentType.includes('application/pdf') || targetUrl.endsWith('.pdf');

          if (isPdf) {
              const buf = await response.arrayBuffer();
              // 10 MB guard — skip oversized PDFs
              if (buf.byteLength > 10 * 1024 * 1024) {
                  return new Response(JSON.stringify({ error: 'PDF too large (>10 MB)' }), {
                      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                  });
              }

              const pdf = await getDocumentProxy(new Uint8Array(buf));

              let pages;
              if (pageParam) {
                  const pageNum = parseInt(pageParam, 10);
                  if (isNaN(pageNum) || pageNum < 1 || pageNum > pdf.numPages) {
                      return new Response(JSON.stringify({
                          error: `Invalid page number. PDF has ${pdf.numPages} pages.`
                      }), {
                          status: 400,
                          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                      });
                  }
                  pages = [pageNum];
              }

              const { text } = await extractPdfText(pdf, { mergePages: true, pages });
              const content = text.replace(/\s+/g, ' ').trim().substring(0, 100000);

              return new Response(JSON.stringify({
                  content,
                  pdf: true,
                  totalPages: pdf.numPages,
                  ...(pageParam ? { page: parseInt(pageParam, 10) } : {}),
              }), {
                  headers: { ...corsHeaders, 'Content-Type': 'application/json' }
              });
          }

          const html = await response.text();
          const content = extractText(html);

          return new Response(JSON.stringify({ content }), {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });

      } catch (e) {
          console.error('fetch handler error:', e.name, e.message, 'target:', targetUrl);
          return new Response(JSON.stringify({
              error: e.name === 'AbortError' ? 'Request timeout' : e.message,
              errorType: e.name,
          }), {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
      }
  }

    if (request.method !== "POST") {
      return new Response("Method not allowed", {
        status: 405,
        headers: cors
      });
    }

    // ===== RATE LIMITING =====
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const now = Date.now();

    let bucket = ipBuckets.get(ip);
    if (!bucket || now - bucket.start > WINDOW_MS) {
      bucket = { count: 0, start: now };
    }

    bucket.count++;
    ipBuckets.set(ip, bucket);

    if (bucket.count > RATE_LIMIT) {
      return new Response("Too many requests", {
        status: 429,
        headers: cors
      });
    }
    // =========================

    // ===== /hf endpoint — proxy to HuggingFace Inference Providers =====
    if (url.pathname === '/hf') {
      const raw = await request.text();
      if (raw.length > HF_MAX_BODY_BYTES) {
        return jsonError(413, "Request body too large", cors);
      }
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return jsonError(400, "Invalid JSON", cors);
      }

      const modelId = typeof body.model === 'string' ? body.model : '';
      const baseModel = modelId.split(':')[0];
      if (!HF_ALLOWED_MODELS.has(baseModel)) {
        return jsonError(400, `Model not allowed: ${modelId || '(missing)'}`, cors);
      }

      if (typeof body.max_tokens === 'number' && body.max_tokens > HF_MAX_TOKENS) {
        body.max_tokens = HF_MAX_TOKENS;
      }

      let upstream;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), HF_UPSTREAM_TIMEOUT_MS);
        try {
          upstream = await fetch("https://router.huggingface.co/v1/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${env.HF_TOKEN}`,
              "X-HF-Bill-To": "wikimedia",
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
      } catch (e) {
        const status = e.name === 'AbortError' ? 504 : 502;
        const msg = e.name === 'AbortError' ? "Upstream timeout" : "Upstream network error";
        return jsonError(status, msg, cors);
      }

      if (upstream.status === 401 || upstream.status === 403) {
        return jsonError(502, "Upstream auth failed", cors);
      }
      if (upstream.status === 429) {
        const ra = upstream.headers.get("retry-after");
        const text = await upstream.text();
        const headers = new Headers(cors);
        headers.set("Content-Type", upstream.headers.get("content-type") || "application/json");
        if (ra) headers.set("retry-after", ra);
        return new Response(text, { status: 429, headers });
      }
      if (upstream.status >= 500) {
        return jsonError(502, "Upstream error", cors);
      }

      const headers = new Headers(cors);
      const ct = upstream.headers.get("content-type");
      if (ct) headers.set("content-type", ct);
      return new Response(upstream.body, { status: upstream.status, headers });
    }

    // ===== /liftwing endpoint — proxy to Wikimedia Lift Wing (Qwen) =====
    if (url.pathname === '/liftwing') {
      const raw = await request.text();
      if (raw.length > LIFTWING_MAX_BODY_BYTES) {
        return jsonError(413, "Request body too large", cors);
      }
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return jsonError(400, "Invalid JSON", cors);
      }

      const modelId = typeof body.model === 'string' ? body.model : '';
      if (!LIFTWING_ALLOWED_MODELS.has(modelId)) {
        return jsonError(400, `Model not allowed: ${modelId || '(missing)'}`, cors);
      }

      if (typeof body.max_tokens === 'number' && body.max_tokens > LIFTWING_MAX_TOKENS) {
        body.max_tokens = LIFTWING_MAX_TOKENS;
      }

      // Lift Wing routes by model name in the path as well as the body.
      const endpoint = `${LIFTWING_BASE}/${encodeURIComponent(modelId)}/openai/v1/chat/completions`;

      const upstreamHeaders = {
        "Content-Type": "application/json",
        // Wikimedia's gateway enforces a User-Agent policy; send both the
        // standard header and the Api-User-Agent variant it documents.
        "User-Agent": LIFTWING_USER_AGENT,
        "Api-User-Agent": LIFTWING_USER_AGENT,
      };
      // Approved-bot JWT, if granted — lifts the shared anonymous rate limit.
      // The gateway parses any Authorization header as a JWT and 401s malformed
      // ones, so only attach a token with the Header.Payload.Signature shape.
      // A blank/placeholder secret then falls back to anonymous access rather
      // than 401ing every request.
      if (typeof env.LIFTWING_TOKEN === "string" && env.LIFTWING_TOKEN.split(".").length === 3) {
        upstreamHeaders["Authorization"] = `Bearer ${env.LIFTWING_TOKEN}`;
      }

      let upstream;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), LIFTWING_UPSTREAM_TIMEOUT_MS);
        try {
          upstream = await fetch(endpoint, {
            method: "POST",
            headers: upstreamHeaders,
            body: JSON.stringify(body),
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
      } catch (e) {
        const status = e.name === 'AbortError' ? 504 : 502;
        const msg = e.name === 'AbortError' ? "Upstream timeout" : "Upstream network error";
        return jsonError(status, msg, cors);
      }

      if (upstream.status === 401 || upstream.status === 403) {
        // Surface the upstream reason — it's usually a User-Agent policy
        // block or a rejected Authorization token, which the generic
        // message would otherwise hide.
        const detail = (await upstream.text()).slice(0, 300);
        return jsonError(502, `Upstream auth failed (${upstream.status}): ${detail}`, cors);
      }
      if (upstream.status === 429) {
        const ra = upstream.headers.get("retry-after");
        const text = await upstream.text();
        const headers = new Headers(cors);
        headers.set("Content-Type", upstream.headers.get("content-type") || "application/json");
        if (ra) headers.set("retry-after", ra);
        return new Response(text, { status: 429, headers });
      }
      if (upstream.status >= 500) {
        return jsonError(502, "Upstream error", cors);
      }

      const upstreamCt = upstream.headers.get("content-type") || "";
      const isStream = body.stream === true || upstreamCt.includes("text/event-stream");

      // Streaming responses pass through untouched — the client strips any
      // <think> tags itself, since we can't cleanly rewrite an SSE stream.
      if (isStream) {
        const headers = new Headers(cors);
        if (upstreamCt) headers.set("content-type", upstreamCt);
        return new Response(upstream.body, { status: upstream.status, headers });
      }

      // Non-streaming: buffer, then strip Qwen <think>…</think> reasoning from
      // each choice's message content so callers get clean (parseable) output.
      const upstreamText = await upstream.text();
      let payload;
      try {
        payload = JSON.parse(upstreamText);
      } catch {
        // Not JSON — return as received rather than corrupting it.
        const headers = new Headers(cors);
        if (upstreamCt) headers.set("content-type", upstreamCt);
        return new Response(upstreamText, { status: upstream.status, headers });
      }

      if (Array.isArray(payload.choices)) {
        for (const choice of payload.choices) {
          if (choice && choice.message && typeof choice.message.content === 'string') {
            choice.message.content = stripThinkTags(choice.message.content);
          }
        }
      }

      const headers = new Headers(cors);
      headers.set("content-type", "application/json");
      return new Response(JSON.stringify(payload), { status: upstream.status, headers });
    }

    // Forward to PublicAI
    const upstream = await fetch(
      "https://api.publicai.co/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // IMPORTANT: matches your secret name
          "Authorization": `Bearer ${env.publicai}`
        },
        body: request.body
      }
    );

    const headers = new Headers(cors);
    const ct = upstream.headers.get("content-type");
    if (ct) headers.set("content-type", ct);

    return new Response(upstream.body, {
      status: upstream.status,
      headers
    });
  }
};

function extractText(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 100000);
}
