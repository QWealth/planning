/**
 * What was promised, what landed, and what was said about the rest.
 *
 * Every row here is one answer to one question the bot asked on the morning a
 * milestone was dated: "did this land?" — and, where the answer was no, whatever the
 * DRI typed into the modal. See fast/app/milestone_check.py for who gets asked and
 * fast/app/routes/milestone_log.py for who may read this.
 *
 * WHY THIS IS A LOG AND NOT A REPORT
 * ----------------------------------
 * No counts, no percentage-hit-rate, no chart. That is deliberate and it is the whole
 * design of the page.
 *
 * The moment this screen totals up who missed how many deadlines, it stops being a
 * record of what happened and becomes a scoreboard — and the reasons, which are the
 * only genuinely useful thing here, stop being written honestly. Somebody who knows
 * their answer becomes a number on a dashboard writes "delayed"; somebody who knows it
 * becomes a line in a log writes "the vendor's API changed under us and we lost a
 * week". The second one is worth reading. So the page shows entries, in time order,
 * and does no arithmetic on them at all.
 *
 * THE NAMES ARE SHOWN, AND THAT IS THE POINT OF SAYING SO IN THE DM
 * -----------------------------------------------------------------
 * The person who typed the reason is named on the row. That is not incidental — an
 * unattributed statement about why a project slipped is worse than none, because
 * nobody can go and ask about it. It is also why the Slack message says, at the moment
 * somebody answers, that the answer is recorded and that business analysts read it
 * (see blocks.compose_milestone_check). A log people find out about later is one they
 * resent; a log they were told about is one they can choose their words for.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import styled from 'styled-components';

import { useIdentity } from '../components/AppShell';
import { describeError, getMilestoneLog } from '../services/api';
import { displayHeading, palette, radius } from '../styles/theme';
import { Chip, ErrorText, Hint, Panel, PageLoading } from '../styles/ui';
import type { MilestoneCheck } from '../types';
import { formatTimestamp } from '../utils/dates';

const Heading = styled.h2`
  ${displayHeading};
  font-size: 18px;
  color: ${palette.deepMagenta};
  margin: 0 0 6px;
`;

const Entries = styled.ul`
  list-style: none;
  margin: 14px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
`;

/*
  A missed milestone is marked on the LEFT EDGE rather than by tinting the whole row.

  Two reasons, and the second is the one that decided it. A tinted row reads as an
  error state, and a deadline that moved for a good reason is not an error. And a
  column of alternating pink and cream cards is unreadable at a glance in a way that a
  single consistent card with a 4px marker is not — the eye finds the stripe.
*/
const Entry = styled.li<{ $missed: boolean }>`
  border: 1px solid ${palette.border};
  border-left: 4px solid
    ${(p) => (p.$missed ? palette.hotPink : palette.turquoise)};
  border-radius: ${radius.md};
  background: ${palette.card};
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
`;

const Top = styled.div`
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
`;

const What = styled.span`
  font-size: 14px;
  font-weight: 700;
  color: ${palette.ink};
`;

const Where = styled(Link)`
  font-size: 12px;
  font-weight: 600;
  color: ${palette.deepMagenta};
  text-decoration: none;

  &:hover {
    text-decoration: underline;
  }
`;

const Spacer = styled.div`
  flex: 1;
`;

const When = styled.span`
  font-size: 11px;
  color: ${palette.inkSoft};
  white-space: nowrap;
`;

/*
  The reason, set apart from the metadata around it.

  Blockquoted rather than run into the line above, because it is the one part of the
  row somebody wrote in their own words and the rest is generated. Left border rather
  than italics: reasons run to a sentence or two and italic body text at 13px is
  tiring.
*/
const Reason = styled.p`
  margin: 2px 0 0;
  padding-left: 10px;
  border-left: 2px solid ${palette.hairline};
  font-size: 13px;
  line-height: 1.5;
  color: ${palette.ink};
  white-space: pre-wrap;
  overflow-wrap: anywhere;
`;

