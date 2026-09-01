#!/usr/bin/env python3
"""
Extract the planning roadmap out of 'Planning Gantt Chart (Aug24).xlsx' into
typed JSON, and report every cell that will not survive the trip.

    python3 extract_workbook.py                  # report only
    python3 extract_workbook.py --write roadmap.json

This is the one-way door for retiring the workbook, so it is deliberately
read-only by default and refuses to guess. Anything it cannot parse is listed as
an issue rather than defaulted, because a silently-defaulted date is exactly the
failure mode we are migrating away from: 33% of the sheet's date and progress
cells are currently either #REF!, a 1900-era serial, or empty, and Excel renders
all three without complaint.

WHY NOT openpyxl
----------------
It drops the x14 dataBar extension, the unparseable headerFooter, and one unknown
extension on round trip. We only read here so that would be harmless, but the same
parsing code is shared with the writers, so the project has one rule: patch and
read the OOXML in the zip directly.

SHEET LAYOUT (reverse-engineered, verified against the live file)
----------------------------------------------------------------
Each project occupies a "lane". The lane's own row carries the project name in
column B and the owners in D (DRI) and E (SUPPORT). The rows beneath it, up to
the next lane, are phases:

    B = phase name        F = progress (0..1)
    C = phase owner       G = start  (Excel date serial)
    D = DRI               H = end    (Excel date serial)
    E = SUPPORT

Column C is only populated on a lane's first phase row, and D/E are duplicated
onto that row for QWAPP but left blank for every other project. Neither is
treated as authoritative: owners are read from the lane row only.
"""

import argparse
import datetime
import json
import os
import re
import sys
import zipfile
from typing import Any, Optional

WORKBOOK = os.path.expanduser('~/projects/Planning Gantt Chart (Aug24).xlsx')
SHEET = 'xl/worksheets/sheet1.xml'

# Lane header rows, in sheet order. Asserted against the file on every run: if a
# row here does not name a project, the layout moved and we stop rather than
# silently emit an empty roadmap.
LANES = [8, 16, 24, 32, 39, 47, 55, 63, 73]
SHEET_END = 80

# Excel's epoch. Day 1 is 1900-01-01, and the serial->date map is offset by two:
# one because it is 1-based, one for the 1900 leap year that never happened.
EPOCH = datetime.date(1899, 12, 30)

# Phase names that are structural rather than real work. "Maintenance" is a row
# we added to every lane to carry the ongoing-support band; it has no progress.
STRUCTURAL_PHASES = {'Maintenance'}

# A serial below this is not a plausible project date -- it is a small integer
# someone typed meaning "day 3", which Excel silently read as January 1900.
MIN_PLAUSIBLE_SERIAL = 2000          # ~1905


# --------------------------------------------------------------------- parsing
def load_cells(path: str, sheet: str) -> dict[str, str]:
    """ref -> display text, with shared strings resolved."""
    with zipfile.ZipFile(path) as z:
        xml = z.read(sheet).decode('utf-8')
        try:
            shared_xml = z.read('xl/sharedStrings.xml').decode('utf-8')
        except KeyError:
            shared_xml = ''

    strings = [re.sub(r'<[^>]+>', '', s)
               for s in re.findall(r'<si>(.*?)</si>', shared_xml, re.S)]

    cells: dict[str, str] = {}
    # The self-closing alternative MUST come first. The other order lets
    # <c r="A10" s="11"/> swallow everything up to the next </c>, which silently
    # eats the following cell -- this bug shipped once already.
    for cell in re.findall(r'<c\b[^>]*?/>|<c\b[^>]*?>.*?</c>', xml, re.S):
        ref = re.search(r'r="([A-Z]+\d+)"', cell)
        if not ref:
            continue
        ctype = re.search(r't="([^"]*)"', cell)
        inline = re.search(r'<is>.*?<t[^>]*>(.*?)</t>', cell, re.S)
        value = re.search(r'<v>(.*?)</v>', cell, re.S)

        if inline:
            text = inline.group(1)
        elif value:
            text = value.group(1)
            if ctype and ctype.group(1) == 's':
                try:
                    text = strings[int(text)]
                except (ValueError, IndexError):
                    pass
        else:
            text = ''
        cells[ref.group(1)] = (text.replace('&amp;', '&')
                                   .replace('&lt;', '<')
                                   .replace('&gt;', '>').strip())
    return cells


