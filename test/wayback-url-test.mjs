// Quick sanity test for rewriteWaybackUrl in src/index.js.
// Run with: node test/wayback-url-test.mjs
//
// Not a real test suite — just the URL shapes the rewrite has to get right,
// with the emphasis on what it must leave alone.

import { rewriteWaybackUrl } from '../src/index.js';

let failures = 0;
function check(name, cond, info) {
    if (cond) {
        console.log('PASS  ' + name);
    } else {
        failures += 1;
        console.log('FAIL  ' + name + (info ? ' :: ' + info : ''));
    }
}

// --- 1. A standard playback URL gains the id_ flag.
{
    const url = 'https://web.archive.org/web/20120816193241/http://seattletimes.nwsource.com/html/x.html';
    const out = rewriteWaybackUrl(url);
    check('playback URL: id_ inserted',
        out === 'https://web.archive.org/web/20120816193241id_/http://seattletimes.nwsource.com/html/x.html', out);
}

// --- 2. http:// snapshots too — old citations are often not https.
{
    const out = rewriteWaybackUrl('http://web.archive.org/web/20120816193241/http://example.com/a');
    check('http snapshot: id_ inserted',
        out === 'http://web.archive.org/web/20120816193241id_/http://example.com/a', out);
}

// --- 3. Archived URLs without a scheme. These reach the proxy unrewritten
// because the user script's own pattern requires a scheme here.
{
    const out = rewriteWaybackUrl('https://web.archive.org/web/20120816193241/example.com/page');
    check('scheme-less archived URL: id_ inserted',
        out === 'https://web.archive.org/web/20120816193241id_/example.com/page', out);
}

// --- 4. Idempotent: an already-rewritten URL is untouched.
{
    const url = 'https://web.archive.org/web/20120816193241id_/http://example.com/a';
    check('already id_: unchanged', rewriteWaybackUrl(url) === url, rewriteWaybackUrl(url));
}

// --- 5. Other playback flags are an explicit caller choice — leave them.
{
    for (const flag of ['im_', 'js_', 'cs_', 'if_']) {
        const url = `https://web.archive.org/web/20120816193241${flag}/http://example.com/a`;
        check(`${flag} flag: unchanged`, rewriteWaybackUrl(url) === url, rewriteWaybackUrl(url));
    }
}

// --- 6. Anchored at the start: a non-archive host that happens to use the
// same path shape must not be rewritten.
{
    const url = 'https://example.com/web/20120816193241/x';
    check('mimic host: unchanged', rewriteWaybackUrl(url) === url, rewriteWaybackUrl(url));
}

// --- 7. A 14-digit timestamp is required, so partial-timestamp URLs (which
// Wayback resolves to a nearest snapshot) are left for it to resolve.
{
    const url = 'https://web.archive.org/web/2012/http://example.com/a';
    check('partial timestamp: unchanged', rewriteWaybackUrl(url) === url, rewriteWaybackUrl(url));
}

// --- 8. Other archive services have no equivalent flag.
{
    for (const url of ['https://archive.today/abc', 'https://archive.ph/xyz', 'https://www.webcitation.org/abc']) {
        check(`${new URL(url).host}: unchanged`, rewriteWaybackUrl(url) === url, rewriteWaybackUrl(url));
    }
}

// --- 9. Ordinary live URLs pass straight through.
{
    const url = 'https://example.com/some/article?id=4#frag';
    check('live URL: unchanged', rewriteWaybackUrl(url) === url, rewriteWaybackUrl(url));
}

console.log('');
if (failures === 0) {
    console.log('All checks passed.');
    process.exit(0);
} else {
    console.log(failures + ' check(s) failed.');
    process.exit(1);
}
