// extract-relevant-content.mjs
//
// Query-aware extraction of relevant snippets from a long source document.
// Pure ES module, no DOM, no Node-only APIs — runs in a Cloudflare Worker
// or under Node 14+. The companion sanity test (sanity-test.mjs) imports
// from this file directly.
//
// Ported from wikidata-SIFT/scripts/tool_executor.py (`_extract_query_matches`
// + the lead/excerpts logic in `web_fetch`). Designed for issue
// alex-o-748/citation-checker-script#88: "Prioritize conclusion section when
// truncating long sources".
//
// The strategy generalizes the user request: instead of always favoring the
// conclusion, we always include the page lead (where infoboxes / abstracts /
// thesis statements live) and then add the paragraphs that actually contain
// the claim's terms — wherever those paragraphs sit (intro, middle, or
// conclusion).
//
// Usage:
//
//   const out = extractRelevantContent(fullPlainText, claimText, {
//       leadChars: 2500,
//       matchWindow: 600,
//       maxMatches: 8,
//       maxTotalChars: 9000,
//       fallbackChars: 5000,
//   });
//   // out.text is the snippet to send to the LLM
//   // out.truncated is true iff the source was reduced
//   // out.matches is the count of paragraphs picked by query
//   // out.fullLength is the original length

const DEFAULTS = Object.freeze({
    leadChars: 2500,        // always-included lead/intro
    matchWindow: 600,       // chars around each query match (per side)
    maxMatches: 8,          // cap distinct matches returned
    maxTotalChars: 9000,    // hard cap on total returned text
    fallbackChars: 5000,    // when no query or no matches, return head of page
});

// Escape a string for safe use inside a RegExp.
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Tokenize a free-text claim into useful query terms.
// Strategy: drop stopwords, dedupe, prefer multi-character tokens, and
// also keep any quoted phrases as-is (multi-word tokens). This is a
// best-effort mirror of how a human would skim a source for the claim.
const STOPWORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'being',
    'by', 'for', 'from', 'has', 'have', 'in', 'is', 'it', 'its',
    'of', 'on', 'or', 'that', 'the', 'to', 'was', 'were', 'with',
    'which', 'who', 'whom', 'this', 'these', 'those', 'their',
    'they', 'them', 'but', 'not', 'no', 'so', 'than', 'then',
    'will', 'would', 'could', 'should', 'may', 'might', 'can',
    'about', 'into', 'over', 'under', 'between', 'after', 'before',
]);

function tokenizeClaim(claim) {
    if (!claim) return [];
    const terms = [];
    const seen = new Set();

    // First pull out quoted phrases verbatim
    const quoted = claim.match(/"([^"]+)"|'([^']+)'/g) || [];
    let stripped = claim;
    for (const q of quoted) {
        const phrase = q.slice(1, -1).trim();
        if (phrase.length >= 3 && !seen.has(phrase.toLowerCase())) {
            terms.push(phrase);
            seen.add(phrase.toLowerCase());
        }
        stripped = stripped.replace(q, ' ');
    }

    // Then individual tokens, preserving original case for proper-noun-ish
    // matches but deduping case-insensitively.
    const tokens = stripped.split(/[^A-Za-z0-9À-ɏͰ-῿Ⰰ-￿]+/);
    for (const tok of tokens) {
        if (!tok) continue;
        const lower = tok.toLowerCase();
        if (STOPWORDS.has(lower)) continue;
        if (tok.length < 3 && !/^\d+$/.test(tok)) continue; // keep numbers
        if (seen.has(lower)) continue;
        seen.add(lower);
        terms.push(tok);
    }
    return terms;
}

