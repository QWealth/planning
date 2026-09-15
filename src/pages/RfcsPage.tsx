/**
 * Every RFC, grouped by the project it belongs to - or by belonging to none.
 *
 * WHAT THIS PAGE IS FOR
 * ---------------------
 * A decision that has been argued out and written down, so that "why is it like
 * this" has an answer six months later that is not somebody's memory of a Slack
 * thread. The roadmap says what is being built and when; this says why.
 *
 * The unattached section is the reason the feature was asked for and it is drawn
 * first. "How we do code review" is about no project in particular, and before the
 * work table existed there was nowhere to put it - project_id is the projects
 * table's partition key, so a document attached to nothing had no partition to live
 * in. See utils/rfcs.ts for the grouping and why a document whose project has been
 * deleted still appears here rather than silently vanishing.
 *
 * THREE REQUESTS, NOT ONE
 * -----------------------
 * The RFCs, the status vocabulary, and the roadmap - the last only for project
 * names. They go out together rather than in sequence because none depends on
 * another's answer, and three round trips one after another is three cold starts'
 * worth of waiting on a Lambda that scales to zero.
 *
 * The roadmap is fetched WITH archived lanes. An RFC can perfectly well be attached
 * to a project that has since been archived, and without them its heading would
 * render as a raw uuid next to nine real names.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import styled from 'styled-components';

import { useIdentity } from '../components/AppShell';
import { describeError, getPerson, getRfcStatuses, getRfcs, getRoadmap } from '../services/api';
import { palette, radius } from '../styles/theme';
import { Chip, ErrorText, Hint, Panel, PrimaryButton, ToggleButton } from '../styles/ui';
import type { Project, Rfc, StatusInfo } from '../types';
import { groupRfcs, rfcSummary } from '../utils/rfcs';

const Toolbar = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
`;

const Spacer = styled.div`
  flex: 1;
`;

const Status = styled.p`
  margin: 0;
  color: ${palette.inkSoft};
`;

const Groups = styled.div`
  display: flex;
  flex-direction: column;
  gap: 18px;
`;

const GroupHead = styled.h2`
  font-size: 14px;
  color: ${palette.deepMagenta};
  margin: 0 0 8px;
`;

const List = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

/*
  The whole row is the link, not just the title. A one-line summary sitting next to a
  clickable title is a target people aim at and miss; making the row the anchor also
  gives it a single focus stop instead of two.
*/
/*
  A row, with an accent down the left edge when this reader has never opened it.

  A border rather than a background wash, because the row already uses background to
  mean hover and a second meaning on the same property makes "unread" and "the cursor
  is here" indistinguishable while the mouse is moving.

  Transient (`$`-prefixed) so styled-components v6 strips it before the DOM - a bare
  `unread` prop reaches the anchor element and React warns on every render. Same
  reasoning as StatusChip's `$closed` below.
*/
const Row = styled(Link)<{ $unread: boolean }>`
  display: block;
  text-decoration: none;
  color: inherit;
  border: 1px solid ${(p) => (p.$unread ? palette.deepMagenta : palette.border)};
  border-left-width: ${(p) => (p.$unread ? '4px' : '1px')};
  border-radius: ${radius.md};
  background: ${palette.card};
  padding: 10px 14px;
  transition: border-color 120ms ease, background 120ms ease;

  &:hover {
    border-color: ${palette.borderStrong};
    background: ${palette.blush};
  }

  &:focus-visible {
    outline: 2px solid ${palette.hotPink};
    outline-offset: 2px;
  }
`;

const RowHead = styled.div`
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
`;

const RowTitle = styled.span<{ $unread: boolean }>`
  font-weight: 700;
  font-size: 14px;
  color: ${(p) => (p.$unread ? palette.deepMagenta : palette.ink)};
`;

const Summary = styled.p`
  margin: 4px 0 0;
  font-size: 13px;
  color: ${palette.inkSoft};
  /* One line, clipped. The reader is one click away and the full text belongs there;
     a list where some rows are four lines tall is a list nobody scans. */
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const Meta = styled.div`
  margin-top: 4px;
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 12px;
  color: ${palette.inkSoft};
`;

/**
 * A status chip, quiet once the proposal is closed.
 *
 * `$closed` comes from the served vocabulary rather than from a list of value names
 * here - see StatusInfo. Transient (`$`-prefixed) so styled-components v6 strips it
 * before it reaches the DOM; a bare `closed` prop would be forwarded to the element
 * and React would warn about an unknown attribute on every render.
 */
const StatusChip = styled(Chip)<{ $closed: boolean }>`
  background: ${(p) => (p.$closed ? 'transparent' : palette.blush)};
  color: ${(p) => (p.$closed ? palette.inkSoft : palette.deepMagenta)};
  border-color: ${(p) => (p.$closed ? palette.border : palette.borderStrong)};
`;

const Empty = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
`;

