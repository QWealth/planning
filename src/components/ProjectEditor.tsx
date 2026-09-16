/**
 * Add a project lane, or edit one: name, DRI, support, ordering, active.
 *
 * One component for both, on the same reasoning as PersonEditor - the two forms
 * differ by one checkbox and by how the body is assembled, and splitting them would
 * duplicate the roster dropdown twice over.
 *
 * The two bodies are assembled differently and the difference is not an oversight.
 * Editing sends only what changed, because a stored row exists and everything absent
 * from the patch must be left alone; see PhaseEditor's header for what goes wrong
 * otherwise. Creating sends the whole form, because there is nothing to leave alone -
 * an omitted field takes the server's default, and every default is the honest one.
 *
 * DRI and Support are the two fields the workbook never had filled in. Eighteen
 * owner slots came across the migration null, because the name-per-project mapping
 * has never existed anywhere, and they were deliberately NOT guessed at load time.
 * This form is how they get filled in, one honest answer at a time, which is why the
 * roster dropdown offers "Unassigned" as a first-class choice rather than defaulting
 * to whoever happens to be first alphabetically.
 */

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import styled from 'styled-components';

import { createProject, describeError, patchProject } from '../services/api';
import { palette } from '../styles/theme';
import { ErrorText, Hint, Input, Label, PrimaryButton, SecondaryButton, Select } from '../styles/ui';
import type { PhaseCreate, Person, Project, ProjectPatch } from '../types';

interface FormValues {
  name: string;
  category: string;
  dri_email: string;
  support_email: string;
  active: boolean;
  /** Create only: seed the lane with the standard phases. See STANDARD_PHASES. */
  seed: boolean;
}

/**
 * The six rows every project in the workbook had.
 *
 * Not an invention: six of the nine migrated lanes carry exactly this list in exactly
 * this order, and a seventh differs only by having no Wireframes row. Offering it as
 * a tick-box means a new lane arrives with the structure everyone already reads,
 * rather than empty and needing six trips through the phase form before the chart can
 * say anything about it.
 *
 * They are created with no dates and no progress, which is the point - the shape is
 * known, the schedule is not, and seeding invented dates is how the workbook filled up
 * with numbers nobody believed. Maintenance goes in structural, so it draws as an
 * ongoing-support band and is excluded from the completeness denominator rather than
 * being reported as six missing fields on day one.
 */
export const STANDARD_PHASES: readonly { name: string; structural: boolean }[] = [
  { name: 'Planning', structural: false },
  { name: 'Wireframes', structural: false },
  { name: 'Architecting', structural: false },
  { name: 'Coding', structural: false },
  { name: 'Testing', structural: false },
  { name: 'Maintenance', structural: true },
];

function seedPhases(): PhaseCreate[] {
  return STANDARD_PHASES.map((phase, index) => ({
    name: phase.name,
    phase_order: index,
    structural: phase.structural,
  }));
}

