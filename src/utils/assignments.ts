/**
 * Turn the roadmap inside out: from "what is each project doing" to "what is each
 * person doing, and when".
 *
 * WHY THE DATA HAS TO BE RESHAPED AT ALL
 * --------------------------------------
 * Everything is stored per project - a lane owns phases, a phase names an owner - so
 * the answer to "is Ha free in October" is spread across nine lanes and is not
 * written down anywhere. /api/people/workload aggregates it, but only as counts:
 * "DRI ×2, 4 phases" says how much somebody carries and says nothing about WHEN,
 * which is the half needed to plan ahead rather than to audit the present.
 *
 * This module does the transpose client-side. It is deliberately not a new endpoint:
 * the Team page already fetches the whole roadmap to turn project ids into names, so
 * every phase, owner and date is on hand, and a second source for the same facts is a
 * second thing to drift.
 *
 * TWO KINDS OF ASSIGNMENT, DRAWN DIFFERENTLY ON PURPOSE
 * ----------------------------------------------------
 * A phase you OWN has its own start and end - it is a dated commitment, and it draws
 * exactly where it sits.
 *
 * Being DRI or Support carries no dates at all. The only honest span for it is the
 * project's own extent, which is INFERRED here rather than stored, and that inference
 * is the reason these are drawn as a light span behind the owned bars instead of as
 * more bars: "Meherzad is accountable for Tax while Tax is running" is a weaker,
 * derived claim than "Meherzad is coding from the 3rd to the 21st", and the chart
 * should not let the two look alike.
 *
 * MILESTONES DO NOT WIDEN A ROLE SPAN
 * -----------------------------------
 * Tempting, because a DRI is plainly still on the hook the week before a launch date
 * that sits past the last phase. Rejected for two reasons. A span is drawn work-
 * shaped, so extending it to a deadline paints work across weeks where none is
 * scheduled - the exact lie utils/segments.ts was written to stop the collapsed lane
 * telling. And the lane extent on the Roadmap page is phases-only, so widening it
 * here would make one project appear to end on two different dates on two pages, with
 * nothing on either to explain the difference.
 */

import type { Phase, Project } from '../types';
import { placeable } from './segments';

export interface Span {
  /** Inclusive ISO day. */
  start: string;
  /** Inclusive ISO day. */
  end: string;
}

export type Role = 'dri' | 'support';

/** A project's extent, attributed to somebody because of the role they hold on it. */
export interface RoleSpan extends Span {
  project_id: string;
  project_name: string;
  role: Role;
}

/** A role on a project with no datable work. Real, and impossible to place. */
export interface UndatedRole {
  project_id: string;
  project_name: string;
  role: Role;
}

export interface PersonAssignments {
  /** Lower-cased, matching the key it is stored under. */
  email: string;
  /** Every phase they own, drawable or not, earliest first. */
  owned: Phase[];
  /**
   * The subset of `owned` the chart cannot place: no dates, or structural. Kept as
   * phases rather than a count so the row can name them - "Maintenance (QWAPP)" is
   * actionable in a way "3 not shown" is not.
   */
  undrawable: Phase[];
  /** DRI/Support spans, earliest first. */
  roles: RoleSpan[];
  /** DRI/Support roles on projects with nothing dated. Stated, never drawn. */
  undatedRoles: UndatedRole[];
}

/** The same lower-casing the backend does, so a stray capital cannot orphan a row. */
const key = (email: string): string => email.trim().toLowerCase();

/**
 * Earliest start to latest end across whichever of these phases can be drawn.
 *
 * Null when none of them can - four of the nine lanes were in that state at migration
 * - and null rather than a zero-width span at today, so the caller is forced to decide
 * what to say about it. A one-day tick at today for work nobody has scheduled would
 * invent a date, which is the failure this whole codebase is arranged against.
 */
export function datedSpan(phases: Phase[]): Span | null {
  const real = placeable(phases);
  if (real.length === 0) {
    return null;
  }
  return {
    start: real.reduce((a, p) => (p.start! < a ? p.start! : a), real[0].start!),
    end: real.reduce((a, p) => (p.end! > a ? p.end! : a), real[0].end!),
  };
}

/** A project's own extent - what a DRI or Support role is taken to span. */
export function projectSpan(project: Project): Span | null {
  return datedSpan(project.phases);
}

/**
 * The most phases one person has running on the same day.
 *
 * Not the same question as segments.ts's peakConcurrency, and the difference matters
 * on exactly this chart. That one counts distinct STATES, because two concurrent
 * `other` workstreams on one lane are one grey band and splitting them into identical
 * slivers says nothing. Here the phases come from different projects, so two
 * simultaneous Coding phases are two genuinely different commitments that collapse
 * into a single stripe - and "is this person double-booked in October" is the
 * question the Team chart exists to answer. So it is counted separately and stated in
 * words next to the row.
 *
 * The maximum always occurs on some phase's start day, so only those are tested.
 */
export function peakOverlap(phases: Phase[]): number {
  const real = placeable(phases);
  return real.reduce(
    (most, at) =>
      Math.max(most, real.filter((p) => p.start! <= at.start! && p.end! >= at.start!).length),
    0
  );
}

