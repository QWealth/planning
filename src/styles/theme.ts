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
 */

import { css } from 'styled-components';

/** Named colours, so the state map below reads as a decision and not as hex codes. */
export const palette = {
  /* PANTONE 219 C, the actual Barbie pink. Reserved for the most advanced state
     and for primary actions - if it is everywhere it emphasises nothing. */
  hotPink: '#E0218A',
  deepMagenta: '#B01271',
  bubblegum: '#FFB3D9',
  lilac: '#C77DFF',
  turquoise: '#1FC7CE',

  /* Chrome. The "white" is faintly warm so the pinks do not look pasted on. */
  blush: '#FFF5FA',
  card: '#FFFFFF',
  border: '#F4C9DF',
  borderStrong: '#E79CC3',

  /* Ink is a deep plum rather than black: pure black against blush reads as a
     rendering artefact, and this keeps contrast above 12:1 either way. */
  ink: '#2E1524',
  inkSoft: '#7A5468',

  /* Grey is warm - pink-tinted - so the states that share it look like part of the
     scheme rather than an unstyled fallback. */
  slate: '#B4A2AC',
  slateDeep: '#8C7A85',

  /* Reserved for states of the data, never for a lifecycle state. */
  danger: '#C1121F',
  warning: '#B8860B',
  today: '#5C1138',
} as const;

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

export const STATE_STYLE: Record<PhaseState, StateStyle> = {
  coding: { fill: palette.hotPink, on: '#FFFFFF', label: 'Coding' },
  architecting: { fill: palette.turquoise, on: '#0A3B3D', label: 'Architecting' },
  wireframes: { fill: palette.lilac, on: '#2B0B3D', label: 'Wireframes' },
  planning: { fill: palette.bubblegum, on: '#5C1138', label: 'Planning' },
  other: { fill: palette.slate, on: '#2E1524', label: 'Other work' },
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

/** Elevation, as a tinted shadow rather than a grey one. */
export const shadow = {
  card: '0 1px 2px rgba(94, 17, 56, 0.06), 0 6px 18px rgba(94, 17, 56, 0.07)',
  raised: '0 2px 4px rgba(94, 17, 56, 0.10), 0 12px 28px rgba(94, 17, 56, 0.12)',
  inset: 'inset 0 1px 2px rgba(94, 17, 56, 0.10)',
} as const;

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
    background: #f6f0f3;
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
