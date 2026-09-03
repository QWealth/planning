/**
 * One ticket: its details, its subtasks, and the editor for both.
 *
 * THIS IS WHERE THE FAMILY IS SHOWN TOGETHER
 * ------------------------------------------
 * The board groups by status, which scatters a ticket's subtasks across five columns.
 * That is the right trade for the board - see utils/tasks.ts - but it leaves one
 * question unanswered: what is left on THIS piece of work. This page is the answer,
 * and it is why the board's cards link here rather than expanding in place.
 *
 * ONE ROUTE FOR THE READER AND THE EDITOR
 * ---------------------------------------
 * /tasks/{id} reads, the same address with Edit pressed writes, and /tasks/new is the
 * editor with nothing loaded. The `new` sentinel cannot collide with a real id because
 * ids are generated as `tsk_` plus twelve hex characters (_new_id in
 * fast/app/db/queries/work.py) - note `tsk`, not `task`, so do not go matching on the
 * wrong prefix if you ever need to.
 *
 * DELETING A TICKET PROMOTES ITS SUBTASKS
 * ---------------------------------------
 * It does not cascade, and the confirm below says so in those words rather than
 * asking "are you sure?" about a consequence it has not named. Somebody deleting a
 * ticket with four subtasks is entitled to know, before pressing it, whether they are
 * about to delete four pieces of work or four references to a heading.
 *
 * ADDING A SUBTASK REFETCHES, IT DOES NOT SPLICE
 * ----------------------------------------------
 * Every mutation here re-runs `load`. The alternative - patching the local array - has
 * to reimplement the promotion rule, the counts and the ordering in the client, and
 * gets them subtly wrong in exactly the cases the server was careful about. One extra
 * request against a page somebody opened deliberately is a cheap price.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import styled from 'styled-components';

import TaskEditor from '../components/TaskEditor';
import {
  deleteTask,
  describeError,
  getRoadmap,
  getTaskStatuses,
  getTasks,
} from '../services/api';
import { palette, radius } from '../styles/theme';
import {
  Chip,
  DangerButton,
  ErrorText,
  Hint,
  PageLoading,
  Panel,
  PrimaryButton,
  SecondaryButton,
} from '../styles/ui';
import type { Project, StatusInfo, Task } from '../types';
import { decorate, isOverdue, subtasksOf, todayISO } from '../utils/tasks';

const Head = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 12px;
  flex-wrap: wrap;
`;

const Heading = styled.h2`
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

/*
  The notes. `pre-wrap` because the body is plain text and not markdown - somebody
  writing three acceptance criteria on three lines gets three lines, which a
  collapsing renderer would run into one paragraph.
*/
const Notes = styled.p`
  border-top: 1px solid ${palette.border};
  margin: 14px 0 0;
  padding-top: 14px;
  white-space: pre-wrap;
  line-height: 1.6;
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

const SubHead = styled.h3`
  font-size: 14px;
  color: ${palette.deepMagenta};
  margin: 0;
  display: flex;
  align-items: baseline;
  gap: 6px;
`;

const List = styled.ul`
  list-style: none;
  margin: 10px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

const Row = styled(Link)`
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  text-decoration: none;
  color: inherit;
  border: 1px solid ${palette.border};
  border-radius: ${radius.md};
  background: ${palette.card};
  padding: 9px 12px;
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

/** A closed subtask is struck through: the list is a checklist, so it should read as one. */
const RowTitle = styled.span<{ $closed: boolean }>`
  font-weight: 600;
  font-size: 13px;
  color: ${(p) => (p.$closed ? palette.inkSoft : palette.ink)};
  text-decoration: ${(p) => (p.$closed ? 'line-through' : 'none')};
`;

const Due = styled.span<{ $overdue: boolean }>`
  font-size: 12px;
  color: ${(p) => (p.$overdue ? palette.deepMagenta : palette.inkSoft)};
  font-weight: ${(p) => (p.$overdue ? 700 : 400)};
