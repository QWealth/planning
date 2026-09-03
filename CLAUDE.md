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
  milestones. 435 backend tests + 219 frontend tests pass.
  Verified against the deployed Lambda on 2026-09-01, not inferred from a successful
  `cdk deploy`: `/api/skills` answers with all eleven skills, `/api/roles` answers with
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
  the skill picker is a **three-star rating with a legend**, plus a separate "wants to
  learn" tick (the two are independent axes; **Figma** joined the vocabulary beside
  ui-ux), the roster is **self-service** (edit yourself; admins edit anyone), and
  the `planning` group check is **off** so any pool account can get in. Since *that*:
  people carry **roles** (BA / UX / Software engineer / QA / Data / Leadership /
  Outside engineering — one
  or more, required on sign-up) and the **`manager_email` field is gone** from the
  code and from the data. All of it is **deployed** as of 2026-09-01.
  **Also deployed, on 2026-09-02**: the Board is **grouped by project** with a banner
  and an **"Assign all"** control per group, the onboarding gate dropped **both the
  specialisation picker and the star legend** (half of which was reversed the same day
  — see "Not yet deployed"), and a milestone may be **filed under a phase** — nullable `phase_id`, a "Part of" picker in the editor, and the row drawn
  under its phase in the expanded lane. Verified end to end against `demo.py` in a
  headless browser, not only in unit tests: attaching, detaching and deleting the
  phase out from under a milestone all move the row live, with no console errors.
  Then verified against the deployed Lambda by synthetic proxy event — every
  milestone comes back carrying `phase_id`, and `openapi.json` has it on all three
  milestone schemas — and against CloudFront, which serves the new strings from the
  freshly split `RoadmapPage-*.js` and `TasksPage-*.js` chunks.
  **Not yet deployed** (built and tested on 2026-09-02, awaiting a commit and a
  `cdk deploy`): **a project collapses on both pages, and yours start open** — the
  Roadmap no longer opens all-collapsed, and the Board's project banners now carry the
  chart's own disclosure arrow. See "Collapsed by default, except the ones that are
  yours" below. Also **the onboarding gate asks for specialisations again** — the
  picker is back, none of it is required, and the star legend stays off there. See
  "The onboarding gate". And **dark mode**, black and pink, taken from the operating
  system with no toggle and no icon. See "Dark mode".
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

## Inviting somebody, and the gate they land on

Getting a colleague into this app is **two separate things that deliberately did not
get merged**:

| | grants | creates a roster row | who does it |
|---|---|---|---|
| `POST /api/people/invite` | a Cognito login + the `planning` group | **no** | an admin |
| `POST /api/people` | nothing | **yes** | the person themselves, at onboarding |

Merging them was the obvious design and is the wrong one. An admin knows somebody's
address; they do not know their skills, and a roster row invented on their behalf is
a row nobody owns and nobody corrects. So the invite grants **access and nothing
else**, and the person fills in their own entry the first time they arrive.

`InviteResult` returns `account_created` and `group_added` as separate booleans and
**both false is a normal outcome, not an error** — it means the person already had a
login (very likely, given the shared pool) and was already in the group. Re-inviting
is idempotent and safe.

### Cognito's own email is not enough, and cannot be fixed from here

The pool does email a temporary password. Two things are wrong with it:

1. **It contains no link** — username and password, nothing about where to sign in.
2. **It is branded "QWealth Marketing Compliance Review"**, because the pool is
   shared and the invite template is per-**pool**, not per-app.

Rebranding it would change what the compliance tool's invitees receive, and that
template may well be managed by *their* CDK, in which case an edit from here is
silently reverted on their next deploy. So the gap is closed by a human:
`InvitePanel` renders a ready-to-send block of text with the URL in it, and that text
**names the wrong-looking subject line on purpose**. An unexplained credentials email
about a compliance tool is exactly the shape of a phishing attempt, and the correct
response to one of those is to ignore it — so an invite that does not pre-empt that
gets ignored by the most security-conscious people on the team.

`inviteMessage()` is exported and pure so it can be asserted on without a DOM.

### The onboarding gate

`AppShell` renders `Onboarding` **instead of** the nav when a caller is authorised
but has no roster row. It blocks rather than nudges: a dismissible banner would leave
the roster as "everyone except the people who clicked the X", which is worse than no
roster because it *looks* complete.

It is **a routing gate, not a security one.** Every route stays open server-side;
skipping the screen would grant nothing.

**`onboarded` on `/api/me` FAILS OPEN, and the shell must keep reading it that way.**

```ts
if (identity?.authorised && identity.onboarded === false && identity.email)
```

`=== false`, never `!identity.onboarded`. The field is optional: a backend deployed
before it existed returns `undefined`, and `!` would read that as "not onboarded" and
gate the **whole team** out of a working roadmap behind a form they already filled
in. `_has_roster_row` likewise answers `true` when DynamoDB cannot be reached. Only
an explicit `false`, from a backend that actually looked, blocks anybody.

The gate has **no Cancel** — `PersonEditor.onCancel` is optional precisely so this
screen can omit it, because a Cancel wired to a no-op is a button that visibly does
nothing. Sign-out **is** offered, because "I am not who this account says I am" needs
an answer that is not "close the tab".

The email field is `disabled` and the saved value is taken from `lockedEmail`, **not
from the form** — a disabled input is exactly the kind of thing a form library is
entitled to drop.

**It asks the same questions the Team page does: email, name, role, and what you
specialise in.** The picker was taken off this screen on 2026-09-02 and put back the
same day *by request* — "please make the user pick the skills and stuff when they sign
up" — so read the two together rather than treating either as the last word:

- **The picker is on the gate.** Later is a page a new colleague has no reason to open:
  they are told they are not on the team list, they fill in the form that fixes it, and
  that is plausibly the last time they look at their own row for months. A roster whose
  skills nobody rated cannot answer the question it exists to answer — who could pick
  this up.
- **Nothing in it is required.** This screen blocks, which makes every required field
  on it a field somebody must satisfy before they can use the app at all, and a rating
  extracted under those conditions is a rating somebody invented. Zero stars with the
  box unticked is a real answer and is dropped on both sides — `buildSpecialisations`
  on the way out, `SpecialisationIn.must_say_something` on the way in — so a row
  created here carries exactly what it was actually given. Only name and role are
  enforced, as before. **Proved in a browser:** a submit with no stars touched clears
  the gate and `/api/me` flips to `onboarded`.
- **The star legend stays off**, which is the surviving half of "remove the description
  of the stars". `starScale={false}`, and that flag is *only* about the four-line key
  above the rows: each star still names itself in a `title` and in screen-reader text,
  so the scale is on the row that needs it. The Team page still prints the block, which
  is the differential the browser check asserts — legend absent on the gate, present on
  Team, per-star labels on both.
