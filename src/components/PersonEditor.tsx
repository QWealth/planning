/**
 * Add somebody to the roster, or edit who they are and what they do.
 *
 * One component for both, because the two forms differ by exactly one field. A
 * separate AddPerson would duplicate the specialisation picker - the fiddliest part
 * of this file - and the two copies would drift the first time the vocabulary grows.
 *
 * FOUR THINGS HERE ARE NOT OBVIOUS.
 *
 * 1. Email is the primary key and is therefore only editable on create. Changing it
 *    afterwards is not a rename, it is a new row plus an orphan, and every project
 *    that pointed at the old address would silently become unowned. Correcting a
 *    typo means deactivating the wrong row and adding the right one.
 *
 * 2. Scalar fields follow the usual dirtyFields rule - only what changed is sent -
 *    but `specialisations` and `roles` cannot, because both REPLACE rather than
 *    merge. React Hook Form marks the whole collection dirty the moment one entry
 *    moves, and sending a partially-dirty map would drop the untouched ones. So each
 *    is rebuilt from the form and compared with what was there; it is sent only if
 *    the resulting SET differs. See types.ts and fast/app/schemas/people.py.
 *
 * 3. Deactivation, not deletion. The API has no hard delete and this form does not
 *    pretend otherwise: their assignments keep pointing at them, because erasing who
 *    was responsible for a lane is a worse outcome than a greyed-out name.
 *
 * 4. Roles and specialisations are two questions, not one asked twice. A role is what
 *    somebody IS - BA, UX, engineer - and at least one is required. A specialisation
 *    is what they could be STAFFED ONTO, and none is a perfectly good answer. A
 *    back-end engineer who is handy with CSS has the front-end skill and is not UX.
 *    The two controls are shaped differently on purpose; see the note above Roles.
 *
 * `admin` hides the controls a plain member would be refused. It is not a check -
 * fast/app/routes/people.py enforces every one of them again, and this form would
 * still be honest if the flag arrived wrong. What it buys is that nobody presses a
 * button and gets a 403 they cannot act on: the roster rule is "edit yourself, ask an
 * admin for anyone else", and a greyed-out Deactivate says that where a red error
 * message after the fact does not.
 */

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import styled from 'styled-components';

import {
  createPerson,
  deactivatePerson,
  deletePerson,
  describeError,
  patchPerson,
} from '../services/api';
import { palette, radius } from '../styles/theme';
import { sameRoles } from '../utils/roles';
import {
  DangerButton,
  ErrorText,
  Hint,
  Input,
  Label,
  PrimaryButton,
  SecondaryButton,
  VisuallyHidden,
} from '../styles/ui';
import type {
  Person,
  PersonPatch,
  PersonRole,
  RoleInfo,
  SkillInfo,
  SkillLevel,
  Specialisation,
  Unassigned,
} from '../types';

/** The three states a skill can be in on this form. `none` is not a stored value. */
type Choice = 'none' | SkillLevel;

interface FormValues {
  email: string;
  name: string;
  /**
   * The checked role values. `string[]` rather than `PersonRole[]` because they come
   * from the API's own catalogue at runtime; the cast to the union happens once, at
   * the point of sending, where the comment explains itself.
   */
  roles: string[];
  active: boolean;
  /** skill value -> choice. Every skill in the vocabulary is present, most as 'none'. */
  levels: Record<string, Choice>;
}

/**
 * The four answers, in the order they are offered.
 *
 * Capability ascending - No, slowly, yes - and then the one that is not on that
 * scale at all. "No, but wants to learn" reads as a footnote to "No" and belongs
 * next to it in meaning, but putting it second would break the ramp the three fills
 * depend on, so it goes last where it reads as the special case it is.
 *
 * `none` is a UI-only value: choosing it stores no entry rather than storing a "no".
 * The roster is a list of what people CAN do, and a row per person per skill they
 * cannot do would be ten times the data to say nothing.
 */
