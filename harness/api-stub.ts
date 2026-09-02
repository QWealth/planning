// THROWAWAY. Stands in for src/services/api.ts so RoadmapPage can be driven in a
// browser without Amplify or live AWS. Delete with the rest of harness/.

import type { Project, ProjectPatch, Roadmap } from '../src/types';

function lane(project_id: string, name: string, lane_order: number): Project {
  return {
    project_id,
    name,
    lane_order,
    dri_email: null,
    support_email: null,
    active: true,
    created_at: null,
    updated_at: null,
    phases: [
      {
        project_id,
        phase_id: `${project_id}-p1`,
        name: 'Coding',
        phase_order: 0,
        owner_email: null,
        start: '2026-09-07',
        end: '2026-10-16',
        progress: 0.4,
        structural: false,
        created_at: null,
        updated_at: null,
      },
    ],
    milestones: [],
  };
}

// Deliberately NOT 0,1,2. Two lanes share an order and the rest are sparse, which is
// the shape the workbook seed actually produced - and the case a swap-based
// implementation would fail on. Sorted by (lane_order, name), the chart should open
// showing: Alpha, Bravo, Charlie, Delta.
const PROJECTS: Project[] = [
  lane('a', 'Alpha', 0),
  lane('b', 'Bravo', 0),
  lane('c', 'Charlie', 10),
  lane('d', 'Delta', 20),
];

/** Every PATCH the page issued, appended to a DOM node the test can read. */
function record(line: string): void {
  const log = document.getElementById('patch-log');
  if (log) {
    log.textContent = `${log.textContent ?? ''}${line}\n`;
  }
}

export async function getRoadmap(): Promise<Roadmap> {
  return {
    projects: PROJECTS.map((p) => ({ ...p })),
    people: [],
    span_start: '2026-09-01',
    span_end: '2026-11-01',
  } as Roadmap;
}

export async function patchProject(projectId: string, patch: ProjectPatch) {
  record(`PATCH ${projectId} lane_order=${patch.lane_order}`);
  const found = PROJECTS.find((p) => p.project_id === projectId);
  if (found && patch.lane_order !== undefined) {
    found.lane_order = patch.lane_order;
  }
  return found;
}

export async function saveLaneOrder(
  changes: readonly { project_id: string; lane_order: number }[]
): Promise<void> {
  await Promise.all(changes.map((c) => patchProject(c.project_id, { lane_order: c.lane_order })));
}

export function describeError(err: unknown): string {
  return String(err);
}

export async function createProject(): Promise<Project> {
  throw new Error('not used by this harness');
}
