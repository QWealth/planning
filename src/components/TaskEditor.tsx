/**
 * Write a task, or edit one.
 *
 * One component for both, and one component for tickets and subtasks alike, because
 * they are the same entity - see types.ts. The only thing that makes a row a subtask
 * is the Belongs-to select below having something in it.
 *
 *   CREATE sends everything. There is no stored row to leave alone, so every omitted
 *   field would take the server's default, and the defaults are the honest ones.
 *
 *   EDIT sends only the fields actually touched, built from React Hook Form's
 *   `dirtyFields`. This matters more here than it does for an RFC, because of what
 *   `parent_id` means.
 *
 * WHY `parent_id` MAKES dirtyFields NON-OPTIONAL
 * ----------------------------------------------
 * `parent_id: null` PROMOTES a subtask to a top-level ticket. It is a real edit and
 * the form must be able to make it - "this turned out to be its own piece of work" is
 * a thing that happens weekly. But it is one keystroke from `parent_id` absent, which
 * means "leave it where it is".
 *
 * A form that sent all its values on every save would therefore send `parent_id: null`
 * every time somebody fixed a typo in a subtask's title, and each individual edit
 * would look perfectly correct while the backlog quietly flattened over a week.
 * buildTaskPatch is where the two are kept apart, and it is exported so it can be read
 * on its own.
 *
 * THE BODY IS A PLAIN TEXTAREA, NOT MARKDOWN
 * ------------------------------------------
 * Deliberately, and it is the difference between this feature and the RFC one. A task
 * is a line with a note attached - the acceptance criteria, the link to the thread,
 * the name of the file. The thing you write paragraphs in is an RFC, and blurring the
 * two would leave decisions buried in a backlog row that nobody reads twice.
 */

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import styled from 'styled-components';

import { createTask, describeError, patchTask } from '../services/api';
import { field } from '../styles/theme';
import {
  ErrorText,
  Hint,
  Input,
  Label,
  PrimaryButton,
  SecondaryButton,
  Select,
} from '../styles/ui';
import type { Project, StatusInfo, Task, TaskPatch } from '../types';
import { projectOptions } from '../utils/projects';
import { eligibleParents } from '../utils/tasks';

interface FormValues {
  title: string;
  /** '' means "not tied to a project", and is stored as null. */
  project_id: string;
  phase_id: string;
  /** '' means "a ticket in its own right", and is stored as null. */
  parent_id: string;
  status: string;
  owner_email: string;
  /** `YYYY-MM-DD`, or '' for "no committed date". '' is the null. */
  due: string;
  body: string;
}

const Form = styled.form`
  display: flex;
  flex-direction: column;
  gap: 14px;
`;

const Fields = styled.div`
  display: grid;
  grid-template-columns: minmax(220px, 2fr) minmax(150px, 1fr) minmax(150px, 1fr);
  gap: 12px 14px;
  align-items: start;
`;

