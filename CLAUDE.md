# CLAUDE.md — Planning Roadmap

## Project Overview

**Planning Roadmap** — internal web app for the engineering roadmap: projects,
phases, schedules, and who owns each project as DRI and as maintenance/support.

Replaces `~/projects/Planning Gantt Chart (Aug24).xlsx`. The workbook is being
**retired**, not exported to — see "Why we left Excel" below.

- **Repo**: `/Users/thomas/planning_roadmap`
- **Account**: AWS 778983355679 (ca-central-1) — same as the marketing tool
- **Status**: everything built so far is **deployed to `dev`** — migration, backend,
  frontend, infra, plus the Team page, the specialisations vocabulary and
  milestones. 154 backend tests + 79 frontend tests pass.
  Verified against the deployed Lambda on 2026-09-01, not inferred from a successful
  `cdk deploy`: `/api/skills` answers with all ten skills, `/api/roles` answers with
  all six roles, and a synthetic caller holding `cognito:groups = "[marketing]"`
  still gets `403`.
  A 401 on `/api/roles` from outside proves only that the authorizer is in front of
  it — every unknown `/api/*` path answers the same — so the route itself is proven
  by invoking the function with a synthetic proxy event carrying authorizer claims.
  **Projects, phases and milestones can now all be created from the UI** — "New
  project" in the toolbar, and `+ Add phase` / `+ Add milestone` at the foot of every
  expanded lane. Since then: the Roadmap toolbar's "Include archived" toggle is gone,
  a person can be **hard-deleted** (blanking every assignment naming them), and the
  Team page carries a **schedule Gantt** — one row per person, phases they own drawn
  as bars and the projects they are DRI/Support on as pale bands behind. Since *that*:
  the skill picker offers **four answers** (No / Yes, but slowly / Yes / No, but wants
  to learn), the roster is **self-service** (edit yourself; admins edit anyone), and
  the `planning` group check is **off** so any pool account can get in. Since *that*:
  people carry **roles** (BA / UX / Software engineer / QA / Data / Leadership — one
  or more, required on sign-up) and the **`manager_email` field is gone** from the
  code and from the data. All of it is **deployed** as of 2026-09-01.
- **URL**: <https://planning.qconnect.qwnext.com> — CloudFront, valid TLS, now
  serving the React app from `dist/`. `/api/*` and `/health` route through to API
  Gateway on the same origin. Sign-in is the shared Cognito pool; **any account in
  that pool may use the app** (`enforce_group` is off by decision — see "Cognito"),
  and the "not authorised" panel is what a refused user would see if it were on.
- **API direct**: `https://slxqk1v4x3.execute-api.ca-central-1.amazonaws.com/prod`
  — `/health` is open, everything else needs a Cognito ID token from the shared
  pool. Loaded with the nine migrated projects and 54 phases.
  **The owner data in `dev` is fabricated** — a ten-person roster of
  `@example.invalid` addresses, attached as DRI/Support on seven of the nine
  lanes. It is placeholder, not migrated: the workbook's owner cells were blank.
  Do not read it as real, and replace it before anyone is shown the tool (see
  "Open migration decisions").

---

## Ground Rules

Inherited from `/Users/thomas/marketing_compliance_review/CLAUDE.md`:

- **No git commits/push** — show what would be committed, wait for approval.
- **Search before writing** — reuse existing code; never reinvent.
- **Python**: snake_case, type annotations required, imports ordered stdlib →
  third-party → local.
- **TypeScript**: styled-components, never inline styles. React Hook Form.
- **Commands run from package dirs**: `(cd fast && pytest)`.
- **Never round-trip .xlsx through openpyxl** — it drops the x14 dataBar
  extension, the unparseable headerFooter, and one unknown extension. Patch the
  OOXML in the zip directly. (Only relevant to `migrate/`.)

---

## Reused from marketing_compliance_review

Deliberately copied rather than reinvented. Check there first when adding anything.

| From | What |
|---|---|
| `src/styles/index.ts` | 757-line Win95 component library — `Window`, `TitleBar`, `raised/sunken/pressed/etched`, tabs, toolbars |
| `fast/app/db/models.py` | static-method models over boto3 (no ORM), versioned items, `from_item` defaults so old records still validate |
| `fast/app/auth.py` | claims come from the API Gateway authorizer's request context; **no JWT parsing in app code** |
| `fast/app/main.py`, `config.py` | FastAPI skeleton, CORS, env config |
| `src/services/api.ts`, `auth.ts` | axios wrapper, Amplify SRP sign-in |
| `cdk/lib/*` | dynamodb, lambda, frontend, waf, cognito stacks |

---

## Cognito: shared pool, and the check it requires

Decision: **reuse the marketing tool's pool**, `ca-central-1_P8orSDvVO`. One
credential and one invite flow for the team; they already have accounts.

An API Gateway Cognito authorizer accepts *any* token issued by the pool,
regardless of which app client minted it — authentication is not authorization.
So without a group claim check, a planning-app login is also a valid
compliance-tool login.

**The group check is built, tested, and currently switched OFF. That is a decision,
not a regression.** `enforce_group: false` in `cdk.json`, so anybody with an account
in the shared pool may use the roadmap — including compliance-tool accounts. It was
weighed and accepted: the pool holds five people, all `@qwealth.com`, and the
alternative was chasing a group membership every time somebody new needed a date
changed.

Because that combination is genuinely dangerous in general, `planning_roadmap_stack.py`
**refuses to synth** on `require_auth && !enforce_group` unless `allow_whole_pool` is
also set. The flag does not make the consequence go away; it makes it a written-down
decision in `cdk.json` rather than an accident. Turning the gate back on is one
boolean — nothing else depends on it being off.

`required_group` is still named, because `/api/me` reports it and the Cognito group
still exists. With enforcement off it is documentation.

State as of 2026-08-27, verified against the pool, **not** inferred from code:

| Piece | State |
|---|---|
| Groups in the pool | ✅ `admin` (10), `compliance` (20), `marketing` (30), `planning` (40) |
| The `planning` group | ✅ created by **this** repo's `cdk/lib/cognito_stack.py` |
| App client of our own | ✅ `pciat37670n002pk5ji276k27`, SRP-only, 1h ID token |
| `cognito:groups` parsed into a role | ✅ `_parse_groups` (copied verbatim from marketing) |
| A route that **refuses** a caller | ✅ `require_planning_group`, on every route but `/health` and `/api/me` (currently not enforcing — see above) |
| A second tier for the roster | ✅ `require_admin`, keyed off the pool's existing `admin` group |

Proven against the deployed Lambda, not just in tests — a synthetic event carrying
`cognito:groups = "[marketing]"` gets:

```
403 {"detail":"Your account is not authorised for the planning roadmap."}
```

which is the whole reason the shared pool is acceptable.

**This repo owns the group; the marketing repo was not touched.** Two reasons, and
both would have caused real damage:

1. Adding `planning` to marketing's `_GROUPS` means running `cdk deploy` there,
   which would also ship the **uncommitted working-tree changes** sitting in that
   repo (`cdk/lib/cognito_stack.py`, `fast/app/auth.py`, `fast/app/main.py`, a new
   `fast/app/routes/identity.py`, `fast/tests/test_auth_groups.py`). A deploy is a
   bad way to discover what someone had half-finished.
