// Keeping the text of rating graphics when HTML is flattened to text.
//
// A review's verdict is often a picture: the Guardian draws its stars as an
// SVG, and the score lives only in the element's aria-label ("3 out of 5
// stars") or an <img alt>. Stripping tags drops it, so "gave the film three
// stars" came back NOT SUPPORTED: "does not state a 3-star rating" (check
// fe5b9a7a; citation-checker-script's
// docs/design-plans/2026-11-08-fixable-causes-of-disputed-verdicts.md §1).
//
// Same rule as tf-source-fetcher's src/ratingLabels.js — keep the two in step.
//
// Only labels that read as a rating are kept: a number together with rating
// vocabulary ("stars", "rated", "Sterne", "звёзд"…) or a score form ("3 out
// of 5", "4/5"). Every other alt text stays out — logos, photo descriptions,
// "Image 1 of 12" — because the verifier quotes from this text, and alt text
// scattered through it would be noise in the place evidence is read.

const LABELLED_TAG = /<[a-z][a-z0-9-]*\b[^>]*?\s(?:aria-label|alt)\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>/gi;

const SCORE_FORM = /\b\d+(?:[.,]\d+)?\s*(?:out\s+of|\/)\s*\d+\b/i;
const RATING_WORD = /\bstars?\b|\brat(?:ing|ed)\b|étoiles?|estrellas?|\bsterne?n?\b|звёзд|звезд/i;

// Longer than any rating label; a long alt is a description.
const MAX_LABEL_CHARS = 80;

export function isRatingLabel(label) {
  const text = (label || '').trim();
  if (!text || text.length > MAX_LABEL_CHARS || !/\d/.test(text)) return false;
  return SCORE_FORM.test(text) || RATING_WORD.test(text);
}

// The markup with each rating label written out as text right after its tag,
// so tag stripping leaves it in place. Run after <script>/<style> are removed.
export function keepRatingLabels(html) {
  return html.replace(LABELLED_TAG, (tag, doubleQuoted, singleQuoted) => {
    const label = doubleQuoted ?? singleQuoted;
    return isRatingLabel(label) ? `${tag} ${label.trim()} ` : tag;
  });
}
