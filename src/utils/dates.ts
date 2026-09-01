/**
 * Calendar arithmetic for the timeline.
 *
 * EVERYTHING HERE IS UTC-ANCHORED, DELIBERATELY.
 *
 * The API speaks plain `YYYY-MM-DD` - a calendar day with no time and no zone. The
 * moment such a string is put through a local-time Date the day can move: in a
 * negative-offset zone `new Date(2026, 7, 13)` and `new Date('2026-08-13')` are 4-8
 * hours apart, and formatting the second with local getters yields the 12th. On a
 * Gantt chart that is not a rounding error - it shifts a bar a whole column, and it
 * shifts it only for viewers west of Greenwich, so it survives every test run in the
 * office and is reported as "the dates are wrong on my screen".
 *
 * So: parse with an explicit `T00:00:00Z`, read with getUTC*, format with
 * timeZone: 'UTC'. The single exception is `todayISO`, which must be the viewer's
 * own calendar day and says so.
 */

const MS_PER_DAY = 86_400_000;

/** `YYYY-MM-DD` -> a Date pinned to midnight UTC. */
export function parseISO(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

/** A UTC-anchored Date -> `YYYY-MM-DD`. */
export function formatISO(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

/** Whole days from `from` to `to`. Negative when `to` is earlier. */
export function dayDiff(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / MS_PER_DAY);
}

/**
 * The Monday on or before `date`.
 *
 * Monday rather than Sunday because the workbook's columns were week-commencing
 * Monday and everyone reading this chart has that week shape in their head.
 */
export function startOfWeek(date: Date): Date {
  // getUTCDay: 0 = Sunday. Sunday belongs to the week that began six days earlier.
  const weekday = date.getUTCDay();
  const back = weekday === 0 ? 6 : weekday - 1;
  return addDays(date, -back);
}

/**
 * The viewer's own calendar day, as `YYYY-MM-DD`.
 *
 * Local getters on purpose - this is the one value that is about the person at the
 * screen rather than about a stored date. Someone in Vancouver at 22:00 on the 27th
 * should see the today-marker on the 27th, not on the 28th, which is what
 * `new Date().toISOString()` would give them.
 */
export function todayISO(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const SHORT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});

const MEDIUM = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

const LONG = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

const MONTH = new Intl.DateTimeFormat('en-GB', {
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/** "13 Aug" */
export function formatShort(iso: string): string {
  return SHORT.format(parseISO(iso));
}

/**
 * "13 Aug 2026" - the year, without the weekday.
 *
 * For lists in the narrow label column, where formatLong's weekday costs five
 * characters that push the row's actual subject into an ellipsis, and formatShort's
 * missing year makes a deadline eighteen months out indistinguishable from one this
 * summer. The chart runs across a year boundary in the live data, so the year is not
 * optional; the weekday is.
 */
export function formatMedium(iso: string): string {
  return MEDIUM.format(parseISO(iso));
}

/** "Thu 13 Aug 2026" */
export function formatLong(iso: string): string {
  return LONG.format(parseISO(iso));
}

/** "Aug 2026" */
export function formatMonth(date: Date): string {
  return MONTH.format(date);
}

/**
 * Inclusive duration in days: a phase that starts and ends on the same date is one
 * day of work, not zero. Three phases in the live data are same-day.
 */
export function inclusiveDays(startISO: string, endISO: string): number {
  return dayDiff(parseISO(startISO), parseISO(endISO)) + 1;
}

export interface WeekColumn {
  /** Monday of this week, UTC-anchored. */
  start: Date;
  /** `YYYY-MM-DD` of that Monday. Stable React key. */
  key: string;
  /** Day-of-month, the column's own tick label. */
  day: number;
  /** "Aug 2026", present only on the first column of each month. */
  monthLabel: string | null;
}

export interface Grid {
  /** Monday of the first week shown. */
  start: Date;
  /** Sunday of the last week shown. */
  end: Date;
  /** Total days spanned, the denominator for every percentage on the chart. */
  totalDays: number;
  columns: WeekColumn[];
}

/**
 * The week columns the chart is drawn on.
 *
 * Snapped out to whole weeks at both ends so the first and last bars are not
 * clipped flush against the frame, and widened to include `todayISO` so the today
 * marker is always somewhere on the chart. That last part matters when the roadmap
 * runs entirely in the future or entirely in the past: without it the marker is
 * positioned off-canvas and the chart silently loses its only fixed reference point.
 */
export function buildGrid(spanStart: string, spanEnd: string, today: string): Grid {
  const earliest = [spanStart, spanEnd, today].reduce((a, b) => (a < b ? a : b));
  const latest = [spanStart, spanEnd, today].reduce((a, b) => (a > b ? a : b));

  const start = startOfWeek(parseISO(earliest));
  // Six days past the Monday of the last week gives the closing Sunday.
  const end = addDays(startOfWeek(parseISO(latest)), 6);

  const columns: WeekColumn[] = [];
  let seenMonth = '';
  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 7)) {
    const month = formatMonth(cursor);
    columns.push({
      start: cursor,
      key: formatISO(cursor),
      day: cursor.getUTCDate(),
      // A week that straddles a month boundary is labelled by the month its Monday
      // falls in. Labelling by the month the week *contains* would print the same
      // month twice whenever a month starts mid-week.
      monthLabel: month === seenMonth ? null : month,
    });
    seenMonth = month;
  }

  return { start, end, totalDays: dayDiff(start, end) + 1, columns };
}

export interface Placement {
  /** Percentage from the left edge of the grid. */
  leftPct: number;
  /** Percentage width. Never below a hairline - see below. */
  widthPct: number;
  /** Inclusive duration in days. */
  days: number;
}

/**
 * Where a dated bar sits on the grid, in percentages of the total span.
 *
 * Percentages rather than pixels so the chart is fluid: the grid is a flex column
 * whose width is whatever the window allows, and a pixel layout would need a
 * measured container and a resize observer to stay honest.
 */
export function place(grid: Grid, startISO: string, endISO: string): Placement {
  const offset = dayDiff(grid.start, parseISO(startISO));
  const days = inclusiveDays(startISO, endISO);
  return {
    leftPct: (offset / grid.totalDays) * 100,
    widthPct: (days / grid.totalDays) * 100,
    days,
  };
}

/** Where a single instant sits, as a percentage. Used for the today marker. */
export function placeDay(grid: Grid, iso: string): number {
  return (dayDiff(grid.start, parseISO(iso)) / grid.totalDays) * 100;
}
