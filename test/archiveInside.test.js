import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";

// A stand-in for archive.org: the metadata API's sub-paths, inside.php on the
// item's numbered server, and each book's _page_numbers.json. `items` maps an
// identifier to its server, dir, file names, and per book (`doc`) the
// paragraphs each query matches.
function stubArchive(t, items) {
  const calls = [];
  const real = globalThis.fetch;
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  globalThis.fetch = async (input) => {
    const href = typeof input === "string" ? input : input.url;
    calls.push(href);
    const url = new URL(href);
    if (url.host === "archive.org") {
      const [, , id, field] = url.pathname.split("/").map(decodeURIComponent);
      const item = items[id];
      if (!item) return json({ error: `Couldn't locate item '${id}'` });
      if (field === "files") return json({ result: item.files.map((name) => ({ name })) });
      return json({ result: item[field] });
    }
    const item = Object.values(items).find((i) => i.server === url.host);
    if (!item) throw new TypeError("fetch failed");
    if (url.pathname === "/fulltext/inside.php") {
      if (item.restricted) return new Response("", { status: 403 });
      const book = item.books[url.searchParams.get("doc")];
      if (!book) return json({ error: "No hOCR or Abbyy file present", matches: [] });
      const q = url.searchParams.get("q");
      if (book.fail && book.fail.includes(q)) throw Object.assign(new Error("timed out"), { name: "TimeoutError" });
      return json({ ia: "x", q, indexed: true, matches: (book.matches[q] || []).map(([leaf, text, leafEnd]) => ({
        text,
        par: [{ page: leaf, boxes: [] }, ...(leafEnd ? [{ page: leafEnd, boxes: [] }] : [])],
      })) });
    }
    const doc = Object.keys(item.books).find((d) => url.pathname === `${item.dir}/${d.split("/").map(encodeURIComponent).join("/")}_page_numbers.json`);
    if (doc && item.books[doc].pages) {
      return json({ confidence: 96, pages: item.books[doc].pages.map(([leafNum, pageNumber]) => ({ leafNum, pageNumber })) });
    }
    return new Response("not found", { status: 404 });
  };
  t.after(() => {
    globalThis.fetch = real;
  });
  return calls;
}

let nextIp = 0;
async function inside(query, { origin = "https://en.wikipedia.org", ip } = {}) {
  const headers = { "CF-Connecting-IP": ip || `10.0.0.${++nextIp}` };
  if (origin) headers.Origin = origin;
  const res = await worker.fetch(new Request(`https://proxy.test/archive/inside?${query}`, { headers }), {}, {});
  return { res, body: await res.json() };
}

const MEMOIRS = {
  memoirs: {
    server: "ia802808.us.archive.org",
    dir: "/11/items/memoirs",
    files: ["memoirs_djvu.txt", "memoirs_hocr_searchtext.txt.gz", "memoirs_page_numbers.json"],
    books: {
      memoirs: {
        pages: [[28, "10"], [29, "11"], [30, "12"]],
        matches: {
          terrace: [[29, "made a {{{terrace}}} on the bank, planting the declivity with lilacs; he screened his {{{terrace}}} from the sun"]],
          lilacs: [
            [29, "made a terrace on the bank, planting the declivity with {{{lilacs}}}; he screened his terrace from the sun"],
            [30, "the {{{lilacs}}} were in flower", 31],
          ],
        },
      },
    },
  },
};

test("searches each term, gives each paragraph once with its terms and printed page", async (t) => {
  const calls = stubArchive(t, MEMOIRS);
  const { res, body } = await inside("id=memoirs&q=terrace&q=lilacs");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "https://en.wikipedia.org");
  assert.match(res.headers.get("cache-control"), /max-age=86400/);
  assert.deepEqual(body.q, ["terrace", "lilacs"]);
  assert.deepEqual(body.counts, [1, 2]);
  assert.equal(body.doc, "memoirs");
  assert.equal(body.pageConfidence, 96);
  assert.deepEqual(body.matches, [
    {
      text: "made a terrace on the bank, planting the declivity with lilacs; he screened his terrace from the sun",
      terms: [0, 1],
      leaf: 29,
      page: "11",
    },
    { text: "the lilacs were in flower", terms: [1], leaf: 30, page: "12", leafEnd: 31, pageEnd: null },
  ]);
  // The reader's own request: the item's path with its slashes.
  const search = calls.find((c) => c.includes("/fulltext/inside.php"));
  assert.match(search, /^https:\/\/ia802808\.us\.archive\.org\/fulltext\/inside\.php\?item_id=memoirs&doc=memoirs&path=\/11\/items\/memoirs&q=terrace&pre_tag=/);
});