2. Creating it by hand with `aws cognito-idp create-group` is the exact
   hand-created-resource mistake the DNS section below documents — the next
   `cdk deploy` finds a resource CloudFormation did not create and fails.

Each app owning its own group means neither stack can surprise the other. Marketing's
stack manages its three; ours manages the fourth.

Note the pool's actual `_GROUPS` is `admin`/`compliance`/`marketing` only — the
`partner-office*` roles were designed and then **cut from scope**, and that file
explains why leaving them defined would be worse than deleting them: a group with no
permissions mapped to it fails closed, so whoever got added would be refused
everywhere with nothing in the code explaining why.

`_parse_groups` is reused verbatim rather than rewritten: `cognito:groups` arrives in
three shapes (real list from a decoded JWT; `"[a, b]"` Java-style string from a REST
authorizer; intact list from an HTTP API), and getting that wrong silently empties
everyone's roles — which fails *open* if you are checking for a forbidden group and
*closed* if you are checking for a required one. We check for a required one.

Still outstanding in the marketing repo: it parses roles but still refuses nobody.
That is a pre-existing gap there and is not this app's to close.

### Two tiers, and where the boundary is

`require_planning_group` and `require_admin` answer **different questions**, and
conflating them is the mistake to avoid:

| | Question | Enforced now? |
|---|---|---|
| `require_planning_group` | may you use this app at all | no — `ENFORCE_GROUP=false` |
| `require_admin` | may you act on somebody **other than yourself** | **yes** |

The roster rule: **anyone signed in may add and edit themselves; only an admin may
touch anybody else, or deactivate or delete at all** — including on their own record,
because a delete blanks assignments across lanes nobody is looking at.

`ADMIN_GROUP` defaults to `admin`, which is the pool's **existing** group. So a
compliance-tool admin is an admin here too. Deliberate, and the alternative was a
second group to create and populate for three people.

**The roadmap itself — projects, phases, milestones — is outside all of this and
stays editable by everyone.** The team schedules its own work; putting one person in
the path of every date change is exactly what the workbook did.
`test_editing_the_roadmap_is_not_admin_only` pins that, because it is the thing most
likely to be "tidied" into admin-only later.

Two traps worth knowing:

- **`active` is a field on `PersonUpdate`.** Without an explicit refusal, a
  deactivated non-admin could `PATCH` themselves back on and the admin-only
  deactivation would mean nothing. The check reads `body.changes()`, **not** a
  comparison against the stored row, so "absent" stays different from "sent" — a
  deactivated person can still correct their own name.
- **`is_admin` is deliberately not a dependency.** Several routes need the *answer*
  rather than the *refusal* — `create_person` allows the call and then decides which
  address you may use.

`DEV_ADMIN` (default true) grants the admin group **only on the no-claims bypass
path**, so an environment with it left set cannot promote a real authenticated caller.
Set `DEV_ADMIN=false` to reach the non-admin paths locally — an admin never sees the
button they are not allowed to press, which is the half that is easy to ship broken.

The frontend hides what it cannot do via `is_admin` on `/api/me`, threaded from
`AppShell` through the router's outlet context. **That is a courtesy, never a check**:
every one of those controls is enforced again on the server. Identity is `null` until
`/api/me` answers, and that state is treated as "a plain member who is nobody" so
controls appear a beat late rather than appearing and being taken away.

---

## DNS: `planning.qconnect.qwnext.com`

**Live.** `planning.qconnect.qwnext.com`, in hosted zone `Z05305531FKJD83WOWYAD`
(`qconnect.qwnext.com`) — alongside the marketing tool's
`compliance.qconnect.qwnext.com`, which lives in the same zone. An A-alias to a
CloudFront distribution, created by `cdk/lib/frontend_stack.py`; the cert is in
us-east-1, created by `cdk/lib/certificate_stack.py`.

The gate was checked *before* the cert was requested, which is the whole point of
the rule below:

```
$ dig +short NS qconnect.qwnext.com @8.8.8.8
ns-1624.awsdns-11.co.uk.   ns-395.awsdns-49.com.
ns-1510.awsdns-60.org.     ns-782.awsdns-33.net.
```

**Do not try to use `planning.qwnext.com`.** The topology is not what it looks
like in the Route53 console:

- The apex `qwnext.com` is served by **Cloudflare** (`kyrie`/`miki.ns.cloudflare.com`).
  The Route53 zone named `qwnext.com` (`Z08296411YFZ6NJE0DYBV`) is **vestigial** —
  it is not authoritative for anything.
- Each working app subdomain resolves because **Cloudflare holds an NS record**
  delegating it to Route53. Verify with
  `dig NS <name> @kyrie.ns.cloudflare.com +noall +authority` — a delegated name
  returns a referral in the AUTHORITY section.
- So any *new* first-level subdomain of `qwnext.com` needs a Cloudflare change,
  which is outside AWS credentials.

The cost of getting this wrong is already visible in the account: `intake.qwnext.com`
and `onboarding.qwnext.com` have Route53 zones that **do not resolve**, because the
Cloudflare delegation was never added. Their ACM certs sat pending and died —
`VALIDATION_TIMED_OUT`. Six FAILED certs in us-east-1 trace to this.

**Rule: never request an ACM DNS-validated cert for a name until
`dig +short NS <parent> @8.8.8.8` returns nameservers.** ACM gives up after 72h.

Nesting under an already-delegated zone sidesteps all of it — no Cloudflare
access, no new hosted zone, no validation risk. There is **no** `*.qwnext.com`
wildcard cert, so each hostname needs its own cert in **us-east-1** (CloudFront
requirement, regardless of where the app runs).

Marketing's `frontend_stack.py` uses `DnsValidatedCertificate`, which is deprecated
in CDK v2. This repo uses `Certificate` with
`validation=CertificateValidation.from_dns(zone)` instead — CloudFormation writes
the CNAME natively rather than through a custom-resource Lambda.

The A record and cert are created **by CDK at deploy time**. Do not hand-create
them in Route53 — CDK will collide with pre-existing records.

**`aws-cdk-lib` must not be 2.116.0 here**, which is what the marketing repo pins.
Cross-region references are broken in that release — any stack with
`cross_region_references=True` dies at synth with `Cannot find module
'../../dist/core/cross-region-ssm-reader-provider.generated'`, because the module is
missing from the wheel. The certificate has to be in us-east-1 while everything else
is ca-central-1, so the feature is not optional. Pinned to `2.253.1`, which is also
below the `2.254.0–2.256.0` range AWS flags in aws-cdk#37949.

---

## Why we left Excel

Not preference. Measured, on the live file:

- **60% of real phases are fully populated** (27 of 45). The rest are missing a
  date or a progress value, and Excel renders every gap without complaint.
- **QWAPP's first three phases had start/end values of `0`, `3`, `5`, `9`** —
  relative day offsets someone typed, which Excel read as January 1900 and drew
  bars for.
- **All of Qfeed's dates were `#REF!`** from a row deletion. The lane just drew
  nothing.
