import test from 'node:test';
import assert from 'node:assert/strict';
import { isRatingLabel, keepRatingLabels } from '../src/ratingLabels.js';

test('a star rating drawn as a graphic survives as text (the Guardian review case)', () => {
  const html = '<p>Brightwood review</p><div class="stars" aria-label="3 out of 5 stars"><svg></svg></div><p>A tense thriller.</p>';
  const text = keepRatingLabels(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  assert.equal(text, 'Brightwood review 3 out of 5 stars A tense thriller.');
});

test('an <img alt> rating and a single-quoted label are kept too', () => {
  assert.match(keepRatingLabels('<img src="s.png" alt="Rated 4/5">'), /> Rated 4\/5 $/);
  assert.match(keepRatingLabels("<span aria-label='4 von 5 Sternen'></span>"), /> 4 von 5 Sternen <\/span>$/);
});

test('rating labels in several languages are recognised', () => {
  for (const label of ['3 stars', '4 out of 5', '4.5/5', 'Note : 4 étoiles sur 5', '3 estrellas', '5 Sterne', '4 звезды из 5']) {
    assert.ok(isRatingLabel(label), label);
  }
});

test('other alt text stays out: logos, photo captions, galleries, long descriptions', () => {
  for (const label of ['Guardian logo', 'Photo of the director, 2024', 'Image 1 of 12', 'Star Wars poster', '', 'x'.repeat(81) + ' 3 stars']) {
    assert.equal(isRatingLabel(label), false, label);
  }
  const html = '<img alt="Photo of the director, 2024"><a aria-label="Share on Facebook" href="#">f</a>';
  assert.equal(keepRatingLabels(html), html);
});
