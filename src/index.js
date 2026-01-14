// ===== Rate limit settings =====
const RATE_LIMIT = 20;        // requests
const WINDOW_MS = 60_000;    // per minute

// Best-effort per-IP buckets (free, in-memory)
const ipBuckets = new Map();

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    const allowedOrigins = [
      "https://en.wikipedia.org",
      "https://www.wikipedia.org"
    ];

    const cors = {
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers":
        request.headers.get("Access-Control-Request-Headers") || "Content-Type",
      "Vary": "Origin"
    };

    if (allowedOrigins.includes(origin)) {
      cors["Access-Control-Allow-Origin"] = origin;
    }

    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // NEW: Handle URL fetch requests
    if (request.method === 'GET' && url.searchParams.has('fetch')) {
      const targetUrl = url.searchParams.get('fetch');
      
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
                  'Accept': 'text/html,application/xhtml+xml',
              }
          });
          clearTimeout(timeout);
          
          if (!response.ok) {
              return new Response(JSON.stringify({ error: `Source returned ${response.status}` }), {
                  headers: { ...corsHeaders, 'Content-Type': 'application/json' }
              });
          }
          
          const html = await response.text();
          const content = extractText(html);
          
          return new Response(JSON.stringify({ content }), {
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
          
      } catch (e) {
          return new Response(JSON.stringify({ 
              error: e.name === 'AbortError' ? 'Request timeout' : e.message 
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
    .substring(0, 12000);
}