test("a book inside a bundle is searched by its own name, slashes and all", async (t) => {
  const doc = "2000-2008/2004/Issue 10 & 11 (2004)";
  const calls = stubArchive(t, {
    magazines: {
      server: "ia601600.us.archive.org",
      dir: "/5/items/magazines",
      files: [`${doc}_djvu.txt`, "1951/Issue 2_djvu.txt"],
      books: { [doc]: { pages: [[43, "44"]], matches: { '"Forty Signs of Rain"': [[43, "Robinson's new novel, {{{Forty Signs of Rain}}}, centers on global warming"]] } } },
    },
  });
  const { res, body } = await inside(`id=magazines&doc=${encodeURIComponent(doc)}&q=${encodeURIComponent('"Forty Signs of Rain"')}`);
  assert.equal(res.status, 200);
  assert.equal(body.doc, doc);
  assert.equal(body.matches[0].page, "44");
  assert.ok(calls.some((c) => c.includes("&doc=2000-2008/2004/Issue+10+%26+11+%282004%29&")), "doc keeps its slashes");
  assert.ok(calls.some((c) => c.endsWith("/5/items/magazines/2000-2008/2004/Issue%2010%20%26%2011%20(2004)_page_numbers.json")));

  // Without a doc, a bundle says how many books it holds.
  const bare = await inside("id=magazines&q=Robinson");
  assert.equal(bare.res.status, 400);
  assert.equal(bare.body.error.code, "bundle");
});

test("asked for no book, an item's one book is found when it is not named after the item", async (t) => {
  stubArchive(t, {
    "dli.ernet.1": {
      server: "ia601503.us.archive.org",
      dir: "/3/items/dli.ernet.1",
      files: ["2015.1.Some-Title_djvu.txt", "2015.1.Some-Title_djvu.xml", "dli.ernet.1_meta.xml"],
      books: { "2015.1.Some-Title": { matches: { Damon: [[3, "LAMENT FOR {{{DAMON}}}"]] } } },
    },
  });
  const { res, body } = await inside("id=dli.ernet.1&q=Damon");
  assert.equal(res.status, 200);
  assert.equal(body.doc, "2015.1.Some-Title");
  assert.deepEqual(body.matches, [{ text: "LAMENT FOR DAMON", terms: [0], leaf: 3, page: null }]);
  assert.equal(body.pageConfidence, null);
});

test("a lending-library book is refused, an unknown item is not found", async (t) => {
  stubArchive(t, {
    lentbook: { server: "ia801004.us.archive.org", dir: "/6/items/lentbook", files: [], restricted: true, books: {} },
  });
  const lent = await inside("id=lentbook&q=funeral");
  assert.equal(lent.res.status, 403);
  assert.equal(lent.body.error.code, "restricted");
  const missing = await inside("id=nosuchitem&q=funeral");
  assert.equal(missing.res.status, 404);
  assert.equal(missing.body.error.code, "not_found");
});

test("rejects what is not an identifier, a book outside the item, or too many terms", async (t) => {
  const calls = stubArchive(t, MEMOIRS);
  for (const query of ["id=..%2Fetc&q=x", "id=memoirs&doc=..%2Fother&q=x", "id=memoirs&q=a&q=b&q=c&q=d", "id=memoirs", `id=memoirs&q=${"x".repeat(101)}`]) {
    const { res, body } = await inside(query);
    assert.equal(res.status, 400, query);
    assert.equal(body.error.code, "bad_request", query);
  }
  assert.equal(calls.length, 0);
});

test("a term whose search fails is counted as null; the others still answer", async (t) => {
  const items = structuredClone(MEMOIRS);
  items.memoirs.books.memoirs.fail = ["lilacs"];
  stubArchive(t, items);
  const { res, body } = await inside("id=memoirs&q=terrace&q=lilacs");
  assert.equal(res.status, 200);
  assert.deepEqual(body.counts, [1, null]);
  assert.equal(body.matches.length, 1);

  items.memoirs.books.memoirs.fail = ["terrace", "lilacs"];
  const failed = await inside("id=memoirs&q=terrace&q=lilacs");
  assert.equal(failed.res.status, 504);
});

test("a long paragraph is cut to the stretch around its hits", async (t) => {
  const filler = "word ".repeat(400);
  const items = structuredClone(MEMOIRS);
  items.memoirs.books.memoirs.matches.terrace = [[29, `${filler}the {{{terrace}}} was built in 1790 ${filler}`]];
  stubArchive(t, items);
  const { body } = await inside("id=memoirs&q=terrace");
  const text = body.matches[0].text;
  assert.ok(text.length <= 1502, `cut to the window (${text.length})`);
  assert.ok(text.startsWith("…") && text.endsWith("…"));
  assert.ok(text.includes("the terrace was built in 1790"));
});

test("one address gets 60 searches a minute", async (t) => {
  stubArchive(t, MEMOIRS);
  let last;
  for (let i = 0; i < 61; i++) last = await inside("id=memoirs&q=terrace", { ip: "192.0.2.7" });
  assert.equal(last.res.status, 429);
  assert.ok(Number(last.res.headers.get("retry-after")) > 0);
});
