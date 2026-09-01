/**
 * The collapsed lane's bar, divided vertically wherever phases overlap.
 *
 * The grammar, which extends Bar.tsx's rather than competing with it:
 *
 *   hairline rule - the project's overall extent, first start to last end. Drawn
 *                   under everything so the lane still reads as one object even
 *                   when its work is in two clumps four months apart.
 *   solid block   - work. Only where work actually is, so a quiet month looks quiet.
 *   stacked bands - two or more phases running at once, split vertically at fixed
 *                   row height. The row does not grow: nine lanes still fit on a
 *                   screen, which is the entire reason the workbook's 54 rows were
 *                   collapsed in the first place.
 *   hatching      - progress not recorded for that band, same meaning as in Bar.
 *
 * Band ORDER is by state rank and is decided in utils/segments.ts, so a colour keeps
 * the same vertical position all the way across a row. That is what makes the split
 * legible rather than a mosaic: the coding stripe is always the top one, so the eye
 * can follow it across boundaries where other phases start and stop.
 *
 * Progress is deliberately not drawn as a proportional fill inside a band - see the
 * header of utils/segments.ts for why a fraction of a time-slice is a number nobody
 * has. It stays in the caption and the tooltip.
 */

import styled from 'styled-components';

import { palette, radius, STATE_STYLE } from '../../styles/theme';
import { formatLong, place, type Grid } from '../../utils/dates';
import { describeSegment, type Band, type Segment } from '../../utils/segments';
import type { Phase } from '../../types';
import { Caption, describeProgress } from './Bar';

/** Slightly taller than a single Bar: at four concurrent phases each band is ~6px. */
const BAR_HEIGHT = 24;

/**
 * The project's full extent, drawn as a hairline behind the blocks.
 *
 * Without it two clumps of work separated by a gap read as two unrelated objects on
 * the row. With it they read as one project that is quiet in between - which is the
 * true statement, and the one the old solid hull could not make because it filled
 * the gap in.
 */
const Extent = styled.div<{ $left: number; $width: number }>`
  position: absolute;
  top: 50%;
  left: ${(p) => p.$left}%;
  width: ${(p) => p.$width}%;
  height: 0;
  border-top: 1px dashed ${palette.borderStrong};
  opacity: 0.8;
`;

const Block = styled.div<{ $left: number; $width: number }>`
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  left: ${(p) => p.$left}%;
  width: ${(p) => p.$width}%;
  /* A minimum width so a one-day segment inside a long lane is still clickable and
     still visible. Percentages alone would render it sub-pixel on a year-long grid. */
  min-width: 3px;
  height: ${BAR_HEIGHT}px;
  display: flex;
  flex-direction: column;
  border: 1px solid rgba(46, 21, 36, 0.22);
  border-radius: ${radius.sm};
  overflow: hidden;
  background: ${palette.card};
`;

/**
 * One colour stripe. `flex: 1` rather than a computed height so N bands always fill
 * the block exactly - a percentage height would leave a rounding gap at the bottom
 * of every three-band segment.
 */
const Stripe = styled.div<{ $fill: string; $unknown: boolean }>`
  flex: 1;
  min-height: 0;
  background: ${(p) => p.$fill};

  /* Hatched when progress is not recorded. The one piece of the progress grammar
     that survives into a 6px stripe, because null-versus-zero is the distinction
     this app exists to keep. */
  ${(p) =>
    p.$unknown &&
    `
      background: repeating-linear-gradient(
        135deg,
        ${p.$fill} 0,
        ${p.$fill} 3px,
        rgba(255, 255, 255, 0.85) 3px,
        rgba(255, 255, 255, 0.85) 7px
      );
    `}

  /* Hairline between stacked bands so two adjacent colours cannot bleed into a
     third apparent colour at the join. */
  & + & {
    border-top: 1px solid rgba(255, 255, 255, 0.55);
  }
`;

function bandTitle(band: Band, name: (phase: Phase) => string): string {
  const names = band.phases.map(name).join(', ');
  return `${names} — ${describeProgress(band.progress)}`;
}

export interface SegmentedBarProps {
  grid: Grid;
  segments: Segment[];
  /** Earliest start across the lane, for the extent rule. */
  start: string;
  /** Latest end across the lane, for the extent rule. */
  end: string;
  caption?: string;
  /** Full sentence for the lane as a whole. */
  title: string;
  /**
   * How to name a phase in the tooltips. Defaults to the phase's own name, which is
   * enough inside a project lane and is not enough on a person's row, where "Coding
   * and Coding" needs to read "Coding (Tax) and Coding (QWAPP)".
   *
   * Naming rather than renaming: the phase objects are untouched, so phaseState still
   * matches on the real name and the colours do not change underneath the caller.
   */
  describePhase?: (phase: Phase) => string;
}

export default function SegmentedBar({
  grid,
  segments,
  start,
  end,
  caption,
  title,
  describePhase = (phase) => phase.name,
}: SegmentedBarProps) {
  if (segments.length === 0) {
    return null;
  }

  const extent = place(grid, start, end);
  const last = place(grid, segments[segments.length - 1].start, segments[segments.length - 1].end);
  const captionAt = Math.max(extent.leftPct + extent.widthPct, last.leftPct + last.widthPct);
  const flip = captionAt > 66;

  return (
    <>
      <Extent
        $left={extent.leftPct}
        $width={extent.widthPct}
        title={title}
        role="img"
        aria-label={title}
      />

      {segments.map((segment) => {
        const geo = place(grid, segment.start, segment.end);
        const when =
          segment.start === segment.end
            ? formatLong(segment.start)
            : `${formatLong(segment.start)} to ${formatLong(segment.end)}`;
        const label = `${describeSegment(segment, describePhase)} — ${when}`;

        return (
          <Block
            key={segment.start}
            $left={geo.leftPct}
            $width={geo.widthPct}
            title={label}
            role="img"
            aria-label={label}
          >
            {segment.bands.map((band) => (
              <Stripe
                key={band.state}
                $fill={STATE_STYLE[band.state].fill}
                $unknown={band.progress === null}
                title={bandTitle(band, describePhase)}
              />
            ))}
          </Block>
        );
      })}

      {caption ? (
        <Caption $left={flip ? extent.leftPct : captionAt} $flip={flip}>
          {caption}
        </Caption>
      ) : null}
    </>
  );
}
