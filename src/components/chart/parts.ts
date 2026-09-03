/**
 * The chart's styled pieces, and the geometry constants they agree on.
 *
 * Two things here are load-bearing rather than cosmetic.
 *
 * LABEL_WIDTH is shared by the header, every row, and the gridline/today overlay.
 * The overlay is absolutely positioned at `left: LABEL_WIDTH; right: 0`, which makes
 * its width exactly the track width - and that is what lets a bar at `left: 42%` and
 * a gridline at `42%` of the overlay land on the same pixel. If a row ever gets its
 * own label width the marker silently stops lining up with the bars, and a Gantt
 * chart whose today line is in the wrong place is worse than one with no today line.
 *
 * Every horizontal position on the chart is a percentage of the FULL span, never a
 * pixel, so the whole thing is fluid without a resize observer. Weeks are all seven
 * days, so equal-flex header cells and percentage-placed bars stay in step exactly.
 */

import styled, { css } from 'styled-components';

import { fontStack, palette, radius, shadow } from '../../styles/theme';

/** Width of the project-name column. See the note above before changing it. */
export const LABEL_WIDTH = 264;

/** Height of the column-heading block: month labels over week ticks. */
export const HEADER_HEIGHT = 46;

export const LANE_HEIGHT = 52;
export const PHASE_HEIGHT = 34;

/**
 * Minimum chart width before the frame starts scrolling horizontally.
 *
 * Below roughly this the week columns become too narrow to tell apart and bars
 * shorter than a fortnight collapse into indistinguishable dots. Scrolling is the
 * honest answer; squeezing is not.
 */
export const MIN_CHART_WIDTH = 900;

export const ChartFrame = styled.div`
  position: relative;
  min-width: ${MIN_CHART_WIDTH}px;
`;

/** Horizontal scroller. Only engages below MIN_CHART_WIDTH. */
export const ChartScroll = styled.div`
  overflow-x: auto;
  overflow-y: visible;
  padding-bottom: 4px;
`;

/** Any row: fixed label cell, then the track. */
export const Row = styled.div`
  display: grid;
  grid-template-columns: ${LABEL_WIDTH}px 1fr;
  align-items: stretch;
`;

export const HeaderRow = styled(Row)`
  height: ${HEADER_HEIGHT}px;
  border-bottom: 1px solid ${palette.borderStrong};
`;

export const HeaderLabelCell = styled.div`
  display: flex;
  align-items: flex-end;
  padding: 0 12px 6px 4px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: ${palette.inkSoft};
`;

export const HeaderTrack = styled.div`
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
`;

/** N equal cells, one per week. Equal because every week is exactly seven days. */
export const TickRow = styled.div`
  display: flex;
`;

export const MonthCell = styled.div`
  flex: 1;
  position: relative;
  font-size: 11px;
  font-weight: 700;
  color: ${palette.deepMagenta};
  white-space: nowrap;
  /* The label is wider than its cell and is allowed to run on into the next one;
     clipping it would print "Sep" as "S". */
  overflow: visible;
`;

export const WeekCell = styled.div`
  flex: 1;
  text-align: center;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: ${palette.inkSoft};
  padding-bottom: 4px;
`;

/**
 * Week gridlines and the today marker, drawn once over the whole lane stack.
 *
 * `pointer-events: none` throughout - it sits on top of every bar, and without it
 * the today line would swallow clicks on whatever phase happens to be running now,
 * which is the bar people most want to click.
 */
export const Overlay = styled.div<{ $columns: number }>`
  position: absolute;
  left: ${LABEL_WIDTH}px;
  right: 0;
  top: ${HEADER_HEIGHT}px;
  bottom: 0;
  pointer-events: none;
  background: repeating-linear-gradient(
    to right,
    ${palette.border} 0,
    ${palette.border} 1px,
    transparent 1px,
    transparent calc(100% / ${(p) => p.$columns})
  );
`;

