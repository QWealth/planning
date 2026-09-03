/**
 * Add a milestone to a lane, or edit one, or delete it.
 *
 * Until this file existed there was no way to put a milestone into the table except
 * by calling the API by hand, which made the diamonds on the chart a feature nobody
 * could use. Create and edit share one component because the form is four fields and
 * splitting it would be duplication with nothing to justify it.
 *
 * The absent/null discipline applies on the edit path exactly as it does to phases -
 * only touched fields are sent - and the two fields where it bites are `date` and
 * `done`:
 *
 *   `date: null` is a real edit and NOT a blank. It means the milestone is still
 *   needed and the commitment has gone: "there has to be a beta launch, nobody will
 *   say when". Omitting `date` leaves the agreed date alone. Clearing the input sends
 *   the first; not touching it sends neither.
 *
 *   `done` is independent of the date in both directions, which is the whole reason
 *   milestones are not modelled as zero-length phases. Past its date and not done is
 *   a missed deadline and the chart says so in red; deriving one from the other would
 *   quietly mark every slipped commitment as achieved. See utils/milestones.ts.
 *
 *   `phase_id: null` DETACHES the milestone from its phase, and is what the select's
 *   first option sends. It means "this belongs to the lane, not to that stage" - the
 *   commonest shape a milestone has, not a cleared field.
 *
 * THE PHASE IS OPTIONAL, AND THE SELECT SAYS SO FIRST
 * ---------------------------------------------------
 * "Not tied to a phase" is the leading option and the default, because it is the
 * honest answer for most milestones: "Regulatory deadline" is a date the whole lane
 * answers to, not a step inside Infra. Making the attachment required would file
 * every such date under whichever phase happened to be nearest, and that phase would
 * then look like it owned a commitment nobody gave it.
 *
 * The list is the project's OWN phases, passed in rather than fetched, because the API
 * refuses a phase from another project - and a select that can offer a 400 is a select
 * that will eventually produce one.
 *
 * Deletion is a real delete, and is the one destructive action on the roadmap.
 * Soft-deleting a milestone would be worse than useless: an inactive one still has a
 * date, so it would keep counting towards the gap report and the missed tally while
 * being invisible on the chart. It is confirmed in place rather than through a
 * window.confirm, so the name being deleted stays on screen while the question is
 * asked.
 */

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import styled from 'styled-components';

import { createMilestone, deleteMilestone, describeError, patchMilestone } from '../services/api';
import { palette } from '../styles/theme';
import {
  DangerButton,
  ErrorText,
  Hint,
  Input,
  Label,
  PrimaryButton,
  SecondaryButton,
  Select,
} from '../styles/ui';
import type { Milestone, MilestonePatch, Phase } from '../types';

interface FormValues {
  name: string;
  /** `YYYY-MM-DD` or '' for "no date agreed". '' is the null. */
  date: string;
  note: string;
  done: boolean;
  /** A phase_id, or '' for "not tied to a phase". '' is the null, as with `date`. */
  phase_id: string;
}

/*
  Four columns now the phase picker is here, not three. The picker sits beside the
  date because the two answer the same kind of question - where in the plan this sits -
  and because putting it on its own row below would leave the note stranded next to a
  gap.
*/
const Form = styled.form`
  display: grid;
  grid-template-columns: minmax(170px, 1.2fr) 150px minmax(150px, 1fr) minmax(180px, 1.3fr);
  gap: 12px 14px;
  align-items: start;
  padding: 14px 16px 16px 30px;
`;

const Actions = styled.div`
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
`;

const Spacer = styled.div`
  flex: 1;
`;

const CheckLabel = styled.label`
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  color: ${palette.ink};
  cursor: pointer;
`;

/** The patch body, built from the touched fields alone. Exported to be readable. */
export function buildMilestonePatch(
  values: FormValues,
  dirty: Partial<Record<keyof FormValues, boolean>>
): MilestonePatch {
  const patch: MilestonePatch = {};
  if (dirty.name) {
    patch.name = values.name.trim();
  }
  if (dirty.date) {
    patch.date = values.date || null;
  }
  if (dirty.note) {
    patch.note = values.note.trim() || null;
  }
  if (dirty.done) {
    patch.done = values.done;
  }
  if (dirty.phase_id) {
    // '' is the select's "Not tied to a phase", and it has to go out as a real null.
    // Sent as an empty string it would be a phase id that passes a truthy check and
    // matches nothing; the API normalises it too, but relying on that would leave the
    // patch body lying about what it means.
    patch.phase_id = values.phase_id || null;
  }
  return patch;
}

export type MilestoneEditorProps = {
  projectId: string;
  /**
   * The project's own phases, for the picker. Empty is fine and normal - a lane with
   * no phases yet still has deadlines - and the select then offers only "Not tied to
   * a phase", which is the truth rather than a disabled control.
   */
  phases: readonly Phase[];
  /** Both endpoints answer with a whole MilestoneOut, so one callback covers both. */
  onSaved: (milestone: Milestone) => void;
  onCancel: () => void;
} & (
  | { milestone: Milestone; onDeleted: (milestoneId: string) => void }
  | { milestone: null; onDeleted?: never }
);