const CHOICES: { value: Choice; label: string; hint: string }[] = [
  { value: 'none', label: 'No', hint: 'Not one of their areas' },
  { value: 'secondary', label: 'Yes, but slowly', hint: 'Can do it; it will take longer' },
  { value: 'primary', label: 'Yes', hint: 'The obvious person for this' },
  {
    value: 'learning',
    label: 'No, but wants to learn',
    hint: 'Not yet - but wants to be given this work',
  },
];

/*
  Two columns, not three. It was three when Manager sat beside Email and Name; with
  that field gone the third track had nothing in it, and an empty column at the top of
  a form reads as a field that failed to render rather than as spacing.
*/
const Form = styled.form`
  display: grid;
  grid-template-columns: minmax(220px, 1fr) minmax(220px, 1fr);
  gap: 12px 14px;
  align-items: start;
`;

const FullRow = styled.div`
  grid-column: 1 / -1;
`;

const Actions = styled.div`
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  border-top: 1px solid ${palette.border};
  padding-top: 12px;
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

/*
  ROLES LOOK DELIBERATELY UNLIKE SKILLS, AND THAT IS THE WHOLE POINT OF THESE RULES.

  The skill control below is a segmented pill: four options welded together, one of
  which is always filled. That shape says "pick exactly one", and it says it whether
  or not it is true. Roles are multi-select - a BA who also does UX ticks both - so
  reusing that control would make the form quietly lie about what it accepts, and the
  BA would tick UX and watch BA switch itself off.

  So: separate chips with gaps between them, and a check mark on the selected ones.
  Detached things that each turn on and off independently, which is what they are.
*/
const Roles = styled.fieldset`
  grid-column: 1 / -1;
  margin: 0;
  padding: 12px 14px;
  border: 1px solid ${palette.border};
  border-radius: ${radius.md};
  background: ${palette.blush};
`;

const RoleChoices = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
`;

const RoleChip = styled.label<{ $on: boolean }>`
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 13px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  border-radius: ${radius.pill};
  border: 1px solid ${(p) => (p.$on ? palette.hotPink : palette.border)};
  background: ${(p) => (p.$on ? palette.hotPink : palette.card)};
  color: ${(p) => (p.$on ? '#ffffff' : palette.inkSoft)};
  transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease;

  &:hover {
    border-color: ${palette.hotPink};
  }

  /* The ring goes on the label, because the input it belongs to is not on screen. */
  &:has(input:focus-visible) {
    outline: 2px solid ${palette.hotPink};
    outline-offset: 2px;
  }
`;

/*
  A tick on the selected chips, so selection is not carried by colour alone.

  Fixed-width and always rendered, blank when off, so turning a chip on cannot change
  its width and reflow the row under the cursor mid-click.
*/
const Tick = styled.span`
  display: inline-block;
  width: 9px;
  font-size: 11px;
  line-height: 1;
`;

/*
  A fieldset rather than a div, and a legend rather than a heading, so that a screen
  reader announces "Specialisations" before each skill's radio group. Ten groups of
  three otherwise arrive as thirty unexplained radios.
*/
const Skills = styled.fieldset`
  grid-column: 1 / -1;
  margin: 0;
  padding: 12px 14px;
  border: 1px solid ${palette.border};
  border-radius: ${radius.md};
  background: ${palette.blush};
`;

const SkillsLegend = styled.legend`
  padding: 0 6px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: ${palette.inkSoft};
`;

/*
  The track minimum is set by the WIDEST SEGMENTED CONTROL, not by taste.

  "No, but wants to learn" is a long label, and the four segments plus a skill name do
  not fit in the 300px this used to be. They did not wrap or scroll - Segments has
  overflow:hidden for its rounded corners, so the row simply clipped, and on the
  narrowest column the "No" segment was cut off the left edge entirely. An option that
  cannot be clicked is worse than a cramped one, and nothing in the type system or the
  tests can see it happen.

  So: fewer columns, all four options reachable in every one of them.
*/
const SkillGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(460px, 1fr));
  gap: 6px 18px;