def parse_date(raw: str) -> tuple[Optional[str], Optional[str]]:
    """(iso_date, problem). Exactly one of the two is set."""
    if not raw:
        return None, 'empty'
    if raw.startswith('#'):
        return None, raw                      # #REF!, #VALUE!, ...
    try:
        serial = float(raw)
    except ValueError:
        return None, 'not a number: %r' % raw[:30]
    if serial < MIN_PLAUSIBLE_SERIAL:
        d = EPOCH + datetime.timedelta(days=int(serial))
        return None, 'implausible serial %s -> %s' % (raw, d.isoformat())
    return (EPOCH + datetime.timedelta(days=int(serial))).isoformat(), None


def parse_progress(raw: str) -> tuple[Optional[float], Optional[str]]:
    if not raw:
        return None, 'empty'
    if raw.startswith('#'):
        return None, raw
    try:
        pct = float(raw)
    except ValueError:
        return None, 'not a number: %r' % raw[:30]
    if not 0.0 <= pct <= 1.0:
        # A date serial sitting in the progress column, most likely.
        return None, 'out of range: %s' % raw
    return round(pct, 4), None


# --------------------------------------------------------------------- extract
def extract(cells: dict[str, str]) -> tuple[dict[str, Any], list[dict[str, str]]]:
    issues: list[dict[str, str]] = []

    def note(project: str, phase: str, field: str, problem: str, ref: str) -> None:
        issues.append({'project': project, 'phase': phase, 'field': field,
                       'problem': problem, 'cell': ref})

    missing = [r for r in LANES if not cells.get('B%d' % r)]
    if missing:
        raise SystemExit('rows %s do not name a project -- the sheet layout '
                         'changed, re-check LANES' % missing)

    projects = []
    people: dict[str, dict[str, Any]] = {}

    def person(name: str) -> None:
        if name and name not in people:
            people[name] = {'name': name}

    for i, lane in enumerate(LANES):
        name = cells['B%d' % lane]
        dri = cells.get('D%d' % lane, '') or None
        support = cells.get('E%d' % lane, '') or None
        person(dri)
        person(support)

        if not dri:
            note(name, '', 'dri', 'no DRI assigned', 'D%d' % lane)
        if dri and not support:
            note(name, '', 'support', 'DRI but no support owner', 'E%d' % lane)

        end_row = LANES[i + 1] if i + 1 < len(LANES) else SHEET_END
        phases = []
        for row in range(lane + 1, end_row):
            phase_name = cells.get('B%d' % row, '')
            if not phase_name:
                continue

            structural = phase_name in STRUCTURAL_PHASES
            start, start_bad = parse_date(cells.get('G%d' % row, ''))
            finish, end_bad = parse_date(cells.get('H%d' % row, ''))
            progress, prog_bad = parse_progress(cells.get('F%d' % row, ''))

            # A structural row legitimately carries no progress and, for most
            # projects, no dates either -- the band exists to mark ongoing
            # support, not scheduled work. Reporting those would bury the 20-odd
            # gaps that actually need a decision under 14 that do not.
            if not (structural and start_bad == 'empty'):
                if start_bad:
                    note(name, phase_name, 'start', start_bad, 'G%d' % row)
            if not (structural and end_bad == 'empty'):
                if end_bad:
                    note(name, phase_name, 'end', end_bad, 'H%d' % row)
            if prog_bad and not structural:
                note(name, phase_name, 'progress', prog_bad, 'F%d' % row)

            owner = cells.get('C%d' % row, '') or None
            person(owner)

            if start and finish and finish < start:
                note(name, phase_name, 'end', 'ends before it starts (%s < %s)'
                     % (finish, start), 'H%d' % row)

            phases.append({
                'name': phase_name,
                'owner': owner,
                'start': start,
                'end': finish,
                'progress': progress,
                'structural': structural,
                'source_row': row,
            })

        projects.append({
            'name': name,
            'order': i,
            'dri': dri,
            'support': support,
            'phases': phases,
            'source_row': lane,
        })

    # On the roster, owning nothing on any lane, so they appear nowhere above. Named
    # here or they would not be extracted at all.
    #
    # Reporting lines used to be recorded here too (Timan and Meherzad to Joe) and are
    # deliberately gone: the app has no use for them, nothing ever read them back, and
    # a hierarchy nobody displays is a hierarchy nobody maintains.
    for extra in ('Timan', 'Meherzad', 'Ha', 'Janine', 'Artem'):
        person(extra)

    roadmap = {
        'source': os.path.basename(WORKBOOK),
        'extracted_at': datetime.datetime.now().isoformat(timespec='seconds'),
        'people': sorted(people.values(), key=lambda p: p['name']),
        'projects': projects,
    }
    return roadmap, issues


