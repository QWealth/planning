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
 * 5. A specialisation is TWO answers on one row: three stars for what somebody can do
 *    today, and a checkbox for whether they want the work. They are independent -
 *    a three-star engineer can still want more of it, and a zero-star one who ticks
 *    the box is the whole reason the box exists. The scale is explained once in a
 *    legend at the top rather than on all eleven rows. See utils/skills.ts.
 *
 * `admin` hides the controls a plain member would be refused. It is not a check -
 * fast/app/routes/people.py enforces every one of them again, and this form would
 * still be honest if the flag arrived wrong. What it buys is that nobody presses a
 * button and gets a 403 they cannot act on: the roster rule is "edit yourself, ask an
 * admin for anyone else", and a greyed-out Deactivate says that where a red error
 * message after the fact does not.
 *
 * The specialisations picker is on every form that uses this component, the onboarding
 * gate included - what somebody can be staffed onto is most of the reason their roster
 * row is worth having, and a gate that skips the question has to ask it again later
 * from a page nobody opens twice.
 *
 * The stars are not captioned. Each one carries its own words in a `title` and in
 * screen-reader text, which is where somebody looks when they want them; a key printed
 * above the rows is read once, by the person who needed it least.
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
import { STAR_VALUES, sameSpecialisations, starLabel } from '../utils/skills';
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
  Specialisation,
  Unassigned,
} from '../types';

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
  /**
   * skill value -> "0".."3". Strings, because a radio group's value is a string and
   * asking React Hook Form to coerce would leave the one uncoerced path - a group
   * with nothing selected - reading back as NaN rather than as zero.
   *
   * Every skill in the vocabulary has a key, so an untouched skill is an explicit
   * "0" rather than an absent field that reads back as undefined.
   */
  stars: Record<string, string>;
  /** skill value -> whether they want this work. Independent of the stars. */
  learn: Record<string, boolean>;
}

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

  The skill control below is a star rating: one value on a scale, always exactly one.
  That shape says "how much", and it says it whether or not it is true. Roles are
  multi-select and unordered - a BA who also does UX ticks both, and neither is more
  BA than the other - so reusing that control would make the form quietly lie about
  what it accepts, and the BA would pick UX and watch BA switch itself off.

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
  color: ${(p) => (p.$on ? palette.onAccent : palette.inkSoft)};
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
  The track minimum is set by the WIDEST ROW, not by taste.

  This was 460px when each row held four segments labelled in words, the longest of
  them "No, but wants to learn". Those segments are gone - a row is now a name, three
  stars and one checkbox - so the old minimum would strand a single column of
  half-empty rows on any normal screen.

  380px is the name at a readable width plus the controls, which do not shrink. The
  rule the old comment was really making still stands and is the reason for a minimum
  at all: the controls must never be what gives when the column is tight, because a
  star clipped off the edge cannot be clicked and nothing in the type system or the
  tests can see it happen.
*/
const SkillGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(380px, 1fr));
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
  A rating built from real radios: each input is visually hidden and its label is the
  star. Keyboard behaviour - arrow keys moving within the group, tab skipping past it -
  comes free from the radio group, which a row of aria-pressed buttons would have had
  to reimplement by hand.

  Never shrinks. A clipped star is one that cannot be clicked; see SkillGrid.
*/
const Stars = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 1px;
  flex-shrink: 0;
`;

/*
  Filled up to the chosen rating, hollow past it.

  Cumulative rather than one-of-three-marks, because that is what a star rating means
  everywhere else and a control that looked like one but behaved like a radio strip
  would be read wrong by everyone before it was read right by anyone. `$on` is
  therefore "this star's value is <= the current rating", not "this star is selected".

  The hollow ones stay on screen so the rating reads as two OUT OF THREE. Rendering
  only the filled stars would also reflow the row on every click, moving the next star
  under the cursor mid-decision.
*/
const Star = styled.label<{ $on: boolean }>`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  border-radius: ${radius.sm};
  color: ${(p) => (p.$on ? palette.hotPink : palette.borderStrong)};
  transition: color 120ms ease, background-color 120ms ease;

  &:hover {
    background: ${palette.blush};
  }

  /* The ring goes on the label, because the input it belongs to is not on screen. */
  &:has(input:focus-visible) {
    outline: 2px solid ${palette.hotPink};
    outline-offset: -2px;
  }