export const TodayLine = styled.div<{ $leftPct: number }>`
  position: absolute;
  top: 0;
  bottom: 0;
  left: ${(p) => p.$leftPct}%;
  width: 2px;
  background: ${palette.today};
  opacity: 0.75;
`;

/**
 * Sits over the column headings only, so the today flag can label the line without
 * covering the first lane.
 *
 * A separate box from Overlay rather than a child positioned above it, because both
 * MUST share the `left: LABEL_WIDTH; right: 0` origin. A percentage inside this box
 * resolves against the track width; the same percentage on the frame would resolve
 * against the frame width - label column included - and put the flag roughly 25%
 * further left than the line it is labelling.
 */
export const HeaderOverlay = styled.div`
  position: absolute;
  left: ${LABEL_WIDTH}px;
  right: 0;
  top: 0;
  height: ${HEADER_HEIGHT}px;
  pointer-events: none;
`;

/*
  Anchored to the BOTTOM of the header - the week band - not the top.

  MonthCell overflows its cell on purpose so "Sept 2026" is not clipped to "S", which
  means the month labels occupy the full width of the top band and the flag sitting
  there covers one of them. At 1500px the flag happened to land in the gap after
  "Aug 2026"; at 1000px the columns are narrower, the same date lands on the label,
  and the heading reads "Aug 202".

  The week band is the cheaper place to overlap. Its numbers are short, so the pill
  hides at most one, and the one it hides is always the week containing today - which
  is precisely what the pill itself says. A covered month name is unrecoverable; a
  covered week tick is not.
*/
export const TodayFlag = styled.div<{ $leftPct: number }>`
  position: absolute;
  bottom: 1px;
  left: ${(p) => p.$leftPct}%;
  /* -50% of the FLAG's own width, which is what a transform percentage means, and
     is exactly what is wanted: centre the pill on the line. */
  transform: translateX(-50%);

  span {
    display: inline-block;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: ${palette.onAccent};
    background: ${palette.today};
    border-radius: ${radius.pill};
    padding: 2px 8px;
    white-space: nowrap;
  }
`;

/** The area a bar is positioned inside. Percentages below are relative to this. */
export const Track = styled.div`
  position: relative;
  height: 100%;
`;

export const LaneRow = styled(Row)`
  min-height: ${LANE_HEIGHT}px;
  border-bottom: 1px solid ${palette.border};
  transition: background-color 120ms ease;

  &:hover {
    background: ${palette.pinkWash};
  }
`;

export const PhaseRow = styled(Row)`
  min-height: ${PHASE_HEIGHT}px;
  /* Phase rows read as a nested block, so they get a tinted ground and a pink rule
     down the left of the label column to tie them to the lane above. */
  background: ${palette.banner};
  border-bottom: 1px solid ${palette.border};
`;

export const LaneLabelCell = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px 6px 4px;
  min-width: 0;
`;

/**
 * The label column of a nested row: a phase, or a milestone.
 *
 * `$nested` is the second step in, and it is what says a milestone belongs to the
 * phase above it rather than to the lane. Indentation is the only device available:
 * the rows are cells of one CSS grid, so the milestone cannot be drawn INSIDE the
 * phase's row, and a 22px shift plus its own left rule is what reads as "under
 * this" in a list that is already one level deep.
 *
 * A second rule was tried and dropped - two vertical lines 22px apart down every
 * lane turned the label column into a ledger. One rule, moved right, is enough,
 * because the diamond in front of a milestone's name already distinguishes the kind
 * of row from the phase above it.
 */
export const PhaseLabelCell = styled.div<{ $nested?: boolean }>`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px 4px 4px;
  margin-left: ${(p) => (p.$nested ? 44 : 22)}px;
  border-left: 2px solid ${palette.border};
  min-width: 0;
`;

export const LaneName = styled.span`
  font-size: 14px;
  font-weight: 700;
  color: ${palette.ink};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

export const PhaseName = styled.span`
  font-size: 12.5px;
  font-weight: 600;
  color: ${palette.ink};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

export const SubLabel = styled.span`
  font-size: 11px;
  color: ${palette.inkSoft};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