# --------------------------------------------------------------------- report
def report(roadmap: dict[str, Any], issues: list[dict[str, str]]) -> None:
    projects = roadmap['projects']
    phases = [p for pr in projects for p in pr['phases']]
    real = [p for p in phases if not p['structural']]
    clean = [p for p in real if p['start'] and p['end'] and p['progress'] is not None]

    print('projects %d   phases %d (%d real, %d structural)   people %d'
          % (len(projects), len(phases), len(real), len(phases) - len(real),
             len(roadmap['people'])))
    print('fully populated phases: %d of %d (%.0f%%)'
          % (len(clean), len(real), 100.0 * len(clean) / len(real) if real else 0))
    print()

    print('%-24s %-9s %-9s %-6s %s' % ('PROJECT', 'DRI', 'SUPPORT', 'PHASES', 'DATE RANGE'))
    for pr in projects:
        dates = [p['start'] for p in pr['phases'] if p['start']] + \
                [p['end'] for p in pr['phases'] if p['end']]
        span = '%s .. %s' % (min(dates), max(dates)) if dates else '-- no usable dates --'
        print('%-24s %-9s %-9s %-6d %s'
              % (pr['name'][:24], (pr['dri'] or '--')[:9], (pr['support'] or '--')[:9],
                 len(pr['phases']), span))

    if not issues:
        print('\nno issues.')
        return

    print('\n%d issues:' % len(issues))
    by_problem: dict[str, int] = {}
    for it in issues:
        key = re.sub(r'\d[\d\-\.]*', 'N', it['problem'])
        by_problem[key] = by_problem.get(key, 0) + 1
    for key, n in sorted(by_problem.items(), key=lambda kv: -kv[1]):
        print('  %3d  %s' % (n, key))

    print('\n  %-24s %-14s %-9s %-6s %s'
          % ('PROJECT', 'PHASE', 'FIELD', 'CELL', 'PROBLEM'))
    for it in issues:
        print('  %-24s %-14s %-9s %-6s %s'
              % (it['project'][:24], it['phase'][:14], it['field'], it['cell'], it['problem']))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--write', metavar='PATH', help='write roadmap JSON here')
    ap.add_argument('--workbook', default=WORKBOOK)
    args = ap.parse_args()

    if not os.path.exists(args.workbook):
        raise SystemExit('workbook not found: %s' % args.workbook)

    cells = load_cells(args.workbook, SHEET)
    roadmap, issues = extract(cells)
    report(roadmap, issues)

    if args.write:
        roadmap['issues'] = issues
        with open(args.write, 'w') as fh:
            json.dump(roadmap, fh, indent=2)
        print('\nwrote %s' % args.write)
    else:
        print('\n(report only -- pass --write PATH to emit JSON)')


if __name__ == '__main__':
    main()