`;

/*
  Clearing the rating back to nothing.

  A star rating built from radios has no way to un-pick the last choice, and without
  this a mis-clicked star is permanent for the life of the form - the only way back to
  "not one of their areas" would be to cancel and reopen. It is the fourth radio in the
  group, value "0", so it is reachable by arrow key like the rest.

  Deliberately quiet and to the LEFT of the stars, where it reads as the bottom of the
  scale rather than as a delete button sitting at the end of the row.
*/
const ClearStars = styled.label<{ $on: boolean }>`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 22px;
  margin-right: 3px;
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
  border-radius: ${radius.sm};
  color: ${(p) => (p.$on ? palette.ink : palette.border)};
  background: ${(p) => (p.$on ? palette.slate : 'transparent')};

  &:hover {
    background: ${palette.blush};
    color: ${palette.ink};
  }

  &:has(input:focus-visible) {
    outline: 2px solid ${palette.hotPink};
    outline-offset: -2px;
  }
`;

/*
  Appetite, not ability, and shaped so it cannot be mistaken for a fourth star.

  This used to be the last segment of the rating control, labelled "No, but wants to
  learn", which put it on the capability scale while every comment in the codebase
  insisted it was not on one. A checkbox beside the stars says the same thing without
  the argument: it is a separate question, and it can be ticked at any rating.
*/
const LearnBox = styled.label<{ $on: boolean }>`
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  padding: 2px 8px 2px 5px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  cursor: pointer;
  border-radius: ${radius.pill};
  border: 1px dashed ${(p) => (p.$on ? palette.deepMagenta : 'transparent')};
  color: ${(p) => (p.$on ? palette.deepMagenta : palette.inkSoft)};

  &:hover {
    border-color: ${palette.deepMagenta};
  }

  &:has(input:focus-visible) {
    outline: 2px solid ${palette.hotPink};
    outline-offset: 1px;
  }

  /*
   * The tick stays a native checkbox on purpose - it is the one control here whose
   * default rendering is already the right shape, and a hand-drawn replacement would
   * have to re-earn the keyboard and screen-reader behaviour it gets for free. Only
   * the colour is overridden: unstyled it fills system blue, the single non-pink
   * thing on the page, which reads as a bug rather than a choice.
   */
  input {
    accent-color: ${palette.deepMagenta};
    margin: 0;
    cursor: pointer;
  }
