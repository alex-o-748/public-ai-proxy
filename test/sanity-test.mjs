// Quick sanity test for extract-relevant-content.mjs.
// Run with: node sanity-test.mjs
//
// Not a real test suite — just a few representative inputs to confirm the
// algorithm picks the right paragraphs and respects the caps.

import { extractRelevantContent, tokenizeClaim } from '../src/extract-relevant-content.mjs';

let failures = 0;
function check(name, cond, info) {
    if (cond) {
        console.log('PASS  ' + name);
    } else {
        failures += 1;
        console.log('FAIL  ' + name + (info ? ' :: ' + info : ''));
    }
}

// --- 1. tokenizeClaim drops stopwords, keeps numbers + multi-char tokens.
{
    const t = tokenizeClaim('The bridge was completed in 1998 by Acme Corp.');
    check('tokenize: no stopwords', !t.includes('the') && !t.includes('was') && !t.includes('in'));
    check('tokenize: keeps year', t.includes('1998'));
    check('tokenize: keeps proper noun', t.includes('Acme'));
    check('tokenize: keeps verb stem', t.includes('completed'));
}

// --- 2. tokenizeClaim preserves quoted phrases as-is.
{
    const t = tokenizeClaim('The president said "the era of austerity is over" in March.');
    check('tokenize: keeps quoted phrase', t.includes('the era of austerity is over'));
}

// --- 3. Short input is returned untouched.
{
    const out = extractRelevantContent('A short page.', 'something', { maxTotalChars: 100, leadChars: 50 });
    check('short input: returned whole', out.text === 'A short page.' && out.truncated === false && out.strategy === 'short');
}

// --- 4. No query: head-of-page fallback with truncation marker.
{
    const big = 'X'.repeat(20000);
    const out = extractRelevantContent(big, null, { fallbackChars: 5000 });
    check('no query: truncated', out.truncated === true);
    check('no query: starts at head', out.text.startsWith('XXXX'));
    // Marker deliberately NOT in LLM-visible text (triggered false
    // source-unavailability verdicts). Truncation state lives on the
    // response object.
    check('no query: truncated flag set', out.truncated === true);
    check('no query: no inline truncation marker', !out.text.includes('[Truncated'));
    check('no query: strategy=fallback', out.strategy === 'fallback');
}

// --- 5. Query path: lead + matches around the conclusion (issue #88 case).
{
    const lead = 'INTRO. '.repeat(400);                 // ~2,800 chars of intro
    const middle = 'FILLER paragraph. '.repeat(800);    // ~14,400 chars of irrelevant middle
    const conclusion =
        'In conclusion, the population of Belgium increased by 12% between 2010 and 2020 ' +
        'according to census data, marking the largest decadal jump in 30 years.';
    const page = lead + '\n\n' + middle + '\n\n' + conclusion;
    const claim = 'The population of Belgium increased by 12% between 2010 and 2020.';

    const out = extractRelevantContent(page, claim);
    check('issue #88: includes lead', out.text.includes('INTRO.'));
    check('issue #88: surfaces conclusion', out.text.includes('Belgium increased by 12%'));
    check('issue #88: drops the filler bulk', !out.text.includes('FILLER paragraph. '.repeat(20)));
    check('issue #88: at least one match', out.matches >= 1);
    check('issue #88: strategy=lead+matches', out.strategy === 'lead+matches');
    check('issue #88: respects max total chars', out.text.length <= 9500); // 9000 + buffer for headers
}