- **`skills.length > 0` is what actually gates the fieldset** in `PersonEditor`, not
  which screen it is. The only case with nothing to ask is a caller holding an empty
  vocabulary, and a fieldset headed "Specialisations" with no rows under it reads as a
  failed render rather than as a question with no options.
- The cost is one more round trip before the form can draw: `GET /api/skills`, fetched
  **with** `GET /api/roles` in a single `Promise.all` so it is one wait and not two,
  and all-or-nothing — a half-loaded form would look complete and quietly create a row
  with no specialisations, which is the outcome asking here exists to prevent.

A trap worth writing down, found while checking this: asserting "the scale is gone" by
searching `innerText` for `The obvious person to ask` **passes when it should fail**.
Those words are also the `VisuallyHidden` label on every third star, so the check
matches the thing that is meant to survive the legend's removal. The legend renders all
three stars of a row inside *one* span, while the rating rows give each star its own —
so the honest test is whether `★★★` appears contiguously inside a single leaf element.

### Exercising it locally

`demo.py` stands up a **moto Cognito pool** with the planning group already in it, so
"Invite somebody" is clickable offline. Worth the eight lines: the real endpoint
writes to the pool shared with marketing, and a wrong first attempt there does not
fail quietly — it creates an account a colleague gets an email about.

To land on the gate, sign in locally as somebody with no roster row:

```bash
DEV_USER_EMAIL=piper@qwealth.com ./venv/bin/python demo.py
```

`auth.signOut` comes from Amplify's `useAuthenticator`, so it is `undefined` under
`demo.py` and **the Sign out button does not render locally**. That escape hatch can
only be checked in a deployed build.

### The third caller: `/roadmap-invite` in Slack

Inviting somebody used to end with a human copying a block of text out of the web UI
and pasting it into Slack — the step most likely to be skipped, and a login nobody
was told about is *worse* than no login, because it silently consumes an invitation
email that reads like phishing. So Slack can now do the whole thing.

The command lives in the **other repo**: `aardvarkaap/aardvark-aap/src/slack/
roadmap.ts`. Three facts about it matter here.

**The message is composed server-side, and that is the reason `app/invites.py`
exists.** `cognito.py` is *how* the pool is written to, `invites.py` is *what
inviting means*, and the `routes/` are *who may ask*. Both front doors — the web
button and the Slack command — call `perform_invite`, so the phishing-pre-emption
paragraph exists exactly once. It used to be built in the browser from
`window.location.origin`, which meant a dev build could mail a colleague a
`localhost` link.

**Slack's people-picker is the only input, deliberately.** The address is read from
the selected person's Slack profile rather than typed. Typing would be two
descriptions of one human that are free to disagree — creating a Cognito account for
one colleague and DMing the instructions to another, on a pool shared with
marketing. This is what needs the `users:read.email` scope; without it Slack returns
a profile with no `email` and no error, so the command looks broken for a reason
found only in Slack's docs.

**It is authorized by IAM, not Cognito** — an ECS task has no token and cannot get
one. Hence `/api/service/*` as a separate path: a method carries exactly one
authorizer, so this could not be a flag on `/api/people/invite`.

Four things must agree, across two repositories, or this fails with a bare 403 that
names none of them:

| Thing | Where |
|---|---|
| Role name `aardvark-app-task-role` | `aardvarkaap/lib/aardvark-app-stack.ts` (pinned, not auto-named) |
| The same name, allowlisted | `cdk/cdk.json` → `service_caller_arns` |
| `execute-api:Invoke` on the one method | `aardvarkaap/lib/aardvark-app-stack.ts` |
| API id + stage | `ROADMAP_API_ID` in that stack, `ROADMAP_API_HOST` in `roadmap.ts` |

The grant and the allowlist are **two locks, and neither alone does anything**:
without the grant API Gateway refuses the signature; without the allowlist entry
`require_service_caller` refuses the caller. `SERVICE_CALLER_ARNS` empty means the
door is shut, which is the right way for this to be misconfigured.

Two traps worth writing down:

- **Sign the execute-api host, never the custom domain.** SigV4 covers the `Host`
  header, so a request signed for `slxqk1v4x3.execute-api…` and sent to
  `planning.qconnect.qwnext.com` (CloudFront in front of the same API) is rejected as
  a signature mismatch. The custom domain is for browsers; machines talk to the
  gateway.
- **An ECS task role has no `AWS_ACCESS_KEY_ID`.** Credentials arrive through the
  container credentials endpoint, so `aws4` plus environment variables would find
  nothing and sign with garbage. `roadmap.ts` uses `defaultProvider()` for this
  reason.

Matching is on the **role**, not the full ARN, because ECS regenerates the
assumed-role session suffix on every task — `_role_name` in `app/auth.py` reduces
both sides before comparing, and `test_service_invite.py` pins that behaviour.

The Slack command is gated by **Aardvark's own admin list**, a MySQL `admins` table —
*not* the Cognito `admin` group this app uses everywhere else. That is a real
delegation of account-creation power to a permission set maintained in another
system, and it is written into `cdk.json` so the decision is reviewable here.

### The other direction: the Slack picker on the Team page

The command above starts in Slack. The **picker** starts here: the Team page invite
panel lists the Slack workspace and the admin chooses a person, so the address is
*read* rather than typed. Same reasoning as the command's people-picker — a typo
creates a Cognito account on the shared pool and mails a stranger a password — but
reached from the web app, which is where an admin already is.

**Planning calls Slack directly.** Not via Aardvark, which would have been the
obvious reuse: Aardvark's ALB is plain HTTP with no certificate and no service
authentication, so proxying the directory through it would put every employee's
email address in clear text across an unauthenticated endpoint. This Lambda is
**not in a VPC** (`VpcConfig` is empty) and reaches `api.slack.com` over TLS.

The cost is a **shared bot token**: `aardvark-app/slack`, read from Secrets Manager,
never put in a Lambda environment variable — anyone with
`lambda:GetFunctionConfiguration` can read those, which is a wider group than can
read the secret. `lambda_stack.py` grants `GetSecretValue` on that one ARN, and the
`-??????` suffix is mandatory: Secrets Manager ARNs carry six random characters, so
a policy without it matches nothing. The visible consequence of sharing is that the
DM arrives **from Aardvark**, which is consistent with `/roadmap-invite`.

**The picker creates nothing.** It answers "who *could* I invite", not "who is on the
team". Seeding the roster from Slack was considered and rejected: every member would
arrive `onboarded`, the onboarding gate would stop firing for anybody, and the roles
and skills the roadmap runs on would sit empty with nothing left to prompt them.
`on_roster` is the only field that crosses over, and it exists so the picker can say
somebody is already set up instead of letting an admin discover it from the result.

**`GET /api/slack/people` never 5xxs for a Slack problem.** An outage, a missing
scope and an unconfigured secret all come back `200` with `unavailable` set, and the
panel falls back to a typed address — which is what it did before Slack. Losing the
convenience is acceptable; losing the ability to give a colleague access because a
third party is down is not.