/**
 * A date sitting in a label cell, which never shrinks.
 *
 * Everything else in that cell is an elastic flex item, so by default the browser
 * takes the overflow out of all of them in proportion and a milestone row ends up
 * reading "Regulatory deadlin... 10 Aug 2...". A clipped name is a nuisance you can
 * resolve by hovering; a clipped date is actively misleading, because "10 Aug 2..."
 * has lost the digit that says whether the deadline is this month or eighteen months
 * out - which is exactly the ambiguity formatMedium exists to close.
 *
 * A date is also a known, bounded width in a way a name is not, so it is the one item
 * in the row that can safely be given its natural size and taken out of the
 * negotiation. The name keeps the ellipsis, and keeps its title tooltip with it.
 */
export const DateLabel = styled(SubLabel)`
  flex: none;
`;

/** The chevron that expands a lane. A real button - this is the main control. */
export const Disclosure = styled.button<{ $open: boolean }>`
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: 1px solid ${palette.border};
  border-radius: ${radius.sm};
  background: ${palette.card};
  color: ${palette.deepMagenta};
  cursor: pointer;
  padding: 0;
  transition: transform 140ms ease, background-color 120ms ease;
  transform: rotate(${(p) => (p.$open ? 90 : 0)}deg);

  &:hover {
    background: ${palette.blush};
  }

  &:focus-visible {
    outline: 2px solid ${palette.hotPink};
    outline-offset: 2px;
  }
`;

/** A small square button that opens an editor. */
export const EditButton = styled.button`
  flex: none;
  font-family: ${fontStack};
  font-size: 11px;
  font-weight: 700;
  color: ${palette.deepMagenta};
  background: transparent;
  border: 1px solid transparent;
  border-radius: ${radius.pill};
  padding: 2px 8px;
  cursor: pointer;
  /* Hidden until the row is hovered or the button itself is focused, so nine lanes
     do not each carry a permanent Edit affordance. Focus-within on the row keeps it
     reachable by keyboard, which visibility:hidden alone would not. */
  opacity: 0;
  transition: opacity 120ms ease, background-color 120ms ease;

  ${LaneRow}:hover &,
  ${PhaseRow}:hover &,
  &:focus-visible {
    opacity: 1;
  }

  &:hover {
    background: ${palette.blush};
    border-color: ${palette.border};
  }

  &:focus-visible {
    outline: 2px solid ${palette.hotPink};
    outline-offset: 2px;
  }
`;

/**
 * Move up / move down, shown in place of Edit while the roadmap is being reordered.
 *
 * Always visible, unlike EditButton, and for the same reason AddButton is: the hover
 * reveal is right for an affordance that would otherwise be noise on every one of nine
 * lanes, and wrong for the only control that does anything in a mode you deliberately
 * turned on. Reordering also means clicking the same lane repeatedly, and a button
 * that appears on hover is a button that flickers as the row it belongs to slides out
 * from under the pointer.
 *
 * Square and glyph-only to fit the label cell, which is 264px and already spends most
 * of it on the disclosure and the project name. The accessible name comes from an
 * aria-label naming the project - "Move Client Portal up" - because "▲" is not a name
 * and nine identical ones are not distinguishable.
 */
export const MoveButton = styled.button`
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  font-family: ${fontStack};
  font-size: 10px;
  line-height: 1;
  color: ${palette.deepMagenta};
  background: ${palette.card};
  border: 1px solid ${palette.border};
  border-radius: ${radius.sm};
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease;

  &:hover:not(:disabled) {
    background: ${palette.blush};
    border-color: ${palette.hotPink};
  }

  /* Kept in the layout rather than removed at the ends of the list, so the label
     column does not reflow by 30px as a lane passes the top or the bottom. */
  &:disabled {
    opacity: 0.3;
    cursor: default;
  }

  &:focus-visible {
    outline: 2px solid ${palette.hotPink};
    outline-offset: 2px;
  }
`;