// --- 6. Query with no hits: lead + head + tail fallback (zero-match case).
// The fallback ensures we don't ship less source text than first-12k would
// under paraphrase/synonym failure. It includes the lead (always) plus the
// head and tail of the rest of the page.
{
    const lead = 'INTRO DISCUSSION OF METHODS. ' + 'Methods text. '.repeat(200);  // ~3,300 chars
    const bodyFiller = 'Middle filler paragraph about completely different topics. '.repeat(500); // ~30,000 chars
    const tailContent = '\n\nFinal concluding notes about cats and astronomy.';
    const page = lead + '\n\n' + bodyFiller + tailContent;

    const out = extractRelevantContent(page, 'committee published findings in 1932');
    check('no hits: zero matches', out.matches === 0);
    check('no hits: strategy=lead+head+tail', out.strategy === 'lead+head+tail', `strategy=${out.strategy}`);
    check('no hits: includes lead', out.text.includes('INTRO DISCUSSION'));
    // Section labels ("Head of remainder", "Tail of remainder") and the
    // explicit fallback note were removed because LLM consumers read them
    // as unreliability signals. We keep the signal on the response object
    // (strategy, truncated, fullLength) instead.
    check('no hits: no inline section label', !out.text.includes('Head of remainder') && !out.text.includes('Tail of remainder'));
    check('no hits: no explicit fallback note', !out.text.includes('did not match any paragraph past the lead'));
    check('no hits: tail text surfaces conclusion', out.text.includes('concluding notes about cats'));
    check('no hits: respects total cap', out.text.length <= 12500);
}

// --- 7. Multi-word phrase match (proper noun + qualifier).
{
    const page =
        'INTRO\n\n' +
        'X'.repeat(5000) + '\n\n' +
        'According to the Morrison Bridge committee, the structure was finished in 2002.\n\n' +
        'Final notes about other bridges.';
    // maxTotalChars lowered below the page size to exercise the narrowing
    // path; production uses a 12k budget that would let this fit whole.
    const out = extractRelevantContent(page, '"Morrison Bridge"', { maxTotalChars: 3000 });
    check('phrase match: surfaces target paragraph', out.text.includes('Morrison Bridge committee'));
    check('phrase match: at least one match', out.matches >= 1);
}

// --- 8. Bare-comma query string is treated as a term list, not a sentence.
{
    const page = 'INTRO\n\n' + 'X'.repeat(5000) + '\n\nDouglas Adams was born on 11 March 1952.';
    const out = extractRelevantContent(page, 'Douglas Adams,1952');
    check('comma-list query: surfaces target', out.text.includes('Douglas Adams was born'));
}

// --- 9. Full-length unaltered when source fits under the total cap.
{
    const page = 'A'.repeat(800) + '\n\nDouglas Adams\n\n' + 'B'.repeat(800);
    const out = extractRelevantContent(page, 'Douglas Adams', { maxTotalChars: 9000, leadChars: 2500 });
    check('fits under cap: not truncated', out.truncated === false);
    check('fits under cap: full text returned', out.text === page);
}

// --- 10. Source with no double-newlines still chunks correctly.
{
    const page = 'INTRO ' + 'X'.repeat(8000) + '\nDouglas Adams was born in 1952.\nMore filler.';
    const out = extractRelevantContent(page, 'Douglas Adams 1952');
    check('single-newline source: surfaces target', out.text.includes('Douglas Adams was born in 1952'));
}

// --- 11. IDF weighting: the rare-token paragraph ranks first (top-scored
// match appears before later-ranked common-token matches in the output).
// With default leadChars=2500 and a 3600-char page, the scoring path
// runs (fullLength > leadChars + matchWindow).
{
    const lead = 'X'.repeat(3000);
    // 8 paragraphs each mentioning "bridge" but not the year
    const commonParas = Array.from({ length: 8 }, (_, i) =>
        `Paragraph ${i} about the bridge project and its general properties.`
    ).join('\n\n');
    // One paragraph with the rare tokens
    const rareHit = 'Construction of the bridge was finally completed in 2002 after delays.';
    const page = lead + '\n\n' + commonParas + '\n\n' + rareHit;

    // maxTotalChars forces narrowing; without it the ~3.6k fixture fits whole.
    const out = extractRelevantContent(page, 'bridge completed 2002', { maxMatches: 3, maxTotalChars: 3000 });
    check('IDF: strategy=lead+matches', out.strategy === 'lead+matches', `strategy=${out.strategy}`);
    check('IDF: rare-token paragraph in output', out.text.includes('completed in 2002 after delays'));
    const rareIdx = out.text.indexOf('completed in 2002');
    const commonIdx = out.text.indexOf('Paragraph 0 about the bridge');
    check('IDF: rare-token paragraph appears first',
        rareIdx !== -1 && (commonIdx === -1 || rareIdx < commonIdx),
        `rareIdx=${rareIdx}, commonIdx=${commonIdx}`);
}

