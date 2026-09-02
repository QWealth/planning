/**
 * Add a phase to a lane, or edit one, or delete it.
 *
 * DELETING IS THE EXPECTED USE, NOT THE EXCEPTIONAL ONE
 * ----------------------------------------------------
 * A new lane is seeded with six standard phases (see STANDARD_PHASES in
 * ProjectEditor.tsx), and that seeding is deliberately generous: it is easier to
 * remove a stage than to remember one. Not every project has a Wireframes stage, and
 * before this control existed the only way to correct that was to leave the row there
 * undated forever - which reads on the chart as "wireframes are planned, nobody has
 * scheduled them" rather than "there are none". So the delete is not an escape hatch
 * for mistakes; it is the second half of the seeding.
 *
 * It is a real delete rather than an archive flag, because an archived phase would
 * still carry dates and progress and would go on feeding the lane's rolled-up state
 * and the chart's span while drawing nothing. The audit row keeps the whole
 * before-snapshot, which is where a phase deleted in error can be read back from.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE, ON THE EDIT PATH: send only what changed.
 *
 * The backend distinguishes an absent field from a null one - absent means "leave it
 * alone", null means "clear it" - and reads that distinction out of Pydantic's
 * `model_fields_set` (see the docstring on fast/app/schemas/projects.py). So a body
 * assembled from the form's current values, which is the obvious thing to write,
 * would be wrong in a quiet and expensive way: fixing a typo in a phase name would
 * PATCH start, end, progress and owner along with it, and every one of those would
 * be re-stamped from whatever the form had. Add a field to the schema and forget to
 * add it to this form and that field is now nulled on every save.
 *
 * React Hook Form's `dirtyFields` is what makes the correct version cheap: it tracks
 * which inputs the user actually touched, and only those become keys in the patch.
 *
 * The create path sends the whole form, and that is the same rule seen from the other
 * side rather than an exception to it: there is no stored row to leave alone, so an
 * omitted field takes the server's default. Every default is the honest one - null
 * dates, null progress, unassigned - so a half-filled create form stores exactly the
 * half somebody knew.
 *
 * The form's own values are all strings, including the dates and the percentage,
 * because that is what DOM inputs give back. Empty string is the null - an
 * <input type="date"> that has been cleared reports '', and that has to reach the
 * API as `null` and not as the string "" or as today's date.
 */

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import styled from 'styled-components';

import { createPhase, deletePhase, describeError, patchPhase } from '../services/api';
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
import type { Person, Phase, PhaseCreate, PhasePatch } from '../types';

interface FormValues {
  name: string;
  owner_email: string;
  start: string;
  end: string;
  /** Whole percent as typed, 0-100. Stored as a 0..1 fraction. */
  progress: string;
  structural: boolean;
}

