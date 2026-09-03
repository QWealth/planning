/**
 * The palette, and the small set of shared surfaces built from it.
 *
 * Barbie, by request. The constraint that shapes every colour choice below is that
 * this palette is not decoration: colour is how a collapsed lane tells you what
 * state a project is in, which is the entire reason the nine swim-lane groups could
 * be compressed to nine rows. A pink monochrome would be on-brief and would destroy
 * the thing the colour is for.
 *
 * So the four lifecycle states get four colours that differ in HUE AND IN LIGHTNESS,
 * not four tints of one hue. Lightness is the part that survives a monochrome print,
 * a bad projector, and the two commonest colour vision deficiencies - under
 * deuteranopia the bubblegum and the lilac converge in hue and stay apart only
 * because one is far lighter than the other. Nothing here relies on colour alone
 * either: every bar carries its state as text, and the legend names all five.
 *
 * Turquoise is not a compromise with the brief. Barbie's own product palette has
 * always run pink / magenta / turquoise / lilac; the doll's packaging is not
 * monochrome and neither is this.
 *
 * DARK MODE: BLACK AND PINK, TAKEN FROM THE OPERATING SYSTEM
 * ----------------------------------------------------------
 * There is no theme switch, by request, and none of the usual machinery that goes
 * with one: no toggle in the toolbar, no icon, no stored preference, no context, no
 * flash of the wrong theme while a stored choice is read back. The whole mechanism is
 * one `@media (prefers-color-scheme: dark)` block in `themeVars` below, which is the
 * same shape of decision the app already makes for `prefers-reduced-motion` - the
 * operating system has been asked this question once, by somebody who meant it, and
 * asking again in every app is how a machine set to dark ends up with one white
 * window in it.
 *
 * The mechanism is CSS CUSTOM PROPERTIES, and that choice is what kept this small.
 * Every value below is a `var(--c-…)`, so all 271 `palette.x` interpolations across
 * 27 files went on meaning what they meant; only the two ends of each variable had to
 * be decided. A second palette object switched at runtime would have needed a
 * ThemeProvider, a matchMedia listener and a re-render of the whole tree on a system
 * theme change, to arrive at the same pixels the browser will produce on its own.
 *
 * TWO RULES DECIDED THE DARK VALUES.
 *
 * 1. THE CHROME INVERTS; THE DATA DOES NOT. Ground, card, border, ink and the accent
 *    pinks all flip. The five lifecycle fills - hotPink, turquoise, lilac, bubblegum,
 *    slate - and the `on` colours that sit on them do NOT, and STATE_STYLE below is
 *    deliberately still written in literal hex for that reason. A bar's colour is the
 *    project's state; a reader who learns that bubblegum means Planning has learned it
 *    for both themes, and a legend swatch has to match the bar it explains. They were
 *    already chosen to hold up against a light ground and they hold up against a dark
 *    one because they are all light themselves.
 *
 * 2. WHAT SITS ON A PINK FILL FLIPS WITH IT. In light mode the strong pinks are
 *    darker than the page and carry white text. In dark mode they are LIGHTER than the
 *    page - a dark-mode accent has to be, or it disappears - so white text on them
 *    would be two bright colours on top of each other. That is what `onAccent` is:
 *    white in the light theme, near-black in the dark one, applied wherever a label
 *    sits on hotPink, deepMagenta or danger. It is the one thing here that cannot be
 *    solved by re-pointing a variable, because the literal `#ffffff` at those call
 *    sites was itself the assumption that broke.
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
  pink: '#E0218A',
  turquoise: '#1FC7CE',
  lilac: '#C77DFF',
  bubblegum: '#FFB3D9',
  slate: '#B4A2AC',
} as const;

const TOKENS = {
  /* PANTONE 219 C, the actual Barbie pink. Reserved for the most advanced state
     and for primary actions - if it is everywhere it emphasises nothing. Lifted in
     the dark theme, where 219 C against near-black is under 4.5:1 as text. */
  hotPink: [FILL.pink, '#FF56AC'],
  /* The heavier pink: a strong FILL under white text on a light ground, and accent
     TEXT on a dark one. That dual life is why onAccent exists. */
  deepMagenta: ['#B01271', '#FF8CC8'],
  /* Lifecycle fills. Identical in both themes - see rule 1 in the header. */
  bubblegum: [FILL.bubblegum, FILL.bubblegum],
  lilac: [FILL.lilac, FILL.lilac],
  turquoise: [FILL.turquoise, FILL.turquoise],

  /* Chrome. The light "white" is faintly warm so the pinks do not look pasted on,
     and the dark ground is faintly plum for the same reason in reverse - flat #000
     under a pink accent reads as a hole rather than as a surface. */
  blush: ['#FFF5FA', '#0A0509'],
  /** The far end of the body's background wash. See GlobalStyle. */
  groundEnd: ['#FFE9F4', '#150A12'],
  card: ['#FFFFFF', '#150E14'],
  /** A card that is switched off: the deactivated roster row. */
  inactive: ['#FBF6F9', '#100A0E'],
  /** A form field that cannot be typed in. */
  disabled: ['#F6F0F3', '#241A20'],
  border: ['#F4C9DF', '#3A2231'],
  borderStrong: ['#E79CC3', '#5C3247'],

  /* Ink is a deep plum rather than black: pure black against blush reads as a
     rendering artefact, and this keeps contrast above 12:1 either way. Its dark
     counterpart is warm off-white for the same reason - #FFF on #000 is a glare. */
  ink: ['#2E1524', '#F7E9F1'],
  inkSoft: ['#7A5468', '#C2A2B4'],
  /** Text and marks that sit ON a saturated fill. See rule 2 in the header. */
  onAccent: ['#FFFFFF', '#1A0510'],

  /* Grey is warm - pink-tinted - so the states that share it look like part of the
     scheme rather than an unstyled fallback. `slate` is a lifecycle fill and holds
     still; `slateDeep` is muted text and has to lift off a dark ground. */
  slate: [FILL.slate, FILL.slate],
  slateDeep: ['#8C7A85', '#A895A1'],

  /* Reserved for states of the data, never for a lifecycle state. */
  danger: ['#C1121F', '#FF6B6B'],
  warning: ['#B8860B', '#E0B341'],
  today: ['#5C1138', '#FF9ED0'],

  /*
    The translucent tints. These were 28 literal rgba() calls scattered across the
    chart and the panels, and every one of them was a tint of ink, of pink or of
    slate over a WHITE ground - which is the assumption dark mode breaks: ink at 12%
    over near-black is not a faint hairline, it is nothing at all. Named here so the
    inversion happens once.
  */
  /** A rule that is a tint of the ink rather than a border colour of its own. */
  hairline: ['rgba(46, 21, 36, 0.12)', 'rgba(255, 214, 236, 0.16)'],
  hairlineStrong: ['rgba(46, 21, 36, 0.22)', 'rgba(255, 214, 236, 0.26)'],
  /** A panel tinted by the accent: the invite box, the active nav tab. */
  pinkWash: ['rgba(224, 33, 138, 0.06)', 'rgba(255, 86, 172, 0.12)'],
  pinkWashStrong: ['rgba(224, 33, 138, 0.20)', 'rgba(255, 86, 172, 0.30)'],
  /** The neutral counterpart, for a band nobody is responsible for. */
  slateWash: ['rgba(180, 162, 172, 0.12)', 'rgba(180, 162, 172, 0.14)'],
  /** The blush ground behind a phase row and behind a project banner. */
  banner: ['rgba(255, 214, 236, 0.30)', 'rgba(255, 86, 172, 0.10)'],
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
  coding: { fill: FILL.pink, on: '#FFFFFF', label: 'Coding' },
  architecting: { fill: FILL.turquoise, on: '#0A3B3D', label: 'Architecting' },
  wireframes: { fill: FILL.lilac, on: '#2B0B3D', label: 'Wireframes' },
  planning: { fill: FILL.bubblegum, on: '#5C1138', label: 'Planning' },
  other: { fill: FILL.slate, on: '#2E1524', label: 'Other work' },
};