Two failure modes that look like nothing:

- **A missing `users:read.email` scope is invisible.** Slack returns every profile
  with no `email` key and *no error*, so the directory filters itself empty and the
  picker looks like a workspace with nobody in it. `list_people` therefore returns
  `{"people", "seen"}` rather than a list, the route turns that into `filtered`, and
  the panel says "42 accounts but no email addresses" instead of "no people found".
- **Adding a scope does nothing until the app is REINSTALLED** to the workspace.

**`slack_user_id` is a delivery route, not an identity.** The email is still the key.
A failed DM is deliberately *not* re-raised — the Cognito account already exists by
then, so failing the request would report "invite failed" for something that
half-succeeded and send the admin retrying into an account that is already there.
`dm_error` comes back instead and the panel shows the copy block.

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
│   │   ├── work.py              ← RFC + task vocabulary; why there is no `superseded`
│   │   └── seeds/
│   │       ├── load_roadmap.py  ← roadmap.json + people map → DynamoDB
│   │       ├── load_jira_tasks.py       ← Jira export → the work table (one-time)
│   │       ├── load_confluence_rfcs.py  ← Confluence export → RFCs (one-time)
│   │       ├── atlassian.py     ← clean_adf: the ONE ADF cleanup, three callers
│   │       └── fix_adf_bodies.py        ← idempotent repair of already-imported bodies
│   └── tests/                   ← 435 tests, moto-backed. test_people_self_service.py
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
│   │   ├── PhaseEditor.tsx      ← add/edit/delete one phase; edit sends only dirty fields
│   │   ├── ProjectEditor.tsx    ← add/edit one project; seeds STANDARD_PHASES
│   │   ├── MilestoneEditor.tsx  ← add/edit one milestone; two-step delete
│   │   ├── PersonEditor.tsx     ← add/edit one person; the skill picker
│   │   ├── Legend.tsx (primitives + StateKey, exported), LoginGate.tsx
│   ├── services/                ← api.ts (axios + token interceptor), auth.ts
│   ├── styles/                  ← theme.ts (palette as CSS vars, light+dark pairs,
│   │                              state colours, themeVars), ui.ts
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

Four tables. Projects and phases share one, partitioned on `project_id`, so
reading a project and everything in it is a single Query.

