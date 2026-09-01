/**
 * The roadmap transposed: one row per person, on the same grid as the project chart.
 *
 * WHAT IT ANSWERS THAT THE ROSTER CANNOT
 * --------------------------------------
 * The roster above it counts - "DRI ×2, 4 phases" - and a count is a fact about now.
 * "We need to plan in advance" is a question about a date: who is free in October,
 * who is holding three things at once in the week of the 14th, who comes off Tax
 * before the QWAPP work starts. None of that is answerable from a number, and all of
 * it is answerable from the same phases the Roadmap page already draws, read down the
 * owner column instead of across the lane.
 *
 * TWO WEIGHTS OF MARK, BECAUSE THERE ARE TWO WEIGHTS OF CLAIM
 * -----------------------------------------------------------
 * The solid bars are phases the person OWNS, drawn by the same SegmentedBar the
 * project lanes use, in the same colours, so the Legend on this page means what it
 * means on the other one and the two charts can be read against each other.
 *
 * Behind them sits a pale band per project they are DRI or Support on. Those are
 * inferred - a role carries no dates of its own, so the band is the project's extent
 * - and they are drawn faintly, and behind, because "accountable while this runs" is
 * a weaker statement than "doing this from the 3rd to the 21st". Giving them equal
 * weight would make everybody look equally busy, which is the specific thing the
 * workbook did and the reason nobody trusted it.
 *
 * DRI and Support are told apart by border style as well as by fill, and both are
 * named in the tooltip and in the row's sub-label. Nothing here depends on
 * distinguishing two pale pinks.
 */

import styled from 'styled-components';

import {
  LegendDivider,
  LegendGroup,
  LegendItem,
  LegendWrap,
  StateKey,
} from '../Legend';
import { palette, radius } from '../../styles/theme';
import { Chip } from '../../styles/ui';
import {
  datedSpan,
  describeRoles,
  peakOverlap,
  type PersonAssignments,
  type RoleSpan,
} from '../../utils/assignments';
import { formatMedium, place, type Grid } from '../../utils/dates';
import { laneSegments } from '../../utils/segments';
import ChartCanvas from './ChartCanvas';
import SegmentedBar from './SegmentedBar';
import { LaneLabelCell, LaneName, LaneRow, SubLabel, Track } from './parts';

const Stack = styled.div`
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
`;

const Empty = styled.p`
  margin: 0;
  padding: 28px 8px;
  text-align: center;
  color: ${palette.inkSoft};
`;

/**
 * A project's extent, attributed to whoever is accountable for it.
 *
 * Taller than the 24px bars and drawn first so the owned work sits inside it and on
 * top of it, which is the relationship: the role is the container, the phases are the
 * commitments. Fill is kept very low so two overlapping bands do not compound into
 * something that reads as solid work.
 */
const RoleBand = styled.div<{ $left: number; $width: number; $dri: boolean }>`
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  left: ${(p) => p.$left}%;
  width: ${(p) => p.$width}%;
  min-width: 3px;
  height: 34px;
  border-radius: ${radius.sm};
  background: ${(p) => (p.$dri ? 'rgba(224, 33, 138, 0.07)' : 'rgba(180, 162, 172, 0.10)')};
  /* Solid for the DRI, dashed for Support. The two roles differ in accountability,
     not in shade, and a dashed edge says "backing somebody up" without needing the
     legend or a second colour. */
  border: 1px ${(p) => (p.$dri ? 'solid' : 'dashed')}
    ${(p) => (p.$dri ? palette.borderStrong : palette.slate)};
`;

/** Somebody with a role or a phase, but not one date between them. */
const NoDates = styled.span`
  position: absolute;
  top: 50%;
  left: 0;
  transform: translateY(-50%);
  font-size: 11px;
  font-weight: 600;
  color: ${palette.slateDeep};
  border: 1px dashed ${palette.borderStrong};
  border-radius: ${radius.pill};
  padding: 1px 9px;
  white-space: nowrap;
`;

