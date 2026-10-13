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
  "zai-org/GLM-5.2",
]);
const HF_MAX_TOKENS = 16384;
const HF_MAX_BODY_BYTES = 200 * 1024;
const HF_UPSTREAM_TIMEOUT_MS = 60_000;

// ===== Tavily relay settings =====
const TAVILY_MAX_BODY_BYTES = 16 * 1024;
const TAVILY_UPSTREAM_TIMEOUT_MS = 60_000;

// The Worker's own key (the TAVILY_API_KEY secret) pays for callers who send
// none, while its credits last. It never leaves the Worker: a key in the user
// script would be on a public wiki page for anyone to take.
const TAVILY_SHARED_MAX_RESULTS = 10;
const TAVILY_SHARED_PER_IP = 50;              // searches on the shared key
const TAVILY_SHARED_WINDOW_MS = 60 * 60_000;  // per hour
const TAVILY_USAGE_TTL_MS = 5 * 60_000;       // how long a /usage reading is trusted
// Tavily's codes for a key over its plan's or its pay-as-you-go limit.
const TAVILY_OUT_OF_CREDITS = new Set([432, 433]);
const tavilySharedBuckets = new Map();
let tavilyUsage = null; // { at, remaining } — remaining is null when unknown

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

// ===== Internet Archive: search inside a book =====
// The search archive.org's book reader runs: every paragraph of one book that
// holds a term, with the scanned leaf it is on. It is served by the item's
// numbered server (ia8xxxxx.us.archive.org), which Wikipedia's
// Content-Security-Policy refuses, so the user script reaches it through
// here. Open books only: without an archive.org login, inside.php answers 403
// for a book in the lending library.
const ARCHIVE_METADATA_URL = "https://archive.org/metadata/";
const ARCHIVE_USER_AGENT =
  "public-ai-proxy (https://github.com/alex-o-748/public-ai-proxy; CNfirmed: search inside a book)";
const ARCHIVE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const ARCHIVE_SERVER = /^[a-z0-9-]+\.us\.archive\.org$/;
const ARCHIVE_DIR = /^\/[A-Za-z0-9._/-]+$/;
const INSIDE_PER_IP = 60;               // requests
const INSIDE_WINDOW_MS = 60_000;        // per minute
const INSIDE_MAX_TERMS = 3;
const INSIDE_MAX_TERM_CHARS = 100;
const INSIDE_MAX_DOC_CHARS = 512;
const INSIDE_MAX_MATCHES = 40;          // paragraphs returned, most terms first
const INSIDE_MAX_TEXT_CHARS = 1500;     // of a paragraph, around its hits
// A common word in a long book is megabytes of matches; such a term is
// reported as failed rather than read.
const INSIDE_MAX_UPSTREAM_CHARS = 4_000_000;
const INSIDE_METADATA_TIMEOUT_MS = 15_000;
const INSIDE_SEARCH_TIMEOUT_MS = 30_000;
const INSIDE_PRE = "{{{";
const INSIDE_POST = "}}}";
// A book's OCR files. Their name before the suffix is the book's `doc`: the
// item's identifier, or for an item holding several books, each book's own.
const BOOK_TEXT_SUFFIXES = ["_djvu.txt", "_djvu.xml", "_hocr_searchtext.txt.gz"];
// inside.php's answer when it has no word positions for that `doc`.
const NO_LAYOUT = /no hocr or abbyy/i;
const insideBuckets = new Map();

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

// ===== Tavily shared credits =====
// An advanced search costs 2 credits, a basic one 1.
function tavilyCost(body) {
  return body.search_depth === "basic" ? 1 : 2;
}

// Credits the shared key has left, from Tavily's /usage: the smallest of the
// key's own limit and the account's plan (plus pay-as-you-go) allowance.
function tavilyCreditsLeft(usage) {
  const key = usage && usage.key;
  const account = usage && usage.account;
  const left = [];
  if (key && typeof key.limit === "number") left.push(key.limit - (key.usage || 0));
  if (account && typeof account.plan_limit === "number") {
    let plan = account.plan_limit - (account.plan_usage || 0);
    if (typeof account.paygo_limit === "number") {
      plan += Math.max(0, account.paygo_limit - (account.paygo_usage || 0));
    }
    left.push(plan);
  }
  return left.length ? Math.max(0, Math.min(...left)) : null;
}