const Form = styled.form`
  display: grid;
  grid-template-columns: minmax(180px, 1.4fr) minmax(160px, 1fr) minmax(160px, 1fr);
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

export function buildProjectPatch(
  values: FormValues,
  dirty: Partial<Record<keyof FormValues, boolean>>
): ProjectPatch {
  const patch: ProjectPatch = {};
  if (dirty.name) {
    patch.name = values.name.trim();
  }
  if (dirty.dri_email) {
    // The backend lowercases and turns '' into a real null, but doing it here too
    // means the value posted matches the value that comes back, so the lane does not
    // flicker from "Joe@..." to "joe@..." after a save.
    patch.dri_email = values.dri_email.trim().toLowerCase() || null;
  }
  if (dirty.support_email) {
    patch.support_email = values.support_email.trim().toLowerCase() || null;
  }
  if (dirty.active) {
    patch.active = values.active;
  }
  if (dirty.category) {
    // Trimmed here as well as on the server, so the value posted matches the value
    // that comes back and the group heading does not shift after a save. Empty string
    // rather than undefined: it has to reach the API, which turns it into a real null.
    patch.category = values.category.trim();
  }
  return patch;
}

/**
 * Two modes, and the callback differs between them because the API's answer does.
 *
 * PATCH returns ProjectOut, which has no phases, so an edit can only ever report the
 * patch and let the caller merge it field by field - see services/api.ts. POST returns
 * ProjectDetail, so a create hands back a whole lane ready to append. Expressing that
 * as a union rather than two optional callbacks makes using the wrong one a compile
 * error instead of a lane that quietly empties itself.
 */
export type ProjectEditorProps = {
  people: Person[];
  /**
   * Every category already in use on the roadmap, for the datalist below.
   *
   * Passed in rather than fetched, because the caller already has every project and a
   * second request to learn something it is holding would be a round trip for nothing.
   * Optional so the component still renders for a caller that has not got them yet.
   */
  categories?: string[];
  onCancel: () => void;
} & (
  | {
      project: Project;
      onSaved: (patch: ProjectPatch) => void;
      nextLaneOrder?: never;
      onCreated?: never;
    }
  | {
      project: null;
      /** Where the new lane sits in the row order - the API defaults it to 0. */
      nextLaneOrder: number;
      onCreated: (project: Project) => void;
      onSaved?: never;
    }
);

/** The roster dropdown, shared by both owner fields. */
function OwnerOptions({ people, current }: { people: Person[]; current: string | null }) {
  const known = people.some((p) => p.email === current);
  return (
    <>
      <option value="">Unassigned</option>
      {!known && current ? <option value={current}>{current} (not on the roster)</option> : null}
      {people.map((person) => (
        <option key={person.email} value={person.email}>
          {person.name}
          {person.active ? '' : ' (inactive)'}
        </option>
      ))}
    </>
  );
}

export default function ProjectEditor(props: ProjectEditorProps) {
  const { project, people, categories = [], onCancel } = props;
  const [error, setError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    formState: { dirtyFields, isSubmitting, isDirty, errors },
  } = useForm<FormValues>({
    defaultValues: {
      name: project?.name ?? '',
      category: project?.category ?? '',
      dri_email: project?.dri_email ?? '',
      support_email: project?.support_email ?? '',
      active: project?.active ?? true,
      seed: true,
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    setError(null);
    try {
      if (!project) {
        props.onCreated(
          await createProject({
            name: values.name.trim(),
            category: values.category.trim() || null,
            lane_order: props.nextLaneOrder,
            dri_email: values.dri_email.trim().toLowerCase() || null,
            support_email: values.support_email.trim().toLowerCase() || null,
            active: true,
            phases: values.seed ? seedPhases() : [],
          })
        );
        return;
      }

      const patch = buildProjectPatch(values, dirtyFields);
      if (Object.keys(patch).length === 0) {
        onCancel();
        return;
      }
      await patchProject(project.project_id, patch);
      // Merged field by field by the caller rather than replaced wholesale: the
      // PATCH response is ProjectOut and has no `phases`, so assigning it over the
      // lane would empty it. See services/api.ts.
      props.onSaved(patch);
    } catch (err) {
      setError(describeError(err));
    }
  });

  return (
    <Form onSubmit={onSubmit}>
      <Label>
        Project name
        <Input
          {...register('name', { required: 'A project needs a name.', maxLength: 200 })}
          aria-invalid={Boolean(errors.name)}
          placeholder={project ? undefined : 'e.g. Client Portal'}
          // Focused on create only. Auto-focusing the edit form would steal the
          // caret every time somebody opened a lane to read who the DRI is.
          autoFocus={!project}
        />
      </Label>

      {/*
        The category, as a text input with a datalist rather than a <select>.

        A select would need a closed list, and nobody can write that list from here -
        see the note on `category` in types.ts. An input alone would give "Data",
        "data" and "DATA" as three headings within a week. The datalist is the middle:
        typing offers what is already in use, so the second project reuses the first's
        spelling, and a genuinely new category is still one you can just type.

        No `required`. A project nobody has filed is a real state and the roadmap has
        a place for it - see UNGROUPED in utils/laneView.ts.
      */}
      <Label>
        Category
        <Input
          {...register('category', { maxLength: 40 })}
          list="project-categories"
          placeholder="e.g. App, Data, QC"
          autoComplete="off"
        />
        <datalist id="project-categories">
          {categories.map((category) => (
            <option key={category} value={category} />
          ))}
        </datalist>
      </Label>
      <Hint>Groups this lane with others like it on the roadmap. Leave it blank to file it later.</Hint>

      <Label>
        DRI
        <Select {...register('dri_email')}>
          <OwnerOptions people={people} current={project?.dri_email ?? null} />
        </Select>
        <Hint>Directly responsible individual.</Hint>
      </Label>

      <Label>
        Support
        <Select {...register('support_email')}>
          <OwnerOptions people={people} current={project?.support_email ?? null} />
        </Select>
      </Label>

      <Actions>
        {project ? (
          <>
            <CheckLabel>
              <input type="checkbox" {...register('active')} />
              Active on the roadmap
            </CheckLabel>
            <Hint>Unticking hides the lane. Nothing is deleted.</Hint>
          </>
        ) : (
          <>
            <CheckLabel>
              <input type="checkbox" {...register('seed')} />
              Start with the standard phases
            </CheckLabel>
            {/* Named in full rather than left as "the standard phases", because the
                tick-box is ticked by default and somebody should be able to untick it
                knowing exactly what they are declining. */}
            <Hint>
              Planning, Wireframes, Architecting, Coding, Testing and a Maintenance band -
              no dates, ready to fill in.
            </Hint>
          </>
        )}
        <Spacer />
        {errors.name ? <ErrorText>{errors.name.message}</ErrorText> : null}
        {error ? <ErrorText role="alert">{error}</ErrorText> : null}
        <SecondaryButton type="button" onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </SecondaryButton>
        {/* `isDirty` gates saving an edit that changed nothing, but must NOT gate a
            create: the form starts pristine and a lane named from the placeholder is
            still a lane somebody wants. Required-field validation catches the empty
            case instead. */}
        <PrimaryButton type="submit" disabled={isSubmitting || (project !== null && !isDirty)}>
          {isSubmitting ? 'Saving…' : project ? 'Save project' : 'Create project'}
        </PrimaryButton>
      </Actions>
    </Form>
  );
}
