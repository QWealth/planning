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
} from '../styles/ui';
import type { Milestone, MilestonePatch } from '../types';

interface FormValues {
  name: string;
  /** `YYYY-MM-DD` or '' for "no date agreed". '' is the null. */
  date: string;
  note: string;
  done: boolean;
}

const Form = styled.form`
  display: grid;
  grid-template-columns: minmax(180px, 1.3fr) 150px minmax(200px, 1.4fr);
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
  return patch;
}

export type MilestoneEditorProps = {
  projectId: string;
  /** Both endpoints answer with a whole MilestoneOut, so one callback covers both. */
  onSaved: (milestone: Milestone) => void;
  onCancel: () => void;
} & (
  | { milestone: Milestone; onDeleted: (milestoneId: string) => void }
  | { milestone: null; onDeleted?: never }
);

export default function MilestoneEditor(props: MilestoneEditorProps) {
  const { milestone, projectId, onSaved, onCancel } = props;
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
    },
  });

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
