// Turning a fetched HTML body (bytes) into text, in the page's own encoding.
//
// The ?fetch= handler used to call response.text(), which by the Fetch spec
// always decodes UTF-8. Every page that isn't UTF-8 — Windows-1251 and KOI8-R
// are still common on older Russian sites, and the Wayback Machine serves
// 2000s-era snapshots in their original encoding — came back as a wall of
// U+FFFD replacement characters (72% of the text on the crjs.ru snapshot cited
// by ru:Еврейские беженцы, 82% on a lechaim.ru one), with a 200 and no error.
// The verifier then judged a claim against noise and reported a passage that
// is in the source verbatim as "not mentioned" (ruwiki editor, 2026-11-05).
//
// Same rule as tf-source-fetcher's src/charset.js — keep the two in step:
//   1. byte order mark
//   2. charset= in the Content-Type header
//   3. <meta charset> / <meta http-equiv="Content-Type"> in the first 4 KB
//   4. no declaration: UTF-8 if the bytes are valid UTF-8, else a guess
//      between Windows-1251, KOI8-R and Windows-1252 (guessLegacyCharset)
// One deliberate deviation from the HTML spec: a page *declared* UTF-8 whose
// bytes are not valid UTF-8 is not believed. Russian servers that send
// charset=utf-8 for Windows-1251 files are common enough that trusting the
// label would leave those pages as broken as before.
//
// Not every Workers runtime's TextDecoder knows the legacy encodings, so the
// three this rule can guess are also carried as tables (generated from Node's
// decoder; test/charset.test.mjs checks them against it) and used whenever the
// runtime refuses the label.

const PRESCAN_BYTES = 4096;

