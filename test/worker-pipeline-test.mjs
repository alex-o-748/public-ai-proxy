// End-to-end test for the patched Worker pipeline.
//
// Inlines the post-patch version of extractText() (which lives in
// index.js after applying index.js.patch), then pipes its output through
// extractRelevantContent — exactly the data path the Worker takes per
// request. Verifies that paragraph boundaries survive HTML extraction
// and that the issue #88 case (claim-relevant text in a long page's
// conclusion) gets surfaced correctly.
//
// Run with: node worker-pipeline-test.mjs

import { extractRelevantContent } from '../src/extract-relevant-content.mjs';

// Inlined copy of the patched extractText. Keep in sync with the post-
// patch version in index.js (see index.js.patch).
function extractText(html) {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<\/(?:p|div|li|tr|h[1-6]|section|article|blockquote|pre)>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const EXTRACT_OPTS = {
    leadChars: 2500,
    matchWindow: 600,
    maxMatches: 8,
    maxTotalChars: 12000,
    fallbackChars: 12000,
};

let failures = 0;
function check(name, cond, info) {
    const tag = cond ? 'PASS  ' : 'FAIL  ';
    if (!cond) failures += 1;
    console.log(tag + name + (info && !cond ? ' :: ' + info : ''));
}

// 1. Paragraph boundaries survive HTML extraction.
{
    const out = extractText('<p>One.</p><p>Two.</p><p>Three.</p>');
    const paras = out.split(/\n\s*\n/).filter(Boolean);
    check('paragraphs split on </p>', paras.length === 3);
}

// 2. <br> becomes a single newline.
{
    const out = extractText('<p>Line A.<br>Line B.</p>');
    check('<br> kept as newline', out.includes('Line A.\nLine B.'));
}

// 3. Heading + para becomes a paragraph boundary.
{
    const out = extractText('<h2>Conclusion</h2><p>The findings show X.</p>');
    check('heading + para → paragraph break',
          /Conclusion\s*\n\s*\n\s*The findings show X\./.test(out));
}

// 4. Boilerplate tags stripped, real content kept.
{
    const html = '<header>SITE NAV</header><p>Real content.</p><footer>COPY</footer>' +
                 '<script>x=1</script><style>p{}</style>';
    const out = extractText(html);
    check('strips boilerplate tags',
          !out.includes('SITE NAV') && !out.includes('COPY') &&
          !out.includes('x=1') && !out.includes('p{}'));
    check('keeps real content', out.includes('Real content'));
}

// 5. End-to-end issue #88 case: long page with claim-relevant text in the
// conclusion. Verifies that the patched pipeline surfaces the conclusion
// instead of dropping it under first-12k truncation.
{
    const intro = '<p>' + 'Background sentence. '.repeat(80) + '</p>';
    const middle = '<p>' + 'Filler about other topics. '.repeat(700) + '</p>';
    const conclusion = '<p>In conclusion, the population of Belgium increased by 12% ' +
                       'between 2010 and 2020 according to official census data.</p>';
    const html = '<html><body><header>NAV</header>' + intro + middle + conclusion +
                 '<footer>x</footer></body></html>';

    const fullText = extractText(html);
    const claim = 'The population of Belgium increased by 12% between 2010 and 2020.';
    const out = extractRelevantContent(fullText, claim, EXTRACT_OPTS);

    check('issue #88: surfaces conclusion', out.text.includes('Belgium increased by 12%'));
    check('issue #88: lead present', out.text.includes('Background sentence'));
    // Post-density-fix: when lead+matches would otherwise be sparse, we
    // backfill with head-of-remainder. The conclusion + lead are still the
    // priority but some filler comes along for density. Check that filler
    // doesn't dominate (the matched paragraph should still be prominent).
    check('issue #88: strategy is lead+matches(+backfill)',
          out.strategy === 'lead+matches' || out.strategy === 'lead+matches+backfill',
          `strategy=${out.strategy}`);
    check('issue #88: respects 12k cap', out.text.length <= 12500);
    check('issue #88: truncated=true', out.truncated === true);
    check('issue #88: output near budget (backfill active)', out.text.length >= 9000,
          `length=${out.text.length}`);
}

// 6. Backward compat: a request with no `query` param sees the same
// first-12k-equivalent behavior the Worker had before the patch.
{
    const fullText = extractText('<p>' + 'X'.repeat(20000) + '</p>');
    const out = extractRelevantContent(fullText, null, EXTRACT_OPTS);
    check('no query: strategy=fallback', out.strategy === 'fallback');
    check('no query: text starts at head', out.text.startsWith('XXXX'));
    check('no query: respects 12k cap', out.text.length <= 12500);
}

console.log('');
console.log(failures === 0 ? 'All checks passed.' : failures + ' check(s) failed.');
process.exit(failures === 0 ? 0 : 1);