export default function MilestoneEditor(props: MilestoneEditorProps) {
  const { milestone, projectId, phases, onSaved, onCancel } = props;
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { dirtyFields, isSubmitting, isDirty, errors },
  } = useForm<FormValues>({
    defaultValues: {
      name: milestone?.name ?? '',
      date: milestone?.date ?? '',
      note: milestone?.note ?? '',
      done: milestone?.done ?? false,
      phase_id: milestone?.phase_id ?? '',
    },
  });

  // A milestone attached to a phase this list does not contain. Only reachable with a
  // stale payload - the API detaches on phase delete - but the option is offered
  // anyway, because a select whose value matches none of its options silently shows
  // the first one, which here would read as "not tied to a phase" and would write
  // exactly that the next time anybody saved the form. Same guard as PhaseEditor's
  // owner select.
  const knownPhase = phases.some((p) => p.phase_id === milestone?.phase_id);

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    try {
      if (!milestone) {
        onSaved(
          await createMilestone(projectId, {
            name: values.name.trim(),
            date: values.date || null,
            note: values.note.trim() || null,
            done: values.done,
            phase_id: values.phase_id || null,
          })
        );
        return;
      }
      const patch = buildMilestonePatch(values, dirtyFields);
      if (Object.keys(patch).length === 0) {
        onCancel();
        return;
      }
      onSaved(await patchMilestone(projectId, milestone.milestone_id, patch));
    } catch (err) {
      setError(describeError(err));
    }
  });

  const onDelete = async () => {
    if (!milestone) {
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await deleteMilestone(projectId, milestone.milestone_id);
      props.onDeleted(milestone.milestone_id);
    } catch (err) {
      setError(describeError(err));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  const disabled = isSubmitting || busy;

  return (
    <Form onSubmit={onSubmit}>
      <Label>
        Milestone
        <Input
          {...register('name', { required: 'A milestone needs a name.', maxLength: 200 })}
          aria-invalid={Boolean(errors.name)}
          placeholder={milestone ? undefined : 'e.g. Beta launch'}
          autoFocus={!milestone}
        />
      </Label>

      <Label>
        Date
        <Input type="date" {...register('date')} />
        {/* Blank is a real answer and the commonest one at the point a milestone is
            first written down. Saying so here is what stops people inventing a date
            to get past the form, which is how the workbook filled up with schedules
            nobody believed. */}
        <Hint>Blank if nobody has committed yet. It is listed as still to decide.</Hint>
      </Label>

      <Label>
        Part of
        <Select {...register('phase_id')}>
          {/* First and default. Belonging to the lane as a whole is the ordinary
              answer, not the fallback, and a picker that leads with a phase invites
              somebody to file a company-wide deadline under whichever stage is at the
              top of the list. */}
          <option value="">Not tied to a phase</option>
          {!knownPhase && milestone?.phase_id ? (
            <option value={milestone.phase_id}>{milestone.phase_id} (phase not found)</option>
          ) : null}
          {phases.map((phase) => (
            <option key={phase.phase_id} value={phase.phase_id}>
              {phase.name}
            </option>
          ))}
        </Select>
        <Hint>
          {phases.length === 0
            ? 'This lane has no phases yet, so it belongs to the project.'
            : 'Optional. A deadline the whole project answers to belongs to no phase.'}
        </Hint>
      </Label>

      <Label>
        Note
        <Input
          {...register('note', { maxLength: 500 })}
          placeholder="Optional - what has to be true"
        />
      </Label>

      <Actions>
        <CheckLabel>
          <input type="checkbox" {...register('done')} />
          Met
        </CheckLabel>
        {/* "Met", not "done": the word "done" already means a filled progress bar two
            legend groups away, and reusing it for a deadline would undo the
            distinction the two groups exist to draw. */}
        <Hint>Independent of the date - a deadline can be met early, or missed and still open.</Hint>
        <Spacer />
        {errors.name ? <ErrorText>{errors.name.message}</ErrorText> : null}
        {errors.note ? <ErrorText>A note is limited to 500 characters.</ErrorText> : null}
        {error ? <ErrorText role="alert">{error}</ErrorText> : null}

        {milestone && confirming ? (
          <>
            <Hint>Delete &ldquo;{milestone.name}&rdquo;? This cannot be undone.</Hint>
            <SecondaryButton type="button" onClick={() => setConfirming(false)} disabled={disabled}>
              Keep it
            </SecondaryButton>
            <DangerButton type="button" onClick={() => void onDelete()} disabled={disabled}>
              {busy ? 'Deleting…' : 'Delete'}
            </DangerButton>
          </>
        ) : (
          <>
            {milestone ? (
              <SecondaryButton type="button" onClick={() => setConfirming(true)} disabled={disabled}>
                Delete
              </SecondaryButton>
            ) : null}
            <SecondaryButton type="button" onClick={onCancel} disabled={disabled}>
              Cancel
            </SecondaryButton>
            {/* Same as the other two editors: `isDirty` gates a no-op edit, never a
                create. A milestone with a name and no date is the normal first draft. */}
            <PrimaryButton type="submit" disabled={disabled || (milestone !== null && !isDirty)}>
              {isSubmitting ? 'Saving…' : milestone ? 'Save milestone' : 'Add milestone'}
            </PrimaryButton>
          </>
        )}
      </Actions>
    </Form>
  );
}
