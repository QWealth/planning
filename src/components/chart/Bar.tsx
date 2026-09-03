/**
 * One bar on the timeline, and the rules for what a bar even is.
 *
 * The visual grammar, which is used identically for a collapsed lane and for an
 * individual phase, so that expanding a lane shows you more detail rather than a
 * different language:
 *
 *   pale fill    - the span, work not yet done
 *   solid fill   - the recorded progress through that span
 *   diagonal     - progress has NOT been recorded. Not the same as zero, and drawn
 *                  differently on purpose: five phases in the live data are at 0.0
 *                  and three are at null, and the workbook rendered both as an empty
 *                  cell, which is how "we have not looked at this yet" and "this has
 *                  not started" became the same thing on screen.
 *   diamond      - a single day. Three phases in Net Of Fees and one in D2 start and
 *                  end on the same date; drawn to scale that is a four-pixel sliver
 *                  that reads as a rendering fault, so it gets the milestone shape
 *                  the rest of the world uses.
 *   open edge    - one date known and the other not. The API allows this on purpose
 *                  (you know when something starts before you know when it ends) and
 *                  the alternative to drawing it is inventing the missing end.
 */

import styled from 'styled-components';

import { palette, radius, shadow, STATE_STYLE, type PhaseState } from '../../styles/theme';
import { formatLong, place, placeDay, type Grid } from '../../utils/dates';

const BAR_HEIGHT = 20;
/** Width given to the known side of a half-scheduled bar, in days. */
const OPEN_EDGE_DAYS = 10;

export type Geometry =
  | { kind: 'none' }
  | { kind: 'bar'; leftPct: number; widthPct: number; days: number }
  | { kind: 'milestone'; leftPct: number }
  | { kind: 'open-end'; leftPct: number; widthPct: number }
  | { kind: 'open-start'; leftPct: number; widthPct: number };

/**
 * Turn a start/end pair into something drawable.
 *
 * A one-day span becomes a milestone rather than a bar. Two days and up stay bars:
 * the threshold is on the DURATION and not on the rendered width, so the same phase
 * does not change shape when the window is resized.
 */
export function geometry(grid: Grid, start: string | null, end: string | null): Geometry {
  if (start && end) {
    const placement = place(grid, start, end);
    if (placement.days <= 1) {
      return { kind: 'milestone', leftPct: placeDay(grid, start) };
    }
    return { kind: 'bar', ...placement };
  }

  const openWidth = (OPEN_EDGE_DAYS / grid.totalDays) * 100;

  if (start) {
    return { kind: 'open-end', leftPct: placeDay(grid, start), widthPct: openWidth };
  }
  if (end) {
    return {
      kind: 'open-start',
      leftPct: Math.max(0, placeDay(grid, end) - openWidth),
      widthPct: openWidth,
    };
  }
  return { kind: 'none' };
}