/**
 * Row that spans both columns, for an open editor.
 *
 * `position: relative; z-index: 1` is what keeps the week gridlines and the today
 * line off the form. Overlay is absolutely positioned over the whole lane stack and
 * is rendered BEFORE the rows, so as a positioned element it paints above every
 * non-positioned row regardless of source order. Over a bar that is the entire
 * point - the today line has to read as being in front. Over a text input it is
 * just a stripe through the middle of the word you are typing.
 *
 * A z-index alone would do nothing: z-index is ignored on a static element, so the
 * `position` is load-bearing rather than incidental. The opaque `background` is the
 * other half of it - lifting a transparent row above the overlay would let the
 * lines show straight through anyway.
 */
export const EditorRow = styled.div`
  position: relative;
  z-index: 1;
  border-bottom: 1px solid ${palette.border};
  background: ${palette.card};
  box-shadow: ${shadow.inset};
`;

/**
 * The foot of an expanded lane: where new phases and milestones are added from.
 *
 * Indented to the same 22px as PhaseLabelCell and carrying the same left rule, so it
 * reads as the last item of the nested block rather than as a control belonging to
 * the next lane down.
 *
 * Lifted above the gridline overlay for the same reason EditorRow is - see the note
 * there. The row's own tint stays deliberately translucent, so the gridlines still
 * run through the empty part of it and it goes on matching the PhaseRow above; what
 * the lift buys is that they no longer cross the buttons, which carry an opaque
 * background of their own.
 */
export const AddRow = styled.div`
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 6px 12px 8px 26px;
  margin-left: 22px;
  border-left: 2px solid ${palette.border};
  border-bottom: 1px solid ${palette.border};
  background: ${palette.banner};
`;

/**
 * "+ Add phase". Always visible, unlike EditButton.
 *
 * EditButton hides until its row is hovered because nine lanes each carrying a
 * permanent Edit affordance is noise. This one is the opposite case: it only exists
 * inside an already-expanded lane, where it is one of two controls, and a create
 * action nobody can find is the reason the milestone diamonds went a whole iteration
 * with no way to put a milestone on the chart.
 */
export const AddButton = styled.button`
  flex: none;
  font-family: ${fontStack};
  font-size: 11.5px;
  font-weight: 700;
  color: ${palette.deepMagenta};
  background: ${palette.card};
  border: 1px dashed ${palette.borderStrong};
  border-radius: ${radius.pill};
  padding: 3px 11px;
  cursor: pointer;
  transition: background-color 120ms ease, border-color 120ms ease;

  &:hover {
    background: ${palette.blush};
    border-color: ${palette.hotPink};
  }

  &:focus-visible {
    outline: 2px solid ${palette.hotPink};
    outline-offset: 2px;
  }
`;

/**
 * A single milestone diamond placed on an expanded lane's own row.
 *
 * Centred on the row rather than pinned to the top with a stem, which is what
 * MilestoneMarks does on the collapsed lane. The stem exists there to line a mark up
 * against the bar bands underneath it; on a row of its own there is nothing to line
 * up against, and a plumb line to nowhere would only suggest a relationship that is
 * not there.
 */
export const MilestonePin = styled.div<{ $leftPct: number }>`
  position: absolute;
  top: 50%;
  left: ${(p) => p.$leftPct}%;
  transform: translate(-50%, -50%);
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
`;

/** Shown in a track that has no dates at all. Not a blank row - a stated fact. */
export const UnscheduledStrip = styled.div`
  position: absolute;
  top: 50%;
  left: 0;
  right: 0;
  transform: translateY(-50%);
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px dashed ${palette.borderStrong};
  border-radius: ${radius.pill};
  background: repeating-linear-gradient(
    135deg,
    ${palette.slateWash} 0,
    ${palette.slateWash} 6px,
    transparent 6px,
    transparent 12px
  );
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: ${palette.slateDeep};
`;

export const srOnly = css`
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