/**
 * A sans stack, no webfont.
 *
 * A Barbie-script display face is tempting and would have to come from a CDN, which
 * means the app renders unstyled or not at all on a locked-down network - and this
 * is an internal tool behind a login. The personality is carried by colour and shape
 * instead. Avenir Next first because it is present on every Mac in the firm and is
 * the roundest thing available without a download.
 */
export const fontStack =
  "'Avenir Next', 'Segoe UI Variable Display', 'Segoe UI', system-ui, -apple-system, sans-serif";

export const monoStack = "'SF Mono', 'Cascadia Mono', Menlo, Consolas, monospace";

/** The one radius. Everything is soft-cornered; nothing is a perfect rectangle. */
export const radius = {
  sm: '6px',
  md: '10px',
  lg: '16px',
  pill: '999px',
} as const;

/**
 * Elevation, as a tinted shadow rather than a grey one.
 *
 * Variables for the same reason the colours are, and with a twist worth stating: a
 * plum shadow at 7% is invisible against a near-black ground, so dark mode does not
 * merely darken these, it leans on them harder and drops the tint. Elevation is the
 * only thing separating a card from the page once both are dark, where in the light
 * theme the white-on-blush contrast was doing most of that work by itself.
 */
const SHADOWS = {
  card: [
    '0 1px 2px rgba(94, 17, 56, 0.06), 0 6px 18px rgba(94, 17, 56, 0.07)',
    '0 1px 2px rgba(0, 0, 0, 0.50), 0 6px 18px rgba(0, 0, 0, 0.45)',
  ],
  raised: [
    '0 2px 4px rgba(94, 17, 56, 0.10), 0 12px 28px rgba(94, 17, 56, 0.12)',
    '0 2px 4px rgba(0, 0, 0, 0.55), 0 12px 28px rgba(0, 0, 0, 0.55)',
  ],
  inset: ['inset 0 1px 2px rgba(94, 17, 56, 0.10)', 'inset 0 1px 2px rgba(0, 0, 0, 0.45)'],
  /** The lift under a bar and under a milestone diamond. */
  mark: ['0 1px 3px rgba(94, 17, 56, 0.30)', '0 1px 3px rgba(0, 0, 0, 0.55)'],
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

/** A white panel on the blush ground. The app is made of these. */
export const card = css`
  background: ${palette.card};
  border: 1px solid ${palette.border};
  border-radius: ${radius.lg};
  box-shadow: ${shadow.card};
`;

/** Text input / select / textarea. One place, so every form field matches. */
export const field = css`
  font-family: ${fontStack};
  font-size: 13px;
  color: ${palette.ink};
  background: ${palette.blush};
  border: 1px solid ${palette.border};
  border-radius: ${radius.sm};
  padding: 6px 8px;
  box-shadow: ${shadow.inset};

  &:focus {
    outline: 2px solid ${palette.hotPink};
    outline-offset: 1px;
    background: ${palette.card};
  }

  &:disabled {
    color: ${palette.inkSoft};
    background: ${palette.disabled};
    cursor: not-allowed;
  }
`;

/**
 * Focus ring.
 *
 * Applied on :focus-visible everywhere rather than relying on the browser default,
 * which on a pink ground is a thin blue-black line that is genuinely hard to see.
 * This screen is keyboard-driven once a lane is expanded - tabbing through date
 * fields is the main editing path - so losing the focus indicator is not cosmetic.
 */
export const focusRing = css`
  &:focus-visible {
    outline: 2px solid ${palette.hotPink};
    outline-offset: 2px;
  }
`;