/**
 * Every person named anywhere in the roadmap, and what they hold.
 *
 * Keyed by lower-cased email, which is the only identifier assignments carry -
 * projects and phases store an address, not a foreign key. A person on the roster who
 * is named nowhere simply has no entry, and the caller supplies the empty one; that
 * is the right way round, because the roster is the list of people who exist and this
 * map is only the list of people who appear in the work.
 *
 * One pass over the projects rather than a filter per person: the Team page renders
 * this for the whole roster at once, and per-person filtering would be a scan of
 * every phase in every project for each of twenty-odd rows.
 */
export function assignmentsByPerson(projects: Project[]): Map<string, PersonAssignments> {
  const found = new Map<string, PersonAssignments>();

  const entry = (email: string): PersonAssignments => {
    const id = key(email);
    const existing = found.get(id);
    if (existing) {
      return existing;
    }
    const fresh: PersonAssignments = {
      email: id,
      owned: [],
      undrawable: [],
      roles: [],
      undatedRoles: [],
    };
    found.set(id, fresh);
    return fresh;
  };

  for (const project of projects) {
    const span = projectSpan(project);
    const roles: [Role, string | null][] = [
      ['dri', project.dri_email],
      ['support', project.support_email],
    ];

    for (const [role, email] of roles) {
      if (!email) {
        continue;
      }
      // Both roles are recorded even when one person holds both on the same project.
      // Two identical spans draw as one, and the label then reads "DRI and Support",
      // which is the true and materially worse position: a lane with no second pair
      // of eyes on it.
      const held = entry(email);
      if (span) {
        held.roles.push({
          ...span,
          project_id: project.project_id,
          project_name: project.name,
          role,
        });
      } else {
        held.undatedRoles.push({
          project_id: project.project_id,
          project_name: project.name,
          role,
        });
      }
    }

    for (const phase of project.phases) {
      if (phase.owner_email) {
        entry(phase.owner_email).owned.push(phase);
      }
    }
  }

  for (const person of found.values()) {
    // Sorted by start so a row reads left to right in the order it is drawn, with the
    // unplaceable ones last - they have no position to sort by and belong in the
    // caption rather than in the sequence.
    const drawable = new Set(placeable(person.owned));
    person.undrawable = person.owned.filter((p) => !drawable.has(p));
    person.owned.sort(
      (a, b) => (a.start ?? '9999').localeCompare(b.start ?? '9999') || a.name.localeCompare(b.name)
    );
    person.roles.sort(
      (a, b) => a.start.localeCompare(b.start) || a.project_name.localeCompare(b.project_name)
    );
  }

  return found;
}

/** The empty answer, for somebody on the roster who is named nowhere in the work. */
export function noAssignments(email: string): PersonAssignments {
  return { email: key(email), owned: [], undrawable: [], roles: [], undatedRoles: [] };
}

/**
 * "DRI of Tax · Support on QWAPP" - the roles behind the light spans, in words.
 *
 * The spans themselves are deliberately faint and unlabelled on the chart, so without
 * this the only way to find out why a person's row stretches across October is to
 * hover each one in turn.
 *
 * ONE PROJECT IS NAMED ONCE, EVEN WHEN SOMEBODY HOLDS BOTH ROLES ON IT
 * --------------------------------------------------------------------
 * `roles` deliberately keeps DRI and Support as two entries so the two bands draw
 * (see assignmentsByPerson). Reading that straight out gave "DRI of DocuTelligence ·
 * Support on DocuTelligence", which spent 66 characters of a 248px label cell saying
 * one project's name twice and then truncated - so the reader lost the END of the
 * list to a repetition they had to notice for themselves.
 *
 * "DRI and Support on DocuTelligence" is shorter and says the thing that actually
 * matters out loud: one person holds both roles, so there is no second pair of eyes
 * on that lane. That is a materially worse position than holding either role alone,
 * and it should not be something you infer from seeing a name twice.
 *
 * Grouped by project_id rather than by name - two lanes are allowed to share a name,
 * and merging them because of it would invent a role nobody holds.
 */
export function describeRoles(assignments: PersonAssignments): string {
  const held = new Map<string, { name: string; dri: boolean; support: boolean }>();
  for (const role of [...assignments.roles, ...assignments.undatedRoles]) {
    const at = held.get(role.project_id) ?? {
      name: role.project_name,
      dri: false,
      support: false,
    };
    at[role.role] = true;
    held.set(role.project_id, at);
  }

  const names = (want: (h: { dri: boolean; support: boolean }) => boolean): string[] =>
    [...held.values()]
      .filter(want)
      .map((h) => h.name)
      .sort((a, b) => a.localeCompare(b));

  const say = (lead: string, list: string[]): string | null =>
    list.length === 0 ? null : `${lead} ${list.join(', ')}`;

  // Both-roles first: it is the strongest claim on a person and the one worth reading
  // before the label runs out of room.
  return [
    say('DRI and Support on', names((h) => h.dri && h.support)),
    say('DRI of', names((h) => h.dri && !h.support)),
    say('Support on', names((h) => !h.dri && h.support)),
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
}
