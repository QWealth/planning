import { describe, expect, it } from 'vitest';

import type { Project } from '../types';
import {
  isResponsibleFor,
  projectOptions,
  resolveProjectName,
  responsibleProjectIds,
  unknownProjectLabel,
} from './projects';

const PROJECTS: Project[] = [
  { project_id: 'p1', name: 'QWAPP' } as Project,
  { project_id: 'p2', name: 'Tax' } as Project,
];

describe('unknownProjectLabel', () => {
  it('names the id so the row is not blank', () => {
    expect(unknownProjectLabel('gone')).toBe('Unknown project (gone)');
  });
});

describe('resolveProjectName', () => {
  it('resolves a live project', () => {
    expect(resolveProjectName('p2', PROJECTS)).toBe('Tax');
  });

  it('is null for work attached to nothing', () => {
    expect(resolveProjectName(null, PROJECTS)).toBeNull();
    expect(resolveProjectName(undefined, PROJECTS)).toBeNull();
  });

  /* '' reaches here from a form field, and means the same as null. */
  it('treats an empty string as attached to nothing', () => {
    expect(resolveProjectName('', PROJECTS)).toBeNull();
  });

  it('names a deleted project by its id rather than returning null', () => {
    expect(resolveProjectName('gone', PROJECTS)).toBe('Unknown project (gone)');
  });
});

describe('projectOptions', () => {
  it('puts the unattached answer first, labelled', () => {
    const options = projectOptions(PROJECTS, null, 'Not tied to a project');
    expect(options[0]).toEqual({ value: '', label: 'Not tied to a project' });
  });

  it('offers every project, in the order given', () => {
    const options = projectOptions(PROJECTS, null, 'None');
    expect(options.map((o) => o.label)).toEqual(['None', 'QWAPP', 'Tax']);
  });

  it('adds nothing extra when the current value is a live project', () => {
    expect(projectOptions(PROJECTS, 'p1', 'None')).toHaveLength(3);
  });

  it('adds nothing extra for unattached work', () => {
    expect(projectOptions(PROJECTS, '', 'None')).toHaveLength(3);
    expect(projectOptions(PROJECTS, null, 'None')).toHaveLength(3);
  });

  /*
    The one that stops a select drawing empty while the form still holds a dead id.
    Without this option the select reports selectedIndex -1 and renders blank, and
    React Hook Form submits the stale value anyway.
  */
  it('adds a trailing option for a project that no longer exists', () => {
    const options = projectOptions(PROJECTS, 'gone', 'None');
    expect(options).toHaveLength(4);
    expect(options[3]).toEqual({ value: 'gone', label: 'Unknown project (gone)' });
  });

  it('keeps the dead id last, where it will not be picked by accident', () => {
    const options = projectOptions(PROJECTS, 'gone', 'None');
    expect(options[options.length - 1].value).toBe('gone');
  });

  it('always contains an option matching the current value', () => {
    for (const current of [null, '', 'p1', 'p2', 'gone']) {
      const options = projectOptions(PROJECTS, current, 'None');
      expect(options.some((o) => o.value === (current ?? ''))).toBe(true);
    }
  });
});

/* Only the two role fields matter here, so only they are filled in. */
function owned(over: Partial<Project>): Project {
  return { project_id: 'px', name: 'Px', dri_email: null, support_email: null, ...over } as Project;
}

describe('isResponsibleFor', () => {
  it('counts the DRI', () => {
    expect(isResponsibleFor(owned({ dri_email: 'ha@x.test' }), 'ha@x.test')).toBe(true);
  });

  /* The decision this function exists to encode: Support is not a spectator. */
  it('counts Support too', () => {
    expect(isResponsibleFor(owned({ support_email: 'ha@x.test' }), 'ha@x.test')).toBe(true);
  });

  it('is false for somebody named on neither', () => {
    const project = owned({ dri_email: 'ha@x.test', support_email: 'mo@x.test' });
    expect(isResponsibleFor(project, 'other@x.test')).toBe(false);
  });

  it('matches regardless of case, because these are addresses', () => {
    expect(isResponsibleFor(owned({ dri_email: 'Ha@X.Test' }), 'ha@x.test')).toBe(true);
    expect(isResponsibleFor(owned({ dri_email: 'ha@x.test' }), 'HA@X.TEST')).toBe(true);
  });

  /*
    The one that would silently open every unowned lane for every signed-out viewer:
    an unfilled DRI field and an unknown viewer must not match each other.
  */
  it('never matches nobody against nobody', () => {
    expect(isResponsibleFor(owned({}), null)).toBe(false);
    expect(isResponsibleFor(owned({}), undefined)).toBe(false);
    expect(isResponsibleFor(owned({}), '')).toBe(false);
    expect(isResponsibleFor(owned({ dri_email: 'ha@x.test' }), null)).toBe(false);
  });

  /* Owning a phase inside the lane is a different question - see the docstring. */
  it('says nothing about phase ownership', () => {
    const project = {
      ...owned({}),
      phases: [{ phase_id: 'f1', owner_email: 'ha@x.test' }],
    } as unknown as Project;
    expect(isResponsibleFor(project, 'ha@x.test')).toBe(false);
  });
});

describe('responsibleProjectIds', () => {
  const ROSTERED: Project[] = [
    owned({ project_id: 'p1', dri_email: 'ha@x.test' }),
    owned({ project_id: 'p2', support_email: 'HA@x.test' }),
    owned({ project_id: 'p3', dri_email: 'mo@x.test', support_email: 'jo@x.test' }),
    owned({ project_id: 'p4' }),
  ];

  it('collects both roles, case-insensitively', () => {
    expect([...responsibleProjectIds(ROSTERED, 'ha@x.test')].sort()).toEqual(['p1', 'p2']);
  });

  it('is empty for somebody on nothing, and for nobody', () => {
    expect(responsibleProjectIds(ROSTERED, 'new@x.test').size).toBe(0);
    expect(responsibleProjectIds(ROSTERED, null).size).toBe(0);
  });

  it('does not claim the unowned lane for anyone', () => {
    for (const email of ['ha@x.test', 'mo@x.test', 'jo@x.test']) {
      expect(responsibleProjectIds(ROSTERED, email).has('p4')).toBe(false);
    }
  });
});
