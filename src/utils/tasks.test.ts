import { describe, expect, it } from 'vitest';

import type { Project, StatusInfo, Task } from '../types';
import {
  decorate,
  defaultOpenGroups,
  eligibleParents,
  filterTasks,
  groupKey,
  groupTasks,
  isOverdue,
  subtasksOf,
  tasksToAssign,
  toColumns,
  todayISO,
  visibleColumns,
} from './tasks';

/* The real vocabulary, in the order /api/tasks/statuses serves it. */
const STATUSES: StatusInfo[] = [
  { status: 'backlog', label: 'Backlog', description: 'Captured.', closed: false },
  { status: 'next', label: 'Next', description: 'Queued up.', closed: false },
  { status: 'in-progress', label: 'In progress', description: 'On it.', closed: false },
  { status: 'done', label: 'Done', description: 'Finished.', closed: true },
  { status: 'dropped', label: 'Dropped', description: 'Decided against.', closed: true },
];

let counter = 0;
function task(over: Partial<Task> = {}): Task {
  counter += 1;
  return {
    item_id: `task_${counter}`,
    kind: 'task',
    title: `Task ${counter}`,
    body: '',
    status: 'backlog',
    project_id: null,
    parent_id: null,
    owner_email: null,
    due: null,
    task_order: 0,
    created_by: null,
    created_at: `2026-01-${`${counter}`.padStart(2, '0')}T00:00:00`,
    updated_at: null,
    ...over,
  };
}

const PROJECTS: Project[] = [
  { project_id: 'p1', name: 'QWAPP' } as Project,
  { project_id: 'p2', name: 'Tax' } as Project,
];

describe('toColumns', () => {
  it('emits one column per served status, in the vocabulary order', () => {
    const columns = toColumns([], STATUSES);
    expect(columns.map((c) => c.status)).toEqual([
      'backlog',
      'next',
      'in-progress',
      'done',
      'dropped',
    ]);
  });

  it('keeps empty columns rather than dropping them', () => {
    const columns = toColumns([task({ status: 'next' })], STATUSES);
    expect(columns).toHaveLength(5);
    expect(columns.find((c) => c.status === 'backlog')?.tasks).toEqual([]);
  });

  it('labels columns from the catalogue, not from the stored value', () => {
    const columns = toColumns([], STATUSES);
    expect(columns.find((c) => c.status === 'in-progress')?.label).toBe('In progress');
  });

  it('carries the closed flag through from the vocabulary', () => {
    const columns = toColumns([], STATUSES);
    const closed = columns.filter((c) => c.closed).map((c) => c.status);
    expect(closed).toEqual(['done', 'dropped']);
  });

  /* The one that fails silently: a status this build has never heard of. */
  it('puts an unknown status in its own trailing column instead of dropping it', () => {
    const odd = task({ status: 'blocked' });
    const columns = toColumns([odd], STATUSES);
    expect(columns).toHaveLength(6);
    expect(columns[5]).toMatchObject({ status: 'blocked', label: 'blocked', closed: false });
    expect(columns[5].tasks).toEqual([odd]);
  });

  it('never loses a task', () => {
    const tasks = [task(), task({ status: 'done' }), task({ status: 'mystery' })];
    const seen = toColumns(tasks, STATUSES).flatMap((c) => c.tasks);
    expect(seen).toHaveLength(3);
  });

  it('preserves input order within a column', () => {
    const a = task({ status: 'next', title: 'first' });
    const b = task({ status: 'next', title: 'second' });
    const columns = toColumns([a, b], STATUSES);
    expect(columns.find((c) => c.status === 'next')?.tasks.map((t) => t.title)).toEqual([
      'first',
      'second',
    ]);
  });
});