`;

export default function TaskPage() {
  const { itemId } = useParams<{ itemId: string }>();
  const navigate = useNavigate();
  const isNew = itemId === 'new';

  const [tasks, setTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [statuses, setStatuses] = useState<StatusInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(isNew);
  const [addingSub, setAddingSub] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  /*
    The WHOLE list, not just this task. The editor needs it to work out what may go in
    Belongs-to, and this page needs it for the subtasks - and both are answered by the
    one request that the board already makes, rather than by a fetch of this task plus
    a fetch of its children plus a fetch of the candidate parents.
  */
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [rows, vocabulary, roadmap] = await Promise.all([
        getTasks(),
        getTaskStatuses(),
        getRoadmap(true),
      ]);
      setTasks(rows);
      setStatuses(vocabulary);
      setProjects(roadmap.projects);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const task = useMemo(
    () => (isNew || !itemId ? null : tasks.find((t) => t.item_id === itemId) ?? null),
    [tasks, itemId, isNew]
  );

  const rows = useMemo(() => decorate(tasks, projects, statuses), [tasks, projects, statuses]);
  const row = task ? rows.get(task.item_id) : undefined;

  const entry = useMemo(
    () => statuses.find((s) => s.status === task?.status),
    [statuses, task]
  );

  const children = useMemo(
    () => (task ? subtasksOf(tasks, task.item_id) : []),
    [tasks, task]
  );

  const closedStatuses = useMemo(
    () => new Set(statuses.filter((s) => s.closed).map((s) => s.status)),
    [statuses]
  );

  const today = todayISO();

  const onDelete = async () => {
    if (!task) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await deleteTask(task.item_id);
      navigate('/tasks', { replace: true });
    } catch (err) {
      setError(describeError(err));
      setConfirming(false);
      setBusy(false);
    }
  };

  if (loading) {
    return <PageLoading>Loading…</PageLoading>;
  }

  // A task that has been deleted, or an id somebody mistyped. Both are the same
  // answer: say so, and offer the way back.
  if (!isNew && !task) {
    return (
      <Panel>
        <Head>
          <Heading>This task is not there</Heading>
        </Head>
        {error ? <ErrorText role="alert">{error}</ErrorText> : null}
        <Meta>
          <Hint>It may have been deleted, or the link may be wrong.</Hint>
        </Meta>
        <Meta>
          <SecondaryButton type="button" onClick={() => navigate('/tasks')}>
            Back to the board
          </SecondaryButton>
        </Meta>
      </Panel>
    );
  }

  if (editing) {
    return (
      <Panel>
        <Head>
          <Heading>{isNew ? 'Add a task' : 'Editing'}</Heading>
          <Spacer />
          <Back to="/tasks">The board</Back>
        </Head>
        {error ? <ErrorText role="alert">{error}</ErrorText> : null}
        <Notes as="div">
          <TaskEditor
            task={task}
            allTasks={tasks}
            projects={projects}
            statuses={statuses}
            onSaved={(saved) => {
              setEditing(false);
              void load();
              /*
                Replace rather than push. /tasks/new has just stopped describing what
                is on screen, and leaving it in the history means Back returns to a
                blank editor for a task that now exists - and pressing Add again
                would write a second copy.
              */
              if (isNew) {
                navigate(`/tasks/${encodeURIComponent(saved.item_id)}`, { replace: true });
              }
            }}
            onCancel={() => {
              if (isNew) {
                navigate('/tasks');
              } else {
                setEditing(false);
              }
            }}
          />
        </Notes>
      </Panel>
    );
  }

  if (!task) {
    return <PageLoading>Loading…</PageLoading>;
  }

  return (
    <>
      <Panel>
        <Head>
          <div>
            {/* A subtask says what it belongs to, and the parent's title is a link -
                this is the only route back up, since the board scatters siblings. */}
            {task.parent_id && row?.parentTitle ? (
              <Back to={`/tasks/${encodeURIComponent(task.parent_id)}`}>
                ↑ {row.parentTitle}
              </Back>
            ) : null}
            <Heading>{task.title}</Heading>
            <Meta>
              <Chip title={entry?.description}>{entry?.label ?? task.status}</Chip>
              {row?.projectName ? <Chip>{row.projectName}</Chip> : <Hint>Not tied to a project</Hint>}
              {task.owner_email ? <Hint>{task.owner_email}</Hint> : null}
              {task.due ? (
                <Due $overdue={isOverdue(task.due, today)}>Due {task.due}</Due>
              ) : null}
            </Meta>
          </div>
          <Spacer />
          <Back to="/tasks">The board</Back>
        </Head>

        <Meta>
          <SecondaryButton type="button" onClick={() => setEditing(true)}>
            Edit
          </SecondaryButton>
          {/* Deleting is never one click. The first press reveals the confirm below,
              which names the task while it asks - a window.confirm would take the
              title off screen at the moment it matters. */}
          <SecondaryButton type="button" onClick={() => setConfirming(true)} disabled={confirming}>
            Delete
          </SecondaryButton>
        </Meta>

        {error ? <ErrorText role="alert">{error}</ErrorText> : null}

        {confirming ? (
          <Confirm>
            <Hint>
              Delete &ldquo;{task.title}&rdquo;? This cannot be undone.
              {children.length > 0
                ? ` Its ${children.length} ${
                    children.length === 1 ? 'subtask stays' : 'subtasks stay'
                  } — deleting a ticket promotes its subtasks rather than removing them.`
                : ' To retire it without losing the record, set its status to Dropped instead.'}
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

        {task.body ? <Notes>{task.body}</Notes> : null}
      </Panel>

      {/* Subtasks are offered only on a ticket. A subtask cannot have children - the
          cap is one level - so on one the whole panel is absent rather than present
          and disabled, which would be a control that never does anything. */}
      {!task.parent_id ? (
        <Panel>
          <Head>
            <SubHead>
              Subtasks{' '}
              {children.length > 0 ? (
                <Hint>
                  · {row?.subtasksClosed ?? 0} of {children.length} done
                </Hint>
              ) : null}
            </SubHead>
            <Spacer />
            {!addingSub ? (
              <PrimaryButton type="button" onClick={() => setAddingSub(true)}>
                Add a subtask
              </PrimaryButton>
            ) : null}
          </Head>

          {addingSub ? (
            <Notes as="div">
              <TaskEditor
                task={null}
                allTasks={tasks}
                defaultParentId={task.item_id}
                // Inherited, not forced: a subtask of a QWAPP ticket is almost always
                // QWAPP work, and the select is right there if it is not.
                defaultProjectId={task.project_id}
                projects={projects}
                statuses={statuses}
                onSaved={() => {
                  setAddingSub(false);
                  void load();
                }}
                onCancel={() => setAddingSub(false)}
              />
            </Notes>
          ) : null}

          {children.length === 0 && !addingSub ? (
            <Hint>
              None yet. A subtask carries its own status, so it can be done while the ticket
              around it is still in progress.
            </Hint>
          ) : null}

          {children.length > 0 ? (
            <List>
              {children.map((child) => {
                const childEntry = statuses.find((s) => s.status === child.status);
                return (
                  <li key={child.item_id}>
                    <Row to={`/tasks/${encodeURIComponent(child.item_id)}`}>
                      <RowTitle $closed={closedStatuses.has(child.status)}>{child.title}</RowTitle>
                      <Chip title={childEntry?.description}>
                        {childEntry?.label ?? child.status}
                      </Chip>
                      <Spacer />
                      {child.owner_email ? <Hint>{child.owner_email}</Hint> : null}
                      {child.due ? (
                        <Due $overdue={isOverdue(child.due, today)}>Due {child.due}</Due>
                      ) : null}
                    </Row>
                  </li>
                );
              })}
            </List>
          ) : null}
        </Panel>
      ) : null}
    </>
  );
}