const Load = styled(Chip)<{ $heavy: boolean }>`
  flex: none;
  color: ${(p) => (p.$heavy ? '#ffffff' : palette.deepMagenta)};
  background: ${(p) => (p.$heavy ? palette.hotPink : palette.blush)};
  border-color: ${(p) => (p.$heavy ? palette.hotPink : palette.border)};
`;

/**
 * This chart's key: the five colours and the two band styles.
 *
 * Not the roadmap's Legend. That one has no way to explain the DRI and Support bands,
 * which are only drawn here - and it carries the three milestone states, which are
 * not. Assembled from the same exported parts so the two keys are indistinguishable
 * in style.
 *
 * There was a "progress not recorded" item here explaining the hatching, and it went
 * at the same time as the roadmap legend's fill-treatment group - the two said the
 * same thing on two pages, so removing one and keeping the other would have been the
 * inconsistency, not the removal. The hatching is still drawn. If anyone asks what it
 * means, both keys are missing the same line and it should go back in both.
 */
const BandSwatch = styled.span<{ $dri: boolean }>`
  width: 26px;
  height: 14px;
  border-radius: ${radius.sm};
  background: ${(p) => (p.$dri ? 'rgba(224, 33, 138, 0.07)' : 'rgba(180, 162, 172, 0.10)')};
  border: 1px ${(p) => (p.$dri ? 'solid' : 'dashed')}
    ${(p) => (p.$dri ? palette.borderStrong : palette.slate)};
`;

export function TeamChartKey() {
  return (
    <LegendWrap>
      <StateKey />

      <LegendDivider aria-hidden />

      <LegendGroup>
        <LegendItem>
          <BandSwatch $dri aria-hidden />
          DRI of that project
        </LegendItem>
        <LegendItem>
          <BandSwatch $dri={false} aria-hidden />
          Support on it
        </LegendItem>
      </LegendGroup>
    </LegendWrap>
  );
}

function describeRole(role: RoleSpan): string {
  return `${role.role === 'dri' ? 'DRI of' : 'Support on'} ${role.project_name} — ${formatMedium(
    role.start
  )} to ${formatMedium(role.end)}`;
}

export interface TeamChartRow {
  email: string;
  name: string;
  active: boolean;
  assignments: PersonAssignments;
}

export interface TeamChartProps {
  rows: TeamChartRow[];
  /** Project id to name, for naming a phase's lane in its tooltip. */
  projectNames: ReadonlyMap<string, string>;
  grid: Grid;
  today: string;
}