/* Asked, and said nothing. A real state — see the note on `reason` in types.ts. */
const NoReason = styled.p`
  margin: 2px 0 0;
  font-size: 12px;
  font-style: italic;
  color: ${palette.inkSoft};
`;

const Who = styled.span`
  font-size: 12px;
  color: ${palette.inkSoft};
  overflow-wrap: anywhere;
`;

export default function MilestoneLogPage() {
  const identity = useIdentity();
  const [entries, setEntries] = useState<MilestoneCheck[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setEntries(await getMilestoneLog());
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /*
    Newest first, and sorted here rather than trusted from the API.

    The server returns them off the kind index in updated_at order, which is the same
    thing today. Sorting again costs nothing on a list this size and means the page
    cannot start rendering a log out of order if that index is ever queried
    differently — and a log in the wrong order is wrong in a way nobody notices.
  */
  const ordered = useMemo(
    () =>
      [...(entries ?? [])].sort((a, b) =>
        (b.created_at ?? '').localeCompare(a.created_at ?? '')
      ),
    [entries]
  );

  if (loading) {
    return <PageLoading>Loading…</PageLoading>;
  }

  /*
    The 403, spelled out.

    Reachable by typing the address, and by anybody whose role changed in another tab
    since the shell fetched their identity. `describeError` would render the API's own
    sentence, which already names the role — so this exists to make it a page rather
    than a red line under an empty panel.
  */
  if (error && identity && !identity.is_ba) {
    return (
      <Panel>
        <Heading>The milestone log is for business analysts</Heading>
        <Hint>
          It records what was said when a dated milestone did not land. Set the Business
          analyst role on your <Link to="/team">Team</Link> entry if that is your work.
        </Hint>
      </Panel>
    );
  }

  return (
    <Panel>
      <Heading>Milestone log</Heading>
      <Hint>
        Every answer the roadmap has had to &ldquo;did this land?&rdquo;, asked of the
        DRI on the morning each milestone was dated. Newest first.
      </Hint>

      {error ? <ErrorText role="alert">{error}</ErrorText> : null}

      {ordered.length === 0 ? (
        /* Not an error, and the expected state until the first deadline passes with
           the check switched on. Says which, so an empty page is not read as broken. */
        <Entries>
          <Hint>
            Nothing recorded yet. Entries appear here the first time a dated milestone
            passes and its DRI answers the question in Slack.
          </Hint>
        </Entries>
      ) : (
        <Entries>
          {ordered.map((entry) => {
            const missed = entry.answer !== 'done';
            return (
              <Entry key={entry.item_id} $missed={missed}>
                <Top>
                  <What>{entry.milestone_name}</What>
                  {/* Straight to the lane it was on. The log is where somebody
                      notices a pattern; the roadmap is where they do something
                      about it, and making them go and find it is how that stops
                      happening. */}
                  {entry.project_id ? (
                    <Where to={`/?project=${encodeURIComponent(entry.project_id)}`}>
                      {entry.project_name}
                    </Where>
                  ) : (
                    <Who>{entry.project_name}</Who>
                  )}
                  <Chip>{missed ? 'Not done' : 'Done'}</Chip>
                  <Spacer />
                  {/* Both dates: what was promised, and when they answered. One
                      without the other cannot show a deadline answered three days
                      late, which is its own small fact. */}
                  <When>
                    due {entry.due} · answered {formatTimestamp(entry.created_at)}
                  </When>
                </Top>

                <Who>{entry.asked_email}</Who>

                {missed ? (
                  entry.reason ? (
                    <Reason>{entry.reason}</Reason>
                  ) : (
                    <NoReason>Asked, and no reason given.</NoReason>
                  )
                ) : null}
              </Entry>
            );
          })}
        </Entries>
      )}
    </Panel>
  );
}
