/**
 * The palette, and the small set of shared surfaces built from it.
 *
 * Adopted from design/sticker-sheet.html. That sheet names five decisions that carry
 * the look, and matching the hex codes without them produces something that is merely
 * the same colours:
 *
 *   1. NAVY KEYLINE. One ink colour outlines everything - 2px on small objects, 3px on
 *      cards - so a surface reads as screen-printed rather than as bordered.
 *   2. HARD OFFSET SHADOW. `6px 6px 0` in navy, with ZERO BLUR. A blurred shadow turns
 *      this into generic material design instantly; it is the single most load-bearing
 *      line in the file.
 *   3. WARM PAPER GROUND. Cream and paper, never pure white. The warmth is what makes
 *      navy read as ink rather than as a dark grey border.
 *   4. HEAVY UPPERCASE DISPLAY for headings and small labels.
 *   5. RED AND TEAL DO NOT SWAP JOBS. Red carries primary actions and headings; teal
 *      carries focus, success and the checked state.
 *
 * WHAT THE COLOUR IS FOR HAS NOT CHANGED
 * --------------------------------------
 * Colour is how a collapsed lane says what state a project is in, which is the whole
 * reason nine swim-lane groups could become nine rows. So the four lifecycle states
 * still get four fills that differ in HUE AND IN LIGHTNESS rather than four tints of
 * one hue - lightness is the part that survives a monochrome print, a bad projector and
 * the two commonest colour vision deficiencies. Nothing relies on colour alone either:
 * every bar carries its state as text and the legend names all five.
 *
 * DARK MODE: FROM THE OPERATING SYSTEM, NOT A TOGGLE
 * --------------------------------------------------
 * There is no theme switch and none of the machinery that goes with one. The whole
 * mechanism is the `@media (prefers-color-scheme: dark)` block in `themeVars` below.
 * The sticker sheet ships its own dark values and they are used here as given, which is
 * why this swap did not have to invent a single dark colour.
 *
 * The mechanism is CSS CUSTOM PROPERTIES, and that is what kept this change small:
 * every value below is a `var(--c-…)`, so all 271 `palette.x` interpolations across 27
 * files went on meaning what they meant. Only the two ends of each variable changed.
 *
 * TWO RULES DECIDED THE DARK VALUES, AND THEY SURVIVED THE REBRAND.
 *
 * 1. THE CHROME INVERTS; THE DATA DOES NOT. Ground, surface, keyline, ink and the
 *    accents all flip. The five lifecycle fills and the `on` colours that sit on them
 *    do NOT, and STATE_STYLE below is still written in literal hex for that reason. A
 *    bar's colour is the project's state; somebody who learns that sand means Planning
 *    has learned it for both themes, and a legend swatch has to match the bar it
 *    explains.
 *
 * 2. WHAT SITS ON A FILL FLIPS WITH IT. In light mode the red is darker than the page
 *    and carries paper-white text. In dark mode it is LIGHTER than the page - a
 *    dark-mode accent has to be - so white on it would be two bright colours stacked.
 *    That is what `onAccent` is, and it is the one thing that cannot be solved by
 *    re-pointing a variable, because the literal `#ffffff` at those call sites was
 *    itself the assumption that broke.
 */

import { css } from 'styled-components';

/**
 * Every colour, light value first and dark value second.
 *
 * One table rather than two objects, so a new colour cannot be added to one theme and
 * forgotten in the other - the type makes both mandatory, and the variable name is
 * derived from the key rather than written out a third time.
 */
/**
 * The five lifecycle fills, as literal colour.
 *
 * Named separately from the tokens below because they are the one group that does NOT
 * have a dark value - see rule 1 in the header - and because both the palette and
 * STATE_STYLE need them, which would otherwise be the same hex written twice with
 * nothing keeping the two copies honest.
 */
const FILL = {
  /* The sunset scene, used as lifecycle fills. Ordered by lightness as well as hue so
     the four states stay distinguishable in monochrome and under deuteranopia. */
  coral: '#E8683A',
  teal: '#2FB3A0',
  sky: '#7FC8C4',
  sand: '#F4CE8C',
  driftwood: '#C4BCA8',
} as const;