describe('decorate', () => {
  it('names a subtask with its parent title', () => {
    const ticket = task({ title: 'Ship the board' });
    const child = task({ parent_id: ticket.item_id });
    const rows = decorate([ticket, child], PROJECTS, STATUSES);
    expect(rows.get(child.item_id)?.parentTitle).toBe('Ship the board');
    expect(rows.get(ticket.item_id)?.parentTitle).toBeNull();
  });

  it('counts subtasks and how many are closed', () => {
    const ticket = task();
    const rows = decorate(
      [
        ticket,
        task({ parent_id: ticket.item_id, status: 'done' }),
        task({ parent_id: ticket.item_id, status: 'dropped' }),
        task({ parent_id: ticket.item_id, status: 'next' }),
      ],
      PROJECTS,
      STATUSES
    );
    expect(rows.get(ticket.item_id)).toMatchObject({ subtaskCount: 3, subtasksClosed: 2 });
  });

  it('resolves the project name', () => {
    const t = task({ project_id: 'p2' });
    expect(decorate([t], PROJECTS, STATUSES).get(t.item_id)?.projectName).toBe('Tax');
  });

  it('leaves an unattached task with no project name', () => {
    const t = task();
    expect(decorate([t], PROJECTS, STATUSES).get(t.item_id)?.projectName).toBeNull();
  });

  it('names a deleted project by its id rather than rendering nothing', () => {
    const t = task({ project_id: 'gone' });
    expect(decorate([t], PROJECTS, STATUSES).get(t.item_id)?.projectName).toBe(
      'Unknown project (gone)'
    );
  });

  /* Stale list: the parent was deleted, so the server has already promoted this. */
  it('keeps a subtask whose parent is missing, as a top-level row', () => {
    const orphan = task({ parent_id: 'task_gone' });
    const rows = decorate([orphan], PROJECTS, STATUSES);
    expect(rows.size).toBe(1);
    expect(rows.get(orphan.item_id)?.parentTitle).toBeNull();
  });
});

describe('filterTasks', () => {
  it('hides closed tasks by default', () => {
    const tasks = [task(), task({ status: 'done' }), task({ status: 'dropped' })];
    expect(filterTasks(tasks, STATUSES, { showClosed: false })).toHaveLength(1);
  });

  it('shows them when asked', () => {
    const tasks = [task(), task({ status: 'done' })];
    expect(filterTasks(tasks, STATUSES, { showClosed: true })).toHaveLength(2);
  });

  it('treats an unknown status as open', () => {
    const tasks = [task({ status: 'blocked' })];
    expect(filterTasks(tasks, STATUSES, { showClosed: false })).toHaveLength(1);
  });

  it('filters to one project', () => {
    const tasks = [task({ project_id: 'p1' }), task({ project_id: 'p2' }), task()];
    const got = filterTasks(tasks, STATUSES, { showClosed: true, projectId: 'p1' });
    expect(got.map((t) => t.project_id)).toEqual(['p1']);
  });

  /* null is a real answer and must not collapse into "no filter". */
  it('filters to the unattached ones when projectId is null', () => {
    const tasks = [task({ project_id: 'p1' }), task(), task()];
    const got = filterTasks(tasks, STATUSES, { showClosed: true, projectId: null });
    expect(got).toHaveLength(2);
    expect(got.every((t) => t.project_id === null)).toBe(true);
  });

  it('applies no project filter when projectId is undefined', () => {
    const tasks = [task({ project_id: 'p1' }), task()];
    expect(filterTasks(tasks, STATUSES, { showClosed: true })).toHaveLength(2);
  });

  it('filters by owner', () => {
    const tasks = [task({ owner_email: 'a@x.invalid' }), task({ owner_email: 'b@x.invalid' })];
    const got = filterTasks(tasks, STATUSES, { showClosed: true, ownerEmail: 'a@x.invalid' });
    expect(got.map((t) => t.owner_email)).toEqual(['a@x.invalid']);
  });

  it('combines the filters', () => {
    const tasks = [
      task({ project_id: 'p1', owner_email: 'a@x.invalid' }),
      task({ project_id: 'p1', owner_email: 'b@x.invalid' }),
      task({ project_id: 'p1', owner_email: 'a@x.invalid', status: 'done' }),
    ];
    const got = filterTasks(tasks, STATUSES, {
      showClosed: false,
      projectId: 'p1',
      ownerEmail: 'a@x.invalid',
    });
    expect(got).toHaveLength(1);
  });
});