`;

const SkillRow = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 30px;
`;

/* Shrinks and wraps so that the control next to it never has to. */
const SkillName = styled.span`
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: ${palette.ink};
`;

/*
  A segmented control built from real radios: the input is visually hidden and the
  label is the button. Keyboard behaviour - arrow keys moving within the group,
  tab skipping past it - comes free from the radio group, which a set of
  aria-pressed buttons would have had to reimplement by hand.
*/
const Segments = styled.div`
  display: inline-flex;
  border: 1px solid ${palette.border};
  border-radius: ${radius.pill};
  background: ${palette.card};
  /* Clips the segment fills to the pill's rounded ends - and would clip the segments
     themselves if the row ever ran out of room, so the control must never be the
     thing that gives. */
  overflow: hidden;
  flex-shrink: 0;
`;

const Segment = styled.label<{ $on: boolean; $level: Choice }>`
  position: relative;
  padding: 3px 11px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  /*
    Distinct fills, not one. An earlier version painted every selected segment the
    same grey, so "No" and "Yes, but slowly" were indistinguishable unless you worked
    out which cell was the filled one - on a ten-row grid that is unreadable. Grey /
    bubblegum / hot pink is a strength ramp that differs in lightness as well as hue,
    so it survives the colour vision deficiencies the palette header is written
    around, and the selected word is still there to read.

    "No, but wants to learn" is deliberately NOT on that ramp. It is not a weaker yes
    - it is a no with an intention attached, and painting it as a paler pink would
    file it under ability, which is the one thing it is not. So it gets the blush fill
    plus an outlined edge: marked out as different in KIND rather than placed
    somewhere in the degree ordering. Without it a selected "learn" would have fallen
    through to the same slate as "No", and the two would have been one mark.
  */
  color: ${(p) => {
    if (!p.$on) {
      return palette.inkSoft;
    }
    if (p.$level === 'primary') {
      return '#ffffff';
    }
    if (p.$level === 'secondary') {
      return '#5C1138';
    }
    return p.$level === 'learning' ? palette.deepMagenta : palette.ink;
  }};
  background: ${(p) => {
    if (!p.$on) {
      return 'transparent';
    }
    if (p.$level === 'primary') {
      return palette.hotPink;
    }
    if (p.$level === 'secondary') {
      return palette.bubblegum;
    }
    return p.$level === 'learning' ? palette.blush : palette.slate;
  }};
  /* Inset so the dashed edge does not change the segment's size and nudge the row. */
  box-shadow: ${(p) =>
    p.$on && p.$level === 'learning' ? `inset 0 0 0 1px ${palette.deepMagenta}` : 'none'};
  transition: background-color 120ms ease, color 120ms ease;

  &:hover {
    background: ${(p) => (p.$on ? undefined : palette.blush)};
  }

  /* The ring goes on the label, because the input it belongs to is not on screen. */
  &:has(input:focus-visible) {
    outline: 2px solid ${palette.hotPink};
    outline-offset: -2px;
  }
`;

/** The stored list, rebuilt from the form. Sorted so two lists compare by value. */
export function buildSpecialisations(levels: Record<string, Choice>): Specialisation[] {
  return Object.entries(levels)
    .filter((entry): entry is [string, SkillLevel] => entry[1] !== 'none')
    .map(([skill, level]) => ({ skill, level }))
    .sort((a, b) => a.skill.localeCompare(b.skill));
}