// --- 12. Proper-noun / numeric boost: with df equal across candidates,
// capitalized or numeric tokens outscore lowercase tokens. Force the
// scoring path by making the page longer than leadChars+matchWindow.
{
    const lead = 'X'.repeat(3000);
    // Two paragraphs match one distinct claim token each. Without boost
    // they'd tie; with boost, the Brandenburg hit should win.
    const propPara = 'Specifically, Brandenburg v. Ohio was decided in 1969 by a unanimous court after extensive oral argument from both parties.';
    const fillerPara = 'The committee published other materials around the same era, primarily in obscure journals of regional legal scholarship.';
    const page = lead + '\n\n' + propPara + '\n\n' + fillerPara;

    const out = extractRelevantContent(page, 'Brandenburg published', { maxMatches: 1 });
    check('proper-noun boost: capitalized hit wins over lowercase hit',
        out.text.includes('Brandenburg v. Ohio'),
        JSON.stringify({ strategy: out.strategy, matches: out.matches, tailOfText: out.text.slice(-400) }));
}

// --- 13. Multi-hit scoring: a paragraph matching three claim terms beats
// paragraphs each matching one claim term.
{
    const lead = 'X'.repeat(3000);
    const p1 = 'Belgium was mentioned in one context here, largely in passing, with little elaboration.';
    const p2 = 'Population figures vary by region and decade, depending on the source of the data.';
    const p3 = 'The census was most recently updated in 2020, replacing prior estimates compiled earlier.';
    const pDense = 'According to the 2020 census, Belgium reported population growth of 12 percent.';
    const page = [lead, p1, p2, p3, pDense].join('\n\n');

    const out = extractRelevantContent(page, 'Belgium population 2020', { maxMatches: 1, maxTotalChars: 3000 });
    check('multi-hit: strategy=lead+matches', out.strategy === 'lead+matches', `strategy=${out.strategy}`);
    check('multi-hit scoring: dense paragraph ranks first',
        out.text.includes('Belgium reported population growth'),
        `matches=${out.matches}, tail=${out.text.slice(-400)}`);
}

// --- 14. Fallback budget split: the head+tail fallback respects total cap
// AND does not double-count when head and tail would overlap on shorter
// pages (guard against returning the same bytes twice).
{
    const lead = 'LEAD '.repeat(500);  // ~2,500 chars
    const tail = 'TAIL '.repeat(1200); // ~6,000 chars
    const page = lead + '\n\n' + tail;

    // Query that matches nothing in the rest of the page
    // maxTotalChars lowered below the ~8.5k page so the fallback path runs.
    const out = extractRelevantContent(page, 'xyzzynobody matches this claim', {
        leadChars: 2500, maxTotalChars: 3000,
    });
    check('fallback: strategy=lead+head+tail', out.strategy === 'lead+head+tail' || out.strategy === 'lead-only',
        `strategy=${out.strategy}`);
    check('fallback: respects total cap', out.text.length <= 12500);
    // If head end >= tail start, the algorithm should NOT emit a separate
    // tail section (avoid returning overlapping bytes).
    const headLabelCount = (out.text.match(/### Head of remainder/g) || []).length;
    const tailLabelCount = (out.text.match(/### Tail of remainder/g) || []).length;
    check('fallback: at most one head-of-remainder section', headLabelCount <= 1);
    check('fallback: head-tail overlap handled', tailLabelCount <= 1);
}

console.log('');
if (failures === 0) {
    console.log('All checks passed.');
    process.exit(0);
} else {
    console.log(failures + ' check(s) failed.');
    process.exit(1);
}
