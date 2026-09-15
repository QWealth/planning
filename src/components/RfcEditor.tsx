/**
 * Write an RFC, or edit one.
 *
 * One component for both, as with MilestoneEditor: the form is the same seven fields
 * either way, and splitting it would be duplication with nothing to justify it. The
 * two paths differ only in what gets sent, and that difference is the whole
 * absent/null discipline:
 *
 *   CREATE sends everything. There is no stored row to leave alone, so an omitted
 *   field takes the server's default, and every default is the honest one - no
 *   project, no owner, draft, undecided.
 *
 *   EDIT sends only the fields the author actually touched, built from React Hook
 *   Form's `dirtyFields` rather than from the form's values. Sending the whole form
 *   would work today and would blank a field the moment one is added to the schema
 *   but not to this form.
 *
 * `project_id: null` is the edit that makes this feature what it is - detaching a
 * proposal that turned out to be a general decision - and it is one keystroke away
 * from `project_id` absent, which means "leave it attached". buildRfcPatch below is
 * where the two are kept apart, and it is exported so it can be read on its own.
 *
 * THE PREVIEW IS A TOGGLE, NOT A SPLIT PANE
 * -----------------------------------------
 * A side-by-side preview halves the width available to a textarea people are writing
 * paragraphs in, on a page that already has a form above it. Toggling gives the
 * writing the full column and the reading the full column, and the button says which
 * one you are looking at. It also means the markdown renderer is not re-parsing the
 * document on every keystroke while somebody types.
 */

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import styled from 'styled-components';

import { createRfc, describeError, patchRfc } from '../services/api';
import { field, palette, radius } from '../styles/theme';
import {
  ErrorText,
  Hint,
  Input,
  Label,
  PrimaryButton,
  SecondaryButton,
  Select,
} from '../styles/ui';
import type { Project, Rfc, RfcPatch, SkillInfo, StatusInfo } from '../types';
import { projectOptions } from '../utils/projects';
import Markdown from './Markdown';

interface FormValues {
  title: string;
  /** '' means "not tied to a project", and is stored as null. */
  project_id: string;
  status: string;
  owner_email: string;
  /** `YYYY-MM-DD`, or '' for "still open". '' is the null. */
  decided_on: string;
  body: string;
  /**
   * Skill values from the vocabulary - who this proposal wants in the room.
   *
   * Registered as a group of checkboxes sharing one name, so react-hook-form collects
   * the checked values into this array. That means `dirtyFields.skills` is an array of
   * booleans rather than a single boolean, which is why buildRfcPatch's `dirty`
   * parameter is typed loosely - see the note there.
   */
  skills: string[];
}

const Form = styled.form`
  display: flex;
  flex-direction: column;
  gap: 14px;
`;

const Fields = styled.div`
  display: grid;
  grid-template-columns: minmax(240px, 2fr) minmax(160px, 1fr) minmax(160px, 1fr);
  gap: 12px 14px;
  align-items: start;
`;

/*
  The body field. A tall monospace textarea, because markdown is written in columns -
  a table or a nested list is unreadable in a proportional face while you are editing
  it, however it renders afterwards.

  `resize: vertical` rather than `both`: horizontal resizing would let the field
  escape the grid and overlap the panel edge.
*/
const Body = styled.textarea`
  ${field};
  font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace;
  line-height: 1.55;
  min-height: 340px;
  resize: vertical;
  width: 100%;
`;

const Preview = styled.div`
  border: 1px solid ${palette.border};
  border-radius: ${radius.md};
  background: ${palette.blush};
  padding: 14px 16px;
  min-height: 340px;
`;

const BodyHead = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
`;

const Actions = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
`;

const Spacer = styled.div`
  flex: 1;
`;

/**
 * The patch body, built from the touched fields alone.
 *
 * Exported and kept free of React so it can be read - and tested - as what it is: the
 * one place where "the author cleared this box" and "the author never went near this
 * box" are turned into two different requests.
 */
