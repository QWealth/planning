/**
 * The frame every chart on this app is drawn inside: column headings, the week
 * gridlines, and the today marker.
 *
 * Extracted from Timeline when the Team page grew a chart of its own. The pieces look
 * like chrome and are not: the gridline overlay and the today flag are absolutely
 * positioned at `left: LABEL_WIDTH; right: 0` so that a percentage inside them
 * resolves against the same width a bar's percentage does. Get that wrong and the
 * today line lands in a different place from the bars it is there to be judged
 * against, which is worse than having no today line at all. That reasoning is
 * recorded in parts.ts and is exactly the sort of thing a second copy stops obeying
 * six months later, so there is one copy and both charts use it.
 *
 * What it does NOT own is the rows. A project lane and a person row share a grid and
 * a today line and nothing else, and pushing their differences in here as flags would
 * produce a component that is two components wearing a coat.
 */

import type { ReactNode } from 'react';

import { formatLong, placeDay, type Grid } from '../../utils/dates';
import {
  ChartFrame,
  ChartScroll,
  HeaderLabelCell,
  HeaderOverlay,
  HeaderRow,
  HeaderTrack,
  MonthCell,
  Overlay,
  TickRow,
  TodayFlag,
  TodayLine,
  WeekCell,
} from './parts';

export interface ChartCanvasProps {
  grid: Grid;
  today: string;
  /** Heading over the label column - "Project", "Person". */
  label: string;
  children: ReactNode;
}

export default function ChartCanvas({ grid, today, label, children }: ChartCanvasProps) {
  const todayPct = placeDay(grid, today);
  // buildGrid always widens the span to contain today, so this is belt and braces -
  // but a marker drawn at -14% is invisible and silently wrong rather than absent,
  // and that is the sort of thing nobody notices for a month.
  const todayVisible = todayPct >= 0 && todayPct <= 100;

  return (
    <ChartScroll>
      <ChartFrame>
        <HeaderRow>
          <HeaderLabelCell>{label}</HeaderLabelCell>
          <HeaderTrack>
            <TickRow>
              {grid.columns.map((column) => (
                <MonthCell key={`m-${column.key}`}>{column.monthLabel ?? ''}</MonthCell>
              ))}
            </TickRow>
            <TickRow>
              {grid.columns.map((column) => (
                // The day-of-month of each Monday. Weeks rather than days because a
                // roadmap that runs five months has no use for 147 columns, and
                // rather than week numbers because nobody in the firm thinks in
                // ISO weeks - "the week of the 14th" is how these are discussed.
                <WeekCell key={`w-${column.key}`}>{column.day}</WeekCell>
              ))}
            </TickRow>
          </HeaderTrack>
        </HeaderRow>

        <Overlay $columns={grid.columns.length} aria-hidden>
          {todayVisible ? <TodayLine $leftPct={todayPct} /> : null}
        </Overlay>

        {todayVisible ? (
          <HeaderOverlay aria-hidden>
            <TodayFlag $leftPct={todayPct}>
              <span title={formatLong(today)}>Today</span>
            </TodayFlag>
          </HeaderOverlay>
        ) : null}

        {children}
      </ChartFrame>
    </ChartScroll>
  );
}