```
planning-roadmap-projects   PK project_id, SK sk
                            sk = "#PROJECT"          → name, lane_order,
                                                       dri_email, support_email, active
                            sk = "PHASE#<phase_id>"  → name, phase_order, owner_email,
                                                       start, end, progress, structural
                            sk = "MILESTONE#<id>"    → name, date, note, done
planning-roadmap-people     PK email                 → name, roles [str], active,
                                                       specialisations [{skill, stars,
                                                       wants_to_learn}]
planning-roadmap-audit      PK entity_id, SK timestamp
                            GSI entity-timestamp-index (PK entity, SK timestamp)
                                                     → action, before, after, user_email
planning-roadmap-work       PK item_id
                            GSI kind-updated-index (PK kind, SK updated_at)
                            kind = "rfc"             → title, body, status, project_id,
                                                       owner_email, decided_on
                            kind = "task"            → title, body, status, project_id,
                                                       parent_id, owner_email, due,
                                                       task_order
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
- `phase_id` **is nullable, and null is the ordinary case.** A milestone may name the
  phase it belongs to ("Infra hardening signed off" is a moment inside Infra) and may
  name none ("Regulatory deadline" is a date the whole lane answers to and is not a
  step in any one stage of it). The picker in `MilestoneEditor` therefore leads with
  "Not tied to a phase" and defaults to it: a required attachment would file every
  company-wide date under whichever phase happened to be nearest, and that phase
  would then look like it owned a commitment nobody gave it.

#### A milestone under a phase, and the four rules that hold it there

1. **The reference is checked in the query layer, not the schema.** `_check_phase_ref`
   in `db/queries/projects.py` refuses a `phase_id` that is not a phase of *this*
   project, because DynamoDB has no foreign keys and a schema cannot read another row.
   Same place as every other cross-row rule in the app.
2. **Only a *sent* `phase_id` is validated.** `update_phase` validates its merged
   result; `update_milestone` deliberately does not, so a row whose phase was broken
   by hand can still have its name fixed. Checking the merged value would block an
   unrelated rename on an already-dangling row.
3. **Deleting a phase detaches its milestones** — `detach_phase_milestones`, called
   before the delete. Same "delete promotes, never cascades" rule as a subtask whose
   ticket goes away, and each detach is its own audit row so the history is
   discoverable from the milestone and not only from the phase.
4. **`create_project` refuses an inline milestone `phase_id` with a 400.** No phase in
   that request has an id yet, so any value there is either a lie or a dangling
   reference. Create, then PATCH.

On the client, `placeMilestones` (`utils/milestones.ts`) splits a lane's milestones
into `byPhase` and `onLane`, and an **unresolvable `phase_id` falls back to the lane**
rather than being dropped — the same argument as `decorate`'s dangling `parent_id`:
the server has already decided, the payload is merely stale, and vanishing from the
only screen that lists a commitment is the failure this app exists to end. The
EXPANDED lane draws the attached ones directly under their phase, indented a second
step (`PhaseLabelCell`'s `$nested`); the COLLAPSED lane ignores the attachment
entirely, because a diamond's position is its date and a date does not move by being
filed under Infra.

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

### Reordering lanes, and why it renumbers instead of swapping

`lane_order` has been in `PROJECT_UPDATABLE` since the table was designed, so **there
is no backend work in reordering the roadmap** — it is a PATCH of a field that was
always writable. What was missing was any way to *reach* it: `ProjectEditor` set it
once on create and nothing could touch it afterwards, so the order everyone read the
board in was frozen at whatever order the spreadsheet happened to have.

The Roadmap toolbar has a **Reorder** button. It holds a **draft order** (`draftOrder`
in `RoadmapPage.tsx`, project ids only) while each lane swaps its Edit button for
▲/▼, and writes nothing until **Save order**. A draft rather than a PATCH per click,
because reordering is a sequence of moves converging on an arrangement — saving each
step would write and *audit* half a dozen intermediate orders nobody wanted, and two
fast clicks would race two overlapping PATCH pairs.

**The obvious implementation — swap the two lanes' `lane_order` values — is wrong
here, and the stored data hits it.** Nothing has ever enforced uniqueness on that
column (see the paragraph above), and the workbook seed produced ties. Swapping two
*equal* orders writes the same numbers back: the user clicks Move up, the row does not
move, and nothing on screen explains why. So `utils/laneOrder.ts` **renumbers the
visible list to its array index** and emits only the rows whose stored value actually
differs. That cannot no-op, it self-heals (after one save the orders are dense and
distinct), and the stored number ends up meaning exactly what the screen shows.

Two consequences worth knowing:

- **Renumbering is not an edit.** The seed is sparse, so `laneOrderChanges` has rows
  to write the instant the mode opens. Gating Save on that would offer to save
  something the user never did and greet them with "3 lanes will be renumbered". Save
  is gated on `orderChanged` — a *positional* comparison against the stored order —
  which also makes move-and-move-back correctly go quiet. `pendingOrder.length` is
  only ever used to *report* how many rows a real change will write, which is often
  more than the number moved.
- **Only the visible (active) lanes are renumbered.** An archived lane keeps its old
  order and can therefore collide with a renumbered active one. This is the same
  collision `nextLaneOrder` already tolerates, for the same reason: the cost is two
  lanes adjacent in an unexpected order, and only if somebody restores an archive.

`saveLaneOrder` issues the PATCHes in parallel and **rejects on the first failure
while the rest land**, so a failed save leaves the stored order part-applied. There is
no honest rollback — the successful writes are committed — so `saveOrder` refetches
rather than keeping its draft on screen. The error message is set *after* `load()`,
because `load()` clears the error on its way in and would otherwise wipe it.

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
held against a person as `roles: [str]`. Seven entries: `ba`, `ux`,
`software-engineer`, `qa`, `data`, `leadership`, `outside-engineering`.

**`outside-engineering` is the catch-all**, added by request. Six of the seven name a
craft; this one names the absence of one — operations, product, compliance, marketing,
finance — so somebody who does none of the delivery disciplines has an honest row
instead of picking the nearest wrong answer. It is **one entry rather than four**
deliberately: splitting it would read better on a roster and would be four guesses
about an org chart this app does not model, made at the moment somebody is filling in a
form about themselves, and a role nobody picks consistently is a filter that returns
the wrong people. It sits **last** in the picker, like `other` at the bottom of the
phase-state ranking, because a list that offers the catch-all first invites people to
stop reading. `test_the_catch_all_is_last` pins the position, not just the membership.

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
`front-end` and is not `ux`. Roles stay coarse — seven entries, for reading a roster at a
glance — and granularity belongs in skills, which is the list that grows. The two
pickers are deliberately shaped differently: skills are a star rating plus a separate
tick ("how much, and do you want more"), roles are detached chips with ticks ("pick as
many as apply"). Giving roles a rating would invite the question of how many stars of
BA somebody is, which is not a thing; giving skills plain chips would throw away the
grading the staffing question is entirely about.

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
| The matching *progress not recorded* item on the Team chart's key | `chart/TeamChart.tsx`, and `HatchedSwatch` with it |
| The two summary chips: *Today \<date\>* and *N projects · N phases · N milestones* | `RoadmapPage.tsx` |

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
against a person as `[{skill, stars, wants_to_learn}]`. Eleven skills: front-end,
back-end, infrastructure, relational-databases, non-relational-databases, networking,
ui-ux, figma, qa-testing, data-engineering, compliance.

Closed because the workbook's free-text ownership is exactly what we are leaving:
"frontend", "front-end", "Front End" and "FE" are four strings and one skill.
**No cap on how many people hold three stars** — a 422 on the third expert would only
teach people to lie to the form.

Catalogue order is the form's order; `PersonEditor` maps straight over it. Figma sits
next to ui-ux rather than at the end of the enum where new members otherwise land, and
`test_figma_is_offered_next_to_ui_ux` pins that so a later addition does not drift it.

**TWO AXES, AND NEITHER IMPLIES THE OTHER:**

| Field | Range | Means |
|---|---|---|
| `stars` | 0–3 | what they can do **today** |
| `wants_to_learn` | bool | whether they want to be **given this work** |

The rungs, worded in the first person because people are usually describing
themselves. These live in `src/utils/skills.ts` as `STAR_LABELS` and are rendered as a
legend above the picker, so the scale is stated once rather than implied by each row:

| Stars | Label |
|---|---|
| 0 | Not one of their areas |
| 1 | Can help out, with somebody alongside |
| 2 | Can do it, but it will take longer |
| 3 | The obvious person to ask |

**This replaced a single four-valued `level`** (`primary`/`secondary`/`learning`).
`learning` was welded onto a capability ladder while explicitly not being a rung of
one, so every consumer needed a comment telling it not to sort `learning` as a weaker
`secondary`. Splitting the axes makes the ordering *arithmetic*
(`b.stars - a.stars || Number(a.wants_to_learn) - Number(b.wants_to_learn)`, in
`compareSpecialisations`) instead of a `Record<SkillLevel, number>` lookup table that
every new consumer had to remember to extend, and it makes the combination the old
control could not express — three stars *and* wants more of it — sayable.

A zero-star entry with no appetite says nothing and is **refused** by
`SpecialisationIn.must_say_something` (422) rather than stored; the form drops the row
instead of sending one. Zero stars *with* appetite is a real and useful answer: that
person is exactly who a staffing search should surface when nobody else is free.

`stars` **defaults to 2, not 3**. Omitting the rating must not silently make somebody
the obvious person to ask — that is a claim about them they did not make, and it is
the one that gets acted on when work is handed out.

**NOTHING WAS MIGRATED, AND THE READ PATH IS THE MIGRATION.** Rows still holding a
`level` string are mapped on read in `PersonModel._specialisations`
(`primary`→3, `secondary`→2, `learning`→0 + `wants_to_learn`, anything else→2), which
is already the "one bad record must not 500 the endpoint" layer. There is no backfill
script and no downtime. **Do not delete that mapping once the table looks converted** —
the tests under "the migration, which only exists on the read path" in
`fast/tests/test_skills.py` are its only proof.

Reads are lenient, writes are strict, and the asymmetry is deliberate:

- A **write** of `stars` outside 0–3 is a 422. `SpecialisationIn` also sets
  `extra="forbid"`, so a browser left open on the pre-stars bundle posting
  `{"skill": ..., "level": "primary"}` gets an error rather than having the `level`
  ignored and the person silently re-recorded at the default two stars.
- A **read** clamps instead of raising: hand-edited data and a future scale with more
  rungs both have to land somewhere, and raising would take the whole roster down over
  one person's row. `clampStars` mirrors this frontend-side, where a non-finite value
  is treated as *no rating* rather than as a huge one.

Three things to know before touching this:

- **The enum *values* are stored against people.** Renaming one orphans everyone who
  holds it and they silently appear to have lost the skill.
  `test_skill_values_are_stable_identifiers` guards it. Do not duplicate the list in
  TypeScript for the same reason — the frontend fetches it. The **scale** is the
  exception and is hardcoded in `src/utils/skills.ts`: three fixed rungs bounded by
  their own constant are not data the way a growing vocabulary is, and fetching them
  would cost a round trip to be told what `MAX_STARS` already says. A fourth rung is a
  change to `fast/app/skills.py` *and* a deploy of both halves.
- **`specialisations` REPLACES, it does not merge.** It is the one exception to the
  absent-≠-null rule above: a merging update could only ever add, so "remove a skill"
  would be unexpressible. `PersonEditor.tsx` therefore compares the resulting *set*
  by value (`sameSpecialisations`, in `src/utils/skills.ts`) rather than trusting RHF's
  `dirtyFields`, which flags the whole map dirty the moment one control moves. It lives
  under `utils/` so it is unit-testable — importing `PersonEditor` would pull in
  `services/api.ts`, which configures a Cognito pool at import time.
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

### Deleting a phase is the other half of seeding one

A new lane is seeded with six standard phases (`STANDARD_PHASES` in
`ProjectEditor.tsx`), and that seeding is deliberately generous on the argument that
it is easier to remove a stage than to remember one. `PhaseEditor` carries the
matching Delete, so **removing a stage a project does not have is the normal use of
it, not an escape hatch for mistakes.** Before it existed the only way to correct an
inapplicable Wireframes row was to leave it undated forever, which the chart reads as
"planned, nobody has scheduled it" rather than "there is none".

Real delete, not an archive flag, for the same reason as milestones: an archived phase
would still carry dates and progress, so it would go on widening the chart's span and
feeding the lane's rolled-up state while drawing nothing — a lane captioned
"Coding · 40%" with no Coding bar on it. The audit row keeps the whole before-snapshot,
which is where one deleted in error is read back from.

Two things that look incidental and are not:

- **The 404 guard on the route is load-bearing.** DynamoDB's `delete_item` is happily
  idempotent, so answering 204 for an unknown phase_id would be free — and wrong,
  because the UI drops the row from the lane on any 2xx. A stale id would vanish from
  the screen and reappear on the next load, which reads as a lost edit.
  `test_deleting_an_unknown_phase_is_a_404_not_a_silent_success` pins it.
- **`Lane.tsx` closes the editor before calling `onPhaseDeleted`.** The editor is
  rendered *under the row for the phase being deleted*, so the other order strands an
  open form editing something that no longer exists.
- **Its milestones survive it.** The backend detaches them (see "Milestones" above)
  and the client needs no matching change: `placeMilestones` already falls back to
  the lane for a `phase_id` it cannot resolve, so the deadline hops from under the
  phase to the lane's own list in the same render, without a refetch.

### RFCs and tasks: one table, two kinds

A written decision (`kind: "rfc"`) and a unit of work (`kind: "task"`) share
`planning-roadmap-work`. They are one entity because **a ticket and a subtask are the
same thing** — the user said so, and modelling them apart would have meant two tables
whose only difference was which one was allowed a parent.

Both have a **nullable `project_id`**, which is the whole reason the table exists.
`project_id` is the projects table's *partition key*, so "how we do code review" —
a decision about no project in particular — is literally unrepresentable there
without inventing a sentinel partition to hold the homeless rows.

`list_rfcs`/`list_tasks` **Query `kind-updated-index`**, not Scan. `list_projects`
still scans, and that is the thing this table was designed not to repeat.

**Tickets vs subtasks: `parent_id`.** Null means top-level. Nesting is capped at one
level and the cap is checked in **both directions** — you cannot parent onto a
subtask, and you cannot give a parent to something that already has children. Two
checks rather than a reachability walk, so cycles are impossible by construction
rather than by a search that has to be right every time.

**Delete promotes, it does not cascade.** `delete_task` re-parents children to
top-level *before* removing the parent. The other order leaves children pointing at a
dead id, which does not orphan them visibly — it makes them vanish from any board
that groups by parent. Each promotion is written to the audit trail as its own
update: a subtask that appears at the top of the backlog with nothing in its history
to explain how it got there is a worse bug than the one being avoided.

RFCs and tasks take **separate audit entities** (`ENTITY_RFC`, `ENTITY_TASK`) even
though they share a table, because `/history` filters on entity and "every decision
that was withdrawn" and "every task that got reassigned" are questions from different
screens.

**The status vocabulary is served, never hardcoded in the client.**
`/api/rfcs/statuses` and `/api/tasks/statuses` return `{status, label, description,
closed}`. `closed` travels with each entry precisely so the frontend does not need a
second copy of `RFC_CLOSED` in another language — adding a sixth status is one
backend deploy. The list page treats an **unknown** status as OPEN, so a backend
running ahead of the frontend hides nothing.

#### The frontend side

- **`src/components/Markdown.tsx` is the only place react-markdown is called**, and
  the docstring there is load-bearing: the library is safe because it builds React
  elements rather than using `dangerouslySetInnerHTML`, so raw HTML in an RFC body is
  *ignored*. **Adding `rehype-raw` would turn that into stored XSS** — bodies are
  written by one signed-in colleague and rendered in another's tab. `remark-gfm` is
  safe and stays.
- **Routes are lazy** (`src/App.tsx`). Markdown is ~165 kB needed by exactly one
  route; the split moved the entry chunk from 983 kB to 919 kB *while* adding it.
  `Suspense` lives in **AppShell, wrapped around its existing
  `<Outlet context={identity} />`** — not around a nested `<Outlet />`, because
  react-router's `useOutlet` always installs a context provider, so an inner outlet
  would shadow `identity` with `undefined` and silently make every page's
  `useIdentity()` return null.
- **`/rfcs/new` is a real route, not a modal**, and the `new` sentinel cannot collide
  because ids carry an `rfc_` prefix. "Here, write it up" should be a link somebody
  can send.
- Grouping and summarising live in **`src/utils/rfcs.ts`** as pure functions, because
  the project has vitest but no jsdom — "an RFC whose project was deleted still
  appears, labelled by its id" is untestable inside a component.

#### The Board (`TasksPage.tsx`, `TaskPage.tsx`, `TaskEditor.tsx`)

The **Board** tab is the backlog. `/tasks` is columns-by-status, `/tasks/:itemId`
is one ticket with its subtasks, and `/tasks/new` is the editor with nothing
loaded — same shape as the RFC pair, and the `new` sentinel is safe because ids
carry a **`tsk_`** prefix (note `tsk`, not `task`).

- **`TaskEditor` is one component for tickets and subtasks alike**, and on an edit
  it sends **only `dirtyFields`**. That is not a bandwidth nicety: `parent_id: null`
  *promotes*, so a form that posted all its values would send `parent_id: null`
  every time somebody fixed a typo in a subtask's title. Each edit would look
  correct in isolation while the backlog quietly flattened over a week. The empty
  option in that select is likewise a **promotion, not a blank** — sent as `''` the
  backend looks for a ticket whose id is the empty string and 400s the whole edit,
  so `buildTaskPatch` coerces `'' → null`.
- **A task with children renders the parent select disabled**, reading "A ticket of
  its own". Disabled rather than absent, so the field does not vanish between one
  task and the next.
- **The body is a plain `textarea`, kept deliberately short.** A task is a line with
  a note attached; the thing you write paragraphs in is an RFC. The shape of the
  field is the only thing telling anybody which of the two they are supposed to be
  writing, so do not grow it and do not render it as markdown.
- **Two kinds of empty column, and only one is worth drawing.** An empty "In
  progress" is a fact about the week and stays. An empty "Done" *while the closed
  toggle is off* is guaranteed empty by the toggle, and spends a fifth of the
  board's width restating what the "Show N closed" button already says.
- **Owners in the filter come from the tasks, not the people roster.** Work is
  routinely owned by somebody who has not been onboarded into this app yet.
- **Parent lines are decorated from the whole list, not the filtered one**, so a
  subtask keeps its "↳ parent" caption when the parent is filtered out.
- `const NO_PROJECT = ' none'` — a select's value is a string, so "unattached only"
  needs a sentinel that cannot be a project id. Without it the filter collapses into
  "no filter" and silently shows everything.
- **`repeat(auto-fit, 225px)`, measured rather than guessed.** Five tracks plus four
  14px gaps need `5 * track + 56` inside a grid measuring 1194px at a 1280px window,
  which caps the track at 227px. **Do not "improve" this to `minmax(200px, 225px)`:
  the floor is dead code.** `auto-fit` computes its repetition count from the MAX
  sizing function when that is definite, and the tracks then render at exactly that
  max — measured, as `grid-template-columns: 250px 250px 250px 250px` on a grid wide
  enough for a fifth. Two wrong guesses were corrected only by reading the computed
  value back out of the browser.

#### The board is grouped by project, and the groups are in roadmap order

One flat set of status columns was the first version and it did not survive contact
with 287 imported tasks: "Backlog · 141" is a number nobody can act on, and the one
question actually being asked of the board — *what is outstanding on Tax* — meant
reading every card's project caption. So `groupTasks` (`utils/tasks.ts`) splits the
list and `TasksPage` draws a **banner per project** with the status columns repeated
underneath it. The ordering, the unattached-first rule and the deleted-project label
live in `groupByProject`, **shared with the RFC list** so the two pages cannot come
to disagree about what order the projects go in.

- **Ordered by the roadmap's `lane_order`, not alphabetically and not by volume.**
  The board and the chart are two views of one plan, and a reader who has learned
  the order of the lanes should not have to learn a second one. Reordering lanes on
  the roadmap reorders the board.
- **"Not tied to a project" is a group, and it comes first.** A nullable
  `project_id` is a deliberate state, so its tasks get a heading of their own rather
  than a bucket at the bottom that reads as leftovers.
- **A project with no tasks gets no banner.** Nine empty lanes of five empty columns
  is a screenful of nothing; the project filter still lists every project, so
  nothing becomes unreachable.
- **Empty status columns inside a group are still drawn** (as `—`), for the same
  reason as before: an empty "In progress" under Tax is a fact about the week.
- **Grouped on the task's OWN `project_id`, never its parent's.** A subtask may be
  attached to a different project from its ticket, or to none while the ticket has
  one, so inheriting would invent an attachment nobody typed — and it would disagree
  with the toolbar's project filter, which reads `task.project_id` directly. A filter
  and a heading answering the same question differently is the kind of bug people
  find by noticing a task is missing. The visible cost is that a subtask can appear
  under a different banner from its ticket, and the card's `↳ parent` line is what
  pays for it.

#### "Assign all", and why a bulk write asks first

`AssignAll.tsx` sits in each banner. 287 tasks arrived from Jira with almost no
assignee — Jira's own field was often unset, and where it was set it was a display
name we refused to guess an address from — and setting the same owner forty times
through forty forms is not a workflow, it is how the owner column stays empty.

- **It writes exactly the rows drawn under its own banner**, because it is handed the
  already-filtered list rather than looking tasks up by project id. "What is on
  screen under this heading" is a rule somebody can hold in their head; "everything
  in the project, including what the toggle is hiding" is not.
- **It confirms in place, and the question carries the count and the person**:
  "Assign 14 tasks in Tax to sam@qwealth.com?". A count is what turns this from a
  button somebody presses to see what it does into a decision. This is the only
  control in the app that writes to dozens of rows from one click, and there is no
  undo.
- **The writes are sequential.** There is no bulk endpoint, so it is N PATCHes
  either way; sequential is what lets a partial failure say *"Assigned 14 of 31
  before this: …"*. Fired in parallel, a rejection says nothing about how much
  landed.
- **Rows already owned by the chosen person are skipped** (`tasksToAssign`), so the
  audit trail does not fill with PATCHes that set a field to the value it held.
- The trigger's label carries the count once somebody is picked — `Assign 3`, not
  `Assign all` — and is disabled **with a title explaining why** rather than hidden.
  "Everybody here is already theirs" is a useful answer; a button that disappears
  when you pick a name reads as a broken picker.
- **It is not rendered at all while its section is collapsed.** That is the first
  rule again rather than a new one: with the board folded away there are no rows drawn
  under the banner, and a bulk write whose scope you cannot see is exactly what the
  confirm step exists to prevent. The banner's count is not a substitute — it says how
  many, not which.

#### Collapsed by default, except the ones that are yours

Both project views fold, and both open **the projects you are answerable for** and
nothing else. Asked for as *"make project collapsable; default view is uncollapsed for
project ur responsible for"*, and it is two halves on two pages.

The Roadmap's lanes were **already** collapsible and defaulted to all-shut, which is
right for a stranger and wrong for everybody else: the lane you are DRI on is the
reason you opened the page, and finding it behind a chevron every time is a hunt down
a list of nine. The Board's banners were **not** collapsible at all, and nine sections
of five columns is a page nobody reaches the bottom of.

- **"Responsible for" means DRI *or* Support** — `isResponsibleFor` in
  `utils/projects.ts`. The pair exists so no lane has a single point of failure (the
  same reason `assignmentsByPerson` records both roles even when one person holds
  both), so opening only your DRI lanes would hide the half you are most likely to
  have forgotten. Compared **lower-cased**, because these are addresses and not keys.
- **A null email never matches a null field.** Without that guard every unowned lane
  would spring open for every signed-out viewer.
- **Owning a phase inside a lane does not count.** That is a dated piece of work with
  a bar of its own, answered by the Team page's per-person chart; this question is
  about the lane, not a stretch of it.
- **The Board adds two rules, in `defaultOpenGroups` (`utils/tasks.ts`).** A section
  also opens if **you own a card in it** — on a board that outranks the lane's roles,
  and it is what keeps *filter by owner: me* from leaving every section shut, which
  reads as no results — and the **unattached section always opens**, because it has no
  project and therefore no DRI, so no rule about responsibility could ever reach it.
- **Seeded once, in an effect, guarded by a `useRef`.** It cannot be a `useState`
  initialiser: neither the projects nor the identity exist at mount, one coming from
  `/api/roadmap` and the other from `/api/me`. And it must not re-run — the seed is an
  **opening position, not a rule the page keeps enforcing**, so without the one-shot
  guard "Collapse all" would spring back the moment anything else re-rendered.
- **Gated on `identity !== null`, which means "`/api/me` has answered"** and not
  "somebody is signed in". Seeding before that lands would open nothing, burn the
  one-shot, and leave the page in the all-collapsed state this replaces. If `/api/me`
  never answers, nothing is seeded — the correct failure, since guessing would either
  open all nine or claim a responsibility that is not ours to claim.
- **The Board seeds from the UNFILTERED board.** Which sections are yours is a fact
  about the projects and about who owns what, not about the toolbar; seeding from the
  filtered sections would make the opening position depend on whatever filter happened
  to be set.
- **The Board reuses the chart's `Disclosure`**, not a second arrow of its own. The
  banner already borrows the phase row's blush ground and pink rule on purpose, and
  the control that opens a lane on the Roadmap should be the control that opens a
  section here. Vite now emits `parts-*.js` as a chunk shared by both pages.
- **Expand all / Collapse all is in both toolbars**, and on the Board it measures
  itself against the sections **on screen** — a filtered board's button has to describe
  the board in front of you. The cost is that "Collapse all" leaves a section open if a
  filter is currently hiding it, and it reopens where it was when the filter comes off.

Proved in a headless browser against `demo.py` signed in as a seeded roster address,
by reading each disclosure's own `aria-expanded` **and counting the columns actually
drawn** — "the arrow says open" and "the board underneath exists" are two claims and
only the second one matters. As Jordan (DRI *and* Support on QWAPP, owner of one card
on Tax): QWAPP open and eight lanes shut on the Roadmap; on the Board, QWAPP open by
role, Tax open by ownership, "Not tied to a project" open by rule, Net Of Fees shut
with zero columns and no assign-all. Collapse all then stayed collapsed, which is the
one-shot guard doing its job.

#### A deleted `project_id` is not the same as no project

`src/utils/projects.ts` exists because a task attached to a deleted project and a
task attached to nothing are **different facts**. Rendering a blank for both makes
the deliberate case look like data loss and the data loss look deliberate. So
`resolveProjectName` falls back to `Unknown project (<id>)`, and the label lives in
one function rather than the three places it was previously spelled.

`projectOptions` is the other half, and it fixes a bug that is invisible on screen:
**a select whose value matches no option reports `selectedIndex: -1` and draws
empty, while React Hook Form keeps its own copy of the value and submits it
anyway.** The editor looked like it had lost the project and would have written the
dead id straight back. It appends a trailing option for any current value with no
live project — last, so it never displaces a real choice. `RfcEditor` had the same
latent bug and now shares the fix.

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
(cd fast && ./venv/bin/python -m pytest tests -q)      # 435 tests, moto-backed
(cd fast && ./venv/bin/python demo.py)                  # seeded demo, no AWS at all
(cd fast && ./run.sh)                                   # needs real AWS creds + tables
```