export default function TeamChart({ rows, projectNames, grid, today }: TeamChartProps) {
  return (
    <ChartCanvas grid={grid} today={today} label="Person">
      {rows.length === 0 ? (
        <Empty>Nobody here is holding anything with a date on it.</Empty>
      ) : (
        rows.map(({ email, name, active, assignments }) => {
          // The same segmenter the project lanes use, fed the phases this person owns
          // rather than the phases one lane contains. That is the whole transpose:
          // concurrent work splits into stacked bands exactly as it does over there,
          // so a person running three things in September looks like a lane running
          // three things in September.
          const segments = laneSegments(assignments.owned);
          // The extent of the OWNED work only, never of the roles. SegmentedBar draws
          // this as a hairline meaning "this is one object, quiet in the gaps", and
          // the role bands already draw the role extents - handing it the union made
          // the hairline retrace a band it was sitting inside, and dragged the caption
          // out to the end of a project the person owns nothing in.
          const span = datedSpan(assignments.owned);
          const peak = peakOverlap(assignments.owned);

          // A phase's own name is ambiguous on this row - two lanes both have Coding
          // - so every tooltip says which project it came from.
          const describePhase = (phase: { project_id: string; name: string }) =>
            `${phase.name} (${projectNames.get(phase.project_id) ?? 'unknown project'})`;

          const roleWords = [
            ...assignments.roles.map(describeRole),
            ...assignments.undatedRoles.map(
              (r) =>
                `${r.role === 'dri' ? 'DRI of' : 'Support on'} ${r.project_name} — nothing scheduled`
            ),
          ];

          // Named, not counted. "Maintenance (QWAPP)" is something you can act on;
          // "3 not shown" invites the reader to assume the chart is broken.
          const missing = assignments.undrawable.map(describePhase);

          const title = [
            name,
            assignments.owned.length
              ? `${assignments.owned.length} phase${assignments.owned.length === 1 ? '' : 's'}`
              : 'no phases owned',
            peak > 1 ? `up to ${peak} at once` : null,
            ...roleWords,
            missing.length ? `not drawn: ${missing.join(', ')}` : null,
          ]
            .filter((part): part is string => Boolean(part))
            .join(' — ');

          const drawn = assignments.owned.length - assignments.undrawable.length;
          const caption =
            [
              drawn > 0 ? `${drawn} phase${drawn === 1 ? '' : 's'}` : null,
              peak > 1 ? `${peak} at once` : null,
            ]
              .filter((part): part is string => part !== null)
              .join(' · ') || undefined;

          // The sub-label carries the roles, because the bands behind the bars are
          // faint and unlabelled by design - without this the only way to find out
          // why a row stretches across October is to hover each band in turn.
          //
          // Names only, no dates. describeRoles omits them deliberately: the label
          // column is 264px, and "DRI of Enhanced Data Delivery — 24 Aug 2026 to 3
          // Oct 2026" truncated at that width to "...— 24 Aug 2026 t", which spent
          // the whole cell on a date range that the band's own POSITION already
          // states, and clipped the project name doing it. The dates are in the
          // tooltip on the band, which is the one place they add something.
          //
          // The undrawable count goes here too rather than on the track: a full-width
          // strip saying "2 not scheduled" would cover the very bands it sits over.
          const roles = describeRoles(assignments);
          const sub = [
            roles ||
              (assignments.owned.length > 0
                ? 'No project role — owns phases only'
                : 'Nothing assigned'),
            missing.length > 0 ? `${missing.length} not scheduled` : null,
          ]
            .filter((part): part is string => part !== null)
            .join(' · ');

          return (
            <LaneRow key={email}>
              <LaneLabelCell>
                <Stack>
                  <LaneName title={`${name} <${email}>`}>
                    {name}
                    {active ? '' : ' (deactivated)'}
                  </LaneName>
                  <SubLabel title={sub}>{sub}</SubLabel>
                </Stack>
                {peak > 1 ? (
                  <Load $heavy title={`Up to ${peak} phases running at the same time`}>
                    ×{peak}
                  </Load>
                ) : null}
              </LaneLabelCell>

              <Track>
                {/* Roles first, so the owned work draws over them. */}
                {assignments.roles.map((role) => {
                  const geo = place(grid, role.start, role.end);
                  const label = describeRole(role);
                  return (
                    <RoleBand
                      key={`${role.project_id}-${role.role}`}
                      $left={geo.leftPct}
                      $width={geo.widthPct}
                      $dri={role.role === 'dri'}
                      title={label}
                      role="img"
                      aria-label={label}
                    />
                  );
                })}

                {segments.length > 0 && span ? (
                  <SegmentedBar
                    grid={grid}
                    segments={segments}
                    start={span.start}
                    end={span.end}
                    caption={caption}
                    title={title}
                    describePhase={describePhase}
                  />
                ) : assignments.roles.length > 0 ? null : (
                  // Bands and no bars needs nothing said - being accountable for work
                  // other people are doing is a real position and the bands ARE the
                  // content. Nothing at all does: an empty row reads as a rendering
                  // failure, and this row is precisely the one somebody scanning for
                  // spare capacity is looking for.
                  <NoDates title={title}>
                    {assignments.owned.length > 0 ? 'Nothing with dates' : 'Nothing assigned'}
                  </NoDates>
                )}
              </Track>
            </LaneRow>
          );
        })
      )}
    </ChartCanvas>
  );
}