const TOKENS = {
  /* Red carries primary actions and headings, and nothing else does - see decision 5.
     Lifted in the dark theme, where #E21E25 against the navy ground is under 4.5:1. */
  hotPink: ['#E21E25', '#FF5A5F'],
  /* The heavier red: headings, and a strong fill under paper-white text. */
  deepMagenta: ['#C0161C', '#FF7A7E'],
  /* Lifecycle fills. Identical in both themes - see rule 1 in the header. */
  bubblegum: [FILL.sand, FILL.sand],
  lilac: [FILL.sky, FILL.sky],
  turquoise: [FILL.teal, FILL.teal],

  /* Chrome. Cream and paper, NEVER pure white - decision 3. The warmth is what makes
     the navy keyline read as ink rather than as a dark grey border, and it is the
     difference between this looking screen-printed and looking like a bordered card. */
  blush: ['#FBF6EC', '#121735'],
  /** The far end of the body's background wash. See GlobalStyle. */
  groundEnd: ['#F6E6B8', '#0E1229'],
  card: ['#FFFDF8', '#1A2043'],
  /** A card that is switched off: the deactivated roster row. */
  inactive: ['#F4EFE3', '#161B3A'],
  /** A form field that cannot be typed in. */
  disabled: ['#EFE7D6', '#222A52'],
  /* Two different jobs, and the sticker sheet keeps them apart. `border` is the warm
     hairline that separates things inside a surface; `borderStrong` is THE KEYLINE,
     and it is navy. Making every 1px rule navy would turn the app into a grid. */
  border: ['#E4DAC7', '#333B66'],
  borderStrong: ['#1D2451', '#46507F'],

  /* Ink is navy rather than black - decision 3 again. Its dark counterpart is the
     sheet's warm off-white, because #FFF on a navy ground is a glare. */
  ink: ['#1D2451', '#F4EFE3'],
  inkSoft: ['#555555', '#A9A9BE'],
  /** Text and marks that sit ON a saturated fill. See rule 2 in the header. */
  onAccent: ['#FFFDF8', '#141A3B'],

  /*
    The sheet's plum. Not a lifecycle fill and not an action colour - it exists for the
    one job red cannot do here.

    Red carries primary actions AND danger, so using it to mean "you have not read this"
    puts an unread row one glance away from looking like a failed one. Plum is the
    sheet's own secondary brand colour, it is the dark pink this marker was asked for
    originally, and it collides with nothing else.
  */
  plum: ['#93345D', '#D98BAE'],

  /* Warm neutral, so the states that share it look like part of the scheme rather
     than an unstyled fallback. */
  slate: [FILL.driftwood, FILL.driftwood],
  slateDeep: ['#8A8578', '#A9A9BE'],

  /* Reserved for states of the data, never for a lifecycle state. Teal is success by
     decision 5, which is why it is not also a lifecycle fill's job here. */
  danger: ['#E21E25', '#FF5A5F'],
  warning: ['#D9A441', '#F0C060'],
  today: ['#E8683A', '#F0913D'],

  /*
    The translucent tints. These were 28 literal rgba() calls scattered across the
    chart and the panels, and every one of them was a tint of ink, of the accent or of
    slate over a WHITE ground - which is the assumption dark mode breaks: ink at 12%
    over a dark ground is not a faint hairline, it is nothing at all. Named here so the
    inversion happens once.
  */
  /** A rule that is a tint of the ink rather than a border colour of its own. */
  hairline: ['rgba(29, 36, 81, 0.14)', 'rgba(244, 239, 227, 0.16)'],
  hairlineStrong: ['rgba(29, 36, 81, 0.26)', 'rgba(244, 239, 227, 0.26)'],
  /** A panel tinted by the accent: the invite box, the active nav tab. */
  pinkWash: ['rgba(226, 30, 37, 0.06)', 'rgba(255, 90, 95, 0.12)'],
  pinkWashStrong: ['rgba(226, 30, 37, 0.18)', 'rgba(255, 90, 95, 0.28)'],
  /** The neutral counterpart, for a band nobody is responsible for. */
  slateWash: ['rgba(196, 188, 168, 0.20)', 'rgba(196, 188, 168, 0.14)'],
  /*
    The veil over the background video.

    Warm white in the light theme and navy in the dark one - the sheet ships both as
    .cl-scrim and .cl-scrim-strong. It is doing real work rather than decoration: the
    video is a saturated sunset, and the gaps between cards are where text sits
    directly over it.
  */
  scrim: ['rgba(255, 253, 248, 0.30)', 'rgba(29, 36, 81, 0.34)'],

  /** The warm wash behind a phase row and behind a project banner. */
  banner: ['rgba(246, 230, 184, 0.45)', 'rgba(255, 90, 95, 0.10)'],
} as const;

