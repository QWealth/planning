/**
 * One RFC: read it, edit it, or write a new one.
 *
 * ONE ROUTE FOR THE READER AND THE EDITOR
 * ---------------------------------------
 * /rfcs/{id} reads, /rfcs/{id} with Edit pressed writes, and /rfcs/new is the editor
 * with nothing loaded. Keeping "write an RFC" at a real address means it can be
 * linked to and bookmarked - "here, write it up" is a message somebody sends - rather
 * than being a mode you can only reach by finding the button first.
 *
 * The `new` sentinel is safe against collision because ids are generated with an
 * `rfc_` prefix (see _new_id in fast/app/db/queries/work.py), so no real document can
 * ever be called "new". That is worth stating rather than assuming: the alternative
 * spelling, /rfcs/new as a separate route declared before /rfcs/:itemId, works
 * equally well right up until somebody reorders the routes.
 *
 * WHY THE READER IS NOT THE LIST PAGE WITH AN EXPANDED ROW
 * -------------------------------------------------------
 * Because a written decision is a thing people link to. An RFC that only exists as an
 * expanded row in a list has no address, so referring to it in Slack means "open the
 * RFCs tab and scroll", which is how documents stop being read.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import styled from 'styled-components';

import Markdown from '../components/Markdown';
import RfcComments from '../components/RfcComments';
import RfcEditor from '../components/RfcEditor';
import {
  deleteRfc,
  describeError,
  getRfc,
  markRfcRead,
  getRfcStatuses,
  getRoadmap,
  getSkills,
} from '../services/api';
import { displayHeading, palette, radius } from '../styles/theme';
import {
  Chip,
  DangerButton,
  ErrorText,
  Hint,
  PageLoading,
  Panel,
  SecondaryButton,
} from '../styles/ui';
import type { Project, Rfc, SkillInfo, StatusInfo } from '../types';
import { resolveProjectName } from '../utils/projects';

const Head = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 12px;
  flex-wrap: wrap;
`;

const Heading = styled.h2`
  ${displayHeading};
  font-size: 20px;
  color: ${palette.deepMagenta};
  margin: 0;
`;

const Spacer = styled.div`
  flex: 1;
`;

const Meta = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 8px;
`;

const Back = styled(Link)`
  font-size: 12px;
  font-weight: 600;
  color: ${palette.inkSoft};
  text-decoration: none;

  &:hover {
    color: ${palette.deepMagenta};
    text-decoration: underline;
  }
`;

const Document = styled.article`
  border-top: 1px solid ${palette.border};
  margin-top: 14px;
  padding-top: 16px;
`;

const Confirm = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  border: 1px solid ${palette.border};
  border-radius: ${radius.md};
  background: ${palette.blush};
  padding: 10px 12px;
  margin-top: 12px;
`;

export default function RfcPage() {
  const { itemId } = useParams<{ itemId: string }>();
  const navigate = useNavigate();
  const isNew = itemId === 'new';

  const [rfc, setRfc] = useState<Rfc | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [statuses, setStatuses] = useState<StatusInfo[]>([]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(isNew);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      /*
        The document, the vocabulary and the project names together. The editor needs
        the last two whether or not it is open, because pressing Edit must not then
        wait on two more round trips before the form can be drawn - a select with no
        options in it looks like a project list that failed to load.
      */
      const [vocabulary, roadmap, document, skillList] = await Promise.all([
        getRfcStatuses(),
        getRoadmap(true),
        isNew || !itemId ? Promise.resolve(null) : getRfc(itemId),
        getSkills(),
      ]);
      setStatuses(vocabulary);
      setProjects(roadmap.projects);
      setSkills(skillList);
      setRfc(document);

      /*
        Opening it counts as reading it, so the list stops highlighting it.

        Deliberately not awaited and deliberately swallowed. The document is already
        on screen by this point, and a failed read-receipt turning a proposal
        somebody is reading into an error page would be absurd. The cost of losing
        one is that the row stays highlighted and they open it again.
      */
      if (document) {
        void markRfcRead(document.item_id).catch(() => {});
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [itemId, isNew]);

  useEffect(() => {
    void load();
  }, [load]);

  const entry = useMemo(
    () => statuses.find((s) => s.status === rfc?.status),
    [statuses, rfc]
  );

  // A deleted project keeps its id as its name - see utils/projects.ts for why that
  // beats rendering nothing where a name should be.
  const projectName = useMemo(
    () => resolveProjectName(rfc?.project_id, projects),
    [rfc, projects]
  );

  const onDelete = async () => {
    if (!rfc) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await deleteRfc(rfc.item_id);
      navigate('/rfcs', { replace: true });
    } catch (err) {
      setError(describeError(err));
      setConfirming(false);
      setBusy(false);
    }
  };

  if (loading) {
    return <PageLoading>Loading…</PageLoading>;
  }

  // A document that has been deleted, or an id somebody mistyped. Both are 404s and
  // both want the same answer: say so, and offer the way back.
  if (!isNew && !rfc) {
    return (
      <Panel>
        <Head>
          <Heading>This RFC is not there</Heading>
        </Head>
        {error ? <ErrorText role="alert">{error}</ErrorText> : null}
        <Meta>
          <Hint>It may have been deleted, or the link may be wrong.</Hint>
        </Meta>
        <Meta>
          <SecondaryButton type="button" onClick={() => navigate('/rfcs')}>
            Back to all RFCs
          </SecondaryButton>
        </Meta>
      </Panel>
    );
  }

  if (editing) {
    return (
      <Panel>
        <Head>
          <Heading>{isNew ? 'Write an RFC' : 'Editing'}</Heading>
          <Spacer />
          <Back to="/rfcs">All RFCs</Back>
        </Head>
        {error ? <ErrorText role="alert">{error}</ErrorText> : null}
        <Document>
          <RfcEditor
            rfc={rfc}
            projects={projects}
            statuses={statuses}
            skills={skills}
            onSaved={(saved) => {
              setRfc(saved);
              setEditing(false);
              /*
                Replace rather than push. /rfcs/new has just stopped describing what
                is on screen, and leaving it in the history means Back returns to a
                blank editor for a document that now exists - and pressing Create
                again would write a second copy.
              */
              if (isNew) {
                navigate(`/rfcs/${encodeURIComponent(saved.item_id)}`, { replace: true });
              }
            }}
            onCancel={() => {
              if (isNew) {
                navigate('/rfcs');
              } else {
                setEditing(false);
              }
            }}
          />
        </Document>
      </Panel>
    );
  }

  if (!rfc) {
    return <PageLoading>Loading…</PageLoading>;
  }

  return (
    <Panel>
      <Head>
        <div>
          <Heading>{rfc.title}</Heading>
          <Meta>
            <Chip title={entry?.description}>{entry?.label ?? rfc.status}</Chip>
            {projectName ? <Chip>{projectName}</Chip> : <Hint>Not tied to a project</Hint>}
            {rfc.owner_email ? <Hint>{rfc.owner_email}</Hint> : null}
            {rfc.decided_on ? <Hint>Decided {rfc.decided_on}</Hint> : null}
          </Meta>
        </div>
        <Spacer />
        <Back to="/rfcs">All RFCs</Back>
      </Head>

      <Meta>
        <SecondaryButton type="button" onClick={() => setEditing(true)}>
          Edit
        </SecondaryButton>
        {/* Deleting is never one click. The first press reveals the confirm below,
            which names the document while it asks - a window.confirm would take the
            title off screen at the moment it matters. */}
        <SecondaryButton type="button" onClick={() => setConfirming(true)} disabled={confirming}>
          Delete
        </SecondaryButton>
      </Meta>

      {error ? <ErrorText role="alert">{error}</ErrorText> : null}

      {confirming ? (
        <Confirm>
          <Hint>
            Delete &ldquo;{rfc.title}&rdquo;? This cannot be undone. To retire a proposal and
            keep its reasoning readable, set its status to Withdrawn instead.
          </Hint>
          <Spacer />
          <SecondaryButton type="button" onClick={() => setConfirming(false)} disabled={busy}>
            Keep it
          </SecondaryButton>
          <DangerButton type="button" onClick={() => void onDelete()} disabled={busy}>
            {busy ? 'Deleting…' : 'Delete'}
          </DangerButton>
        </Confirm>
      ) : null}

      <Document>
        <Markdown>{rfc.body}</Markdown>
      </Document>

      {/* Below the document, not beside it. The proposal is the thing being read and
          the thread is what happened next, so the reading order is the page order.
          Absent from the editor and from /rfcs/new for the obvious reason: there is
          nothing to discuss until the document has been saved and has an id. */}
      <RfcComments itemId={rfc.item_id} />
    </Panel>
  );
}