export function buildRfcPatch(
  values: FormValues,
  // `unknown` rather than `boolean`, and that is not laziness. React Hook Form reports
  // a dirty checkbox GROUP as an array of booleans, so typing this as boolean would be
  // a lie the compiler happily accepts and nobody notices until skills stop saving.
  dirty: Partial<Record<keyof FormValues, unknown>>
): RfcPatch {
  const patch: RfcPatch = {};
  if (dirty.title) {
    patch.title = values.title.trim();
  }
  if (dirty.body) {
    // NOT trimmed to null when empty: an RFC with a title and no body yet is a
    // normal first draft, and the API's default for body is '' rather than null.
    patch.body = values.body;
  }
  if (dirty.status) {
    patch.status = values.status;
  }
  if (dirty.project_id) {
    // The empty option means "not tied to a project", which is a null and not a
    // blank string - stored as '' it would group under a project heading with no
    // name and stop matching any project filter.
    patch.project_id = values.project_id || null;
  }
  if (dirty.owner_email) {
    patch.owner_email = values.owner_email.trim() || null;
  }
  if (dirty.decided_on) {
    patch.decided_on = values.decided_on || null;
  }
  if (dirty.skills) {
    // Always sent whole. Skills are a set rather than a field with a value, so there
    // is no "cleared versus untouched" distinction to preserve - an empty array means
    // "tagged with nothing", which is a real and storable answer.
    patch.skills = values.skills ?? [];
  }
  return patch;
}

/*
  The skill picker: checkboxes drawn as chips.

  Real checkboxes rather than buttons with state, because react-hook-form collects a
  group sharing one name into an array for free, and because a checkbox is already
  keyboard-operable and announced correctly. The input is visually hidden rather than
  `display: none` - the latter removes it from the tab order and from the accessibility
  tree, which would leave the chips unreachable without a mouse.
*/
const SkillGrid = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 4px;
`;

const SkillChip = styled.label`
  position: relative;
  display: inline-flex;
  align-items: center;
  padding: 4px 10px;
  border: 1px solid ${palette.border};
  border-radius: ${radius.pill};
  font-size: 12px;
  color: ${palette.inkSoft};
  cursor: pointer;
  user-select: none;

  input {
    position: absolute;
    opacity: 0;
    width: 1px;
    height: 1px;
  }

  &:hover {
    border-color: ${palette.borderStrong};
  }

  &:has(input:checked) {
    background: ${palette.blush};
    border-color: ${palette.deepMagenta};
    color: ${palette.deepMagenta};
    font-weight: 700;
  }

  /* Focus lives on the hidden input, so the ring has to be drawn by the label. */
  &:has(input:focus-visible) {
    outline: 2px solid ${palette.hotPink};
    outline-offset: 2px;
  }
