/**
 * Shared chrome: the global reset, buttons, chips, panels.
 *
 * Kept apart from theme.ts so that theme.ts stays importable from anything -
 * including the pure state module and its tests - without dragging
 * createGlobalStyle and a styled-components runtime along with it.
 */

import styled, { createGlobalStyle, css } from 'styled-components';

import { card, field, focusRing, fontStack, monoStack, palette, radius, shadow } from './theme';

export const GlobalStyle = createGlobalStyle`
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
    /* A very quiet vertical wash rather than a flat fill, so the white cards read
       as sitting on something. Fixed attachment so it does not scroll away on a
       long roadmap. */
    background: linear-gradient(170deg, ${palette.blush} 0%, #FFE9F4 100%) fixed;
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
  font-size: 13px;
  font-weight: 600;
  border-radius: ${radius.pill};
  padding: 7px 14px;
  cursor: pointer;
  border: 1px solid transparent;
  transition: background-color 120ms ease, box-shadow 120ms ease, transform 120ms ease;

  &:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  &:not(:disabled):active {
    transform: translateY(1px);
  }
`;

export const PrimaryButton = styled.button`
  ${buttonBase};
  background: ${palette.hotPink};
  color: #ffffff;
  box-shadow: ${shadow.card};

  &:not(:disabled):hover {
    background: ${palette.deepMagenta};
  }
`;

export const SecondaryButton = styled.button`
  ${buttonBase};
  background: ${palette.card};
  color: ${palette.deepMagenta};
  border-color: ${palette.borderStrong};

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
    color: #ffffff;
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
  background: ${(p) => (p.$on ? palette.deepMagenta : palette.card)};
  color: ${(p) => (p.$on ? '#ffffff' : palette.inkSoft)};
  border-color: ${(p) => (p.$on ? palette.deepMagenta : palette.border)};

  &:not(:disabled):hover {
    background: ${(p) => (p.$on ? palette.deepMagenta : palette.blush)};
  }
`;

/** A small stated fact: a count, a date, a status. */
export const Chip = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  font-weight: 600;
  color: ${palette.deepMagenta};
  background: ${palette.blush};
  border: 1px solid ${palette.border};
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
  font-weight: 700;
  letter-spacing: 0.04em;
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