/** `hotPink` -> `--c-hot-pink`. Derived, so the two spellings cannot drift apart. */
function varName(key: string): string {
  return `--c-${key.replace(/[A-Z]/g, (ch) => `-${ch.toLowerCase()}`)}`;
}

/**
 * Named colours, so the state map below reads as a decision and not as hex codes.
 *
 * Every value is a `var()` reference rather than a colour. Interpolating one of these
 * into styled-components produces exactly the CSS it always did, and the browser
 * resolves it against whichever `:root` block the media query left standing - which
 * is why the theme can change under a component without React hearing about it.
 */
export const palette = Object.fromEntries(
  Object.keys(TOKENS).map((key) => [key, `var(${varName(key)})`])
) as Record<keyof typeof TOKENS, string>;

/**
 * The four lifecycle states, plus the bucket everything else falls into.
 *
 * `other` covers Testing, Maintenance, and the eight one-off workstream names in
 * the live data (Accounts, Transactions, Addresses, Beneficiaries, Tax, Net Worth,
 * Marketing Feed, Workflows). Giving Testing its own colour was offered and
 * explicitly not taken up; if that changes it is one entry here plus one line in
 * utils/phaseState.ts, and nothing else.
 */
export type PhaseState = 'coding' | 'architecting' | 'wireframes' | 'planning' | 'other';

export interface StateStyle {
  /** Bar fill. */
  fill: string;
  /** Text that sits on the fill. Chosen per state for contrast, not per theme. */
  on: string;
  /** Human label, used on the bar and in the legend. */
  label: string;
}

/**
 * Written in FILL and in literal hex, deliberately NOT in `palette`.
 *
 * These five are the data, not the chrome, and they are the same colour in both
 * themes - so a `var()` here would be a variable with one value, which is a promise
 * that it might one day have two. It must not: bubblegum means Planning, a legend
 * swatch has to match the bar it explains, and somebody comparing a screenshot from a
 * dark machine with one from a light machine is comparing project states.
 *
 * `on` is the text that sits on the fill and is likewise fixed, because the fill it
 * has to contrast with is fixed. This is the one place in the file where a literal
 * colour is the correct answer rather than a missed refactor - the theme-sensitive
 * version of the same idea is `palette.onAccent`, and it is a different question.
 */
export const STATE_STYLE: Record<PhaseState, StateStyle> = {
  coding: { fill: FILL.coral, on: '#141A3B', label: 'Coding' },
  architecting: { fill: FILL.teal, on: '#141A3B', label: 'Architecting' },
  wireframes: { fill: FILL.sky, on: '#141A3B', label: 'Wireframes' },
  planning: { fill: FILL.sand, on: '#141A3B', label: 'Planning' },
  other: { fill: FILL.driftwood, on: '#141A3B', label: 'Other work' },
};

/**
 * Heavy uppercase display - decision 4.
 *
 * The stack is the sticker sheet's own, fallbacks included, and the fallbacks are the
 * point: Bowlby One is a webfont and this app deliberately loads none. index.html links
 * no stylesheet from a CDN, because it is an internal tool behind a login and a blocked
 * font request would leave it rendering unstyled on a locked-down network.
 *
 * Arial Black and Impact are present on every machine in the firm and carry the same
 * instruction - heavy, condensed, uppercase - so the signature survives without the
 * download. Adding the Google Fonts link to index.html is a one-line change if the
 * exact face is ever wanted more than the guarantee.
 */
export const displayStack = '"Bowlby One", "Arial Black", Impact, sans-serif';

export const fontStack =
  'Montserrat, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif';

export const monoStack = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/** The sheet's four radii. `lg` is its button radius, which is the card corner here. */
export const radius = {
  sm: '6px',
  md: '8px',
  lg: '15px',
  pill: '999px',
} as const;

/**
 * Elevation, as a HARD OFFSET in navy with zero blur.
 *
 * This is decision 2 and it is the single most load-bearing thing in the file. The
 * sticker sheet is explicit that a blurred drop shadow "turns this into generic
 * material design instantly" - same tokens, different family. So there is no blur
 * radius anywhere below, and the offset is always down and to the right.
 *
 * Still variables per theme, because the ink changes: navy on cream, and the lighter
 * keyline on the navy ground. A #1D2451 shadow against a #121735 page is invisible,
 * which would silently delete the elevation in dark mode rather than merely dim it.
 */
