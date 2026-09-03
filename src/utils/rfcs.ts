/**
 * Turning a flat list of RFCs into the sections the list page draws.
 *
 * Pure, and separate from the page, for the reason every util in this folder is:
 * there is no jsdom in this project, so a function extracted here can be tested and
 * a function left inside a component cannot. The grouping has three edge cases that
 * are each invisible when they go wrong, which is enough to earn the extraction.
 */

import type { Project, Rfc } from '../types';
import { groupByProject } from './projects';

export interface RfcGroup {
  /** null for the unattached section. */
  projectId: string | null;
  title: string;
  rfcs: Rfc[];
}

/**
 * Group RFCs by the project they are attached to, unattached ones first.
 *
 * Every rule this obeys - unattached first, empty sections omitted, a deleted
 * project's documents still reachable under its raw id, sections in lane_order -
 * lives in groupByProject, because the board needs the identical behaviour and each
 * of those rules fails silently when it is wrong. This function is the RFC-shaped
 * name for it, kept so the page reads as what it does.
 */
export function groupRfcs(rfcs: readonly Rfc[], projects: readonly Project[]): RfcGroup[] {
  return groupByProject(rfcs, projects, (rfc) => rfc.project_id, 'Not tied to a project').map(
    ({ projectId, title, items }) => ({ projectId, title, rfcs: items })
  );
}

/**
 * A one-line preview of a markdown body, for the list.
 *
 * Takes the first line that carries prose, skipping the heading an RFC almost always
 * opens with - the title is already displayed immediately above, so echoing it as
 * the summary would print the same words twice and say nothing.
 *
 * The markdown stripping is deliberately shallow: this is a preview, not a renderer.
 * It removes the marks that would otherwise be read aloud as punctuation on a list
 * of one-liners, and leaves anything more elaborate alone rather than growing into a
 * second, worse parser alongside the real one.
 */
export function rfcSummary(body: string, limit = 140): string {
  const lines = body.split('\n');

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    // Headings, horizontal rules, and the fences around code blocks: all structure,
    // none of it a summary.
    if (line.startsWith('#') || /^([-*_])\1{2,}$/.test(line) || line.startsWith('```')) {
      continue;
    }

    const text = line
      // Links and images: keep the text, drop the target. An RFC opening with a
      // link would otherwise summarise as a URL.
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      // Emphasis, bold, inline code, and a leading list marker or quote.
      .replace(/[*_`~]/g, '')
      .replace(/^\s*([-*+]|\d+\.|>)\s+/, '')
      .trim();

    if (!text) {
      continue;
    }
    return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
  }

  return '';
}