describe('subtasksOf', () => {
  it('returns only that ticket’s children', () => {
    const a = task();
    const b = task();
    const tasks = [a, b, task({ parent_id: a.item_id }), task({ parent_id: b.item_id })];
    expect(subtasksOf(tasks, a.item_id)).toHaveLength(1);
  });

  it('sorts by task_order, not by status', () => {
    const parent = task();
    const tasks = [
      parent,
      task({ parent_id: parent.item_id, task_order: 2, title: 'second', status: 'done' }),
      task({ parent_id: parent.item_id, task_order: 1, title: 'first', status: 'backlog' }),
    ];
    expect(subtasksOf(tasks, parent.item_id).map((t) => t.title)).toEqual(['first', 'second']);
  });

  it('falls back to creation order when task_order ties', () => {
    const parent = task();
    const older = task({ parent_id: parent.item_id, created_at: '2026-01-01T00:00:00' });
    const newer = task({ parent_id: parent.item_id, created_at: '2026-06-01T00:00:00' });
    expect(subtasksOf([parent, newer, older], parent.item_id).map((t) => t.item_id)).toEqual([
      older.item_id,
      newer.item_id,
    ]);
  });

  it('is empty for a ticket with no subtasks', () => {
    const t = task();
    expect(subtasksOf([t], t.item_id)).toEqual([]);
  });
});

describe('eligibleParents', () => {
  it('offers top-level tickets', () => {
    const a = task();
    const b = task();
    expect(eligibleParents([a, b], null).map((t) => t.item_id)).toEqual([a.item_id, b.item_id]);
  });

  it('never offers a subtask, because the cap is one level', () => {
    const ticket = task();
    const child = task({ parent_id: ticket.item_id });
    expect(eligibleParents([ticket, child], null).map((t) => t.item_id)).toEqual([
      ticket.item_id,
    ]);
  });

  it('never offers the task itself', () => {
    const a = task();
    const b = task();
    expect(eligibleParents([a, b], a).map((t) => t.item_id)).toEqual([b.item_id]);
  });

  /* The cap checked from above: a ticket with children cannot become a subtask. */
  it('offers nothing for a ticket that already has subtasks', () => {
    const ticket = task();
    const child = task({ parent_id: ticket.item_id });
    expect(eligibleParents([ticket, child], ticket)).toEqual([]);
  });
});

describe('isOverdue', () => {
  it('is false when there is no date', () => {
    expect(isOverdue(null, '2026-09-01')).toBe(false);
  });

  it('is false on the day itself', () => {
    expect(isOverdue('2026-09-01', '2026-09-01')).toBe(false);
  });

  it('is true the day after', () => {
    expect(isOverdue('2026-08-31', '2026-09-01')).toBe(true);
  });

  it('is false for a future date', () => {
    expect(isOverdue('2026-12-25', '2026-09-01')).toBe(false);
  });

  /* String comparison, so a year boundary is not a special case. */
  it('compares across years correctly', () => {
    expect(isOverdue('2025-12-31', '2026-01-01')).toBe(true);
    expect(isOverdue('2026-01-01', '2025-12-31')).toBe(false);
  });
});