`demo.py` is still the fastest way to click through `/docs`, and it is the only way
to do so without a token — the deployed API keeps `/docs` behind the authorizer,
because the OpenAPI schema names every route and field and that is not something to
publish just because it is convenient for a browser. It runs moto in-process,
creates the four tables in memory, loads `roadmap.json`, and serves on :8000.
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

### Importing from Jira and Confluence

Both are **one-time ports, already run**. Neither writes to Atlassian, neither syncs,
and there is no `jira_key` or `confluence_page_id` column — a field supporting a sync
that was explicitly not built is wrong within the month. Provenance goes in the body
instead: every imported row ends with the source key, the URL, and what the source
claimed about itself at the moment it was read.

```bash
(cd fast && ./venv/bin/python -m app.seeds.load_jira_tasks \
    --export /tmp/jira_export.json --allow-unmapped)             # dry run
(cd fast && ./venv/bin/python -m app.seeds.load_confluence_rfcs \
    --export /tmp/confluence_rfcs --allow-unmapped)              # dry run
```

**What landed**: 287 tasks (231 top-level / 56 subtasks) from Jira, and 11 RFCs from
Confluence, 4 of them owned by `thomas@qwealth.com`. Verified against the table rather
than the loaders' own output: no dangling `parent_id`, nothing nested deeper than one
level, no leftover ADF, every row traceable to its source page or issue.

