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
import type { Project, Rfc, RfcPatch, StatusInfo } from '../types';
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
  dirty: Partial<Record<keyof FormValues, boolean>>
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
  return patch;
}

export interface RfcEditorProps {
  /** null to write a new one. */
  rfc: Rfc | null;
  projects: readonly Project[];
  statuses: readonly StatusInfo[];
  onSaved: (rfc: Rfc) => void;
  onCancel: () => void;
}

export default function RfcEditor({ rfc, projects, statuses, onSaved, onCancel }: RfcEditorProps) {
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
