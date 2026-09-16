/**
 * Shared chrome: the global reset, buttons, chips, panels.
 *
 * Kept apart from theme.ts so that theme.ts stays importable from anything -
 * including the pure state module and its tests - without dragging
 * createGlobalStyle and a styled-components runtime along with it.
 */

import styled, { createGlobalStyle, css } from 'styled-components';

import {
  card,
  field,
  focusRing,
  fontStack,
  monoStack,
  palette,
  radius,
  shadow,
  themeVars,
} from './theme';

export const GlobalStyle = createGlobalStyle`
  /*
    Every colour in the app, and its dark counterpart. First in the file because a
    custom property has to be declared on an ancestor before anything can read it, and
    :root is as high as it goes. See theme.ts - this is the whole of the dark mode.
  */
  ${themeVars}

  *,
  *::before,
  *::after {
    box-sizing: border-box;
  }

  html,
  body,
  #root {
    height: 100%;
  }

  body {
    margin: 0;
    font-family: ${fontStack};
    font-size: 14px;
    line-height: 1.45;
    color: ${palette.ink};
    /* A very quiet vertical wash rather than a flat fill, so the cards read as
       sitting on something. Fixed attachment so it does not scroll away on a long
       roadmap. Both stops are variables: in the dark theme the wash runs the other
       way round - a plum-black that deepens downward rather than a white that
       pinkens - and a hard-coded second stop was the one thing keeping the page
       white at the bottom of a long scroll. */
    background: linear-gradient(170deg, ${palette.blush} 0%, ${palette.groundEnd} 100%) fixed;
    -webkit-font-smoothing: antialiased;
  }

  h1, h2, h3, h4 {
    margin: 0;
    font-weight: 700;
    letter-spacing: -0.01em;
  }

  button {
    font-family: inherit;
  }

  /*
    Respect a reduced-motion preference globally.

    This screen animates on expand/collapse, and the timeline is wide enough that a
    sliding reflow of nine lanes is a genuine vestibular trigger rather than a
    theoretical one. Overriding at the root means no individual component has to
    remember.
  */
  @media (prefers-reduced-motion: reduce) {
    *,
    *::before,
    *::after {
      animation-duration: 0.01ms !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0.01ms !important;
      scroll-behavior: auto !important;
    }
  }
`;

export const Panel = styled.section`
  ${card};
  padding: 16px 18px;
`;

const buttonBase = css`
  ${focusRing};
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  /* Heavy and uppercase - decision 4. .1em tracking is the sheet's value for small
     labels, and a button label is one. */
  font-weight: 800;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  /* The sheet's dedicated button radius, not the pill. */
  border-radius: ${radius.lg};
  padding: 8px 16px;
  cursor: pointer;
  /* 2px keyline: the small-object weight from decision 1. Navy on every button,
     whatever the fill, because one ink colour outlines everything. */
  border: 2px solid ${palette.borderStrong};
  transition: background-color 120ms ease, box-shadow 120ms ease, transform 120ms ease;

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /*
    Pressed moves the button INTO its own shadow rather than merely down.

    With a hard offset shadow the two have to move together - translating the button
    while the shadow stays put reads as the object tearing away from its outline, which
    is the one motion this family cannot do.
  */
  &:not(:disabled):active {
    transform: translate(2px, 2px);
    box-shadow: none;
  }
`;

export const PrimaryButton = styled.button`
  ${buttonBase};
  background: ${palette.hotPink};
  color: ${palette.onAccent};
  /* The smaller hard offset. A card's 6px under a button reads as a floating slab. */
  box-shadow: ${shadow.mark};

  &:not(:disabled):hover {
    background: ${palette.deepMagenta};
  }
`;

export const SecondaryButton = styled.button`
  ${buttonBase};
  background: ${palette.card};
  color: ${palette.ink};
  box-shadow: ${shadow.mark};

  &:not(:disabled):hover {
    background: ${palette.blush};
  }
`;

/**
 * The confirm step of a destructive action. Red, and used nowhere else.
 *
 * Kept scarce on purpose: red means "this one is irreversible", and it only carries
 * that meaning while it is the rarest button on the screen. It should never appear
 * as the first step of anything - the first press is an ordinary SecondaryButton
 * that reveals this one, so nothing destructive is ever a single click.
 */
export const DangerButton = styled(SecondaryButton)`
  color: ${palette.danger};
  border-color: ${palette.danger};

  &:not(:disabled):hover {
    background: ${palette.danger};
    color: ${palette.onAccent};
  }
`;

/**
 * A toggle that is on or off, with the state carried by fill AND by aria-pressed.
 *
 * `$on` is transient (styled-components v6 strips `$`-prefixed props before they
 * reach the DOM), which matters here: a bare `on` prop would be forwarded to the
 * <button> and React would warn about an unknown attribute on every render.
 */
export const ToggleButton = styled.button<{ $on: boolean }>`
  ${buttonBase};
  /*
    On is TEAL, not red. Decision 5 gives red to primary actions and headings and teal
    to focus, success and the CHECKED STATE, and the two never swap jobs - a red "on"
    would read as a warning rather than as a thing that is switched on.
  */
  background: ${(p) => (p.$on ? palette.turquoise : palette.card)};
  color: ${(p) => (p.$on ? '#141A3B' : palette.inkSoft)};
  box-shadow: ${shadow.mark};

  &:not(:disabled):hover {
    background: ${(p) => (p.$on ? palette.turquoise : palette.blush)};
  }
`;

/** A small stated fact: a count, a date, a status. */
export const Chip = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  /* A chip is a small label: heavy, uppercase, .1em - decision 4. */
  font-weight: 800;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: ${palette.ink};
  background: ${palette.card};
  border: 2px solid ${palette.borderStrong};
  border-radius: ${radius.pill};
  padding: 3px 10px;
  white-space: nowrap;
`;

export const Input = styled.input`
  ${field};
`;

export const Select = styled.select`
  ${field};
`;

export const Label = styled.label`
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
  font-weight: 800;
  /* The sheet's small-label tracking. */
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: ${palette.inkSoft};
`;

/** Explanatory text under a field. Deliberately not italic - it is not an aside. */
export const Hint = styled.span`
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0;
  text-transform: none;
  color: ${palette.inkSoft};
`;

/**
 * The gap where a lazily-loaded page will appear.
 *
 * Deliberately plain text and not a spinner or a skeleton. On a warm cache the chunk
 * arrives in a few milliseconds, and an animation that flashes for one frame is more
 * distracting than a word that does; on a cold load the honest thing to say is that
 * something is being fetched. `min-height` keeps the masthead from jumping up and
 * then back down as the page swaps in.
 */
export const PageLoading = styled.p`
  margin: 0;
  padding: 48px 0;
  min-height: 220px;
  text-align: center;
  color: ${palette.inkSoft};
  font-size: 13px;
`;

export const ErrorText = styled.p`
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  color: ${palette.danger};
`;

export const Mono = styled.span`
  font-family: ${monoStack};
  font-size: 12px;
`;

/** Present to a screen reader, absent on screen. */
export const VisuallyHidden = styled.span`
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
`;
