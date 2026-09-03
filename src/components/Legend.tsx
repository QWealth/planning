/**
 * The key for the roadmap chart, and the pieces every key on this app is built from.
 *
 * Not optional chrome. A collapsed lane says what state a project is in using
 * colour, and colour without a key is a private code - the workbook's readers had
 * six labelled task rows per project and could see the state by reading; this chart
 * trades that for one row and therefore owes an explanation somewhere on screen.
 *
 * It used to spell out the fill treatments too - solid vs hatched vs pale, meaning
 * "60% done" vs "nobody has recorded how far along this is" vs "not started". That
 * group was removed as clutter, along with the single-day diamond and the matching
 * "progress not recorded" item on the Team chart's key. The charts still draw all of
 * it, so the treatments are now inferred rather than stated; if a reader ever asks
 * what the hatching means, that group is what they are missing and it belongs back
 * here - and in chart/TeamChart.tsx, which lost the same line.
 *
 * `HatchedSwatch` went with it. It was the hatched *key* swatch and nothing else: the
 * bars draw their own hatching in Bar.tsx and SegmentedBar.tsx, so deleting it does
 * not change a pixel of either chart. Restoring the item means restoring the swatch.
 *
 * ONE KEY PER CHART, NOT ONE KEY REUSED
 * -------------------------------------
 * The Team chart draws the same five colours and the same hatching, and draws no
 * milestones, no proportional fill and no single-day diamonds - it does draw two
 * things this chart has never heard of, the DRI and Support bands. Showing it this
 * component wholesale advertised four marks that are not on it and omitted the two
 * that are, which is worse than no key: a reader who cannot find "milestone due" on
 * the chart concludes the chart is broken, not that the key is generous.
 *
 * So the primitives and the state swatches are exported, each chart assembles the
 * key for what it actually draws, and they stay visually identical because they are
 * made of the same parts. See StateKey below and ChartKey in chart/TeamChart.tsx.
 */

import styled from 'styled-components';

import { palette, radius, STATE_STYLE, type PhaseState } from '../styles/theme';

export const LegendWrap = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 18px;
  font-size: 12px;
  color: ${palette.inkSoft};
`;

export const LegendGroup = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 14px;
`;

export const LegendDivider = styled.span`
  width: 1px;
  height: 18px;
  background: ${palette.border};
`;

export const LegendItem = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  color: ${palette.ink};
  white-space: nowrap;
`;

export const Swatch = styled.span<{ $fill: string }>`
  width: 26px;
  height: 12px;
  border-radius: ${radius.pill};
  background: ${(p) => p.$fill};
  border: 1px solid ${palette.hairline};
`;

const DiamondSwatch = styled.span<{ $fill: string }>`
  width: 11px;
  height: 11px;
  margin: 0 8px;
  background: ${(p) => p.$fill};
  border-radius: 3px;
  transform: rotate(45deg);
`;

/**
 * A milestone diamond.
 *
 * It used to sit next to the single-day-phase diamond, and that adjacency was the
 * explanation: the two shapes are close cousins on the chart, and the key was where a
 * reader settled which is which. The fill-treatment group has since been removed, so
 * the milestone diamond is now the only diamond in the key and the comparison has to
 * be made from the chart itself. They differ by colour family (lifecycle vs the
 * data-state plum/red/grey) and by where they sit on a lane - see the header of
 * components/chart/MilestoneMarks.tsx.
 */
const MilestoneSwatch = styled(DiamondSwatch)<{ $border: string; $ring: boolean }>`
  border: 1.5px solid ${(p) => p.$border};
  box-shadow: ${(p) => (p.$ring ? `0 0 0 1.5px ${p.$fill}` : 'none')};
`;

/**
 * Ordered most advanced first, matching the precedence in utils/phaseState.ts, so
 * the key reads as the ranking it actually is rather than as an arbitrary list.
 */
const ORDER: PhaseState[] = ['coding', 'architecting', 'wireframes', 'planning', 'other'];

/**
 * The five lifecycle colours. Shared by both charts, because both colour a bar by
 * phaseState and the two must never disagree about which pink means what.
 */
export function StateKey() {
  return (
    <LegendGroup>
      {ORDER.map((state) => (
        <LegendItem key={state}>
          <Swatch $fill={STATE_STYLE[state].fill} aria-hidden />
          {/* "Other work" covers Testing, Maintenance and the one-off workstream
              names. Named explicitly so nobody reads grey as "broken". */}
          {STATE_STYLE[state].label}
        </LegendItem>
      ))}
    </LegendGroup>
  );
}

export default function Legend() {
  return (
    <LegendWrap>
      <StateKey />

      <LegendDivider aria-hidden />

      <LegendGroup>
        <LegendItem>
          <MilestoneSwatch
            $fill={palette.today}
            $border={palette.card}
            $ring={false}
            aria-hidden
          />
          milestone due
        </LegendItem>
        <LegendItem>
          <MilestoneSwatch
            $fill={palette.danger}
            $border={palette.card}
            $ring
            aria-hidden
          />
          missed
        </LegendItem>
        <LegendItem>
          {/* Hollow, so the three statuses stay apart in monochrome and under the
              commonest colour vision deficiencies. Nothing on this chart is carried
              by hue alone. */}
          <MilestoneSwatch
            $fill={palette.card}
            $border={palette.slateDeep}
            $ring={false}
            aria-hidden
          />
          {/* "met", not "done" - the solid swatch two groups up already means done,
              and the same word for a progress fill and for a deadline would undo the
              distinction the two groups exist to draw. */}
          met
        </LegendItem>
      </LegendGroup>
    </LegendWrap>
  );
}
