import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeHtml, decodeSingleByte, guessLegacyCharset } from '../src/charset.js';

// Node has no TextEncoder for legacy charsets; invert its decoder table.
function encode(text, label) {
  const decoder = new TextDecoder(label);
  const table = new Map();
  for (let b = 0; b < 256; b++) table.set(decoder.decode(Uint8Array.of(b)), b);
  return Uint8Array.from([...text].map((ch) => table.get(ch) ?? 0x3f));
}

const RU = 'Евреям, покинувшим Россию, было запрещено возвращаться обратно. ';
const FR = 'Le café de la rue est fermé depuis l’été dernier, après une décision municipale. ';
const page = (body, head = '') => `<html><head>${head}<title>t</title></head><body><p>${body.repeat(20)}</p></body></html>`;

test('the regression: Windows-1251 with a <meta> declaration and a bare Content-Type', () => {
  const bytes = encode(page(RU, '<meta http-equiv="Content-Type" content="text/html; charset=windows-1251">'), 'windows-1251');
  // What response.text() used to return:
  assert.ok(new TextDecoder().decode(bytes).includes('�'));
  const { text, charset, source } = decodeHtml(bytes.buffer, 'text/html');
  assert.ok(text.includes(RU.trim()));
  assert.equal(charset, 'windows-1251');
  assert.equal(source, 'meta');
});

test('HTML5 <meta charset> is read', () => {
  const { text, charset } = decodeHtml(encode(page(RU, '<meta charset="koi8-r">'), 'koi8-r'), 'text/html');
  assert.equal(charset, 'koi8-r');
  assert.ok(text.includes(RU.trim()));
});

test('the Content-Type header wins over <meta>', () => {
  const { charset, source } = decodeHtml(encode(page(RU, '<meta charset="koi8-r">'), 'windows-1251'), 'text/html; charset=windows-1251');
  assert.equal(charset, 'windows-1251');
  assert.equal(source, 'header');
});

test('a page wrongly declared UTF-8 is not believed', () => {
  const { text, charset } = decodeHtml(encode(page(RU), 'windows-1251'), 'text/html; charset=utf-8');
  assert.equal(charset, 'windows-1251');
  assert.ok(text.includes(RU.trim()));
});

test('ordinary UTF-8 pages are untouched', () => {
  const html = page(RU + FR, '<meta charset="utf-8">');
  const { text, charset } = decodeHtml(new TextEncoder().encode(html), 'text/html; charset=UTF-8');
  assert.equal(text, html);
  assert.equal(charset, 'utf-8');
});

test('undeclared UTF-8 is detected as UTF-8', () => {
  const html = page(RU);
  assert.equal(decodeHtml(new TextEncoder().encode(html), 'text/html').text, html);
});

test('an unknown charset label falls through instead of throwing', () => {
  const { text, source } = decodeHtml(encode(page(RU, '<meta charset="x-no-such-charset">'), 'windows-1251'), 'text/html; charset=bogus');
  assert.equal(source, 'guess');
  assert.ok(text.includes(RU.trim()));
});

test('undeclared legacy pages: Cyrillic encodings vs Western European', () => {
  assert.equal(guessLegacyCharset(encode(page(RU), 'windows-1251')), 'windows-1251');
  assert.equal(guessLegacyCharset(encode(page(RU), 'koi8-r')), 'koi8-r');
  assert.equal(guessLegacyCharset(encode(page(FR), 'windows-1252')), 'windows-1252');
  assert.ok(decodeHtml(encode(page(FR), 'windows-1252'), 'text/html').text.includes(FR.trim()));
});

test('the built-in tables match the platform decoder byte for byte', () => {
  const all = Uint8Array.from({ length: 256 }, (_, i) => i);
  for (const label of ['windows-1251', 'koi8-r', 'windows-1252']) {
    assert.equal(decodeSingleByte(all, label), new TextDecoder(label).decode(all), label);
  }
});

test('a runtime whose TextDecoder knows only UTF-8 still decodes Windows-1251', () => {
  const declared = encode(page(RU, '<meta charset="windows-1251">'), 'windows-1251');
  const undeclared = encode(page(RU), 'koi8-r');
  const Real = globalThis.TextDecoder;
  globalThis.TextDecoder = class extends Real {
    constructor(label = 'utf-8', opts) {
      if (!/^utf-?8$/i.test(label)) throw new RangeError(`unsupported: ${label}`);
      super(label, opts);
    }
  };
  try {
    const { text, charset } = decodeHtml(declared, 'text/html');
    assert.equal(charset, 'windows-1251');
    assert.ok(text.includes(RU.trim()));
    // And with no declaration at all, via the guess.
    assert.ok(decodeHtml(undeclared, 'text/html').text.includes(RU.trim()));
  } finally {
    globalThis.TextDecoder = Real;
  }
});