describe('todayISO', () => {
  it('formats with zero padding', () => {
    expect(todayISO(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('uses local calendar fields, not UTC', () => {
    // 00:30 local on the 13th. Date#toISOString would report the 12th anywhere west
    // of Greenwich, which is what makes today's work look overdue before dawn.
    expect(todayISO(new Date(2026, 7, 13, 0, 30))).toBe('2026-08-13');
  });
});

describe('groupTasks', () => {
  it('puts the unattached section first', () => {
    // The half of the board the workbook could never hold. Buried under nine project
    // headings it would be the least reachable thing on the page.
    const groups = groupTasks(
      [task({ project_id: 'p1' }), task({ project_id: null })],
      PROJECTS
    );

    expect(groups.map((g) => g.title)).toEqual(['Not tied to a project', 'QWAPP']);
  });

  it('omits the unattached section when everything is attached', () => {
    const groups = groupTasks([task({ project_id: 'p2' })], PROJECTS);

    expect(groups).toHaveLength(1);
    expect(groups[0].projectId).toBe('p2');
  });

  it('follows lane order, not alphabetical order', () => {
    // "Same order probably" - the sections have to match the chart's rows, which are
    // served in lane_order. Alphabetical would disagree with the roadmap one tab away.
    const groups = groupTasks(
      [task({ project_id: 'p2' }), task({ project_id: 'p1' })],
      PROJECTS
    );

    expect(groups.map((g) => g.title)).toEqual(['QWAPP', 'Tax']);
  });

  it('still shows a task whose project no longer exists', () => {
    const groups = groupTasks([task({ item_id: 'orphan', project_id: 'gone' })], PROJECTS);

    expect(groups.map((g) => g.projectId)).toEqual(['gone']);
    expect(groups[0].title).toContain('gone');
  });

  it('sorts an unknown project last rather than to the top', () => {
    const groups = groupTasks(
      [task({ project_id: 'gone' }), task({ project_id: 'p1' })],
      PROJECTS
    );

    expect(groups.map((g) => g.projectId)).toEqual(['p1', 'gone']);
  });

  it('groups a subtask by its own project, not by its ticket', () => {
    /*
      A subtask carries its own project_id and it is allowed to differ. Inheriting the
      parent's would invent an attachment nobody typed, and it would disagree with the
      toolbar's project filter, which reads task.project_id directly.
    */
    const ticket = task({ item_id: 'tsk_parent', project_id: 'p1' });
    const child = task({ item_id: 'tsk_child', parent_id: ticket.item_id, project_id: 'p2' });

    const groups = groupTasks([ticket, child], PROJECTS);

    expect(groups.find((g) => g.projectId === 'p1')?.tasks.map((t) => t.item_id)).toEqual([
      'tsk_parent',
    ]);
    expect(groups.find((g) => g.projectId === 'p2')?.tasks.map((t) => t.item_id)).toEqual([
      'tsk_child',
    ]);
  });

  it('treats an empty-string project_id as unattached', () => {
    // Otherwise a form sending '' rather than null creates a banner reading
    // "Unknown project ()".
    expect(groupTasks([task({ project_id: '' })], PROJECTS)[0].projectId).toBeNull();
  });

  it('is empty for an empty board rather than one empty section', () => {
    expect(groupTasks([], PROJECTS)).toEqual([]);
  });
});

describe('tasksToAssign', () => {
  it('skips the rows already owned by that person', () => {
    // Every write is an audit row, and a PATCH setting owner_email to the value it
    // already holds logs that nothing happened.
    const rows = [
      task({ item_id: 'a', owner_email: 'sam@qwealth.com' }),
      task({ item_id: 'b', owner_email: null }),
      task({ item_id: 'c', owner_email: 'jo@qwealth.com' }),
    ];

    expect(tasksToAssign(rows, 'sam@qwealth.com').map((t) => t.item_id)).toEqual(['b', 'c']);
  });

  it('is empty when the whole group is already theirs, so the button can say so', () => {
    const rows = [task({ owner_email: 'sam@qwealth.com' })];

    expect(tasksToAssign(rows, 'sam@qwealth.com')).toEqual([]);
  });
});

describe('visibleColumns', () => {
  it('drops the closed columns while closed work is hidden', () => {
    // Guaranteed empty by the toggle, so drawing them spends two fifths of the
    // board's width restating what the "Show N closed" button already says.
    const got = visibleColumns([task({ status: 'done' })], STATUSES, false);
    expect(got.map((c) => c.status)).toEqual(['backlog', 'next', 'in-progress']);
  });

  it('brings them back with the toggle', () => {
    const got = visibleColumns([], STATUSES, true);
    expect(got.map((c) => c.status)).toEqual([
      'backlog',
      'next',
      'in-progress',
      'done',
      'dropped',
    ]);
  });

  it('keeps an empty OPEN column, which is a fact about the week', () => {
    const got = visibleColumns([], STATUSES, false);
    expect(got.find((c) => c.status === 'in-progress')?.tasks).toEqual([]);
  });

  it('keeps a column for a status this build has never heard of', () => {
    // Flagged open by toColumns, so it survives the filter. The alternative is a row
    // that exists in the table, is returned by the API, and appears nowhere.
    const got = visibleColumns([task({ status: 'blocked' })], STATUSES, false);
    expect(got.map((c) => c.status)).toContain('blocked');
  });
});

describe('groupKey', () => {
  it('is the project id for an attached section', () => {
    expect(groupKey('p1')).toBe('p1');
  });

  /* Underscore-prefixed, so no prj_ id can ever collide with it. */
  it('is a sentinel no project id can collide with', () => {
    expect(groupKey(null)).toBe('_unattached');
    expect(groupKey(null).startsWith('_')).toBe(true);
  });
});

describe('defaultOpenGroups', () => {
  const OWNED: Project[] = [
    { project_id: 'p1', name: 'QWAPP', dri_email: 'ha@x.test', support_email: null } as Project,
    { project_id: 'p2', name: 'Tax', dri_email: null, support_email: 'ha@x.test' } as Project,
    { project_id: 'p3', name: 'Infra', dri_email: 'mo@x.test', support_email: null } as Project,
  ];

  function open(tasks: Task[], email: string | null): string[] {
    return [...defaultOpenGroups(groupTasks(tasks, OWNED), OWNED, email)].sort();
  }

  it('opens the lanes you are DRI or Support on', () => {
    const tasks = [
      task({ project_id: 'p1' }),
      task({ project_id: 'p2' }),
      task({ project_id: 'p3' }),
    ];
    expect(open(tasks, 'ha@x.test')).toEqual(['p1', 'p2']);
  });

  /*
    The rule that keeps "filter by owner: me" from looking like no results: a card
    with your address on it opens its section whoever the lane's DRI is.
  */
  it('opens a lane you are on neither role of but own a card in', () => {
    const tasks = [task({ project_id: 'p3', owner_email: 'ha@x.test' })];
    expect(open(tasks, 'ha@x.test')).toEqual(['p3']);
  });

  it('matches an owner regardless of case', () => {
    const tasks = [task({ project_id: 'p3', owner_email: 'HA@X.test' })];
    expect(open(tasks, 'ha@x.test')).toEqual(['p3']);
  });

  /* No project means no DRI, so nothing else could ever open it. */
  it('always opens the unattached section', () => {
    const tasks = [task({ project_id: null }), task({ project_id: 'p3' })];
    expect(open(tasks, 'ha@x.test')).toEqual(['_unattached']);
    expect(open(tasks, null)).toEqual(['_unattached']);
    expect(open(tasks, 'nobody@x.test')).toEqual(['_unattached']);
  });

  it('leaves everything else shut', () => {
    const tasks = [task({ project_id: 'p3' })];
    expect(open(tasks, 'ha@x.test')).toEqual([]);
  });

  /* Before /api/me answers we do not know whose board this is. */
  it('opens nothing but the unattached section for an unknown viewer', () => {
    const tasks = [task({ project_id: 'p1', owner_email: 'ha@x.test' })];
    expect(open(tasks, null)).toEqual([]);
    expect(open(tasks, '')).toEqual([]);
  });

  /* An unowned card must not open a section just by having a null owner. */
  it('does not treat an unowned card as owned by nobody', () => {
    const tasks = [task({ project_id: 'p3', owner_email: null })];
    expect(open(tasks, 'ha@x.test')).toEqual([]);
  });

  /* A deleted project still gets a heading; it cannot be anybody's responsibility. */
  it('leaves a section for a deleted project shut', () => {
    const tasks = [task({ project_id: 'gone' })];
    expect(open(tasks, 'ha@x.test')).toEqual([]);
    expect(open([task({ project_id: 'gone', owner_email: 'ha@x.test' })], 'ha@x.test')).toEqual([
      'gone',
    ]);
  });

  it('returns keys the board can look up directly', () => {
    const groups = groupTasks([task({ project_id: 'p1' }), task({ project_id: null })], OWNED);
    const opened = defaultOpenGroups(groups, OWNED, 'ha@x.test');
    for (const group of groups) {
      expect(opened.has(groupKey(group.projectId))).toBe(group.projectId !== 'p3');
    }
  });
});