`;

export interface RfcEditorProps {
  /** null to write a new one. */
  rfc: Rfc | null;
  projects: readonly Project[];
  statuses: readonly StatusInfo[];
  /** The skill vocabulary, served rather than hardcoded - see getSkills. */
  skills: readonly SkillInfo[];
  onSaved: (rfc: Rfc) => void;
  onCancel: () => void;
}

export default function RfcEditor({
  rfc,
  projects,
  statuses,
  skills,
  onSaved,
  onCancel,
}: RfcEditorProps) {
  const [error, setError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const {
    register,
    handleSubmit,
    watch,
    formState: { dirtyFields, isSubmitting, isDirty, errors },
  } = useForm<FormValues>({
    defaultValues: {
      title: rfc?.title ?? '',
      project_id: rfc?.project_id ?? '',
      // A new RFC starts as a draft rather than as the first served status, so this
      // does not change meaning if the vocabulary is ever reordered.
      status: rfc?.status ?? 'draft',
      owner_email: rfc?.owner_email ?? '',
      decided_on: rfc?.decided_on ?? '',
      body: rfc?.body ?? '',
      skills: rfc?.skills ?? [],
    },
  });

  // Watched so the preview reflects what is in the box. Only read while previewing,
  // so the markdown is not re-parsed on every keystroke during writing.
  const draftBody = watch('body');

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    try {
      if (!rfc) {
        onSaved(
          await createRfc({
            title: values.title.trim(),
            body: values.body,
            status: values.status,
            project_id: values.project_id || null,
            owner_email: values.owner_email.trim() || null,
            skills: values.skills ?? [],
            decided_on: values.decided_on || null,
          })
        );
        return;
      }
      const patch = buildRfcPatch(values, dirtyFields);
      if (Object.keys(patch).length === 0) {
        onCancel();
        return;
      }
      onSaved(await patchRfc(rfc.item_id, patch));
    } catch (err) {
      setError(describeError(err));
    }
  });

  return (
    <Form onSubmit={onSubmit}>
      <Fields>
        <Label>
          Title
          <Input
            {...register('title', { required: 'An RFC needs a title.', maxLength: 200 })}
            aria-invalid={Boolean(errors.title)}
            placeholder="e.g. How we do code review"
            autoFocus={!rfc}
          />
          {errors.title ? <ErrorText>{errors.title.message}</ErrorText> : null}
        </Label>

        <Label>
          Status
          <Select {...register('status')}>
            {statuses.map((entry) => (
              <option key={entry.status} value={entry.status}>
                {entry.label}
              </option>
            ))}
          </Select>
        </Label>

        <Label>
          Project
          {/* The empty option is first and is not a placeholder - it is a real
              answer, and the commonest one for a decision that cuts across the team.
              A deleted project gets a trailing option naming its id, so the select
              cannot draw blank while the form still holds the dead value; see
              utils/projects.ts. */}
          <Select {...register('project_id')}>
            {projectOptions(projects, rfc?.project_id, 'Not tied to a project').map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </Select>
        </Label>

        <Label>
          Owner
          <Input
            {...register('owner_email', { maxLength: 200 })}
            placeholder="Optional - who is driving it"
          />
        </Label>

        <Label>
          Decided on
          <Input type="date" {...register('decided_on')} />
          <Hint>Blank while it is still open.</Hint>
        </Label>

        <Label as="div">
          <span>Skills</span>
          <SkillGrid>
            {skills.map((entry) => (
              <SkillChip key={entry.skill} title={entry.description}>
                <input type="checkbox" value={entry.skill} {...register('skills')} />
                {entry.label}
              </SkillChip>
            ))}
          </SkillGrid>
          {/* Says what tagging actually causes, because it is not cosmetic: it decides
              who gets named in #request_for_comments once this is open for comment. */}
          <Hint>
            Who should read this. Anyone holding one of these is asked in Slack each
            weekday until they open it, for a working week after it moves to In review.
          </Hint>
        </Label>
      </Fields>

      <div>
        <BodyHead>
          <Label as="div">Body — markdown</Label>
          <Spacer />
          <SecondaryButton type="button" onClick={() => setPreviewing((on) => !on)}>
            {previewing ? 'Back to writing' : 'Preview'}
          </SecondaryButton>
        </BodyHead>

        {previewing ? (
          <Preview>
            <Markdown>{draftBody}</Markdown>
          </Preview>
        ) : (
          <Body
            {...register('body')}
            placeholder={'# Context\n\nWhat is the problem?\n\n# Proposal\n\n# Alternatives'}
            spellCheck
          />
        )}
      </div>

      <Actions>
        {error ? <ErrorText role="alert">{error}</ErrorText> : null}
        <Spacer />
        <SecondaryButton type="button" onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </SecondaryButton>
        {/* `isDirty` gates a no-op edit, never a create - same rule as the other
            editors. A new RFC with a title and an empty body is a normal first
            draft and must be savable. */}
        <PrimaryButton type="submit" disabled={isSubmitting || (rfc !== null && !isDirty)}>
          {isSubmitting ? 'Saving…' : rfc ? 'Save' : 'Create RFC'}
        </PrimaryButton>
      </Actions>
    </Form>
  );
}