`;

/**
 * The stored list, rebuilt from the form. Sorted so two lists compare by value.
 *
 * An entry survives if it says something: at least one star, or the box ticked. A
 * skill at zero stars that nobody wants to learn is dropped rather than sent, which
 * is the same rule the API enforces - see SpecialisationIn.must_say_something. The
 * roster is a list of what people can do or want to do, and storing eleven "no"s per
 * person would be ten times the data to say nothing.
 */
export function buildSpecialisations(
  stars: Record<string, string>,
  learn: Record<string, boolean>
): Specialisation[] {
  return Object.keys(stars)
    .map((skill) => ({
      skill,
      // Radios hand back strings, and a group with nothing chosen hands back
      // undefined. Both land on zero rather than NaN.
      stars: Number(stars[skill] ?? 0) || 0,
      wants_to_learn: Boolean(learn?.[skill]),
    }))
    .filter((s) => s.stars > 0 || s.wants_to_learn)
    .sort((a, b) => a.skill.localeCompare(b.skill));
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
  /**
   * Absent means there is nowhere to go back to, and no Cancel button is drawn.
   *
   * The onboarding screen is the case: it is the whole page, it is deliberately a
   * gate, and a Cancel wired to a no-op would be a button that visibly does nothing.
   */
  onCancel?: () => void;
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
      // Every skill gets a key in both maps, so an untouched skill is an explicit
      // "0"/false rather than an absent field that would read back as undefined.
      // Keying off `skills` and not off what is stored also means a skill added to
      // the vocabulary appears on the form for people who predate it.
      stars: Object.fromEntries(
        skills.map((s) => [
          s.skill,
          String(existing.find((e) => e.skill === s.skill)?.stars ?? 0),
        ])
      ),
      learn: Object.fromEntries(
        skills.map((s) => [
          s.skill,
          Boolean(existing.find((e) => e.skill === s.skill)?.wants_to_learn),
        ])
      ),
    },
  });

  const stars = watch('stars');
  const learn = watch('learn');
  const chosenRoles = watch('roles') ?? [];

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    const specialisations = buildSpecialisations(values.stars, values.learn);
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
        // Nothing changed, so close rather than write. Unreachable without a Cancel
        // handler - this branch is edit-only and onboarding always creates.
        onCancel?.();
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
        Name (or alias)
        <Input
          {...register('name', { required: 'A name is needed.', maxLength: 120 })}
          aria-invalid={Boolean(errors.name)}
          placeholder="Name or alias"
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
        {/* The explanatory sentence that used to live here was removed as clutter -
            the legend already says "pick at least one", and the distinction it drew
            between a role and a specialisation is made by the two controls looking
            nothing alike. Only the validation message survives, which is the half
            that was ever load-bearing. */}
        {errors.roles ? (
          <FullRow>
            <ErrorText role="alert">{errors.roles.message}</ErrorText>
          </FullRow>
        ) : null}
      </Roles>

      {/*
        Gated on the VOCABULARY, not on which screen this is. Every form asks the
        question; the only case with nothing to ask is a caller holding an empty skill
        list, and a fieldset headed "Specialisations" with no rows under it reads as a
        render that failed rather than as a question with no options.
      */}
      {skills.length > 0 ? (
        <Skills>
          <SkillsLegend>Specialisations</SkillsLegend>
          <SkillGrid>
            {skills.map((skill) => {
              const rating = Number(stars?.[skill.skill] ?? 0) || 0;
              const wants = Boolean(learn?.[skill.skill]);
              return (
                <SkillRow key={skill.skill}>
                  <SkillName title={skill.description}>{skill.label}</SkillName>
                  {/* radiogroup, not group: four radios where exactly one is chosen.
                      The accessible name has to carry the skill, because the stars
                      themselves are identical on every row. */}
                  <Stars role="radiogroup" aria-label={`${skill.label} — rating`}>
                    <ClearStars $on={rating === 0} title={`${skill.label}: ${starLabel(0)}`}>
                      <span aria-hidden="true">✕</span>
                      <VisuallyHidden as="span">
                        {skill.label} — {starLabel(0)}
                      </VisuallyHidden>
                      <VisuallyHidden
                        as="input"
                        type="radio"
                        value="0"
                        {...register(`stars.${skill.skill}` as const)}
                      />
                    </ClearStars>
                    {STAR_VALUES.map((value) => (
                      <Star
                        key={value}
                        // Cumulative: every star up to the rating is filled, which is
                        // what a star rating means. Not "this one is the selected radio".
                        $on={value <= rating}
                        title={`${skill.label}: ${starLabel(value)}`}
                      >
                        <span aria-hidden="true">{value <= rating ? '★' : '☆'}</span>
                        <VisuallyHidden as="span">
                          {skill.label} — {starLabel(value)}
                        </VisuallyHidden>
                        <VisuallyHidden
                          as="input"
                          type="radio"
                          value={String(value)}
                          {...register(`stars.${skill.skill}` as const)}
                        />
                      </Star>
                    ))}
                  </Stars>
                  <LearnBox
                    $on={wants}
                    title={`${skill.label}: wants to be given this work`}
                  >
                    <input type="checkbox" {...register(`learn.${skill.skill}` as const)} />
                    Wants to learn
                  </LearnBox>
                </SkillRow>
              );
            })}
          </SkillGrid>
        </Skills>
      ) : null}

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
            {onCancel ? (
              <SecondaryButton type="button" onClick={onCancel} disabled={disabled}>
                Cancel
              </SecondaryButton>
            ) : null}
            <PrimaryButton type="submit" disabled={disabled}>
              {isSubmitting ? 'Saving…' : person ? 'Save person' : 'Add to roster'}
            </PrimaryButton>
          </>
        )}
      </Actions>
    </Form>
  );
}
