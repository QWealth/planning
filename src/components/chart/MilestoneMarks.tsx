/**
 * Milestone diamonds, drawn along the top of a collapsed lane.
 *
 * THE DIAMOND IS ALREADY TAKEN, AND THAT IS THE MAIN PROBLEM THIS FILE SOLVES.
 *
 * Bar.tsx draws a same-day phase as a diamond, in that phase's lifecycle colour, on
 * the bar's centreline - because a one-day bar rendered to scale is a four-pixel
 * sliver that reads as a rendering fault. Four phases in the live data are same-day,
 * so that shape is not going away, and a milestone that looked identical to it would
 * make the chart ambiguous in the one place it needs to be exact.
 *
 * So a milestone differs on THREE axes at once, not one:
 *
 *   position - milestones sit at the TOP of the lane, on their own band above the
 *              bar. A phase diamond is always on the centreline.
 *   colour   - the data-state colours (plum, red, grey), never a lifecycle colour.
 *              theme.ts reserves these precisely so that "a state of the data" and "a
 *              stage of the work" can never be confused for one another.
 *   fill     - solid for due, ringed for missed, hollow for done. This is the axis
 *              that survives a monochrome print and the two commonest colour vision
 *              deficiencies, which is why status is not carried by hue alone. Every
 *              mark also states its status in words, in the title and the aria-label.
 *
 * A stem drops from each diamond to the foot of the lane. Without it a mark floating
 * above a segmented bar is hard to line up against the bands it is judging - and
 * "does this deadline land inside the coding stripe or after it" is the entire
 * question somebody is asking when they look at one.
 *
 * A DONE MILESTONE STAYS DRAWN. It is history: hiding it once achieved would lose
 * the record that the date was met, and the lane would silently rewrite itself into
 * a project that never had a deadline.
 */

import styled from 'styled-components';

import { palette, shadow } from '../../styles/theme';
import { placeDay, type Grid } from '../../utils/dates';
import { describeMark, type MilestoneMark, type MilestoneStatus } from '../../utils/milestones';

/** Edge length of the un-rotated square. Its diagonal is ~1.41x this. */
const SIZE = 10;

interface Look {
  fill: string;
  border: string;
  /** A second outline, so `missed` differs in SHAPE and not only in hue. */
  ring: boolean;
}

const LOOK: Record<MilestoneStatus, Look> = {
  // Deep plum - the today marker's colour. Deliberately the chart's "fixed points in
  // time" family rather than anything from the lifecycle palette.
  due: { fill: palette.today, border: palette.card, ring: false },
  missed: { fill: palette.danger, border: palette.card, ring: true },
  // Hollow: finished business should recede rather than compete with what is still
  // outstanding, and an outline is the natural shape for a moment already passed.
  done: { fill: palette.card, border: palette.slateDeep, ring: false },
};

/**
 * The hit area and the stem's anchor. Sixteen pixels square, which is bigger than the
 * 10px diamond on purpose - a 10px rotated target is not a reasonable thing to ask
 * anybody to hover, and the tooltip is where the milestone's name actually lives.
 */
const Mark = styled.div<{ $left: number }>`
  position: absolute;
  top: 0;
  left: ${(p) => p.$left}%;
  transform: translateX(-50%);
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
`;

const Diamond = styled.span<{ $look: Look }>`
  width: ${SIZE}px;
  height: ${SIZE}px;
  background: ${(p) => p.$look.fill};
  border: 1.5px solid ${(p) => p.$look.border};
  /* Barely rounded rather than sharp, matching Bar.tsx's same-day diamond, so the two
     read as the same family of shape even though they mean different things. */
  border-radius: 2px;
  transform: rotate(45deg);
  box-shadow: ${(p) =>
    p.$look.ring
      ? `0 0 0 1.5px ${p.$look.fill}, ${shadow.mark}`
      : shadow.mark};
`;

/**
 * Dotted, faint, and behind everything - it is a plumb line, not a divider.
 *
 * `pointer-events: none` for the same reason the today line has it: this crosses the
 * bar, and a hairline that swallowed clicks would steal them from the segment
 * underneath, which is the thing people actually want to hover.
 */
const Stem = styled.div<{ $left: number }>`
  position: absolute;
  top: 14px;
  bottom: 2px;
  left: ${(p) => p.$left}%;
  width: 0;
  border-left: 1px dotted ${palette.slateDeep};
  opacity: 0.45;
  pointer-events: none;
`;

/**
 * The number of milestones a diamond stands for, when it stands for more than one.
 *
 * Shown rather than left to the tooltip: two milestones on one day are drawn as one
 * mark (see utils/milestones.ts), and an unmarked cluster would understate how much
 * is riding on that date to anyone who does not hover it.
 */
const Count = styled.span`
  position: absolute;
  left: 14px;
  top: 0;
  font-size: 9px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: ${palette.slateDeep};
`;

/**
 * One diamond on its own, for callers that place it themselves.
 *
 * Exported so the expanded lane's per-milestone rows can show the same shape in the
 * same three treatments without copying LOOK. Copying it is the failure that matters:
 * two tables would drift, and the chart would end up saying "missed" in red in one
 * place and plum in another - which is exactly the ambiguity the three-axis scheme
 * above exists to prevent.
 */
export function MilestoneDiamond({ status }: { status: MilestoneStatus }) {
  return <Diamond $look={LOOK[status]} />;
}

export interface MilestoneMarksProps {
  grid: Grid;
  marks: MilestoneMark[];
  /** Today, for turning a date into due / missed / done. */
  today: string;
  /** Project name, so a mark's label makes sense read on its own. */
  project: string;
}

export default function MilestoneMarks({ grid, marks, today, project }: MilestoneMarksProps) {
  if (marks.length === 0) {
    return null;
  }

  return (
    <>
      {marks.map((mark) => {
        const leftPct = placeDay(grid, mark.date);
        // buildGrid is widened to cover every milestone date, so this should not
        // happen - but a diamond at -6% is invisible and silently wrong rather than
        // absent, which is the sort of thing that goes unnoticed for months.
        if (leftPct < 0 || leftPct > 100) {
          return null;
        }

        const label = `${project} — ${describeMark(mark, today)}`;
        const look = LOOK[mark.status];

        return (
          <div key={mark.date}>
            <Stem $left={leftPct} aria-hidden />
            <Mark $left={leftPct} title={label} role="img" aria-label={label}>
              <Diamond $look={look} />
              {mark.milestones.length > 1 ? <Count>{mark.milestones.length}</Count> : null}
            </Mark>
          </div>
        );
      })}
    </>
  );
}