const META_CHARSET = /<meta\b[^>]*?charset\s*=\s*["']?\s*([a-z0-9._:-]+)/i;
const HEADER_CHARSET = /charset\s*=\s*["']?\s*([a-z0-9._:-]+)/i;

// Bytes 0x80-0xFF; 0x00-0x7F are ASCII in all three.
const SINGLE_BYTE_HIGH = {
  'windows-1251': "\u0402\u0403\u201a\u0453\u201e\u2026\u2020\u2021\u20ac\u2030\u0409\u2039\u040a\u040c\u040b\u040f\u0452\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u0098\u2122\u0459\u203a\u045a\u045c\u045b\u045f\u00a0\u040e\u045e\u0408\u00a4\u0490\u00a6\u00a7\u0401\u00a9\u0404\u00ab\u00ac\u00ad\u00ae\u0407\u00b0\u00b1\u0406\u0456\u0491\u00b5\u00b6\u00b7\u0451\u2116\u0454\u00bb\u0458\u0405\u0455\u0457\u0410\u0411\u0412\u0413\u0414\u0415\u0416\u0417\u0418\u0419\u041a\u041b\u041c\u041d\u041e\u041f\u0420\u0421\u0422\u0423\u0424\u0425\u0426\u0427\u0428\u0429\u042a\u042b\u042c\u042d\u042e\u042f\u0430\u0431\u0432\u0433\u0434\u0435\u0436\u0437\u0438\u0439\u043a\u043b\u043c\u043d\u043e\u043f\u0440\u0441\u0442\u0443\u0444\u0445\u0446\u0447\u0448\u0449\u044a\u044b\u044c\u044d\u044e\u044f",
  'koi8-r': "\u2500\u2502\u250c\u2510\u2514\u2518\u251c\u2524\u252c\u2534\u253c\u2580\u2584\u2588\u258c\u2590\u2591\u2592\u2593\u2320\u25a0\u2219\u221a\u2248\u2264\u2265\u00a0\u2321\u00b0\u00b2\u00b7\u00f7\u2550\u2551\u2552\u0451\u2553\u2554\u2555\u2556\u2557\u2558\u2559\u255a\u255b\u255c\u255d\u255e\u255f\u2560\u2561\u0401\u2562\u2563\u2564\u2565\u2566\u2567\u2568\u2569\u256a\u256b\u256c\u00a9\u044e\u0430\u0431\u0446\u0434\u0435\u0444\u0433\u0445\u0438\u0439\u043a\u043b\u043c\u043d\u043e\u043f\u044f\u0440\u0441\u0442\u0443\u0436\u0432\u044c\u044b\u0437\u0448\u044d\u0449\u0447\u044a\u042e\u0410\u0411\u0426\u0414\u0415\u0424\u0413\u0425\u0418\u0419\u041a\u041b\u041c\u041d\u041e\u041f\u042f\u0420\u0421\u0422\u0423\u0416\u0412\u042c\u042b\u0417\u0428\u042d\u0429\u0427\u042a",
  'windows-1252': "\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178\u00a0\u00a1\u00a2\u00a3\u00a4\u00a5\u00a6\u00a7\u00a8\u00a9\u00aa\u00ab\u00ac\u00ad\u00ae\u00af\u00b0\u00b1\u00b2\u00b3\u00b4\u00b5\u00b6\u00b7\u00b8\u00b9\u00ba\u00bb\u00bc\u00bd\u00be\u00bf\u00c0\u00c1\u00c2\u00c3\u00c4\u00c5\u00c6\u00c7\u00c8\u00c9\u00ca\u00cb\u00cc\u00cd\u00ce\u00cf\u00d0\u00d1\u00d2\u00d3\u00d4\u00d5\u00d6\u00d7\u00d8\u00d9\u00da\u00db\u00dc\u00dd\u00de\u00df\u00e0\u00e1\u00e2\u00e3\u00e4\u00e5\u00e6\u00e7\u00e8\u00e9\u00ea\u00eb\u00ec\u00ed\u00ee\u00ef\u00f0\u00f1\u00f2\u00f3\u00f4\u00f5\u00f6\u00f7\u00f8\u00f9\u00fa\u00fb\u00fc\u00fd\u00fe\u00ff",
};

const LABEL_ALIASES = {
  'cp1251': 'windows-1251', 'x-cp1251': 'windows-1251', 'win-1251': 'windows-1251',
  'koi8': 'koi8-r', 'koi': 'koi8-r', 'cskoi8r': 'koi8-r',
  'cp1252': 'windows-1252', 'x-cp1252': 'windows-1252',
  'iso-8859-1': 'windows-1252', 'latin1': 'windows-1252', 'us-ascii': 'windows-1252', 'ascii': 'windows-1252',
};

export function decodeSingleByte(bytes, label) {
  const high = SINGLE_BYTE_HIGH[label];
  let out = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    const chunk = bytes.subarray(i, i + 8192);
    const chars = new Array(chunk.length);
    for (let j = 0; j < chunk.length; j++) {
      const b = chunk[j];
      chars[j] = b < 0x80 ? String.fromCharCode(b) : high[b - 0x80];
    }
    out += chars.join('');
  }
  return out;
}

function isUtf8Label(label) {
  return /^(utf-?8|unicode-1-1-utf-8)$/i.test(label);
}

// Decodes with `label`, or returns null if neither the runtime nor our tables
// know it — an unknown charset must fall through to the next source, not throw.
function tryDecode(bytes, label) {
  const tabled = LABEL_ALIASES[label] || label;
  try {
    const decoder = new TextDecoder(label);
    return { text: decoder.decode(bytes), charset: decoder.encoding };
  } catch {
    if (SINGLE_BYTE_HIGH[tabled]) return { text: decodeSingleByte(bytes, tabled), charset: tabled };
    return null;
  }
}

function isValidUtf8(bytes) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function bomCharset(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  return null;
}

function headerCharset(contentType) {
  const m = HEADER_CHARSET.exec(contentType || '');
  return m ? m[1].toLowerCase() : null;
}

// The declaration lives in ASCII markup, so reading the head one byte per
// character finds it whatever the body's encoding is.
function metaCharset(bytes) {
  const head = String.fromCharCode.apply(null, bytes.subarray(0, PRESCAN_BYTES));
  const m = META_CHARSET.exec(head);
  return m ? m[1].toLowerCase() : null;
}

// For an undeclared, non-UTF-8 page. Cyrillic text in a single-byte encoding
// is runs of high bytes (whole words), while Western European text has an
// isolated accented letter between ASCII ones — so the share of high bytes
// next to another high byte separates the two. Between the Cyrillic
// encodings: both put letters in 0xC0-0xFF, but Windows-1251 has lowercase in
// the upper half (0xE0-0xFF) and KOI8-R in the lower, and running text is
// mostly lowercase.
export function guessLegacyCharset(bytes) {
  let high = 0;
  let paired = 0;
  let upperHalf = 0;
  let lowerHalf = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b < 0x80) continue;
    high++;
    if ((i > 0 && bytes[i - 1] >= 0x80) || (i + 1 < bytes.length && bytes[i + 1] >= 0x80)) paired++;
    if (b >= 0xe0) upperHalf++;
    else if (b >= 0xc0) lowerHalf++;
  }
  if (high === 0 || paired / high < 0.5) return 'windows-1252';
  return upperHalf >= lowerHalf ? 'windows-1251' : 'koi8-r';
}

/**
 * Decodes an HTML response body.
 * @param {ArrayBuffer|Uint8Array} body
 * @param {string} [contentType]  the response's Content-Type header
 * @returns {{ text: string, charset: string, source: 'bom'|'header'|'meta'|'utf8-valid'|'guess' }}
 */
export function decodeHtml(body, contentType) {
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body);

  const bom = bomCharset(bytes);
  if (bom) {
    const decoded = tryDecode(bytes, bom);
    if (decoded) return { ...decoded, source: 'bom' };
  }

  const utf8Valid = isValidUtf8(bytes);
  const candidates = [
    [headerCharset(contentType), 'header'],
    [metaCharset(bytes), 'meta'],
  ];
  for (const [label, source] of candidates) {
    if (!label) continue;
    if (isUtf8Label(label)) {
      if (utf8Valid) return { text: new TextDecoder('utf-8').decode(bytes), charset: 'utf-8', source };
      continue; // declared UTF-8, isn't: see the header comment
    }
    const decoded = tryDecode(bytes, label);
    if (decoded) return { ...decoded, source };
  }

  if (utf8Valid) return { text: new TextDecoder('utf-8').decode(bytes), charset: 'utf-8', source: 'utf8-valid' };
  const guess = guessLegacyCharset(bytes);
  return { ...tryDecode(bytes, guess), source: 'guess' };
}