- **Conditional formatting silently re-anchors.** Net Worth's 13 CF rules were
  re-pointed at Qfeed's rows by a row insert, so the lane rendered blank. Excel
  corrupted the chart and reported nothing. This is what made the workbook
  untenable: it can be wrong in ways nobody can see.
- **Style indices are not stable.** Excel garbage-collects and renumbers the
  style table on every save, breaking anything programmatic. Our own generator
  hardcoded xf 146–151; after one user save they were 94–100.
- **No history, and single-writer.** No answer to "who moved this date"; every
  edit needs the file closed first.

Design consequences:

- Dates and progress are **nullable**, and "unscheduled" is a first-class state
  rendered as such. Better an explicit gap than a bar in 1900.
- Assignments are foreign keys to people, not free text. The workbook had
  `"Liam -> AI Hire"` typed into a DRI cell.
- Every mutation writes an audit row (`before`/`after`/`user_email`), same
  pattern as the compliance audit table.

---

## Layout

```
planning_roadmap/
├── migrate/
│   ├── extract_workbook.py     ← xlsx → typed JSON + data-quality report
│   └── strip_manager_email.py  ← one-off: drop the dead attribute from the table
├── fast/                        ← FastAPI backend
│   ├── app/
│   │   ├── auth.py              ← identity; the group check + the admin tier
│   │   ├── config.py
│   │   ├── main.py
│   │   ├── db/models.py         ← item shapes; UNSET sentinel; Decimal handling
│   │   ├── db/queries/          ← projects.py, people.py, audit.py
│   │   ├── routes/              ← projects.py, people.py, roadmap.py, identity.py
│   │   ├── schemas/             ← projects.py, people.py
│   │   ├── roles.py             ← the CLOSED role vocabulary (what someone IS)
│   │   ├── skills.py            ← the CLOSED specialisation vocabulary (what they CAN DO)
│   │   └── seeds/load_roadmap.py ← roadmap.json + people map → DynamoDB
│   └── tests/                   ← 159 tests, moto-backed. test_people_self_service.py
│                                  is the who-may-act-on-whom rule, over HTTP
├── src/                         ← React frontend
│   ├── App.tsx                  ← LoginGate + BrowserRouter + the two routes
│   ├── pages/
│   │   ├── RoadmapPage.tsx      ← the Gantt and its toolbar
│   │   └── TeamPage.tsx         ← roster, roles, skills, workload;
│   │                              hides what a non-admin cannot do
│   ├── components/
│   │   ├── chart/               ← ChartCanvas.tsx (shared grid chrome),
│   │   │                          Timeline.tsx, TeamChart.tsx, Lane.tsx,
│   │   │                          Bar.tsx, parts.ts, SegmentedBar.tsx,
│   │   │                          MilestoneMarks.tsx
│   │   ├── AppShell.tsx         ← masthead, tabs, /api/me check, <Outlet/>
│   │   ├── PhaseEditor.tsx      ← add/edit one phase; edit sends only dirty fields
│   │   ├── ProjectEditor.tsx    ← add/edit one project; seeds STANDARD_PHASES
│   │   ├── MilestoneEditor.tsx  ← add/edit one milestone; two-step delete
│   │   ├── PersonEditor.tsx     ← add/edit one person; the skill picker
│   │   ├── Legend.tsx (primitives + StateKey, exported), LoginGate.tsx
│   ├── services/                ← api.ts (axios + token interceptor), auth.ts
│   ├── styles/                  ← theme.ts (palette + state colours), ui.ts
│   ├── utils/                   ← dates.ts (UTC-anchored), phaseState.ts,
│   │                              segments.ts, milestones.ts, assignments.ts
│   │                              (the person-centric transpose) — all pure,
│   │                              all tested
│   └── types.ts                 ← ProjectSummary vs Project — see below
├── cdk/                         ← (slice 5) CDK stacks
└── CLAUDE.md
```

### migrate/extract_workbook.py

```bash
python3 migrate/extract_workbook.py                    # report only
python3 migrate/extract_workbook.py --write roadmap.json
```

Read-only by default and refuses to guess: anything unparseable is reported, not
defaulted. Sheet layout it depends on (verified against the live file):

- Lane rows `[8, 16, 24, 32, 39, 47, 55, 63, 73]`: **B**=project, **D**=DRI, **E**=SUPPORT
- Rows beneath, to the next lane, are phases: **B**=name, **C**=owner, **F**=progress
  (0..1), **G**=start serial, **H**=end serial
- `C`/`D`/`E` are populated on a lane's first phase row for QWAPP only, and are
  not treated as authoritative — owners come from the lane row.

Asserts every lane row still names a project, so a layout change stops the run
instead of emitting an empty roadmap.

**Cell-tokenising rule** (this bug shipped once): the self-closing alternative
must come first — `r'<c\b[^>]*?/>|<c\b[^>]*?>.*?</c>'`. The other order lets
`<c r="A10" s="11"/>` swallow the following cell.

---

## Data model

Three tables. Projects and phases share one, partitioned on `project_id`, so
reading a project and everything in it is a single Query.

```
planning-roadmap-projects   PK project_id, SK sk
                            sk = "#PROJECT"          → name, lane_order,
                                                       dri_email, support_email, active
                            sk = "PHASE#<phase_id>"  → name, phase_order, owner_email,
                                                       start, end, progress, structural
                            sk = "MILESTONE#<id>"    → name, date, note, done
planning-roadmap-people     PK email                 → name, roles [str], active,
                                                       specialisations [{skill, level}]
planning-roadmap-audit      PK entity_id, SK timestamp
                            GSI entity-timestamp-index (PK entity, SK timestamp)
                                                     → action, before, after, user_email
```

Assignments are attributes on the project row rather than their own table. With a
DRI and a support owner and nothing else in prospect, a join table would be three
extra reads to answer a question two attributes already answer.

`#PROJECT` is punctuation-first on purpose: `#` (0x23) sorts before `P` (0x50), so
the project row is always `items[0]`. With the obvious `PROJECT`, phases would sort
first (`PHASE#` < `PROJECT`) and any caller assuming otherwise would be wrong only
once a project had phases. `MILESTONE#` lands between the two (`M` 0x4D < `P`), which
changes nothing — `#` still beats both.

`Phase.structural` marks the Maintenance band — ongoing support, not scheduled
work, so it legitimately has no dates or progress and must not be drawn as a bar.
Writes that put a date on one are refused.

### Milestones

A dated point on a lane — "Beta launch", "Regulatory deadline" — drawn as a diamond.
**Not a zero-length phase**: a phase is owned work with a duration and progress, a
milestone is a moment something is due. Modelling one as the other gives you either
phases with no owner or milestones stuck at 0% forever, and both draw as a lie.

- `date` **is nullable**, same argument as everywhere else. "We need a beta launch
  and nobody has committed to when" is real; the alternative is somebody inventing a
  date. Undated milestones are **not drawn** — there is nowhere honest to put them on
  a time axis — so the lane's tooltip is the only thing that names them. The gap
  report used to announce them too, and is gone.
- `done` is **independent of the date**, and the gap between them is the interesting
  bit. Past its date and `done: false` is a *missed deadline*, and `utils/milestones.ts`
  draws it as `missed`. Deriving doneness from the date would mark every slipped
  commitment as achieved.
