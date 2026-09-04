/**
 * The star scale: what the rungs say, how chips order, and when a save is a no-op.
 *
 * Two different kinds of wrong live in this file. `starLabel` and `starGlyphs` being
 * wrong is loud - the form says one thing and the roster another, and somebody gets
 * staffed off the wrong reading. `sameSpecialisations` being wrong is silent: the
 * save still works, and it shows up months later as an audit trail claiming people
 * revised their skills on days they only opened the form.
 *
 * `compareSpecialisations` sits between the two. Nobody notices a chip in the wrong
 * order, but the whole point of the ordering is that the first chip on a row answers
 * "what is this person for", so getting it wrong makes the Team page quietly
 * misleading rather than visibly broken.
 */

import { describe, expect, it } from 'vitest';

import type { Specialisation } from '../types';
import {
  MAX_STARS,
  clampStars,
  compareSpecialisations,
  sameSpecialisations,
  starGlyphs,
  starLabel,
} from './skills';

/** A specialisation, with the two axes spelled out at each call site that varies. */
function spec(skill: string, stars: number, wants_to_learn = false): Specialisation {
  return { skill, stars, wants_to_learn };
}

describe('clampStars', () => {
  it('leaves every rung of the scale alone', () => {
    expect([0, 1, 2, 3].map(clampStars)).toEqual([0, 1, 2, 3]);
  });

  it('pulls values from outside the scale to its edges', () => {
    // Mirrors PersonModel._stars server-side. Hand-edited data lands here, and a
    // fourth rung added later would arrive as a 4 against a frontend still on three.
    expect(clampStars(-2)).toBe(0);
    expect(clampStars(99)).toBe(MAX_STARS);
  });

  it('rounds rather than truncating', () => {
    expect(clampStars(2.6)).toBe(3);
    expect(clampStars(2.4)).toBe(2);
  });

  it('treats a value that is not a real number as no rating at all', () => {
    // Not the same rule as clamping, and the difference is deliberate. A finite 99 is
    // a rating from some longer scale, so it means "as high as it goes"; NaN and
    // Infinity are not ratings, so they mean "nothing was recorded" and get no stars.
    // Either way nothing throws - `'★'.repeat(NaN)` would take the Team page with it.
    expect(clampStars(NaN)).toBe(0);
    expect(clampStars(Infinity)).toBe(0);
  });
});

describe('starLabel', () => {
  it('counts the stars rather than characterising the person', () => {
    // The rungs used to be captioned - "the obvious person to ask" and so on. They are
    // not any more, and this is the test that notices if a caption comes back.
    expect([0, 1, 2, 3].map(starLabel)).toEqual([
      'Not rated',
      '1 of 3 stars',
      '2 of 3 stars',
      '3 of 3 stars',
    ]);
  });

  it('falls back rather than returning undefined for a value off the scale', () => {
    // Read from stored data, so it has to answer for anything the table holds.
    expect(starLabel(7)).toBe(starLabel(MAX_STARS));
    expect(starLabel(-1)).toBe(starLabel(0));
  });
});

describe('starGlyphs', () => {
  it('shows the rating out of the scale, not just the filled stars', () => {
    // Filled-only would leave "★★" beside "★★★" to be read against a remembered
    // scale length. Hollow glyphs make it two OUT OF three at a glance.
    expect(starGlyphs(2)).toBe('★★☆');
    expect(starGlyphs(0)).toBe('☆☆☆');
    expect(starGlyphs(3)).toBe('★★★');
  });

  it('is always the width of the scale', () => {
    for (const n of [-5, 0, 1, 2, 3, 12]) {
      expect(starGlyphs(n)).toHaveLength(MAX_STARS);
    }
  });
});

describe('compareSpecialisations', () => {
  it('puts the strongest skill first', () => {
    const sorted = [spec('a', 1), spec('b', 3), spec('c', 2)].sort(compareSpecialisations);
    expect(sorted.map((s) => s.skill)).toEqual(['b', 'c', 'a']);
  });

  it('sorts a want-to-learn after an equal rating without it', () => {
    // Both are true statements at two stars, but "can do this" answers the question
    // the roster is usually being read for.
    const sorted = [spec('keen', 2, true), spec('plain', 2)].sort(compareSpecialisations);
    expect(sorted.map((s) => s.skill)).toEqual(['plain', 'keen']);
  });

  it('drops pure appetite to the very bottom', () => {
    // The case that motivated arithmetic over a lookup table: zero stars plus
    // appetite is not a weak capability, and must not sort as one.
    const sorted = [spec('wants', 0, true), spec('can', 1)].sort(compareSpecialisations);
    expect(sorted.map((s) => s.skill)).toEqual(['can', 'wants']);
  });

  it('falls back to the name so the order is stable', () => {
    // Otherwise a person's chips reshuffle between renders for no reason.
    const sorted = [spec('zebra', 2), spec('apple', 2)].sort(compareSpecialisations);
    expect(sorted.map((s) => s.skill)).toEqual(['apple', 'zebra']);
  });
});

describe('sameSpecialisations', () => {
  it('is true for the same skills in a different order', () => {
    // The real case: the form yields catalogue order, the API returns storage order.
    expect(
      sameSpecialisations([spec('ui-ux', 2), spec('back-end', 3)], [spec('back-end', 3), spec('ui-ux', 2)])
    ).toBe(true);
  });

  it('is true for two empty lists', () => {
    // Everybody seeded from the workbook. Opening one to fix a name must not write.
    expect(sameSpecialisations([], [])).toBe(true);
  });

  it('is false when only the rating moved', () => {
    expect(sameSpecialisations([spec('ui-ux', 2)], [spec('ui-ux', 3)])).toBe(false);
  });

  it('is false when only the appetite moved', () => {
    // The half a star-only comparison would miss. Ticking the box is the entire
    // change somebody came to the form to make.
    expect(sameSpecialisations([spec('ui-ux', 2)], [spec('ui-ux', 2, true)])).toBe(false);
  });

  it('is false when a skill is added or removed', () => {
    expect(sameSpecialisations([spec('ui-ux', 2)], [spec('ui-ux', 2), spec('qa-testing', 1)])).toBe(
      false
    );
    expect(sameSpecialisations([spec('ui-ux', 2), spec('qa-testing', 1)], [spec('ui-ux', 2)])).toBe(
      false
    );
  });

  it('is false when one skill is swapped for another at the same rating', () => {
    // Same length, same ratings - the pair a length-and-total check would call equal.
    expect(sameSpecialisations([spec('ui-ux', 2)], [spec('figma', 2)])).toBe(false);
  });
});