const SHADOWS = {
  card: ['6px 6px 0 #1D2451', '6px 6px 0 #46507F'],
  /* The sheet's optional depth, with the hard edge kept dominant. */
  raised: [
    '6px 6px 0 #1D2451, 0 20px 40px rgba(20, 26, 59, 0.15)',
    '6px 6px 0 #46507F, 0 20px 40px rgba(0, 0, 0, 0.45)',
  ],
  inset: ['inset 0 2px 0 rgba(29, 36, 81, 0.10)', 'inset 0 2px 0 rgba(0, 0, 0, 0.35)'],
  /** The lift under a bar and under a milestone diamond. Smaller, same family. */
  mark: ['2px 2px 0 #1D2451', '2px 2px 0 #46507F'],
} as const;

export const shadow = Object.fromEntries(
  Object.keys(SHADOWS).map((key) => [key, `var(--shadow-${key})`])
) as Record<keyof typeof SHADOWS, string>;

/**
 * The two `:root` blocks: every token's light value, then the dark overrides.
 *
 * Interpolated once, at the top of GlobalStyle. Nothing else in the app reads TOKENS.
 *
 * `color-scheme` is the line that is easy to leave out and hard to spot missing. It is
 * what tells the browser to draw the things this stylesheet cannot reach - the
 * scrollbars, the select's own dropdown, the native checkbox in the wants-to-learn
 * tick, the caret in a text field - in dark form too. Without it the app goes dark and
 * every native control stays a bright white rectangle on top of it.
 */
export const themeVars = css`
  :root {
    color-scheme: light dark;
    ${Object.entries(TOKENS).map(([key, [light]]) => `${varName(key)}: ${light};`).join('\n    ')}
    ${Object.entries(SHADOWS)
      .map(([key, [light]]) => `--shadow-${key}: ${light};`)
      .join('\n    ')}
  }

  @media (prefers-color-scheme: dark) {
    :root {
      ${Object.entries(TOKENS).map(([key, [, dark]]) => `${varName(key)}: ${dark};`).join('\n      ')}
      ${Object.entries(SHADOWS)
        .map(([key, [, dark]]) => `--shadow-${key}: ${dark};`)
        .join('\n      ')}
    }
  }
`;

/**
 * A paper panel on the cream ground. The app is made of these.
 *
 * 3px keyline, per decision 1 - cards get the heavier of the two weights, small objects
 * get 2px. The border colour is `borderStrong` (navy) rather than `border` (the warm
 * hairline): one ink colour outlines everything, which is what makes a surface read as
 * screen-printed instead of bordered.
 */
export const card = css`
  background: ${palette.card};
  border: 3px solid ${palette.borderStrong};
  /* The sheet's card radius is its MEDIUM one. radius.lg here is its BUTTON radius
     and is deliberately not reused - a 15px card corner softens the printed edge. */
  border-radius: ${radius.md};
  box-shadow: ${shadow.raised};
`;

/**
 * A panel heading, per the sheet's `.cl-title-sm`.
 *
 * Display face, but NOT uppercase and NOT red - both of which belong to the masthead
 * (`.cl-title`). Shouting every panel heading in a heavy uppercase face would make a
 * settings page read as a series of announcements, and it is not what the sheet does.
 */
export const displayHeading = css`
  font-family: ${displayStack};
  font-weight: 400;
  letter-spacing: 0.01em;
  color: ${palette.ink};
`;

/**
 * Text input / select / textarea. One place, so every form field matches.
 *
 * 2px keyline - the small-object weight. Focus is TEAL and not red: decision 5 gives red
 * to primary actions and headings and teal to focus, success and the checked state, and
 * they never swap jobs. A red focus ring would read as an error on a form.
 */
export const field = css`
  font-family: ${fontStack};
  font-size: 13px;
  color: ${palette.ink};
  background: ${palette.card};
  border: 2px solid ${palette.borderStrong};
  border-radius: ${radius.sm};
  padding: 6px 8px;

  &:focus {
    outline: 2px solid ${palette.turquoise};
    outline-offset: 1px;
    background: ${palette.card};
  }

  &:disabled {
    color: ${palette.inkSoft};
    background: ${palette.disabled};
    border-color: ${palette.border};
    cursor: not-allowed;
  }
`;

/**
 * Focus ring. Teal, for the reason above.
 *
 * Applied on :focus-visible everywhere rather than relying on the browser default,
 * which on a warm paper ground is a thin blue-black line that is genuinely hard to see.
 * This screen is keyboard-driven once a lane is expanded - tabbing through date fields
 * is the main editing path - so losing the focus indicator is not cosmetic.
 */
export const focusRing = css`
  &:focus-visible {
    outline: 2px solid ${palette.turquoise};
    outline-offset: 2px;
  }
`;