- Milestone dates widen the roadmap span. A deadline past the last phase must not
  fall off the right edge of the chart — that is why it was recorded.

**Never name a pydantic field after its own type.** This cost a debugging round:

```python
from datetime import date
class MilestoneBase(BaseModel):
    date: Optional[date] = None      # ← field type is NoneType, not date
```

Python evaluates the assignment before the annotation, so `date` is already rebound
to `None` in the class namespace when `Optional[date]` resolves — giving
`Optional[None]`, i.e. `NoneType`. Pydantic then builds a field that accepts `null`
and **422s every real date**. Nothing fails at import and no query-layer test
notices; the only symptom is a rejected request that is plainly valid. Fixed by
importing as `ISODate`, pinned by `test_milestone_date_field_is_actually_a_date`.

### The rule the backend exists to enforce

**Absent ≠ null.** A field omitted from a PATCH is left alone; a field sent as
`null` is stored as null, meaning *unscheduled*.

This is the whole reason we left Excel, so it is defended in three places:
`UNSET` in `db/models.py`, `.changes()` (Pydantic `exclude_unset`) in `schemas/`,
and `_apply_update` in `queries/projects.py`, which — unlike the marketing tool's
`update_rule` — deliberately **does** SET a field whose value is None.

Copying `update_rule`'s `if value is None: continue` here would make it impossible
to clear a date once set, and `tests/test_nullable.py` exists to catch that.

Related: `from_item` tests `progress is not None` rather than truthiness, because
`0.0` ("started, nothing done") and `None` ("nobody has said") are different states.

**On a POST the rule inverts, and that matters for ordering.** There is no stored row
to leave alone, so an omitted field takes the server's default. For the nullable
fields that is exactly right — every default is the honest one (no dates, no
progress, unassigned), so the create forms send the whole body and let the blanks
land as null.

The exception is `phase_order` and `lane_order`, which both default to **0** in
`create_phase` / `create_project`. A row created without one therefore sorts to the
*top* of its list, above work that was already there — it looks like the app inserted
the new item in the wrong place. The client computes and sends the next order
instead (`nextPhaseOrder` in `Lane.tsx`, `nextLaneOrder` in `RoadmapPage.tsx`).
Neither column is unique; a collision just falls through to the name tiebreak.

### Validate input, not output

`PersonCreate.email` is `EmailStr`. **`PersonOut.email` is a plain `str`**, and the
asymmetry is deliberate.

`EmailStr` on a *response* model means one malformed row — a hand-edited item, a
pre-check migration, an address in a form nobody anticipated — raises
`ResponseValidationError` and kills the **entire** list response. The whole roadmap
returns 500 because of one person.

Found by running `demo.py`: nine perfectly good projects were sitting in the table
and `GET /api/roadmap` answered `{"detail":"Internal server error"}`. Same reasoning
as the `from_item` defaults — one bad record degrades to one odd row, never a dead
endpoint. Pinned by `test_one_odd_stored_address_does_not_kill_the_whole_response`.

### Roles — what somebody IS

A second **closed** vocabulary, in `fast/app/roles.py`, served by `GET /api/roles`,
held against a person as `roles: [str]`. Six entries: `ba`, `ux`, `software-engineer`,
`qa`, `data`, `leadership`.

**At least one is required to add yourself.** It is the one field on `PersonCreate`
with no default and no server-side fallback: a defaulted role would put "Software
engineer" against a designer and look authoritative. `roles: []` is a 422 on both POST
and PATCH — you may change your roles, you may not end up with none.

**But `[]` still has to render**, because every person seeded from the workbook is in
exactly that state. The workbook recorded names, not disciplines, and
`load_roadmap.py` refuses to infer one from a first name for the same reason it
refuses to infer an email address. Strict at the edge, forgiving on read — the same
asymmetry as `PersonOut.email`. The roster shows "No role set" on those rows, which is
a prompt rather than an error.

**Three different things here are called a "role".** Conflating them is a real bug:

| | what it is | lives on |
|---|---|---|
| `Role` in `app/roles.py` | what somebody **is** — BA, UX, … | the person's row |
| `'dri' \| 'support'` | what they are **on one lane** | the project's row |
| Cognito `admin` group | what they may **do** | outside this app entirely |

The frontend type is `PersonRole`, **not** `Role` — `Role` was already taken by
`'dri' | 'support'` in `utils/assignments.ts`, and importing the wrong one typechecks
for exactly as long as both remain string unions.

**Nothing may read a role as a permission.** People set their own roles, so anything
treating `leadership` as authorisation would make admin a two-click self-service
operation. Pinned by `test_leadership_is_a_job_not_a_permission`.