Three decisions worth knowing before touching either loader:

- **Jira status collapses by `statusCategory`, not by name.** The category keys
  (`new` / `indeterminate` / `done`) are stable across workflows; the per-project status
  *names* are not. So Architecting, Wireframing, Testing, Blocked/Hold and Code Review
  all become `in-progress`, and the original name survives in the body. An unknown
  category is a hard stop, not a shrug onto backlog.
- **Neither loader invents an owner.** Jira withholds `emailAddress` site-wide on this
  instance (298 of 304 null) and Confluence gives display names only. 281 tasks
  therefore have no owner, and the display name goes in the body. The one exception is
  `AUTHOR_EMAIL` in the RFC loader, four pages, and `check_author_roster()` makes the
  people table veto it before anything is written.
- **`SKIP_PAGES` and `PAGE_STATUS` are human judgements recorded in code**, with the
  sentence from the page that decided each one, rather than patched into the export.
  Four of the fifteen exported pages are an audit, an execution plan, a conventions
  guide and a description of shipped behaviour — useful documents, none of them a
  decision record. The export stays a faithful copy of Confluence; the judgement is
  reviewable and arguable in the diff.

**`clean_adf` in `seeds/atlassian.py` is the one place any of this rewrites somebody's
text**, and it is deliberately narrow. Atlassian leaks `<custom data-type="mention">…`
wrappers into both Jira descriptions and Confluence bodies, and `react-markdown` v9
without `rehype-raw` **escapes** unknown tags rather than dropping them — measured with
a real render, not assumed; the first guess was the opposite and it was wrong. But a
blanket tag strip would have been data loss: these documents contain `<uuid>`,
`<filename>`, `<write table details here>`, `<optional int FK>` and whole JSX snippets
as content. So the regex matches `<custom data-type=` and nothing else, and half of
`tests/test_atlassian_markup.py` asserts what it must **not** touch.