/** True when the two lists describe the same set of skills at the same levels. */
export function sameSpecialisations(a: Specialisation[], b: Specialisation[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const key = (list: Specialisation[]) =>
    [...list]
      .sort((x, y) => x.skill.localeCompare(y.skill))
      .map((s) => `${s.skill}:${s.level}`)
      .join('|');
  return key(a) === key(b);
}

interface PersonEditorProps {
  /** The person being edited, or null to add a new one. */
  person: Person | null;
  skills: SkillInfo[];
  roles: RoleInfo[];
  /**
   * What this person is currently named on, for the delete warning.
   *
   * Passed in rather than fetched here because the Team page already holds both the
   * workload and the project names, and a second round trip to restate them would be
   * one more thing that can be stale at the moment it matters most.
   *
   * Names, not ids: the warning is read by a person deciding whether to go ahead, and
   * "QWAPP, Net Worth" answers that question where three uuids do not.
   */
  assignments?: { dri: string[]; support: string[]; phaseCount: number };
  /**
   * Whether this caller may act on people other than themselves.
   *
   * Drives the two controls the API refuses a plain member outright - Deactivate, and
   * the active checkbox - so they are absent rather than armed. Delete is gated by
   * `onDeleted` instead, which the Team page simply does not pass to a non-admin.
   */
  admin: boolean;
  /**
   * On a create, the only address this caller is allowed to use.
   *
   * A non-admin may add exactly themselves, so there is nothing to type: the field is
   * filled in and locked, and the value below is taken from here rather than from the
   * form. Null on an edit, and for an admin, who may add anybody.
   */
  lockedEmail?: string | null;
  onSaved: (saved: Person) => void;
  /** Absent means the person cannot be deleted from here, only edited. */
  onDeleted?: (email: string, unassigned: Unassigned) => void;
  onCancel: () => void;
}

export default function PersonEditor({
  person,
  skills,
  roles,
  assignments,
  admin,
  lockedEmail = null,
  onSaved,
  onDeleted,
  onCancel,
}: PersonEditorProps) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const existing = person?.specialisations ?? [];
  const existingRoles = person?.roles ?? [];

  const {
    register,
    handleSubmit,
    watch,
    formState: { dirtyFields, isSubmitting, errors },
  } = useForm<FormValues>({
    defaultValues: {
      email: person?.email ?? lockedEmail ?? '',
      name: person?.name ?? '',
      // Whatever is stored, including values the catalogue no longer offers - see the
      // note beside the chips below for why those are shown rather than dropped.
      roles: existingRoles,
      active: person?.active ?? true,
      // Every skill gets a key, so an untouched skill is an explicit 'none' rather
      // than an absent field that would read back as undefined.
      levels: Object.fromEntries(
        skills.map((s) => [s.skill, existing.find((e) => e.skill === s.skill)?.level ?? 'none'])
      ) as Record<string, Choice>,
    },
  });

  const levels = watch('levels');
  const chosenRoles = watch('roles') ?? [];

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    const specialisations = buildSpecialisations(values.levels);
    // Asserting what the server just told us, not guessing: every value here came out
    // of the catalogue this component was handed by GET /api/roles, and the API
    // validates the closed list again on arrival.
    const chosen = (values.roles ?? []) as PersonRole[];

    try {
      if (!person) {
        const created = await createPerson({
          // `lockedEmail` wins over the field, rather than being trusted to have
          // populated it. The input is disabled, and a disabled input is exactly the
          // kind of thing whose value a form library is entitled to drop.
          email: (lockedEmail ?? values.email).trim().toLowerCase(),
          name: values.name.trim(),
          roles: chosen,
          active: values.active,
          specialisations,
        });
        onSaved(created);
        return;
      }

      const patch: PersonPatch = {};
      if (dirtyFields.name) {
        patch.name = values.name.trim();
      }
      // By value, not by dirtyFields, for the same reason as specialisations below:
      // an array field is marked dirty wholesale the moment one box is ticked, and a
      // tick-then-untick would send an unchanged list and log a phantom edit.
      if (!sameRoles(chosen, existingRoles)) {
        patch.roles = chosen;
      }
      if (dirtyFields.active) {
        patch.active = values.active;
      }
      // Compared by value, not by dirtyFields - see the header.
      if (!sameSpecialisations(specialisations, existing)) {
        patch.specialisations = specialisations;
      }
      if (Object.keys(patch).length === 0) {
        onCancel();
        return;
      }
      onSaved(await patchPerson(person.email, patch));
    } catch (err) {
      setError(describeError(err));
    }
  });

  const onDeactivate = async () => {
    if (!person) {
      return;
    }
    setError(null);
    setBusy(true);
    try {
      onSaved(await deactivatePerson(person.email));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const onDelete = async () => {
    if (!person || !onDeleted) {
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const receipt = await deletePerson(person.email);
      onDeleted(receipt.email, receipt.unassigned);
    } catch (err) {
      setError(describeError(err));
      // Back to the un-confirmed state on failure. Leaving the red button armed
      // after an error invites a second press at the thing that just broke.
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  const disabled = isSubmitting || busy;

  // What the delete will take with it, as a sentence rather than three counts.
  // Built here so the confirm step can be honest about scope: a delete that also
  // silently unassigns four lanes is not the delete the button appears to offer.
  const collateral = (() => {
    if (!assignments) {
      return null;
    }
    const parts: string[] = [];
    if (assignments.dri.length > 0) {
      parts.push(`DRI of ${assignments.dri.join(', ')}`);
    }
    if (assignments.support.length > 0) {
      parts.push(`Support on ${assignments.support.join(', ')}`);
    }
    if (assignments.phaseCount > 0) {
      parts.push(
        `owner of ${assignments.phaseCount} phase${assignments.phaseCount === 1 ? '' : 's'}`
      );
    }
    return parts.length > 0 ? parts.join('; ') : null;
  })();

  return (
    <Form onSubmit={onSubmit}>
      <Label>
        Email
        <Input
          type="email"
          {...register('email', {
            required: 'An email address is the roster key.',
            // Deliberately loose. The backend is the authority on what it accepts;
            // a stricter pattern here would refuse addresses the API is happy with.
            pattern: { value: /.+@.+\..+/, message: 'That does not look like an address.' },
          })}
          disabled={person !== null || lockedEmail !== null}
          aria-invalid={Boolean(errors.email)}
          placeholder="name@qwealth.com"
        />
        <Hint>
          {person
            ? 'The roster key. Fixed once created.'
            : lockedEmail
              ? 'The address you are signed in as. Ask an admin to add anybody else.'
              : 'Adding somebody here does not create a login.'}
        </Hint>
      </Label>

      <Label>
        Name
        <Input
          {...register('name', { required: 'A name is needed.', maxLength: 120 })}
          aria-invalid={Boolean(errors.name)}
          placeholder="Full name"
        />
      </Label>

      <Roles>
        <SkillsLegend>Role &mdash; pick at least one</SkillsLegend>
        <RoleChoices>
          {roles.map((role) => {
            const on = chosenRoles.includes(role.role);
            return (
              <RoleChip key={role.role} $on={on} title={role.description}>
                <Tick aria-hidden="true">{on ? '✓' : ''}</Tick>
                {role.label}
                <VisuallyHidden
                  as="input"
                  type="checkbox"
                  value={role.role}
                  {...register('roles', {
                    // Enforced here as well as at the API, because a 422 after pressing
                    // Save cannot say *which* field is wrong in a way this can. The API
                    // check is the one that counts; this one is the one that helps.
                    validate: (chosen) =>
                      (chosen?.length ?? 0) > 0 || 'Pick at least one role.',
                  })}
                />
              </RoleChip>
            );
          })}
          {/*
            A stored role the catalogue no longer offers still has to appear, or opening
            the form would silently drop it on the next save - the person would lose a
            role by looking at their own record. Rendered with its raw value, since
            there is no label to look up.
          */}
          {existingRoles
            .filter((stored) => !roles.some((r) => r.role === stored))
            .map((stored) => (
              <RoleChip
                key={stored}
                $on={chosenRoles.includes(stored)}
                title="No longer offered. Untick to drop it."
              >
                <Tick aria-hidden="true">{chosenRoles.includes(stored) ? '✓' : ''}</Tick>
                {stored}
                <VisuallyHidden as="input" type="checkbox" value={stored} {...register('roles')} />
              </RoleChip>
            ))}
        </RoleChoices>
        <FullRow>
          <Hint>
            {errors.roles ? (
              <ErrorText role="alert">{errors.roles.message}</ErrorText>
            ) : (
              <>
                What you do, not what you can be assigned to &mdash; tick as many as
                apply. Specialisations below are the separate question of what work you
                could take.
              </>
            )}
          </Hint>
        </FullRow>
      </Roles>

      <Skills>
        <SkillsLegend>Specialisations</SkillsLegend>
        <SkillGrid>
          {skills.map((skill) => (
            <SkillRow key={skill.skill}>
              <SkillName title={skill.description}>{skill.label}</SkillName>
              <Segments role="group" aria-label={skill.label}>
                {CHOICES.map((choice) => {
                  const on = (levels?.[skill.skill] ?? 'none') === choice.value;
                  return (
                    <Segment
                      key={choice.value}
                      $on={on}
                      $level={choice.value}
                      title={`${skill.label}: ${choice.hint}`}
                    >
                      <VisuallyHidden as="span">{skill.label} — </VisuallyHidden>
                      {choice.label}
                      <VisuallyHidden
                        as="input"
                        type="radio"
                        value={choice.value}
                        {...register(`levels.${skill.skill}` as const)}
                      />
                    </Segment>
                  );
                })}
              </Segments>
            </SkillRow>
          ))}
        </SkillGrid>
        <FullRow>
          <Hint>
            &ldquo;Yes&rdquo; is the obvious person for the job; &ldquo;yes, but slowly&rdquo; is
            who to fall back on. &ldquo;Wants to learn&rdquo; is not a weaker yes &mdash; it
            says they cannot do it today and would like the work anyway, and they will
            show up when you go looking for who could take something. There is no numeric
            scale on purpose.
          </Hint>
        </FullRow>
      </Skills>

      <Actions>
        {/* Shown to everybody, editable by admins only. Hiding it from a plain member
            would leave a deactivated person no way to see that they are - the row is
            the only place that fact appears - and the API refuses `active` on a
            self-edit regardless, so an enabled box here would only produce a 403. */}
        <CheckLabel title={admin ? undefined : 'Only an admin can change this.'}>
          <input type="checkbox" {...register('active')} disabled={!admin} />
          On the active roster
        </CheckLabel>
        <Spacer />
        {errors.email ? <ErrorText>{errors.email.message}</ErrorText> : null}
        {errors.name ? <ErrorText>{errors.name.message}</ErrorText> : null}
        {error ? <ErrorText role="alert">{error}</ErrorText> : null}
        {person && confirming ? (
          <>
            <Hint>
              Delete {person.name} for good?{' '}
              {collateral
                ? `They are ${collateral} - all of that becomes unassigned.`
                : 'They hold no assignments.'}{' '}
              This cannot be undone; use Deactivate to keep the record.
            </Hint>
            <SecondaryButton type="button" onClick={() => setConfirming(false)} disabled={disabled}>
              Keep them
            </SecondaryButton>
            <DangerButton type="button" onClick={() => void onDelete()} disabled={disabled}>
              {busy ? 'Deleting…' : 'Delete for good'}
            </DangerButton>
          </>
        ) : (
          <>
            {person && person.active && admin ? (
              <SecondaryButton
                type="button"
                onClick={() => void onDeactivate()}
                disabled={disabled}
              >
                Deactivate
              </SecondaryButton>
            ) : null}
            {person && onDeleted ? (
              <SecondaryButton type="button" onClick={() => setConfirming(true)} disabled={disabled}>
                Delete
              </SecondaryButton>
            ) : null}
            <SecondaryButton type="button" onClick={onCancel} disabled={disabled}>
              Cancel
            </SecondaryButton>
            <PrimaryButton type="submit" disabled={disabled}>
              {isSubmitting ? 'Saving…' : person ? 'Save person' : 'Add to roster'}
            </PrimaryButton>
          </>
        )}
      </Actions>
    </Form>
  );
}