// Cached for a few minutes, and counted down locally between readings, so a
// search does not cost a /usage call. A reading that fails is null: searches
// go ahead, and Tavily's own refusal (432/433) is what stops them.
async function tavilySharedRemaining(env) {
  if (!env.TAVILY_API_KEY) return 0;
  const now = Date.now();
  if (tavilyUsage && now - tavilyUsage.at < TAVILY_USAGE_TTL_MS) return tavilyUsage.remaining;
  let remaining = null;
  try {
    const res = await fetch("https://api.tavily.com/usage", {
      headers: { "Authorization": `Bearer ${env.TAVILY_API_KEY}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) remaining = tavilyCreditsLeft(await res.json());
  } catch {
    // Unknown; see above.
  }
  tavilyUsage = { at: now, remaining };
  return remaining;
}

function tavilySpend(credits) {
  if (tavilyUsage && tavilyUsage.remaining !== null) {
    tavilyUsage.remaining = Math.max(0, tavilyUsage.remaining - credits);
  }
}

// What the shared key will pay for: a search, at most advanced depth, with
// a bounded number of results. Callers with their own key send what they like.
function tavilySharedBody(body) {
  const out = { ...body };
  out.search_depth = body.search_depth === "basic" ? "basic" : "advanced";
  delete out.auto_parameters; // may pick a dearer depth on its own
  const n = Number(body.max_results);
  out.max_results = Number.isFinite(n) ? Math.min(Math.max(1, Math.floor(n)), TAVILY_SHARED_MAX_RESULTS) : 5;
  return out;
}

// The user script tells this apart from other errors (code
// "free_credits_exhausted") to ask for the user's own key.
function noFreeCredits(message, cors) {
  return new Response(
    JSON.stringify({ error: { code: "free_credits_exhausted", message } }),
    { status: 402, headers: { ...cors, "Content-Type": "application/json" } },
  );
}

// ===== /archive/inside: search inside one book =====
function archiveError(status, code, message, cors, maxAgeS) {
  const headers = { ...cors, "Content-Type": "application/json" };
  if (maxAgeS) headers["Cache-Control"] = `public, max-age=${maxAgeS}`;
  return new Response(JSON.stringify({ error: { code, message } }), { status, headers });
}

// Seconds to wait when over the limit, or 0.
function overLimit(buckets, ip, limit, windowMs) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now - b.start > windowMs) b = { count: 0, start: now };
  b.count++;
  buckets.set(ip, b);
  return b.count > limit ? Math.max(1, Math.ceil((b.start + windowMs - now) / 1000)) : 0;
}

// One field of an item's metadata, read through the API's sub-paths
// (`/metadata/{id}/server`), since a whole record runs to megabytes for an
// item holding hundreds of books. Undefined when the item has no such field
// or does not exist; throws when the API cannot be read.
async function archiveMetadataField(id, field) {
  const res = await fetch(`${ARCHIVE_METADATA_URL}${encodeURIComponent(id)}/${field}`, {
    headers: { "User-Agent": ARCHIVE_USER_AGENT, "Accept": "application/json" },
    signal: AbortSignal.timeout(INSIDE_METADATA_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`metadata HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > INSIDE_MAX_UPSTREAM_CHARS) throw new Error("metadata too large");
  const data = JSON.parse(text);
  return data && typeof data === "object" && "result" in data ? data.result : undefined;
}

// The books an item's files hold, by their `doc` name.
function bookDocs(files) {
  const out = new Set();
  for (const f of Array.isArray(files) ? files : []) {
    const name = f && typeof f.name === "string" ? f.name : "";
    for (const s of BOOK_TEXT_SUFFIXES) if (name.endsWith(s)) out.add(name.slice(0, -s.length));
  }
  return [...out];
}

// A book's name is a path inside the item ("2004/Issue 10 (2004-10)"), and
// may begin with a space: kept as given, but never leaving the item.
function validDoc(doc) {
  return doc.length > 0 && doc.length <= INSIDE_MAX_DOC_CHARS && !/[\u0000-\u001f]/.test(doc) &&
    !doc.startsWith("/") && !doc.split("/").some((part) => part === "." || part === "..");
}

// The book reader's own request. inside.php does not read an encoded slash,
// so the item's path and the book's name keep theirs, as the reader sends them.
function insideUrl(server, id, doc, dir, term) {
  const params = new URLSearchParams({
    item_id: id, doc, path: dir, q: term, pre_tag: INSIDE_PRE, post_tag: INSIDE_POST,
  });
  return `https://${server}/fulltext/inside.php?${params.toString().replace(/%2F/g, "/")}`;
}

function pageNumbersUrl(server, dir, doc) {
  return `https://${server}${dir}/${doc.split("/").map(encodeURIComponent).join("/")}_page_numbers.json`;
}

// One term searched inside the book: its matches, or why there are none.
async function searchInsideTerm(server, id, doc, dir, term) {
  let res;
  try {
    res = await fetch(insideUrl(server, id, doc, dir, term), {
      headers: { "User-Agent": ARCHIVE_USER_AGENT, "Accept": "application/json" },
      signal: AbortSignal.timeout(INSIDE_SEARCH_TIMEOUT_MS),
    });
  } catch (e) {
    return { error: e.name === "TimeoutError" || e.name === "AbortError" ? "timeout" : "network error" };
  }
  if (res.status === 403) return { restricted: true };
  if (!res.ok) return { error: `HTTP ${res.status}` };
  const text = await res.text();
  if (text.length > INSIDE_MAX_UPSTREAM_CHARS) return { error: "too many matches" };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: "unreadable reply" };
  }
  const matches = data && Array.isArray(data.matches) ? data.matches : [];
  if (!matches.length && data && data.error) {
    return NO_LAYOUT.test(String(data.error)) ? { noLayout: true } : { error: String(data.error).slice(0, 200) };
  }
  return { matches };
}

// The book's printed page numbers by leaf, from the `_page_numbers.json` the
// Archive works out from the scans (what its reader shows), with its overall
// confidence. Null when the book has none.
async function pageNumbers(server, dir, doc) {
  try {
    const res = await fetch(pageNumbersUrl(server, dir, doc), {
      headers: { "User-Agent": ARCHIVE_USER_AGENT, "Accept": "application/json" },
      signal: AbortSignal.timeout(INSIDE_METADATA_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const byLeaf = new Map();
    for (const p of Array.isArray(data && data.pages) ? data.pages : []) {
      const page = p && typeof p.pageNumber === "string" ? p.pageNumber.trim() : "";
      if (Number.isInteger(p && p.leafNum) && page) byLeaf.set(p.leafNum, page);
    }
    return { byLeaf, confidence: typeof data.confidence === "number" ? data.confidence : null };
  } catch {
    return null;
  }
}

// A paragraph without its hit markers, and where each hit begins in it.
function unmark(text) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  let plain = "";
  const hits = [];
  for (let i = 0; i < t.length;) {
    if (t.startsWith(INSIDE_PRE, i)) {
      hits.push(plain.length);
      i += INSIDE_PRE.length;
    } else if (t.startsWith(INSIDE_POST, i)) {
      i += INSIDE_POST.length;
    } else {
      plain += t[i++];
    }
  }
  return { plain, hits };
}

// At most `max` characters of a paragraph: the stretch holding the most hits,
// cut at spaces, "…" where it was cut.
function windowAround(plain, hits, max) {
  if (plain.length <= max) return plain;
  let start = 0;
  let best = -1;
  for (const h of hits.length ? hits : [0]) {
    const s = Math.max(0, Math.min(h - Math.floor(max / 4), plain.length - max));
    const n = hits.filter((x) => x >= s && x < s + max).length;
    if (n > best) {
      best = n;
      start = s;
    }
  }
  let w = plain.slice(start, start + max);
  if (start > 0) w = `…${w.replace(/^\S*\s/, "")}`;
  if (start + max < plain.length) w = `${w.replace(/\s\S*$/, "")}…`;
  return w;
}

// Every term's matches as one list of paragraphs, each once with the terms it
// holds: the most terms first, then in the book's order. A paragraph that
// runs onto the next page says so (leafEnd).
function mergeMatches(perTerm, byLeaf) {
  const leafOf = (p) => (p && Number.isInteger(p.page) ? p.page : null);
  const seen = new Map();
  perTerm.forEach((r, term) => {
    for (const m of r.matches || []) {
      const par = Array.isArray(m && m.par) ? m.par : [];
      const leaf = leafOf(par[0]);
      const { plain, hits } = unmark(m && m.text);
      if (!plain) continue;
      const key = `${leaf}\u0000${plain}`;
      let e = seen.get(key);
      if (!e) {
        e = { plain, hits: [], terms: [], leaf, leafEnd: leafOf(par[par.length - 1]) };
        seen.set(key, e);
      }
      if (!e.terms.includes(term)) e.terms.push(term);
      for (const h of hits) if (!e.hits.includes(h)) e.hits.push(h);
    }
  });
  const page = (leaf) => (byLeaf && leaf !== null && byLeaf.get(leaf)) || null;
  return [...seen.values()]
    .sort((a, b) => b.terms.length - a.terms.length || (a.leaf ?? 0) - (b.leaf ?? 0))
    .slice(0, INSIDE_MAX_MATCHES)
    .map((e) => {
      const out = {
        text: windowAround(e.plain, e.hits.sort((x, y) => x - y), INSIDE_MAX_TEXT_CHARS),
        terms: e.terms.sort((x, y) => x - y),
        leaf: e.leaf,
        page: page(e.leaf),
      };
      if (e.leafEnd !== null && e.leafEnd !== e.leaf) {
        out.leafEnd = e.leafEnd;
        out.pageEnd = page(e.leafEnd);
      }
      return out;
    });
}

// GET /archive/inside?id=<identifier>&doc=<book>&q=<term>[&q=<term>…]
async function archiveInside(url, ip, cors) {
  const wait = overLimit(insideBuckets, ip, INSIDE_PER_IP, INSIDE_WINDOW_MS);
  if (wait) {
    return new Response(JSON.stringify({ error: { code: "rate_limited", message: "Too many searches; try again shortly" } }), {
      status: 429,
      headers: { ...cors, "Content-Type": "application/json", "Retry-After": String(wait) },
    });
  }
  const id = url.searchParams.get("id") || "";
  if (!ARCHIVE_ID.test(id)) return archiveError(400, "bad_request", "id: an Internet Archive identifier", cors);
  const docParam = url.searchParams.get("doc");
  if (docParam !== null && !validDoc(docParam)) return archiveError(400, "bad_request", "doc: a book in the item", cors);
  // The reader takes a slash out of a term too: it would end the path.
  const terms = [...new Set(url.searchParams.getAll("q")
    .map((q) => q.replace(/\//g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean))];
  if (!terms.length || terms.length > INSIDE_MAX_TERMS ||
      terms.some((t) => t.length > INSIDE_MAX_TERM_CHARS || /[\u0000-\u001f]/.test(t))) {
    return archiveError(400, "bad_request", `q: one to ${INSIDE_MAX_TERMS} terms of up to ${INSIDE_MAX_TERM_CHARS} characters`, cors);
  }

  let server;
  let dir;
  try {
    [server, dir] = await Promise.all([archiveMetadataField(id, "server"), archiveMetadataField(id, "dir")]);
  } catch {
    return archiveError(502, "upstream_error", "Could not read the item's metadata", cors);
  }
  if (typeof server !== "string" || typeof dir !== "string") {
    return archiveError(404, "not_found", "No such item on the Internet Archive", cors, 3600);
  }
  if (!ARCHIVE_SERVER.test(server) || !ARCHIVE_DIR.test(dir) || dir.split("/").includes("..")) {
    return archiveError(502, "upstream_error", "Unexpected item location", cors);
  }

  let doc = docParam ?? id;
  const searchAll = (d) => Promise.all(terms.map((t) => searchInsideTerm(server, id, d, dir, t)));
  let results = await searchAll(doc);
  // Asked for no book in particular, the item's one book may not be named
  // after the item ("History of Civilizations of Central Asia, Volume 2").
  if (docParam === null && results.every((r) => r.noLayout)) {
    let books = null;
    try {
      books = bookDocs(await archiveMetadataField(id, "files"));
    } catch {
      books = null;
    }
    if (books && books.length > 1) {
      return archiveError(400, "bundle", `This item holds ${books.length} books: name one in doc`, cors, 3600);
    }
    if (books && books.length === 1 && books[0] !== doc) {
      doc = books[0];
      results = await searchAll(doc);
    }
  }
  if (results.some((r) => r.restricted)) {
    return archiveError(403, "restricted", "Only open books can be searched inside: this one is lent, or restricted", cors, 3600);
  }
  if (results.every((r) => r.noLayout)) {
    return archiveError(404, "no_text", "The Archive has no searchable text for this book", cors, 3600);
  }
  if (results.every((r) => !r.matches)) {
    const timedOut = results.some((r) => r.error === "timeout");
    return archiveError(timedOut ? 504 : 502, "upstream_error", `Search inside failed: ${results.map((r) => r.error || "no text").join("; ")}`, cors);
  }

  const pages = results.some((r) => r.matches && r.matches.length) ? await pageNumbers(server, dir, doc) : null;
  const body = {
    id,
    doc,
    q: terms,
    // Matches per term; null for a term whose search failed.
    counts: results.map((r) => (r.matches ? r.matches.length : null)),
    pageConfidence: pages ? pages.confidence : null,
    matches: mergeMatches(results, pages && pages.byLeaf),
  };
  return new Response(JSON.stringify(body), {
    headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" },
  });
}

// ===== /log and /feedback payload sanitization =====
// Both endpoints are unauthenticated and publicly reachable, so every field
// is treated as untrusted: wrong types and oversized strings are coerced to
// null/truncated rather than rejected outright, since malformed telemetry
// shouldn't take down logging for everyone else.
const TELEMETRY_MAX_BODY_BYTES = 64 * 1024;
const KIND_VALUES = new Set(["source", "group"]);
// Outcome of checking the model's source_quote against the source text it was
// shown. Enumerated rather than free text so a client typo lands as null
// instead of seeding a junk value into a column we group by.
const QUOTE_STATUS_VALUES = new Set([
  "exact",
  "normalized",
  "partial",
  "not-found",
  "too-short",
  "empty",
  "no-source",
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

    // ===== GET /tavily — are free (shared-key) searches available? =====
    if (url.pathname === '/tavily' && request.method === 'GET') {
      const remaining = await tavilySharedRemaining(env);
      return new Response(JSON.stringify({
        shared: remaining === null || remaining >= 2,
        remaining,
      }), { headers: { ...cors, "Content-Type": "application/json" } });
    }

    // ===== GET /archive/inside — search inside one Internet Archive book =====
    if (url.pathname === '/archive/inside' && request.method === 'GET') {
      return archiveInside(url, request.headers.get("CF-Connecting-IP") || "unknown", cors);
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

    // ===== /tavily endpoint — relay to Tavily search =====
    // Wikipedia's Content-Security-Policy blocks api.tavily.com from user
    // scripts, so they reach it through here. A caller's own Tavily key (its
    // Authorization header) is passed through; a caller without one searches
    // on the Worker's key (TAVILY_API_KEY) while its credits last.
    if (url.pathname === '/tavily') {
      const callerAuth = request.headers.get("Authorization") || "";
      if (callerAuth && !/^Bearer \S+$/.test(callerAuth)) {
        return jsonError(401, "Malformed Tavily API key", cors);
      }
      const shared = !callerAuth;
      const raw = await request.text();
      if (raw.length > TAVILY_MAX_BODY_BYTES) {
        return jsonError(413, "Request body too large", cors);
      }
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return jsonError(400, "Invalid JSON", cors);
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return jsonError(400, "Invalid JSON", cors);
      }

      let auth = callerAuth;
      let sendBody = raw;
      if (shared) {
        // Only the user script, on Wikipedia, gets the shared key.
        if (!isAllowedOrigin) {
          return jsonError(403, "Free searches are for the CNfirmed user script on Wikipedia", cors);
        }
        const remaining = await tavilySharedRemaining(env);
        if (!env.TAVILY_API_KEY || (remaining !== null && remaining < tavilyCost(body))) {
          return noFreeCredits("No free web searches left", cors);
        }
        let b = tavilySharedBuckets.get(ip);
        if (!b || now - b.start > TAVILY_SHARED_WINDOW_MS) b = { count: 0, start: now };
        b.count++;
        tavilySharedBuckets.set(ip, b);
        if (b.count > TAVILY_SHARED_PER_IP) {
          return jsonError(429, "Too many free searches this hour; try again later or add your own Tavily key", cors);
        }
        body = tavilySharedBody(body);
        sendBody = JSON.stringify(body);
        auth = `Bearer ${env.TAVILY_API_KEY}`;
      }

      let upstream;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TAVILY_UPSTREAM_TIMEOUT_MS);
        try {
          upstream = await fetch("https://api.tavily.com/search", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": auth },
            body: sendBody,
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

      if (shared) {
        if (TAVILY_OUT_OF_CREDITS.has(upstream.status) || upstream.status === 401) {
          // Spent, or the key was revoked: no free searches until the
          // next /usage reading says otherwise.
          tavilyUsage = { at: Date.now(), remaining: 0 };
          return noFreeCredits("No free web searches left", cors);
        }
        if (upstream.ok) tavilySpend(tavilyCost(body));
        else if (upstream.status >= 400 && upstream.status < 500) {
          // Tavily's message could name the shared key's account; keep it.
          return jsonError(upstream.status, `Tavily refused the search (${upstream.status})`, cors);
        }
      }

      // With the caller's own key, errors pass through as Tavily sent them:
      // a bad key or spent credits are the caller's to see and fix.
      const headers = new Headers(cors);
      const ct = upstream.headers.get("content-type");
      if (ct) headers.set("content-type", ct);
      return new Response(upstream.body, { status: upstream.status, headers });
    }

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