**The footer's whitespace is load-bearing, and this is the lesson worth keeping.**
`text\n---` is a **setext H2** in markdown, not a paragraph followed by a rule. The
footer opened with a single newline, so all 298 imported rows rendered the closing
sentence of their description as a large heading and showed no separator at all. The
footer's own facts, as consecutive plain lines, were one paragraph and ran together
into an unreadable sentence.

**419 tests passed throughout.** Every one of them asserted a substring — `"A-1" in
body`, `"browse/A-1" in body` — and a substring survives a whitespace bug perfectly
intact. It was found by rendering a real stored body through react-markdown and reading
the HTML, which is the only thing that could have found it. There are now tests that
assert *shape* (`"sentence.\n\n---\n" in body`, and `"sentence.\n---" not in body`),
and `footer()` lives in `seeds/atlassian.py` so the two loaders cannot drift apart.
**When a change is about how something renders, render it.**

`fix_adf_bodies.py` repairs both defects in rows already written: 59 bodies for the ADF
wrappers, then 298 for the footer. It is idempotent, covers tasks and RFCs, and is
scoped to `created_by in ("jira-import", "confluence-import")` — so a body somebody
typed in the app is outside its blast radius. The footer fix is anchored on the
importer's own `Imported from …` line rather than on the markup, because `text\n---` in
a human's document is a heading they meant to write. `tests/test_fix_adf_bodies.py` has
a whole class for what it must not touch.

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
| `npm test` | vitest, 219 tests |
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

