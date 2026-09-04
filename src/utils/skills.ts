/**
 * The star scale.
 *
 * Here rather than in PersonEditor because the Team page reads the same numbers back
 * out and has to render them the same way. Two copies of "how do we write a rating"
 * is exactly the drift this app keeps its vocabularies server-side to avoid.
 *
 * It is NOT served by the API, unlike the skill list itself. The skill vocabulary is
 * data - it grows, it gets renamed, and a stale copy silently stops matching stored
 * values. Three fixed rungs on a scale defined by its own bounds are not data, and
 * fetching them would cost a round trip to be told what MAX_STARS already says. If
 * this ever gains a fourth rung, that is a schema change in fast/app/skills.py and a
 * deploy of both halves, which is the moment to reconsider.
 *
 * THE RUNGS ARE NOT CAPTIONED. They used to be: one star read "can help out, with
 * somebody alongside" and so on up. The sentences said less than the stars did and
 * put words in the mouth of whoever ticked the box, so a rating now says how many
 * stars it is and leaves the reading to the reader.
 */

import type { Specialisation } from '../types';

/** Matches MIN_STARS/MAX_STARS in fast/app/skills.py, which validates the write. */
export const MAX_STARS = 3;

/** The star values offered, weakest first, so a picker can map straight over them. */
export const STAR_VALUES: readonly number[] = [1, 2, 3];

/**
 * A rating in words: a count, not a claim.
 *
 * Exists for the places a glyph cannot go - tooltips, and the labels screen readers
 * announce - where "★★☆" would be read out as punctuation or as nothing at all.
 */
export function starLabel(stars: number): string {
  const n = clampStars(stars);
  if (n === 0) {
    return 'Not rated';
  }
  return `${n} of ${MAX_STARS} stars`;
}

/** Hand-edited data and future scales both land in range. See PersonModel._stars. */
export function clampStars(stars: number): number {
  if (!Number.isFinite(stars)) {
    return 0;
  }
  return Math.max(0, Math.min(MAX_STARS, Math.round(stars)));
}

/**
 * "★★☆", for a chip that has no room for a sentence.
 *
 * Filled and hollow glyphs rather than filled-only, so the rating is legible as "two
 * OUT OF THREE" at a glance. Two lone stars beside three lone stars is a comparison
 * the reader has to do from memory of the scale's length.
 */
export function starGlyphs(stars: number): string {
  const n = clampStars(stars);
  return '★'.repeat(n) + '☆'.repeat(MAX_STARS - n);
}

/**
 * How one person's chips are ordered: strongest first, then appetite, then name.
 *
 * Arithmetic, not a lookup table. The thing this replaced was a `Record<SkillLevel,
 * number>` that every new level had to be added to by hand, and the old `learning`
 * value had to be pinned to the end of it with a comment explaining that it was not
 * really part of the ordering at all.
 *
 * Want-to-learn entries sort last within their star count, which puts the zero-star
 * ones at the very bottom of the list. That is where they belong when the question is
 * "who can do this" and they are still present for the question "who wants to".
 */
export function compareSpecialisations(a: Specialisation, b: Specialisation): number {
  return (
    b.stars - a.stars ||
    Number(a.wants_to_learn) - Number(b.wants_to_learn) ||
    a.skill.localeCompare(b.skill)
  );
}

/**
 * True when two lists describe the same skills, at the same stars, with the same
 * appetite.
 *
 * Decides whether a PATCH sends `specialisations` at all, for the same reason
 * `sameRoles` exists next door: the collection is marked dirty wholesale the moment
 * one control moves, so comparing by value is the only way an open-and-save of an
 * unmodified form does not write a phantom audit entry.
 *
 * Order-insensitive. The form yields catalogue order and the API returns storage
 * order, and those routinely differ for a person nobody has touched.
 */
export function sameSpecialisations(a: Specialisation[], b: Specialisation[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const key = (list: Specialisation[]) =>
    [...list]
      .sort((x, y) => x.skill.localeCompare(y.skill))
      .map((s) => `${s.skill}:${s.stars}:${s.wants_to_learn ? 1 : 0}`)
      .join('|');
  return key(a) === key(b);
}