export default function RfcsPage() {
  const navigate = useNavigate();
  const [rfcs, setRfcs] = useState<Rfc[] | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [statuses, setStatuses] = useState<StatusInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);

  const identity = useIdentity();
  const email = identity?.email ?? null;
  /*
    Which RFCs this reader has opened, from their own roster row.

    Null until it is known, and that matters: defaulting to `{}` would paint every
    row as unread for the moment between first paint and the roster arriving, so the
    list would flash entirely dark pink on every visit. Null means "do not highlight
    anything yet".
  */
  const [read, setRead] = useState<Record<string, string> | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [documents, vocabulary, roadmap, person] = await Promise.all([
        getRfcs(),
        getRfcStatuses(),
        getRoadmap(true),
        /*
          The reader's own roster row, for rfcs_read. Failure is swallowed to an empty
          map rather than propagated: being in the planning group is what grants access
          and the roster is a separate list, so somebody who has not been added yet has
          no row and would otherwise get an error page instead of the RFC list. They
          simply see nothing highlighted.
        */
        email
          ? getPerson(email).catch(() => null)
          : Promise.resolve(null),
      ]);
      setRfcs(documents);
      setStatuses(vocabulary);
      setProjects(roadmap.projects);
      setRead(person?.rfcs_read ?? {});
    } catch (err) {
      setError(describeError(err));
      // An empty list rather than null, so the page renders its empty state instead
      // of sitting on "Loading…" for ever next to an error nobody can act on.
      setRfcs([]);
    }
  }, [email]);

  useEffect(() => {
    void load();
  }, [load]);

  /* status value -> how to say it, and whether it is retired. */
  const vocabulary = useMemo(
    () => new Map(statuses.map((entry) => [entry.status, entry])),
    [statuses]
  );

  /*
    Closed RFCs are hidden by default and the toggle says how many there are.

    Accepted is a CLOSED status, which is worth pausing on: an accepted RFC is the
    most useful document on this page and hiding it by default would be perverse if
    this were a reading list. It is not - it is a working list, and the question it
    answers is "what still needs my attention". The count on the toggle keeps the
    hidden ones visible as a fact even while their rows are not.
  */
  const visible = useMemo(() => {
    if (!rfcs) {
      return [];
    }
    if (showClosed) {
      return rfcs;
    }
    // Unknown statuses are treated as OPEN. A status this build has never heard of
    // means the backend is ahead of the frontend, and defaulting to hidden would
    // make documents disappear from the only page that lists them.
    return rfcs.filter((rfc) => !vocabulary.get(rfc.status)?.closed);
  }, [rfcs, showClosed, vocabulary]);

  const closedCount = useMemo(
    () => (rfcs ?? []).filter((rfc) => vocabulary.get(rfc.status)?.closed).length,
    [rfcs, vocabulary]
  );

  const groups = useMemo(() => groupRfcs(visible, projects), [visible, projects]);

  return (
    <>
      <Panel>
        <Toolbar>
          <Status>
            {rfcs === null
              ? 'Loading…'
              : `${visible.length} ${visible.length === 1 ? 'RFC' : 'RFCs'}`}
          </Status>
          <Spacer />
          {closedCount > 0 ? (
            <ToggleButton
              type="button"
              $on={showClosed}
              aria-pressed={showClosed}
              onClick={() => setShowClosed((on) => !on)}
            >
              {showClosed ? 'Hide' : 'Show'} {closedCount} decided
            </ToggleButton>
          ) : null}
          <PrimaryButton type="button" onClick={() => navigate('/rfcs/new')}>
            Write an RFC
          </PrimaryButton>
        </Toolbar>
        {error ? <ErrorText role="alert">{error}</ErrorText> : null}
      </Panel>

      {rfcs !== null && groups.length === 0 ? (
        <Panel>
          <Empty>
            <strong>Nothing written down yet.</strong>
            <Hint>
              An RFC is a decision argued out in writing - it can belong to a project, or to
              none, which is what &ldquo;how we do code review&rdquo; needs.
            </Hint>
            <PrimaryButton type="button" onClick={() => navigate('/rfcs/new')}>
              Write the first one
            </PrimaryButton>
          </Empty>
        </Panel>
      ) : null}

      <Groups>
        {groups.map((group) => (
          <Panel key={group.projectId ?? '_unattached'}>
            <GroupHead>
              {group.title} <Hint>· {group.rfcs.length}</Hint>
            </GroupHead>
            <List>
              {group.rfcs.map((rfc) => {
                const entry = vocabulary.get(rfc.status);
                const summary = rfcSummary(rfc.body);
                // Never opened by this reader. `read === null` means the roster row has
                // not arrived, and nothing is highlighted until it has.
                const unread = read !== null && !(rfc.item_id in read);
                return (
                  <li key={rfc.item_id}>
                    <Row
                      to={`/rfcs/${encodeURIComponent(rfc.item_id)}`}
                      $unread={unread}
                      aria-label={unread ? `${rfc.title} (unread)` : undefined}
                    >
                      <RowHead>
                        <RowTitle $unread={unread}>{rfc.title}</RowTitle>
                        <StatusChip
                          $closed={Boolean(entry?.closed)}
                          // The description is the vocabulary's own gloss, so hovering
                          // answers "what does review actually mean here" without a
                          // legend taking up permanent space.
                          title={entry?.description}
                        >
                          {entry?.label ?? rfc.status}
                        </StatusChip>
                      </RowHead>
                      {summary ? <Summary>{summary}</Summary> : null}
                      <Meta>
                        {rfc.owner_email ? <span>{rfc.owner_email}</span> : null}
                        {rfc.decided_on ? <span>Decided {rfc.decided_on}</span> : null}
                      </Meta>
                    </Row>
                  </li>
                );
              })}
            </List>
          </Panel>
        ))}
      </Groups>
    </>
  );
}