const Form = styled.form`
  display: grid;
  grid-template-columns: minmax(160px, 1.4fr) minmax(150px, 1.2fr) 130px 130px 110px;
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

/** 0.85 -> "85", null -> "". Rounded through tenths because 0.85 * 100 is 85.000…1. */
export function progressToPercent(progress: number | null): string {
  return progress === null ? '' : String(Math.round(progress * 1000) / 10);
}

/** "85" -> 0.85, "" -> null. */
export function percentToProgress(percent: string): number | null {
  const trimmed = percent.trim();
  return trimmed === '' ? null : Number(trimmed) / 100;
}

/**
 * The patch body, built from the touched fields alone.
 *
 * Exported so the shape of this decision is testable and readable in one place
 * rather than tangled into the submit handler.
 */
export function buildPhasePatch(values: FormValues, dirty: Partial<Record<keyof FormValues, boolean>>): PhasePatch {
  const patch: PhasePatch = {};
  if (dirty.name) {
    patch.name = values.name.trim();
  }
  if (dirty.owner_email) {
    patch.owner_email = values.owner_email.trim() || null;
  }
  if (dirty.start) {
    patch.start = values.start || null;
  }
  if (dirty.end) {
    patch.end = values.end || null;
  }
  if (dirty.progress) {
    patch.progress = percentToProgress(values.progress);
  }
  if (dirty.structural) {
    patch.structural = values.structural;
    // Turning a phase structural is only accepted alongside cleared dates and
    // progress - the API refuses a structural phase that carries either, because a
    // Maintenance band marks ongoing support rather than scheduled work. Clearing
    // them here makes the save succeed instead of returning a 422 the user has to
    // decode; untouched fields would otherwise stay put and trip the validator.
    if (values.structural) {
      patch.start = null;
      patch.end = null;
      patch.progress = null;
    }
  }
  return patch;
}

/**
 * The create body: every field, not just the touched ones.
 *
 * A structural phase is sent with nothing else at all, rather than with explicit
 * nulls. The API refuses a structural phase carrying dates or progress outright - see
 * the check_dates validator in fast/app/schemas/projects.py - and while `null` would
 * pass that check today, sending the fields at all states an intention the form does
 * not have. A support band has no schedule; it does not have an empty one.
 */
export function buildPhaseCreate(values: FormValues, phaseOrder: number): PhaseCreate {
  const owner = values.owner_email.trim().toLowerCase() || null;
  if (values.structural) {
    return {
      name: values.name.trim(),
      phase_order: phaseOrder,
      owner_email: owner,
      structural: true,
    };
  }
  return {
    name: values.name.trim(),
    phase_order: phaseOrder,
    owner_email: owner,
    start: values.start || null,
    end: values.end || null,
    progress: percentToProgress(values.progress),
    structural: false,
  };
}

/**
 * One callback for both modes, because both endpoints answer with a whole PhaseOut -
 * unlike projects, where PATCH returns the childless ProjectOut and create and edit
 * therefore cannot share one. The caller upserts on phase_id.
 */
export type PhaseEditorProps = {
  people: Person[];
  onSaved: (phase: Phase) => void;
  onCancel: () => void;
} & (
  | {
      phase: Phase;
      projectId?: never;
      nextPhaseOrder?: never;
      /** Edit only. There is nothing to delete on the create path. */
      onDeleted: (projectId: string, phaseId: string) => void;
    }
  | {
      phase: null;
      projectId: string;
      /** Where the new row sits in the lane - the API defaults it to 0, i.e. the top. */
      nextPhaseOrder: number;
      onDeleted?: never;
    }
);

export default function PhaseEditor(props: PhaseEditorProps) {
  const { phase, people, onSaved, onCancel } = props;
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const {
    register,
    handleSubmit,
    watch,
    formState: { dirtyFields, isSubmitting, isDirty, errors },
  } = useForm<FormValues>({
    defaultValues: {
      name: phase?.name ?? '',
      owner_email: phase?.owner_email ?? '',
      start: phase?.start ?? '',
      end: phase?.end ?? '',
      progress: progressToPercent(phase?.progress ?? null),
      structural: phase?.structural ?? false,
    },
  });

  const structural = watch('structural');

  // The roster may not contain whoever is currently recorded - the migration left
  // every owner field null and addresses can be typed in later, or a person can be
  // removed. Dropping an unknown owner from the list would silently reassign the
  // phase to nobody the next time anyone saved this form.
  const knownOwner = people.some((p) => p.email === phase?.owner_email);

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    try {
      if (!phase) {
        onSaved(await createPhase(props.projectId, buildPhaseCreate(values, props.nextPhaseOrder)));
        return;
      }
      const patch = buildPhasePatch(values, dirtyFields);
      if (Object.keys(patch).length === 0) {
        onCancel();
        return;
      }
      onSaved(await patchPhase(phase.project_id, phase.phase_id, patch));
    } catch (err) {
      setError(describeError(err));
    }
  });

  const onDelete = async () => {
    if (!phase) {
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await deletePhase(phase.project_id, phase.phase_id);
      props.onDeleted(phase.project_id, phase.phase_id);
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
        Phase name
        <Input
          {...register('name', { required: 'A phase needs a name.', maxLength: 200 })}
          aria-invalid={Boolean(errors.name)}
          placeholder={phase ? undefined : 'e.g. Coding'}
          autoFocus={!phase}
        />
        {/* Said only on create, and only as a hint. Four of the five names below get
            a lane colour from utils/phaseState.ts and anything else falls to grey,
            which is honest rather than a failure - nine phases in the live data are
            one-off workstream names. But somebody typing "Dev" when they mean
            "Coding" should find that out here, not from a grey lane later. */}
        {phase ? null : <Hint>Planning, Wireframes, Architecting and Coding are coloured.</Hint>}
      </Label>

      <Label>
        Owner
        <Select {...register('owner_email')}>
          <option value="">Unassigned</option>
          {!knownOwner && phase?.owner_email ? (
            <option value={phase.owner_email}>{phase.owner_email} (not on the roster)</option>
          ) : null}
          {people.map((person) => (
            <option key={person.email} value={person.email}>
              {person.name}
              {person.active ? '' : ' (inactive)'}
            </option>
          ))}
        </Select>
      </Label>

      <Label>
        Start
        <Input type="date" {...register('start')} disabled={structural} />
      </Label>

      <Label>
        End
        <Input type="date" {...register('end')} disabled={structural} />
      </Label>

      <Label>
        Progress %
        <Input
          type="number"
          min={0}
          max={100}
          step={1}
          placeholder="unknown"
          disabled={structural}
          {...register('progress', {
            validate: (value) => {
              if (value.trim() === '') {
                return true;
              }
              const n = Number(value);
              if (Number.isNaN(n)) {
                return 'Progress must be a number, or blank.';
              }
              return n >= 0 && n <= 100 ? true : 'Progress runs from 0 to 100.';
            },
          })}
          aria-invalid={Boolean(errors.progress)}
        />
        {/* Blank is a real answer and is not the same as 0. Said out loud because
            the placeholder alone has not been enough for anyone yet. */}
        <Hint>Leave blank for &ldquo;not recorded&rdquo;. That is different from 0%.</Hint>
      </Label>

      <Actions>
        <CheckLabel>
          <input type="checkbox" {...register('structural')} />
          Ongoing support, not scheduled work
        </CheckLabel>
        {structural ? (
          <Hint>
            {phase
              ? 'Dates and progress are cleared on save - a support band carries neither.'
              : 'Dates and progress are not stored - a support band carries neither.'}
          </Hint>
        ) : null}
        <Spacer />
        {errors.name ? <ErrorText>{errors.name.message}</ErrorText> : null}
        {errors.progress ? <ErrorText>{errors.progress.message}</ErrorText> : null}
        {error ? <ErrorText role="alert">{error}</ErrorText> : null}

        {phase && confirming ? (
          <>
            {/* Confirmed in place rather than through a window.confirm, so the name
                being deleted stays on screen while the question is asked. Same as
                MilestoneEditor and the roster's delete. */}
            <Hint>Delete &ldquo;{phase.name}&rdquo;? This cannot be undone.</Hint>
            <SecondaryButton type="button" onClick={() => setConfirming(false)} disabled={disabled}>
              Keep it
            </SecondaryButton>
            <DangerButton type="button" onClick={() => void onDelete()} disabled={disabled}>
              {busy ? 'Deleting…' : 'Delete'}
            </DangerButton>
          </>
        ) : (
          <>
            {phase ? (
              <SecondaryButton type="button" onClick={() => setConfirming(true)} disabled={disabled}>
                Delete
              </SecondaryButton>
            ) : null}
            <SecondaryButton type="button" onClick={onCancel} disabled={disabled}>
              Cancel
            </SecondaryButton>
            {/* `isDirty` gates an edit that changed nothing. It must not gate a create:
                "Coding, no dates yet" is a pristine form and a perfectly good phase. */}
            <PrimaryButton type="submit" disabled={disabled || (phase !== null && !isDirty)}>
              {isSubmitting ? 'Saving…' : phase ? 'Save phase' : 'Add phase'}
            </PrimaryButton>
          </>
        )}
      </Actions>
    </Form>
  );
}