// Find paragraphs containing any of the query terms.
// Returns: array of { term, excerpt } up to opts.maxMatches.
function extractQueryMatches(text, terms, opts) {
    if (!terms.length) return [];

    // Split on blank-line paragraph boundaries first; if the source has no
    // double-newlines (which happens when the upstream extractor squeezed
    // them out), fall back to single-newline lines, and then to sentences.
    let paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
    if (paragraphs.length <= 1) {
        paragraphs = text.split(/\n+/).map(p => p.trim()).filter(Boolean);
    }
    if (paragraphs.length <= 1) {
        // Sentence-like fallback. Keep the splitter cheap; we are only trying
        // to give the windowing logic something to work with.
        paragraphs = text.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(\[])/).filter(Boolean);
    }

    if (paragraphs.length === 0) return [];

    // Build per-term metadata: regex, document frequency (paragraph count that
    // contains the term), and a weight combining rarity + information boost.
    //
    // Weight rationale:
    //   rarity = log(N / df)  — classic IDF over paragraphs. Tokens in every
    //     paragraph score 0 (they discriminate nothing); tokens in one
    //     paragraph score log(N) (strongly discriminating).
    //   boost  = 2 for capitalized or purely-numeric tokens. These are
    //     proper nouns and years/numbers, which tend to be the highest-
    //     information tokens in Wikipedia-prose claims.
    //   weight = rarity * boost, with a floor of rarity so that rare
    //     lowercase tokens still score above 0.
    //
    // Terms that match zero paragraphs get weight 0 and are dropped (they
    // can't contribute). Terms that match every paragraph also get weight 0
    // (they carry no signal) but are kept for the fallback-message path so
    // we can report what we looked for.
    const N = paragraphs.length;
    const termInfo = terms.map(term => {
        const re = term.includes(' ')
            ? new RegExp(escapeRegExp(term), 'i')
            : new RegExp('\\b' + escapeRegExp(term) + '\\b', 'i');
        let df = 0;
        for (const para of paragraphs) {
            if (re.test(para)) df += 1;
        }
        const isCapitalized = /^[A-Z]/.test(term);
        const isNumeric = /^\d+$/.test(term);
        const boost = isCapitalized || isNumeric ? 2 : 1;
        const rarity = df === 0 || df === N ? 0 : Math.log(N / df);
        const weight = rarity * boost;
        return { term, re, df, weight };
    });

    const scoring = termInfo.filter(t => t.weight > 0);
    if (scoring.length === 0) return [];

    // Score each paragraph: sum of weights of matching terms. Tie-break by
    // match count (denser evidence beats thinly-weighted single hits).
    const scored = [];
    for (const para of paragraphs) {
        let score = 0;
        const hitTerms = [];
        for (const info of scoring) {
            if (info.re.test(para)) {
                score += info.weight;
                hitTerms.push(info);
            }
        }
        if (score > 0) {
            scored.push({ para, score, hitTerms });
        }
    }

    if (scored.length === 0) return [];

    // Highest-scoring paragraphs first; break ties by number of distinct
    // term hits, then by length (prefer fuller context) .
    scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (b.hitTerms.length !== a.hitTerms.length) return b.hitTerms.length - a.hitTerms.length;
        return b.para.length - a.para.length;
    });

    const matches = [];
    const seenStarts = new Set();

    for (const { para, hitTerms } of scored) {
        if (matches.length >= opts.maxMatches) break;

        // Dedupe by prefix so near-duplicate paragraphs don't crowd out
        // other matches.
        const key = para.slice(0, 60);
        if (seenStarts.has(key)) continue;
        seenStarts.add(key);

        // Pick the highest-weight hit term to center the excerpt window on.
        const primary = hitTerms.reduce((a, b) => (b.weight > a.weight ? b : a));
        const m = primary.re.exec(para);

        let excerpt;
        if (para.length > opts.matchWindow * 2 && m) {
            const start = Math.max(0, m.index - opts.matchWindow);
            const end = Math.min(para.length, m.index + m[0].length + opts.matchWindow);
            excerpt = (start > 0 ? '...' : '') + para.slice(start, end) + (end < para.length ? '...' : '');
        } else {
            excerpt = para;
        }
        matches.push({ term: primary.term, excerpt });
    }

    return matches;
}

/**
 * Extract a query-aware snippet from a long source document.
 *
 * @param {string} text          Full extracted plain text from the source.
 * @param {string|null} query    Free-text claim, or comma-separated terms,
 *                               or null/empty for fallback head-of-page.
 * @param {object} [options]     Override defaults (leadChars, matchWindow,
 *                               maxMatches, maxTotalChars, fallbackChars).
 * @returns {{ text: string,
 *             truncated: boolean,
 *             matches: number,
 *             fullLength: number,
 *             strategy: 'short'|'fallback'|'lead-only'|'lead+matches'|'lead+head+tail' }}
 */
