/**
 * "Assign all" — hand every task under one banner to one person, in one action.
 *
 * WHY THIS EXISTS
 * ---------------
 * 287 tasks arrived from Jira in a single import and almost none of them carry an
 * owner: Jira's assignee was frequently unset, and where it was set it was a display
 * name we deliberately refused to guess an address from. Opening a project, opening
 * each of its forty tickets, and setting the same address forty times is not a
 * workflow, and the predictable outcome is that the owner column stays empty and the
 * board stops answering the only question a board is for.
 *
 * WHAT IT WRITES, AND WHAT IT DOES NOT
 * ------------------------------------
 * Exactly the rows visible under its own banner. That is a deliberate scope choice
 * rather than the easy one: the board's filters have already been applied by the time
 * this component is handed its list, so hiding closed work and then reassigning it
 * would write to rows nobody could see. "What is on screen under this heading" is a
 * rule somebody can hold in their head; "everything in the project, including the
 * things the toggle is hiding" is not.
 *
 * Rows already owned by the chosen person are skipped, not re-sent - see
 * tasksToAssign. Every write is an audit row, and a PATCH setting owner_email to the
 * value it already holds logs that nothing happened.
 *
 * WHY IT CONFIRMS, AND WHY THE CONFIRMATION COUNTS
 * ------------------------------------------------
 * This is the only control in the app that writes to dozens of rows from one click,
 * and there is no undo. So it asks first, in place rather than through a
 * window.confirm, and the question names both the number and the person: "Assign 14
 * tasks in Tax to sam@qwealth.com?" A count is what turns this from a button somebody
 * presses to see what it does into a decision.
 *
 * WHY THE WRITES ARE SEQUENTIAL
 * -----------------------------
 * There is no bulk endpoint, so this is N PATCHes either way. Sequential makes the
 * partial failure honest: if the fifteenth request fails, the message says fourteen
 * were written and which one broke, and the board reloads to show exactly that. Fired
 * in parallel, a rejection tells you nothing about how much of the change landed, and
 * the operator's only recourse is to reload and count by hand.
 */

import { useState } from 'react';
import styled from 'styled-components';

import { describeError, patchTask } from '../services/api';
import { palette } from '../styles/theme';
import { ErrorText, Hint, PrimaryButton, SecondaryButton, Select } from '../styles/ui';
import type { Person, Task } from '../types';
import { tasksToAssign } from '../utils/tasks';

const Wrap = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
`;

/*
  Narrower than the toolbar's filters. It sits inside a banner beside a project name
  that may itself be long, and an address is legible at this width - the roster is
  eleven people, not a thousand.
*/
const Who = styled(Select)`
  width: auto;
  min-width: 150px;
  max-width: 220px;
  font-size: 12px;
  padding: 4px 8px;
`;

const Small = styled(SecondaryButton)`
  font-size: 12px;
  padding: 4px 10px;
`;

const SmallPrimary = styled(PrimaryButton)`
  font-size: 12px;
  padding: 4px 10px;
`;

const Question = styled(Hint)`
  color: ${palette.ink};
`;

interface AssignAllProps {
  /**
   * The tasks under this banner, already filtered exactly as they are drawn.
   *
   * Passed in rather than looked up by project id, so that this component cannot
   * write to a row the page is not showing. See the header.
   */
  tasks: readonly Task[];
  people: readonly Person[];
  /** The banner's own heading, for the confirm sentence. */
  groupTitle: string;
  /** Reload the board. Called once, after the whole run, success or partial. */
  onDone: () => void;
}

export default function AssignAll({ tasks, people, groupTitle, onDone }: AssignAllProps) {
  const [email, setEmail] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [written, setWritten] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // No roster and there is nobody to assign to, so the control would be a select with
  // one disabled option. Absent is the honest rendering of "add somebody first".
  if (people.length === 0) {
    return null;
  }

  const pending = email ? tasksToAssign(tasks, email) : [];
  const busy = written !== null;

  const run = async () => {
    setError(null);
    setWritten(0);
    let done = 0;
    try {
      for (const task of pending) {
        await patchTask(task.item_id, { owner_email: email });
        done += 1;
        setWritten(done);
      }
    } catch (err) {
      // Says how far it got, then the reason. A bulk write that stops halfway and
      // reports only the error leaves the operator unable to tell whether to run it
      // again or fix thirteen rows by hand.
      setError(
        `Assigned ${done} of ${pending.length} before this: ${describeError(err)}`
      );
    } finally {
      setWritten(null);
      setConfirming(false);
      // Reloaded either way. On a partial failure the board is the only place that
      // says which rows actually changed.
      onDone();
    }
  };

  if (confirming) {
    return (
      <Wrap>
        <Question>
          Assign {pending.length} {pending.length === 1 ? 'task' : 'tasks'} in {groupTitle} to{' '}
          {email}?
        </Question>
        <Small type="button" onClick={() => setConfirming(false)} disabled={busy}>
          Cancel
        </Small>
        <SmallPrimary type="button" onClick={() => void run()} disabled={busy}>
          {busy ? `Assigning ${written} of ${pending.length}…` : 'Assign them'}
        </SmallPrimary>
        {error ? <ErrorText role="alert">{error}</ErrorText> : null}
      </Wrap>
    );
  }

  return (
    <Wrap>
      <Who
        value={email}
        onChange={(e) => {
          setEmail(e.target.value);
          setError(null);
        }}
        aria-label={`Assign all of ${groupTitle} to`}
      >
        <option value="">Assign all to…</option>
        {people.map((person) => (
          <option key={person.email} value={person.email}>
            {person.name}
          </option>
        ))}
      </Who>
      {/*
        Disabled with a reason rather than hidden. "Everybody here is already theirs"
        is a useful answer, and a button that vanishes when you pick a name reads as a
        bug in the picker.
      */}
      <Small
        type="button"
        onClick={() => setConfirming(true)}
        disabled={!email || pending.length === 0}
        title={
          !email
            ? 'Pick somebody first.'
            : pending.length === 0
              ? 'Every task here is already theirs.'
              : undefined
        }
      >
        Assign {pending.length > 0 ? pending.length : 'all'}
      </Small>
      {error ? <ErrorText role="alert">{error}</ErrorText> : null}
    </Wrap>
  );
}
