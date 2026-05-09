import { parseHTML } from 'linkedom/worker';
import { Defuddle } from 'defuddle/node';

const MAX_CHARS = 12000;

export async function defuddleExtract(html, sourceUrl) {
  const { document } = parseHTML(html);
  const result = await Defuddle(document, sourceUrl, { includeReplies: false });
  if (!result) {
    console.warn(`defuddle returned null for ${sourceUrl}`);
    return '';
  }
  const innerHtml = result?.content ?? '';
  if (!innerHtml) {
    console.warn(`defuddle returned empty content for ${sourceUrl}`);
    return '';
  }

  // result.content is HTML; collapse to plain text via documentElement.textContent.
  // Note: textContent decodes all HTML entities (including numeric like &#32;), whereas
  // the strip path only decodes &nbsp;/&amp;/&lt;/&gt;. Asymmetry accepted — Phase 2's
  // AI-graded review treats this as part of "structured extraction quality."
  const { document: textDoc } = parseHTML(innerHtml);
  const raw = textDoc.documentElement?.textContent ?? '';

  return raw.replace(/\s+/g, ' ').trim().substring(0, MAX_CHARS);
}