function extractRelevantContent(text, query, options) {
    const opts = Object.assign({}, DEFAULTS, options || {});
    const fullLength = text ? text.length : 0;

    if (!text) {
        return { text: '', truncated: false, matches: 0, fullLength: 0, strategy: 'short' };
    }

    // No reduction needed: short enough to send whole.
    if (fullLength <= opts.maxTotalChars && (!query || fullLength <= opts.leadChars + opts.matchWindow)) {
        return { text, truncated: false, matches: 0, fullLength, strategy: 'short' };
    }

    // No query: fall back to head-of-page snapshot.
    if (!query || !query.trim()) {
        if (fullLength <= opts.fallbackChars) {
            return { text, truncated: false, matches: 0, fullLength, strategy: 'fallback' };
        }
        return {
            text: text.slice(0, opts.fallbackChars) +
                  `\n\n[Truncated — full page was ${fullLength} chars; ` +
                  'pass a query to get targeted excerpts]',
            truncated: true,
            matches: 0,
            fullLength,
            strategy: 'fallback',
        };
    }

    // Query path.
    const lead = text.slice(0, opts.leadChars);
    const leadTruncated = fullLength > opts.leadChars;
    const restOfPage = text.slice(opts.leadChars);

    // Accept either a free-text claim (we tokenize) or a comma-separated
    // term list (we use as-is). Heuristic: a comma-bearing string with no
    // spaces around commas looks intentional.
    let terms;
    if (query.includes(',') && !/\s,/.test(query)) {
        terms = query.split(',').map(t => t.trim()).filter(Boolean);
    } else {
        terms = tokenizeClaim(query);
    }

    const matches = extractQueryMatches(restOfPage, terms, opts);

    const parts = [];
    parts.push('## Page lead\n' + lead);

    let strategy;
    if (matches.length) {
        strategy = 'lead+matches';
        parts.push(`\n## Excerpts matching claim\n`);
        for (const { term, excerpt } of matches) {
            parts.push(`### [match: "${term}"]\n${excerpt}\n`);
        }
        if (matches.length >= opts.maxMatches) {
            parts.push(
                `\n[Additional matches may exist in the full ${fullLength}-char ` +
                'page; the model has the most relevant excerpts above.]'
            );
        }
    } else if (leadTruncated) {
        // Zero-match fallback: split the remaining budget between the head
        // and tail of the rest of the page. Abstracts and thesis statements
        // tend to be at the front; conclusions and summaries tend to be at
        // the end; the middle is where topic drift lives. Strictly better
        // than lead-only when token-matching fails on paraphrase or
        // synonym-heavy claims.
        // Budget for section headers + the explanatory note. Upper-bounded
        // by a worst-case measurement: the note includes up to 6 query
        // terms plus the full-length string, and section headers run ~150
        // chars total. 600 gives comfortable margin without wasting budget.
        const headerReserve = 600;
        const remaining = Math.max(0, opts.maxTotalChars - lead.length - headerReserve);
        if (remaining >= 1000 && restOfPage.length > 0) {
            strategy = 'lead+head+tail';
            const halfBudget = Math.floor(remaining / 2);
            const headEnd = Math.min(restOfPage.length, halfBudget);
            const tailStart = Math.max(headEnd, restOfPage.length - halfBudget);
            const head = restOfPage.slice(0, headEnd);
            const tail = restOfPage.slice(tailStart);
            const shownTerms = terms.slice(0, 6).map(t => `"${t}"`).join(', ');

            parts.push(
                `\n## Remainder of page — fallback view\n` +
                `[Note: full page was ${fullLength} chars. The claim's specific ` +
                `terms (${shownTerms}) did not match any paragraph past the lead, ` +
                `so we fell back to showing the head and tail of the remainder.]\n`
            );
            parts.push(`### Head of remainder (${head.length} chars)\n${head}`);
            // Only include tail if it's not already contained in head.
            if (tailStart > headEnd) {
                parts.push(
                    `\n### Tail of remainder (${tail.length} chars, ` +
                    `from char ${opts.leadChars + tailStart} onward)\n${tail}`
                );
            }
        } else {
            strategy = 'lead-only';
            parts.push(
                `\n[Note: full page was ${fullLength} chars. No matches found ` +
                `for claim terms (${terms.slice(0, 6).join(', ')}). The fact you are ` +
                'looking for may not appear in this source.]'
            );
        }
    } else {
        strategy = 'lead-only';
    }

    let result = parts.join('\n');
    let truncated = result.length < fullLength;
    if (result.length > opts.maxTotalChars) {
        result = result.slice(0, opts.maxTotalChars) + '\n\n[Truncated — hit total output cap]';
        truncated = true;
    }

    return {
        text: result,
        truncated,
        matches: matches.length,
        fullLength,
        strategy,
    };
}

export { extractRelevantContent, tokenizeClaim, extractQueryMatches, DEFAULTS };
