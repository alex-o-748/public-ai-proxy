// Runs the Worker's ?fetch= handler under Node against a bundled three-page
// PDF (test/fixtures/three-pages.pdf). Each page has two lines: "Page N first
// line alphaN" and "Page N second line omegaN". The outbound fetch() is
// stubbed to serve that file, so the test needs no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import worker from '../src/index.js';

const FIXTURE = await readFile(new URL('./fixtures/three-pages.pdf', import.meta.url));
const TARGET = 'https://example.org/three-pages.pdf';

const realFetch = globalThis.fetch;
test.before(() => {
  globalThis.fetch = async (url) => {
    assert.equal(String(url), TARGET);
    return new Response(FIXTURE, { headers: { 'Content-Type': 'application/pdf' } });
  };
});
test.after(() => {
  globalThis.fetch = realFetch;
});

async function callFetch(page) {
  const qs = new URLSearchParams({ fetch: TARGET });
  if (page !== undefined) qs.set('page', String(page));
  const res = await worker.fetch(new Request(`https://proxy.test/?${qs}`), {}, {});
  return { status: res.status, body: await res.json() };
}

test('page=2 returns only page 2 text', async () => {
  const { status, body } = await callFetch(2);
  assert.equal(status, 200);
  assert.equal(body.pdf, true);
  assert.equal(body.totalPages, 3);
  assert.equal(body.page, 2);
  assert.equal(body.content, 'Page 2 first line alpha2 Page 2 second line omega2');
});

test('no page param returns the whole document', async () => {
  const { body } = await callFetch();
  assert.equal(body.totalPages, 3);
  assert.equal('page' in body, false);
  for (const n of [1, 2, 3]) {
    assert.ok(body.content.includes(`Page ${n} first line alpha${n}`));
    assert.ok(body.content.includes(`Page ${n} second line omega${n}`));
  }
});

test('out-of-range page is a 400 naming the page count', async () => {
  const { status, body } = await callFetch(4);
  assert.equal(status, 400);
  assert.equal(body.error, 'Invalid page number. PDF has 3 pages.');
});
