import { describe, expect, it } from 'vitest';

import type { Project, Rfc } from '../types';
import { groupRfcs, rfcSummary } from './rfcs';

function rfc(over: Partial<Rfc> = {}): Rfc {
  return {
    item_id: 'rfc_1',
    kind: 'rfc',
    title: 'A proposal',
    body: '',
    status: 'draft',
    project_id: null,
    owner_email: null,
    skills: [],
    review_since: null,
    decided_on: null,
    created_by: null,
    created_at: null,
    updated_at: null,
    ...over,
  };
}

function project(projectId: string, name: string): Project {
  return {
    project_id: projectId,
    name,
    lane_order: 0,
    dri_email: null,
    support_email: null,
    active: true,
    phases: [],
    milestones: [],
  } as unknown as Project;
}

describe('groupRfcs', () => {
  it('puts the unattached ones first', () => {
    const groups = groupRfcs(
      [rfc({ item_id: 'a', project_id: 'p1' }), rfc({ item_id: 'b', project_id: null })],
      [project('p1', 'Net Worth')]
    );

    expect(groups.map((g) => g.title)).toEqual(['Not tied to a project', 'Net Worth']);
  });

  it('omits the unattached section when there is nothing in it', () => {
    const groups = groupRfcs([rfc({ project_id: 'p1' })], [project('p1', 'Net Worth')]);

    expect(groups).toHaveLength(1);
    expect(groups[0].projectId).toBe('p1');
  });

  it('follows lane order, not alphabetical order', () => {
    // The headings here have to match the roadmap's top-to-bottom order. Sorting by
    // name would silently disagree with the chart on the very next tab.
    const projects = [project('p1', 'Zebra'), project('p2', 'Apple')];
    const groups = groupRfcs(
      [rfc({ item_id: 'a', project_id: 'p2' }), rfc({ item_id: 'b', project_id: 'p1' })],
      projects
    );

    expect(groups.map((g) => g.title)).toEqual(['Zebra', 'Apple']);
  });

  it('still shows an RFC whose project no longer exists', () => {
    /*
      The failure this guards is invisible: projects are soft-deleted and DynamoDB has
      no foreign keys, so a stored project_id can outlive its row. An implementation
      that iterates the known projects drops these documents from the only page that
      lists them, with nothing on screen to say anything is missing.
    */
    const groups = groupRfcs([rfc({ item_id: 'orphan', project_id: 'gone' })], []);

    expect(groups).toHaveLength(1);
    expect(groups[0].title).toContain('gone');
    expect(groups[0].rfcs[0].item_id).toBe('orphan');
  });

  it('sorts an unknown project last rather than to the top', () => {
    const groups = groupRfcs(
      [rfc({ item_id: 'a', project_id: 'gone' }), rfc({ item_id: 'b', project_id: 'p1' })],
      [project('p1', 'Net Worth')]
    );

    expect(groups.map((g) => g.projectId)).toEqual(['p1', 'gone']);
  });

  it('keeps the API order within a group', () => {
    const groups = groupRfcs(
      [
        rfc({ item_id: 'newest', project_id: 'p1' }),
        rfc({ item_id: 'older', project_id: 'p1' }),
      ],
      [project('p1', 'Net Worth')]
    );

    expect(groups[0].rfcs.map((r) => r.item_id)).toEqual(['newest', 'older']);
  });

  it('treats an empty-string project_id as unattached', () => {
    // Not hypothetical: a form that sends '' instead of null would otherwise create
    // a group headed "Unknown project ()".
    const groups = groupRfcs([rfc({ project_id: '' })], []);

    expect(groups[0].projectId).toBeNull();
  });
});

describe('rfcSummary', () => {
  it('skips the opening heading', () => {
    // The title is displayed directly above the summary, so echoing it says nothing.
    expect(rfcSummary('# How we do code review\n\nTwo approvals on every PR.')).toBe(
      'Two approvals on every PR.'
    );
  });

  it('strips emphasis and inline code', () => {
    expect(rfcSummary('We should **stop** using `eval` here.')).toBe(
      'We should stop using eval here.'
    );
  });

  it('keeps the text of a link and drops the target', () => {
    expect(rfcSummary('See [the RFC](https://example.com/very/long/path) for detail.')).toBe(
      'See the RFC for detail.'
    );
  });

  it('drops a leading list marker or quote', () => {
    expect(rfcSummary('- First point')).toBe('First point');
    expect(rfcSummary('> Quoted opening')).toBe('Quoted opening');
    expect(rfcSummary('1. Numbered opening')).toBe('Numbered opening');
  });

  it('skips a code fence rather than summarising the fence', () => {
    expect(rfcSummary('```python\nprint(1)\n```\n\nThe point is this.')).toBe('print(1)');
  });

  it('skips a horizontal rule', () => {
    expect(rfcSummary('---\n\nAfter the rule.')).toBe('After the rule.');
  });

  it('truncates on an ellipsis rather than mid-layout', () => {
    const summary = rfcSummary('x'.repeat(300), 20);

    expect(summary).toHaveLength(20);
    expect(summary.endsWith('…')).toBe(true);
  });

  it('is empty for a body that is only a heading', () => {
    // A brand new RFC. The page shows nothing rather than a stray hash.
    expect(rfcSummary('# Title only')).toBe('');
  });

  it('is empty for an empty body', () => {
    expect(rfcSummary('')).toBe('');
  });
});