const Shell = styled.div<{ $left: number; $width: number; $fill: string; $open: string | null }>`
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  left: ${(p) => p.$left}%;
  width: ${(p) => p.$width}%;
  height: ${BAR_HEIGHT}px;
  /* A four-hex-digit alpha suffix on the state colour: the same hue, 25% opaque, so
     the pale portion is unmistakably the same phase as the solid portion. */
  background: ${(p) => p.$fill}40;
  border: 1px solid ${(p) => p.$fill};
  border-radius: ${radius.pill};
  overflow: hidden;

  /* A half-scheduled bar fades out on the unknown side and loses its border there,
     so it cannot be mistaken for a bar that genuinely ends where it stops. */
  ${(p) =>
    p.$open === 'end' &&
    `
      border-right: none;
      border-top-right-radius: 0;
      border-bottom-right-radius: 0;
      mask-image: linear-gradient(to right, #000 55%, transparent 100%);
    `}
  ${(p) =>
    p.$open === 'start' &&
    `
      border-left: none;
      border-top-left-radius: 0;
      border-bottom-left-radius: 0;
      mask-image: linear-gradient(to left, #000 55%, transparent 100%);
    `}
`;

const Progress = styled.div<{ $pct: number; $fill: string }>`
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: ${(p) => p.$pct}%;
  background: ${(p) => p.$fill};
`;

/** Diagonal hatching: progress has not been recorded. */
const Unknown = styled.div<{ $fill: string }>`
  position: absolute;
  inset: 0;
  background: repeating-linear-gradient(
    135deg,
    ${(p) => p.$fill} 0,
    ${(p) => p.$fill} 3px,
    transparent 3px,
    transparent 9px
  );
  opacity: 0.55;
`;

const Diamond = styled.div<{ $left: number; $fill: string }>`
  position: absolute;
  top: 50%;
  left: ${(p) => p.$left}%;
  width: 13px;
  height: 13px;
  margin: -7px 0 0 -6px;
  background: ${(p) => p.$fill};
  border: 1px solid ${palette.card};
  border-radius: 3px;
  transform: rotate(45deg);
  box-shadow: ${shadow.mark};
`;

/**
 * The caption beside the bar.
 *
 * Outside the bar rather than inside it, always. Inside would need the text colour
 * to flip depending on whether the solid progress fill happens to have reached that
 * far, which is a contrast bug waiting for the one bar at 48%. Outside is legible
 * against every state colour and against none.
 *
 * It flips to the left of the bar past the two-thirds mark so a late-running project
 * does not have its caption clipped off the right edge of the chart.
 */
export const Caption = styled.span<{ $left: number; $flip: boolean }>`
  position: absolute;
  top: 50%;
  transform: translateY(-50%) ${(p) => (p.$flip ? 'translateX(-100%)' : 'none')};
  left: ${(p) => p.$left}%;
  margin-left: ${(p) => (p.$flip ? '-8px' : '8px')};
  font-size: 11px;
  font-weight: 600;
  color: ${palette.inkSoft};
  white-space: nowrap;
  pointer-events: none;
`;

export interface BarProps {
  grid: Grid;
  start: string | null;
  end: string | null;
  state: PhaseState;
  /** 0..1, or null for "not recorded" - which is drawn as hatching, not as zero. */
  progress: number | null;
  /** Short text beside the bar. */
  caption?: string;
  /** Full sentence for the native tooltip and for screen readers. */
  title: string;
}

export default function Bar({ grid, start, end, state, progress, caption, title }: BarProps) {
  const geo = geometry(grid, start, end);
  const { fill } = STATE_STYLE[state];

  if (geo.kind === 'none') {
    return null;
  }

  if (geo.kind === 'milestone') {
    return (
      <>
        <Diamond $left={geo.leftPct} $fill={fill} title={title} role="img" aria-label={title} />
        {caption ? (
          <Caption $left={geo.leftPct} $flip={geo.leftPct > 66}>
            {caption}
          </Caption>
        ) : null}
      </>
    );
  }

  const open = geo.kind === 'open-end' ? 'end' : geo.kind === 'open-start' ? 'start' : null;
  const captionAt = geo.leftPct + geo.widthPct;
  const flip = captionAt > 66;

  return (
    <>
      <Shell
        $left={geo.leftPct}
        $width={geo.widthPct}
        $fill={fill}
        $open={open}
        title={title}
        role="img"
        aria-label={title}
      >
        {progress === null ? (
          <Unknown $fill={fill} />
        ) : (
          <Progress $pct={Math.max(0, Math.min(1, progress)) * 100} $fill={fill} />
        )}
      </Shell>
      {caption ? (
        <Caption $left={flip ? geo.leftPct : captionAt} $flip={flip}>
          {caption}
        </Caption>
      ) : null}
    </>
  );
}

/** "13 Aug 2026 to 13 Sep 2026", or an honest phrase when one end is missing. */
export function describeSpan(start: string | null, end: string | null): string {
  if (start && end) {
    return start === end ? `${formatLong(start)} (one day)` : `${formatLong(start)} to ${formatLong(end)}`;
  }
  if (start) {
    return `starts ${formatLong(start)}, no end date set`;
  }
  if (end) {
    return `no start date set, ends ${formatLong(end)}`;
  }
  return 'not scheduled';
}

/** "62%" or "progress not recorded". Never "0%" for an unknown. */
export function describeProgress(progress: number | null): string {
  return progress === null ? 'progress not recorded' : `${Math.round(progress * 100)}%`;
}