/*
  Short by design. A task note is a few lines; a box the size of the RFC editor's
  would invite the paragraphs that belong in an RFC, and the shape of the field is
  the only thing telling anybody which of the two they are supposed to be writing.
*/
const Body = styled.textarea`
  ${field};
  line-height: 1.55;
  min-height: 90px;
  resize: vertical;
  width: 100%;
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
 * one place where "the author moved this out of its ticket" and "the author never
 * went near the Belongs-to box" are turned into two different requests.
 */
export function buildTaskPatch(
  values: FormValues,
  dirty: Partial<Record<keyof FormValues, boolean>>
): TaskPatch {
  const patch: TaskPatch = {};
  if (dirty.title) {
    patch.title = values.title.trim();
  }
  if (dirty.body) {
    // Not turned into null when empty: most tasks are a title and nothing else, and
    // the API's default for body is '' rather than null.
    patch.body = values.body;
  }
  if (dirty.status) {
    patch.status = values.status;
  }
  if (dirty.project_id) {
    patch.project_id = values.project_id || null;
    /*
      A project change always carries the phase with it, whether or not the phase field
      was touched.

      The API refuses a phase_id belonging to a different project, so a patch that moved
      only the project would be rejected outright - correctly, but the person did not do
      anything wrong. Sending the phase alongside makes the two fields move together,
      which is what choosing a different project in this form actually means. The select
      below resets to blank on that change, so unless they then picked one, this is null.
    */
    patch.phase_id = values.phase_id || null;
  }
  if (dirty.phase_id && !dirty.project_id) {
    patch.phase_id = values.phase_id || null;
  }
  if (dirty.parent_id) {
    // The empty option is a PROMOTION, not a blank. Sent as '' the backend would look
    // for a ticket whose id is the empty string and reject the whole edit with a 400.
    patch.parent_id = values.parent_id || null;
  }
  if (dirty.owner_email) {
    patch.owner_email = values.owner_email.trim() || null;
  }
  if (dirty.due) {
    patch.due = values.due || null;
  }
  return patch;
}

export interface TaskEditorProps {
  /** null to write a new one. */
  task: Task | null;
  /**
   * Every task in hand, used only to work out what may be selected in Belongs-to.
   * The one-level cap is enforced by the backend either way; this exists so the
   * select does not offer a choice that is going to come back as a 400.
   */
  allTasks: readonly Task[];
  /** Preselected parent for a new subtask, when created from a ticket's own page. */
  defaultParentId?: string | null;
  /** Preselected project for a new task, when created with a project filter on. */
  defaultProjectId?: string | null;
  projects: readonly Project[];
  statuses: readonly StatusInfo[];
  onSaved: (task: Task) => void;
  onCancel: () => void;
}

export default function TaskEditor({
  task,
  allTasks,
  defaultParentId,
  defaultProjectId,
  projects,
  statuses,
  onSaved,
  onCancel,
}: TaskEditorProps) {
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { dirtyFields, isSubmitting, isDirty, errors },
  } = useForm<FormValues>({
    defaultValues: {
      title: task?.title ?? '',
      project_id: task?.project_id ?? defaultProjectId ?? '',
      phase_id: task?.phase_id ?? '',
      parent_id: task?.parent_id ?? defaultParentId ?? '',
      // A new task starts in the backlog rather than at the first served status, so
      // this does not change meaning if the vocabulary is ever reordered.
      status: task?.status ?? 'backlog',
      owner_email: task?.owner_email ?? '',
      due: task?.due ?? '',
      body: task?.body ?? '',
    },
  });

  /*
    What may legally go in Belongs-to. Excludes subtasks (the cap is one level),
    excludes this task itself, and is EMPTY when this task already has subtasks of
    its own - a ticket with children cannot become a child. In that last case the
    select below says so instead of rendering an empty dropdown, because a select
    with nothing in it looks like a list that failed to load.
  */
  const parents = eligibleParents(allTasks, task);
  const hasChildren = task !== null && allTasks.some((other) => other.parent_id === task.item_id);

  /*
    Built against the value the form is actually holding, so a task filed under a
    project that has since been deleted shows "Unknown project (id)" rather than
    drawing an empty select while quietly keeping the dead id. See utils/projects.ts -
    that mismatch is invisible on screen and only shows up in the request body.
  */
  const projectChoices = projectOptions(
    projects,
    task?.project_id ?? defaultProjectId,
    'Not tied to a project'
  );

  /*
    The project the form is CURRENTLY holding, not the one the task was loaded with,
    so the phase list follows the project select as it changes rather than a render
    behind it.
  */
  const chosenProjectId = watch('project_id');
  const chosenProject = projects.find((p) => p.project_id === chosenProjectId) ?? null;
  const phaseChoices = chosenProject
    ? [...chosenProject.phases].sort((a, b) => a.phase_order - b.phase_order)
    : [];

  /*
    Picking a different project clears the phase. The old phase belongs to the old
    project and the API would refuse it, so leaving it selected would make the form
    hold a value that cannot be saved and say nothing about why.
  */
  useEffect(() => {
    if (chosenProjectId !== (task?.project_id ?? defaultProjectId ?? '')) {
      setValue('phase_id', '', { shouldDirty: true });
    }
    // Only when the project moves. Including setValue would re-run this on every
    // render of a form whose project has not changed, wiping a phase mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosenProjectId]);

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    try {
      if (!task) {
        onSaved(
          await createTask({
            title: values.title.trim(),
            body: values.body,
            status: values.status,
            project_id: values.project_id || null,
            phase_id: values.phase_id || null,
            parent_id: values.parent_id || null,
            owner_email: values.owner_email.trim() || null,
            due: values.due || null,
          })
        );
        return;
      }
      const patch = buildTaskPatch(values, dirtyFields);
      if (Object.keys(patch).length === 0) {
        onCancel();
        return;
      }
      onSaved(await patchTask(task.item_id, patch));
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
            {...register('title', { required: 'A task needs a title.', maxLength: 200 })}
            aria-invalid={Boolean(errors.title)}
            placeholder="e.g. Write the migration"
            autoFocus={!task}
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
          Due
          <Input type="date" {...register('due')} />
          <Hint>Blank is normal.</Hint>
        </Label>

        <Label>
          Belongs to
          {hasChildren ? (
            <>
              {/* Disabled rather than absent, so the field does not vanish between
                  one task and the next and leave the reader wondering where it
                  went. The reason is stated underneath rather than left to be
                  discovered by a rejected save. */}
              <Select disabled>
                <option>A ticket of its own</option>
              </Select>
              <Hint>This has subtasks, so it cannot itself become one.</Hint>
            </>
          ) : (
            <>
              <Select {...register('parent_id')}>
                {/* First, and a real answer rather than a placeholder: most work is
                    a ticket in its own right. */}
                <option value="">A ticket of its own</option>
                {parents.map((other) => (
                  <option key={other.item_id} value={other.item_id}>
                    {other.title}
                  </option>
                ))}
              </Select>
              <Hint>Subtasks go one level deep, no further.</Hint>
            </>
          )}
        </Label>

        <Label>
          Project
          <Select {...register('project_id')}>
            {projectChoices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </Select>
        </Label>

        {/*
          The phase, and only once a project has been chosen.

          A phase belongs to a project, so offering this first would be a dropdown whose
          contents depend on a field below it - and the API refuses the pair where one is
          set and the other is not. Absent rather than disabled when there is no project:
          a disabled control implies something you could enable here, and the thing to do
          is pick a project, which is the field immediately above.

          "The whole project" is a real first answer rather than a placeholder. Most
          tasks are not about one phase, and every one of the 287 that came across the
          migration is in exactly that state.
        */}
        {chosenProject ? (
          <Label>
            Phase
            <Select {...register('phase_id')}>
              <option value="">The whole project</option>
              {/* A phase that has since been deleted is offered back rather than
                  silently dropped by a select that cannot represent it - the same
                  guard projectOptions makes one field up. */}
              {task?.phase_id && !phaseChoices.some((p) => p.phase_id === task.phase_id) ? (
                <option value={task.phase_id}>Unknown phase ({task.phase_id})</option>
              ) : null}
              {phaseChoices.map((phase) => (
                <option key={phase.phase_id} value={phase.phase_id}>
                  {phase.name}
                </option>
              ))}
            </Select>
            <Hint>Shows this task under that phase when the lane is expanded.</Hint>
          </Label>
        ) : null}

        <Label>
          Owner
          <Input
            {...register('owner_email', { maxLength: 200 })}
            placeholder="Optional - who is doing it"
          />
        </Label>
      </Fields>

      <Label>
        Notes
        <Body
          {...register('body')}
          placeholder="Acceptance criteria, a link to the thread, anything the title cannot hold."
          spellCheck
        />
      </Label>

      <Actions>
        {error ? <ErrorText role="alert">{error}</ErrorText> : null}
        <Spacer />
        <SecondaryButton type="button" onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </SecondaryButton>
        {/* `isDirty` gates a no-op edit, never a create - a new task with a title and
            nothing else is the normal case and must be savable in one keystroke. */}
        <PrimaryButton type="submit" disabled={isSubmitting || (task !== null && !isDirty)}>
          {isSubmitting ? 'Saving…' : task ? 'Save' : 'Add task'}
        </PrimaryButton>
      </Actions>
    </Form>
  );
}
