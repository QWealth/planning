import { describe, expect, it } from 'vitest';

import { formatTimestamp } from './dates';

/*
  These assertions are deliberately timezone-INDEPENDENT.

  formatTimestamp renders in the reader's own zone, which is the point of it, so
  asserting a literal "14:23" would pass on the machine that wrote the test and fail in
  CI running under a different TZ. What can be asserted anywhere is the relationship
  the function exists to establish: a stored naive timestamp means UTC, and must render
  identically to the same instant written with an explicit Z.
*/
describe('formatTimestamp', () => {
  it('reads a naive backend timestamp as UTC, not as local time', () => {
    // The bug this closes: `new Date("2026-09-11T14:23:45")` is LOCAL per spec, so
    // without the appended Z these two disagree by the local offset - four hours in
    // Toronto, and zero in CI running UTC, which is how it would have survived review.
    expect(formatTimestamp('2026-09-11T14:23:45.123456')).toBe(
      formatTimestamp('2026-09-11T14:23:45.123456Z')
    );
  });

  it('works without fractional seconds', () => {
    // isoformat() drops microseconds entirely when they are zero, so both shapes
    // genuinely occur in the table.
    expect(formatTimestamp('2026-09-11T14:23:45')).toBe(formatTimestamp('2026-09-11T14:23:45Z'));
  });

  it('leaves an explicit offset alone', () => {
    // +00:00 is the same instant as Z. If the backend ever moves to timezone-aware
    // timestamps, this is the case that must not get a second Z stapled to it.
    expect(formatTimestamp('2026-09-11T14:23:45+00:00')).toBe(
      formatTimestamp('2026-09-11T14:23:45Z')
    );
  });

  it('honours a non-UTC offset rather than assuming UTC', () => {
    // 09:23 at -05:00 IS 14:23 UTC. Getting this wrong would mean re-interpreting a
    // stated offset, which is worse than the original bug.
    expect(formatTimestamp('2026-09-11T09:23:45-05:00')).toBe(
      formatTimestamp('2026-09-11T14:23:45Z')
    );
  });

  it('renders something for a real timestamp', () => {
    // Weak on purpose - the exact string is the reader's locale and zone. This only
    // pins that the happy path produces output at all.
    expect(formatTimestamp('2026-09-11T14:23:45Z')).not.toBe('');
  });

  it('returns an empty string for nothing, rather than "Invalid Date"', () => {
    // created_at is nullable in the API types. Rendering the literal text
    // "Invalid Date" into a comment header is the failure this prevents.
    expect(formatTimestamp(null)).toBe('');
    expect(formatTimestamp(undefined)).toBe('');
    expect(formatTimestamp('')).toBe('');
    expect(formatTimestamp('not a date')).toBe('');
  });
});