### Dark mode

Black and pink, **taken from the OS and nothing else**. No toggle, no icon, no stored
preference, no `matchMedia` listener, no `ThemeProvider` — one
`@media (prefers-color-scheme: dark)` block, following the `prefers-reduced-motion`
precedent already in `ui.ts`.

The mechanism is in `src/styles/theme.ts`. Every colour is a `[light, dark]` pair in
`TOKENS`, and `palette.x` is no longer a hex string but the string `var(--c-x)`. That is
the whole reason this was a small change: **271 interpolations across 27 files kept
working untouched**, because they were already `${palette.border}` and still are. The
variable name is *derived* from the key (`hotPink` → `--c-hot-pink`), so the two
spellings cannot drift apart. `themeVars` emits both blocks and is interpolated at the
top of `GlobalStyle` — first in the file, because a custom property must be declared on
an ancestor before anything can read it. `shadow.*` works the same way.

Two rules decide every value, and they are the ones to defend in review:

1. **The chrome inverts, the data does not.** `STATE_STYLE` — the five lifecycle fills —
   is deliberately *not* routed through `palette`; it holds literal hex and is
   identical in both themes. A bar's colour is the project's state, so a legend swatch
   must match the bar it explains and a screenshot must mean the same thing in either
   theme. Routing `STATE_STYLE` through the palette is the obvious wrong turn here; a
   browser check asserts the Coding fill is `rgb(224, 33, 138)` both ways.
2. **What sits on a pink fill flips with the fill.** Light mode's accent is *darker*
   than the page, dark mode's is *lighter*, so white-on-pink breaks in dark. Hence the
   `onAccent` token — white in light, near-black `#1A0510` in dark — used at the ~8
   places a label sits on a saturated fill (active nav tab, primary button, role chip,
   today badge, heavy-load chip, three-star chip). It exists because `deepMagenta` is a
   *fill under white text* in light mode and *accent text* in dark, which is a genuine
   collision and not a naming problem.

`color-scheme: light dark` on `:root` hands the native controls over too — scrollbars,
the select dropdown, the wants-to-learn checkbox, the caret. Without it those stay white
on an otherwise black page.

**The three `rgba(255,255,255,…)` left in `SegmentedBar.tsx` are correct and must stay.**
They are the hatching and the band hairline, drawn *on a lifecycle fill*, which is the
same in both themes — so they have no relationship with the page behind them. Making
them ink-coloured would put a dark hatch on a bright pink bar to match a background it
never touches.

**The sign-in gate is not our markup, and that is where this nearly shipped broken.**
`LoginGate.tsx` remaps Amplify's design tokens, and those remaps *do* inherit —
`--amplify-colors-font-primary` computes to our ink on every node inside the shell. The
inputs were still drawn in `hsl(210 50% 10%)` anyway, because **Amplify declares its
component tokens at `:root`** (`--amplify-components-fieldcontrol-color:
var(--amplify-colors-font-primary)`), and a custom property's `var()` is substituted
**where it is declared, not where it is used**. The substitution had already happened
against Amplify's default palette before our override on a descendant was ever visible.
Adding more `--amplify-colors-*` remaps cannot fix that; only overriding the component
token, or setting the property outright, can. So `.amplify-label`, `.amplify-input`, the
show-password toggle and `.amplify-button--primary` now set `color` directly.

In light mode the bug was invisible — Amplify's near-black on our white is merely the
*wrong* near-black. In dark mode it was a **1.15:1 input and a 1.79:1 label on a black
card**: a sign-in form nobody can read, on the first screen a user sees. Nothing in the
type-check, the 219 unit tests or the authenticated route sweep could catch it, because
the sweep runs signed in and never renders the gate at all. **A screen the automated
sweep cannot reach needs its own check** — that is the general lesson, not the Amplify
specific.

Verified by reading **computed** styles under `page.emulateMedia({ colorScheme })` and
computing WCAG contrast in-page, rather than screenshotting and squinting — "dark enough
to look right" and "readable" are different questions and only the second has an answer.
Ink on ground is 15.77:1 light and 17.22:1 dark; a sweep of all four routes found zero
text under 3:1. One **pre-existing** wrinkle the sweep surfaced and dark mode did not
cause: the light theme's active nav tab is white on PANTONE 219 C at **4.42:1**, just
under AA for body text. Dark mode's is 6.69:1. Fixing it means moving a brand colour, so
it is flagged rather than silently changed.

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

### The gridline overlay paints over everything, and what has to opt out

`Overlay` in `ChartCanvas.tsx` draws the week gridlines and the today line **once**,
over the whole lane stack, and is rendered *before* `{children}`. Because it is
`position: absolute` and the rows are not positioned at all, it paints **above every
row** whatever the source order says. Over a bar that is the whole point — the today
line has to read as being in front of the work it crosses, and `pointer-events: none`
is there so it does not swallow clicks on the bar people most want to click.

Over a **form** it is wrong, and it was: open a phase editor and the gridlines ran
straight through the labels, the inputs and the Save button. The fix is in
`parts.ts` — `EditorRow` and `AddRow` carry `position: relative; z-index: 1`.

Two things about that are easy to get wrong later:

- **The `position` is load-bearing, not decoration.** `z-index` is ignored on a
  static element, so `z-index: 1` on its own changes nothing at all.
- **So is the background.** Lifting a transparent row above the overlay lets the
  lines show through regardless. `EditorRow` is opaque `palette.card`, so the form
  is clean. `AddRow` keeps its translucent tint **on purpose**, so the gridlines go
  on running through the empty part of it and it still matches the `PhaseRow` above;
  what the lift buys there is that they no longer cross the buttons, which have an
  opaque background of their own.

Anything new that renders *content* rather than a *track* inside `ChartCanvas` needs
the same two properties. `TeamChart` needs none of this today — it is read-only, and
every row it draws is a track.

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