**Roles are not a coarser grain of skills.** A role says "I am a designer"; a skill
says "I can be staffed onto this". A back-end engineer who is handy with CSS holds
`front-end` and is not `ux`. Roles stay coarse — six entries, for reading a roster at a
glance — and granularity belongs in skills, which is the list that grows. The two
pickers are deliberately shaped differently: skills are a welded segmented pill ("pick
one of four"), roles are detached chips with ticks ("pick as many as apply"). Reusing
the segmented control would make the form lie about what it accepts, and a BA ticking
UX would watch BA switch itself off.

Like `specialisations`, `roles` **replaces rather than merges**, so `PersonEditor`
compares the set by value (`utils/roles.ts`) instead of trusting RHF's `dirtyFields`.
That comparison is order-insensitive because it has to be: RHF yields checkbox values
in catalogue order while the API returns them in stored order, so comparing as
sequences would treat every open-and-save as a change and write an audit entry
claiming somebody edited their role when they only looked at it.

### The manager field is gone

`manager_email` was removed everywhere in Aug 2026. It was **write-only data**:
captured in a dropdown on the person form and read nowhere — not on the roster row,
not in the chart, not in the gap report that still existed at the time. A field no
code reads is a field nobody
maintains, so keeping it meant stale reporting lines that still looked authoritative
to anyone opening the table or an export.

Removing it from the code does not remove it from DynamoDB, which is schemaless, so
`migrate/strip_manager_email.py` does the data half: a paginated scan plus a
conditional `REMOVE` per item. Dry-run by default, prints exactly who is about to lose
which manager, and re-running is a no-op. `REMOVE` rather than setting null, and
`update_item` rather than a read-modify-write `put_item` — the latter would race with
somebody editing their skills at that moment and silently discard the edit.

The workbook's reporting lines (Timan → Joe, Meherzad → Joe) are gone for good, and
`migrate/extract_workbook.py` no longer extracts them.

As of the 2026-09-01 deploy the script has nothing left to do against `dev`: the one
row that still carried the attribute was `joe@qwealth.com`, and deleting Joe through
the UI took it with him. Keep the script anyway — `prod` has not been through this,
and a table restored from a pre-removal backup would need it again.

### The gap report is gone, and so is a layer of toolbar chrome

Removed together on 2026-09-01 as clutter. What went, and what did NOT:

| Removed | Where it lived |
|---|---|
| `GET /api/roadmap/gaps` and its `Gap`/`GapReport` models | `fast/app/routes/roadmap.py` |
| The "Still to decide" panel and its toggle | `src/components/GapsPanel.tsx` (deleted), `RoadmapPage.tsx` |
| `getGaps`, and the `Gap` / `GapReport` types | `src/services/api.ts`, `src/types.ts` |
| Both **Refresh** buttons | `RoadmapPage.tsx`, `TeamPage.tsx` |
| The "carrying nothing" chip and its filter | `TeamPage.tsx` |
| The "Show deactivated" toggle | `TeamPage.tsx` |
| "Adding somebody here does not grant them a login." | `TeamPage.tsx` |
| The legend group: *done / remaining / progress not recorded / single-day phase* | `src/components/Legend.tsx` |

**The chart itself is unchanged.** It still draws the pale fill for remaining work,
the hatching for unrecorded progress, and the diamond for a single-day phase — only
the key explaining them is gone. `HatchedSwatch` stays exported because `TeamChart`
uses it; `DiamondSwatch` stays because `MilestoneSwatch` is built on it. Deleting
either would break a chart that was supposed to be untouched.

**"progress not recorded" still exists, and must.** `describeProgress` in
`chart/Bar.tsx` returns that phrase for a null progress, and it is a statement about
one phase, not a key entry: it shows on an expanded phase row, in a segment tooltip
and in the screen-reader description. Grepping the string and deleting every hit
would "finish the job" by making an unknown progress render as blank or as `0%`,
which is the exact lie this app exists to prevent. The key entry went; the caption
stays.

Two consequences worth knowing before you "fix" something that looks broken:

- **Nothing announces an unowned lane or a placeholder DRI any more.** The gap report
  was the only thing that did. `test_people_delete.py` still pins the underlying
  guarantee — deleting a DRI blanks the assignment rather than deleting the project —
  it just asserts it against `/api/roadmap` instead.
- **The Team page shows deactivated people unconditionally**, and that is deliberate,
  not a leftover. `active` is still an admin-editable checkbox on the person form, so
  hiding inactive rows by default would make the first person an admin unticks vanish
  from the only screen that can tick them back on. They render greyed and marked
  "(deactivated)", which separates them without stranding them.

The argument the gap report was built on was about *Excel*: a missing date, a `#REF!`
and a relative day offset all render as either nothing or a bar in January 1900, so
the sheet could be wrong in ways nobody could see. This app does not have that
problem — unscheduled is a state it renders as such, not an absence it has to infer —
so the report was answering a question the tool had already designed away. The same
analysis still runs once, offline, in `migrate/extract_workbook.py`, which is where it
belongs: against the workbook, not against live data on every request.

### Specialisations — what somebody CAN DO

A **closed** vocabulary in `fast/app/skills.py`, served by `GET /api/skills`, held
against a person as `[{skill, level}]`. Ten skills: front-end, back-end,
infrastructure, relational-databases, non-relational-databases, networking, ui-ux,
qa-testing, data-engineering, compliance.

Closed because the workbook's free-text ownership is exactly what we are leaving:
"frontend", "front-end", "Front End" and "FE" are four strings and one skill. No
numeric proficiency scale, and **no cap on how many people hold `primary`** — a 422
on the third primary would only teach people to lie to the form.

**Four answers in the UI, three of them stored:**

| The form says | Stored as | Means |
|---|---|---|
| No | *nothing* | absence is the answer |
| Yes, but slowly | `secondary` | can do it, will take longer |
| Yes | `primary` | the obvious person to ask |
| No, but wants to learn | `learning` | cannot do it today, wants the work |

Two things about that table are load-bearing.

**The stored values still read `primary`/`secondary` because the wording changed and
the data did not.** The labels used to be "yes" and "could cover". Relabelling is a
presentation change and must never rewrite what is in DynamoDB, so there was no
migration and there should never be one — see the enum-values point below.

**`learning` is NOT a third rung of the capability ladder.** It describes appetite,
not ability, and everything about how it is drawn says so: on the chips it gets a
diamond `◇` and a dashed edge rather than a paler pink, and in the picker it gets a
blush fill with an outlined ring instead of a place on the grey → bubblegum → hot-pink
ramp. Painting it as a weaker "yes" would file appetite under ability, which is the
one thing it is not.

It **does** count as cover: a learner shows up when you go looking for who could take
something, which is the whole point of recording it — a learner who is never surfaced
is never offered the work. That only holds while the level is displayed next to the
name everywhere the list is read, so do not add a caller that reads `specialisations`
and drops the level.

One layout note, because it is invisible until it bites: **"No, but wants to learn" is
a long label** and the four segments no longer fit the picker's old 300px grid track.
`Segments` has `overflow: hidden` for its rounded ends, so a cramped row does not wrap
or scroll — it *clips*, and the first casualty is the "No" segment sliding off the
left edge where it cannot be clicked. The track minimum is 460px for that reason, and
`Segments` is `flex-shrink: 0` so the skill name gives way instead of the control.
Nothing in the type system or the tests can see this happen; it was caught by looking.

Three things to know before touching this:

- **The enum *values* are stored against people.** Renaming one orphans everyone who
  holds it and they silently appear to have lost the skill.
  `test_skill_values_are_stable_identifiers` guards it. Do not duplicate the list in
  TypeScript for the same reason — the frontend fetches it.
- **`specialisations` REPLACES, it does not merge.** It is the one exception to the
  absent-≠-null rule above: a merging update could only ever add, so "remove a skill"
  would be unexpressible. `PersonEditor.tsx` therefore compares the resulting *set*
  by value rather than trusting RHF's `dirtyFields`, which flags the whole map dirty
  the moment one skill moves.
- **Rows written before the field existed read back as `[]`.** That is the state of
  the ten people in `dev` right now, not a hypothetical, and getting it wrong 500s
  the roster for everybody. `PersonModel._specialisations` drops malformed entries
  individually rather than failing the row — same rule as `PersonOut.email`.

Gotcha found while testing the form: `PersonCreate.email` is `EmailStr`, which
rejects RFC 2606 reserved domains, so **you cannot add an `@example.invalid` person
through the API**. The seeded fake roster got in via `load_roadmap.py`, which writes
directly. Fine in production, confusing in local demo data.

### Deleting a person, and why deactivate stayed

Two verbs, both kept, because they answer different questions:

| | `POST /api/people/{email}/deactivate` | `DELETE /api/people/{email}` |
|---|---|---|
| does | flips `active` to false | removes the row **and blanks every assignment naming them** |
| assignments | left alone | `dri_email` / `support_email` / `owner_email` set to null |
| means | "left the team; the history stands" | "should never have been here" |

Deactivate moved from `PATCH` to its own `POST .../deactivate` sub-path: it is not a
field edit, and expressing it as one meant a client could half-perform it by sending
`{"active": false}` alongside other changes.

**The delete blanks assignments because nothing in DynamoDB can.** Assignments are
stored as email *strings*, not foreign keys — there is no referential integrity to
lean on, so a deleted person otherwise leaves dangling addresses that render as an
owner nobody can look up. The blanking is done server-side in one pass and the
response reports what it touched; `TeamPage.tsx` mirrors the same blanking into its
local `projects` state rather than refetching, so the chart and the roster cannot
briefly disagree.

`DangerButton` lives in `styles/ui.ts`, not in the page — delete is now offered in
more than one place and the affordance for "this does not come back" must look
identical everywhere.

### Audit

Keyed `entity_id` + `timestamp`, **not** the marketing tool's `timestamp`-only
shape, which its own `config.py` records as a mistake: every item in its own
partition, no key to query by, so any question means scanning the whole table.

`audit.record()` swallows its own errors and logs them. Deliberate: for an internal
planning tool, a transient DynamoDB error should not block someone rescheduling
work. **This trade is the wrong way round for the compliance tool**, where the trail
is the artefact a regulator is shown — re-decide it if this app ever acquires a
similar obligation.

---

## Running the backend

```bash
(cd fast && python3 -m venv venv && ./venv/bin/pip install -r requirements-dev.txt)
(cd fast && ./venv/bin/python -m pytest tests -q)      # 159 tests, moto-backed
(cd fast && ./venv/bin/python demo.py)                  # seeded demo, no AWS at all
(cd fast && ./run.sh)                                   # needs real AWS creds + tables
```

`demo.py` is still the fastest way to click through `/docs`, and it is the only way
to do so without a token — the deployed API keeps `/docs` behind the authorizer,
because the OpenAPI schema names every route and field and that is not something to
publish just because it is convenient for a browser. It runs moto in-process,
creates the three tables in memory, loads `roadmap.json`, and serves on :8000.
Nothing touches AWS and the data dies with the process.

Owner addresses in the demo are `@example.invalid` — RFC 2606 reserved, so they can
never resolve or receive mail. Chosen over the convenient `firstname@qwealth.com`
precisely because a plausible-looking wrong address is the failure mode this
migration exists to end; nobody can mistake these for real and load them.

`run.sh` sets `ENFORCE_GROUP=false`, because a local run has no API Gateway
authorizer and therefore no claims — every request would otherwise be 401. It logs
a warning per request so this can never be confused with the deployed config.

**Signing in as somebody, locally.** The roster is self-service, so "is this row mine,
and am I an admin" is a thing to exercise. Two env vars, both read by `demo.py`:

```bash
./venv/bin/python demo.py                                  # admin, demo@example.invalid
DEV_ADMIN=false ./venv/bin/python demo.py                   # plain member
DEV_ADMIN=false DEV_USER_EMAIL=ha@example.invalid \
  ./venv/bin/python demo.py                                 # a plain member ON the roster
```

The third is the interesting one: as `ha@example.invalid` you get exactly one Edit
button, on your own row, with no Delete and no Deactivate. The default identity is
deliberately **not addable** — `demo@example.invalid` is an RFC 2606 reserved TLD that
`EmailStr` refuses, so `POST /api/people` 422s. That is confusing for about a minute
and then correct: this identity stands in for a Cognito account, and letting it create
roster rows would put a fictional person in the seeded data.

Neither var is ever set by the CDK. `DEV_ADMIN` grants the admin group only on the
no-claims bypass path, so even if one leaked into a deployed environment it could not
promote a real authenticated caller — but setting them in `lambda_stack.py` would make
every request appear to come from one address while looking, from the outside, exactly
like a working deployment.

### Loading the migrated data

```bash
python3 migrate/extract_workbook.py --write roadmap.json
(cd fast && ./venv/bin/python -m app.seeds.load_roadmap \
    --roadmap ../roadmap.json --people ../people.json)          # dry run
```

`people.json` is `{"Joe": "joe@qwealth.com", ...}` and **must be written by hand**.
The workbook identifies owners by first name; the data model keys on email. There
is no safe derivation — `first.lower() + "@qwealth.com"` is a guess, and a wrong
guess creates a person who looks real, owns projects and never receives anything.
An unmapped name is a hard stop unless `--allow-unmapped` is passed.

The loader creates, it does not merge, and it refuses to run against a non-empty
table: a second run would silently double every lane.

**What is loaded in `dev` right now**: all nine projects and 54 phases, plus a
roster of **ten fabricated `@example.invalid` people** attached as DRI/Support on
seven of the nine lanes (Qfeed and QWAPP Expansion Packs are the two left
unassigned).

This contradicts the intent recorded above, and the intent was the better call:
the workbook's owner cells were blank, the real addresses are still an open
question, and the honest representation of "we do not know who owns this" is
null. A lane with a fake DRI reads as answered when it is not, so **the roster should
be cleared before anyone is shown the tool**, not carried forward. (This used to be
enforceable — the gap report counted a placeholder as a filled slot — but that report
has been removed, so nothing catches it now.)

---

## Running the frontend

```bash
cd /Users/thomas/planning_roadmap
npm install
npm run dev          # Vite on :5173
```

`npm run dev` proxies `/api` and `/health` to `http://localhost:8000`, so run
something on :8000 alongside it. Two choices, and the difference matters:

- `fast/run.sh` — talks to the **real ca-central-1 tables**. An edit made at
  localhost:5173 is a write to `dev` data.
- `fast/demo.py` — moto, in-process, seeded from the workbook. Nothing touches AWS
  and everything vanishes on restart, which makes it the right target for clicking
  through a new screen. **It has no `--reload`**: restart it after a backend change
  or you will spend a while wondering why a new endpoint 404s.

| command | does |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run build` | `tsc -b && vite build` → `dist/` |
| `npm test` | vitest, 71 tests |
| `npm run type-check` | `tsc --noEmit` |

### Things that will bite

- **`@aws-amplify/datastore` is a direct dependency and pinned exactly**, even
  though no code imports it. `@aws-amplify/ui-react` reaches for it from inside
  its own directory; npm nested it under `aws-amplify/node_modules/` here rather
  than hoisting it as it did in the marketing repo, and Rollup then fails the
  build with "failed to resolve import". The pin forces it to the top level.
  DataStore is fully tree-shaken — aliasing it to a stub produced a *byte
  identical* bundle — so it only needs to **resolve**, not ship. Do not remove it
  to "save weight"; there is no weight to save.
- **`vite.config.ts` needs the `global` shim in two places.** See the comment in
  the file. After editing either, delete `node_modules/.vite`.
- **All date maths is UTC-anchored** (`src/utils/dates.ts`). `new Date('2026-08-13')`
  and `new Date(2026, 7, 13)` differ by hours, which is enough to shift a bar a
  whole column for anyone west of Greenwich. `todayISO()` is the single
  deliberate exception.
- **`ProjectSummary` vs `Project`.** `PATCH /api/projects/{id}` returns
  `ProjectOut`, which has **no phases**. `patchProject` is typed to return
  `ProjectSummary` so that merging the response over a lane is a compile error
  instead of a silently emptied lane. Editors pass the *patch body* up, not the
  response, and `RoadmapPage.tsx` merges field by field.
- **Editors send only `dirtyFields` when editing**, because the API distinguishes
  absent ("leave alone") from null ("clear"). `''` in a form is null. This is why
  clearing a progress box restores "not recorded" rather than setting 0%.
  **When creating they send the whole body** — see the POST note above — so
  `isDirty` must not gate a create button the way it gates a save. A create form
  the user submits untouched is still a valid create.
- **The create and edit forms are the same components**, following `PersonEditor`:
  a null entity prop means create. The props are a discriminated union, so the
  create-only fields (`nextLaneOrder`, `projectId`) and the differing callbacks
  (`onCreated` vs `onSaved`) are enforced by the compiler rather than by comment.
  Projects need both callbacks because POST returns a `ProjectDetail` with children
  while PATCH returns a childless `ProjectOut`; phases and milestones need only
  `onSaved` because both their endpoints answer with the whole entity.
- **New rows are upserted into local state, then re-sorted.** They arrive from a
  single POST rather than a fresh roadmap fetch, so appending without re-sorting
  makes a row sit last and then jump on the next refresh, which reads as the app
  having lost the edit. `sortMilestones` in `utils/milestones.ts` is the shared,
  tested comparator; undated milestones sort last.
- **`progress: null` ≠ `progress: 0`** everywhere. Null renders as diagonal
  hatching, 0 as an empty pale bar, and null is excluded from the lane average.
- **`project.milestones` is typed as required and defaulted in `services/api.ts`.**
  Production is still running a Lambda built before milestones existed, so its
  `/api/roadmap` omits the key entirely and `project.milestones.length` would throw.
  Normalised once at the boundary rather than guarded with `?? []` at each of the
  half-dozen read sites, one of which would eventually be forgotten.
- **Deep links depend on CloudFront mapping 403 *and* 404 to `/index.html`.** S3
  returns 403, not 404, for a missing key in a private bucket, so mapping only 404
  would make `/team` an access-denied page for anyone who typed it or reloaded on
  it. Both are configured in `cdk/lib/frontend_stack.py`; verified against the
  deployed site. This is what lets `App.tsx` use `BrowserRouter` rather than hashes.
- **`AppShell` mounts once and stays mounted** across tab changes, so `/api/me` is
  called once per session. Page state is deliberately *not* hoisted with it —
  switching tabs refetches, which is right for a board several people edit at once.

### Lane colour precedence

`src/utils/phaseState.ts`. The lane takes the colour of the **highest-ranked
incomplete phase that has started**, ranked:

```
Coding 40 > Architecting 30 > Wireframes 20 > Planning 10 > other 0
```

This is a **colour** precedence, not lifecycle order, and **Testing deliberately
ranks lowest** (it falls in `other`). QWAPP has Coding at 85% and Testing at 50%
running together; a lifecycle ranking would paint the most advanced project on
the board grey. A test pins this. The docstring names the two edits needed if
Testing should ever get its own colour.

### The two diamonds

There are now two diamonds on the chart and they mean different things, so they are
kept apart on **three** axes rather than one:

| | same-day phase (`Bar.tsx`) | milestone (`MilestoneMarks.tsx`) |
|---|---|---|
| where | the bar's centreline | its own band at the top of the lane |
| colour | the lifecycle palette | `today` / `danger` / `slateDeep` — the data-state colours |
| fill | solid | solid = due, ringed = missed, hollow = met |

`Bar.tsx` got the diamond first, and for a good reason: four phases in the live data
start and end on the same day, and drawn to scale that is a four-pixel sliver that
reads as a rendering fault. It is not moving. So a milestone has to be unmistakable
against it, and one difference would not be enough — at 10px, hue alone is not a
distinction anybody can rely on.

Status is never carried by colour alone. Solid / ringed / hollow survives a
monochrome print and both common colour vision deficiencies, and every mark states
its status in words in its `title` and `aria-label`.

Two more things in `utils/milestones.ts` that look like details and are not:

- **Milestones on the same day are ONE mark.** Two diamonds at the same percentage
  are one diamond with another invisible underneath it — a deadline hidden by
  geometry. The cluster takes the most urgent status in it, so a missed deadline
  cannot be concealed by a completed one sharing its date, and the count is printed
  beside it.
- **Due *today* is not missed.** Turning a deadline red at midnight on the day it
  falls due cries wolf on every commitment the moment it arrives.

Milestone dates widen the chart's span, in `RoadmapPage.tsx` as well as in the API's
`span_start`/`span_end`. Both, or the two disagree the moment somebody edits a date —
and a deadline set past the last phase is exactly the thing that must not fall off the
right-hand edge.

### The Team Gantt: the same chart, transposed

The Roadmap page answers "what is this project doing". The Team page's schedule
answers "who is free in October" — the same phases, read down the **owner** column
instead of across the lane. `/api/people/workload` cannot answer it: it returns
counts ("DRI ×2, 4 phases"), and a count is a fact about *now*, not about *when*.

The transpose is pure and client-side, in **`src/utils/assignments.ts`**. Not a new
endpoint: the Team page already fetches the whole roadmap to turn project ids into
names, so every phase, owner and date is on hand, and a second source for the same
facts is a second thing to drift.

**No second chart engine.** A person's row is `laneSegments(phasesTheyOwn)` handed to
the existing `SegmentedBar` — so concurrency splitting, hatching, the lifecycle
colours and the extent hairline all mean exactly what they mean on the other page.
`ChartCanvas.tsx` was extracted out of `Timeline.tsx` for this, so the
`left: LABEL_WIDTH; right: 0` alignment rule that keeps a bar at 42% and a gridline at
42% on the same pixel has **one** copy, not two that can drift apart.

**Two weights of mark, because there are two weights of claim.** A phase you own has
its own dates. Being DRI or Support carries none, so the only honest span for it is
the project's own extent — *inferred*, and therefore drawn as a pale band behind and
around the solid bars. Giving them equal weight would make everybody look equally
busy, which is precisely what the workbook did and the reason nobody trusted it. DRI
and Support differ by border style (solid / dashed) as well as fill, and both are
named in the sub-label and the tooltip; nothing depends on telling two pale pinks
apart.

Four things in `assignments.ts` that look like details and are not:

- **Emails are lower-cased on the way in** (`key()`), matching the backend. A stray
  capital would otherwise split one person into two rows, each looking half as loaded
  as they are, and neither wrong on its own terms.
- **`peakOverlap` is not `segments.peakConcurrency`.** That one counts distinct
  *states*, because two concurrent `other` workstreams on one lane are one grey band.
  This counts distinct *phases*, because two simultaneous Coding phases from different
  projects are two real commitments that collapse into a single stripe — and "is this
  person double-booked in October" is the question the chart exists to answer.
- **Milestones do not widen a role span**, unlike the lane span on the Roadmap page.
  A span is drawn work-shaped, so stretching it to a deadline paints work across weeks
  that have none — the exact lie `segments.ts` was written to stop. And widening it
  here would make one project appear to end on two different dates on two pages.
- **`datedSpan(assignments.owned)`, never the union with the role spans.** Its
  predecessor `personSpan` unioned them, and Paul's extent hairline then ran from his
  single-day August phase out to the December end of a project he owns nothing in,
  retracing the band it sat inside and towing the "1 phase" caption three months from
  the phase. Pinned by a test.

**`placeable` is exported from `segments.ts`** so `undrawable` is computed by the very
predicate that excluded the phases — the "2 not scheduled" caption cannot disagree
with what was drawn. Those phases are kept as objects, not counted: "Maintenance
(QWAPP)" is actionable in a way "3 not shown" is not.

**One key per chart.** `Legend.tsx` exports its primitives and a shared `StateKey`;
each chart assembles the key for what it actually draws. Reusing the roadmap's
`Legend` wholesale advertised four marks the team chart never draws (proportional
fills, single-day diamonds, the three milestone states) and could not explain the two
it does — worse than no key, because a reader who cannot find "milestone due" on the
chart concludes the chart is broken, not that the key is generous.

**An empty chart is an answer, so it must not be shown before the answer is known.**
`TeamPage.tsx` gates the panel on `loading && projects.length === 0`; without it the
page asserted "Nobody here is holding anything with a date on it" during the fetch.
The sub-label uses `describeRoles()`, which omits dates *deliberately* — the label
cell is 264px, and "DRI of Enhanced Data Delivery — 24 Aug 2026 to 3 Oct 2026"
truncated to "…— 24 Aug 2026 t", spending the whole cell on a range the band's own
position already states. The dates live in the band's tooltip.

---

## Deploying

```bash
(cd cdk && python3 -m venv venv && ./venv/bin/pip install -r requirements.txt)
(cd cdk && cdk synth)                                   # builds the image too
(cd cdk && cdk deploy --all --require-approval never)
```

Needs Docker running — the Lambda is a container image, not a zip.

Six stacks under `PlanningRoadmap-dev`: `DynamoDBStack`, `CognitoStack`,
`LambdaStack`, `CertificateStack` (us-east-1), `FrontendStack`, and the parent.
**No WAF** — the marketing tool fronts its distribution with a country allowlist;
this one does not, because a CLOUDFRONT Web ACL that blocks by default locks out
whoever has to undo it, and every route but `/health` is already Cognito-gated.
It is a second layer here, not the only one.

Set `domain_name: null` in `cdk.json` to skip the certificate, the distribution and
the DNS record entirely and deploy the API alone.

Things in here that are load-bearing and easy to undo by accident:

- **`cdk.json` runs `venv/bin/python`, not `python3`.** On a pyenv machine `python3`
  is a shim that is usually not this venv, and synth then fails with
  `ModuleNotFoundError: aws_cdk` immediately after a successful `pip install`.
- **The Docker platform is pinned `LINUX_ARM64`** and the function's `architecture`
  matches. Unpinned, a deploy from Apple Silicon builds arm64 for an x86_64
  function and fails at startup with `Runtime.InvalidEntrypoint` — an error that
  says nothing about architecture.
- **The tables are `RemovalPolicy.RETAIN`**, unlike the marketing tool's `DESTROY`.
  This table is the successor to a workbook that exists in one copy on one laptop.
  A `cdk destroy` that silently took the roadmap with it would recreate the original
  problem in a more expensive form.
- **`require_auth` without `enforce_group` raises at synth.** That combination is a
  shared pool with the door open — the authorizer would admit any compliance-tool
  token and the app would wave it through. Better to fail at synth than to find out
  from an audit row.
- **`/health` is the only unauthenticated route**, and it reports a literal
  `{"status": "ok"}` and nothing about the data or the config. An uptime monitor
  holds no Cognito token.
- **`DEV_AUTH_BYPASS` is deliberately not in the Lambda environment.** Setting it
  would make every request appear to come from one address while looking, from the
  outside, exactly like a working deployment.
- **The `/api/*` CloudFront behaviour uses `ALL_VIEWER_EXCEPT_HOST_HEADER`.**
  Without an origin request policy, CloudFront forwards only what the cache key
  contains — and `CACHING_DISABLED` contains no headers, so `Authorization` is
  dropped. Every authenticated call then becomes an anonymous one and API Gateway
  answers 401 for a request the browser definitely sent a token on. Host must still
  be stripped: API Gateway routes on it, and forwarding the CloudFront hostname
  makes it answer 403.
- **The API origin needs `origin_path="/prod"`.** Otherwise `/api/roadmap` reaches
  API Gateway without the stage and comes back 403 — which reads like an auth
  failure and is not one.
- **CloudFront maps both 403 and 404 to `/index.html`.** S3 with a private origin
  answers `AccessDenied`, not `NoSuchKey`, for a missing object, so a 404-only rule
  leaves every refreshed React deep link showing CloudFront's XML error page.

### Getting a token

There is no login screen yet, so a browser gets 401 on everything but `/health`.

```bash
export API=https://planning.qconnect.qwnext.com
export TOKEN=$(cd fast && ./venv/bin/python get_token.py -q --username you@qwealth.com)
curl -s -H "Authorization: Bearer $TOKEN" "$API/api/roadmap"         | python3 -m json.tool
curl -s -H "Authorization: Bearer $TOKEN" "$API/api/roles"           | python3 -m json.tool
curl -s -H "Authorization: Bearer $TOKEN" "$API/api/people/workload" | python3 -m json.tool
```

`get_token.py` does SRP via `pycognito`. The AWS CLI cannot: it has no SRP
implementation, so `--auth-flow USER_SRP_AUTH` sends the first message and stops.
The alternative was enabling `USER_PASSWORD_AUTH` on the app client, which sends the
password itself rather than a zero-knowledge proof of it — a permanent weakening of
the deployed config to save a dev dependency. It is the **ID** token, not the access
token: only the ID token carries `cognito:groups`.

**A caller must be in the `planning` group** or they get 403 with a token that is
otherwise perfectly valid. Add someone:

```bash
aws cognito-idp admin-add-user-to-group --user-pool-id ca-central-1_P8orSDvVO \
  --username <the-uuid-not-the-email> --group-name planning --region ca-central-1
```

The username is the pool's UUID, not the address — `list-users` maps between them.

---

## Open migration decisions

Carried as `null` until answered; none of them block the migration.

**Decision 0, and it gates the rest: the people.** Every address in `dev` is
`@example.invalid` — Artem, David, Ha, Janine, Joe, Jordan, Liam, Meherzad, Paul,
Timan. Nobody supplied these. Real addresses are needed before the tool is shown
to anyone, and until then a DRI shown against a lane is decoration. The table
below describes the *workbook's* gaps, which is the real state of the data.

| Project | Gap |
|---|---|
| Qfeed | no DRI, no support, all five phases undated (`#REF!`) |
| QWAPP Expansion Packs | no DRI, no support |
| D2 | DRI is Joe, no support owner |
| QWAPP | Planning / Wireframes / Architecting are 100% done with 1900 dates |
| DocuTelligence | Planning, Architecting undated |
| Net Worth | Wireframes undated; Architecting/Coding/Testing have no progress |
| Enhanced Data Delivery | Testing undated; Accounts/Transactions/Addresses no progress |

Roster members owning nothing: **Ha, Janine, Artem, Meherzad**. The Team page used to
surface exactly this, with a "carrying nothing" chip and filter; both were removed.
A person holding nothing now shows an empty workload cell and is not counted anywhere,
so this list is the record of it rather than something the tool will tell you.

**Decision 0a: nobody has any specialisations recorded.** The vocabulary exists and
the form works, but all ten people read back `[]`. Filling that in is a person's
judgement, not a migration step, so it is deliberately not guessed.
