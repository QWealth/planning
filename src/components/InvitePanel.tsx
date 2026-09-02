/**
 * Give somebody a login: pick them out of Slack, or type an address.
 *
 * WHY THERE IS A PICKER AT ALL
 *
 * This used to be a bare email field, and a mistyped address is not a harmless
 * mistake here. It creates a Cognito account on the pool SHARED with the marketing
 * compliance tool and mails a stranger a temporary password. The roadmap exists
 * because the workbook it replaced held first names and nothing else, so
 * plausible-looking-but-wrong identity is the exact failure this project started to
 * kill. Slack already knows who works here and what their addresses are, so the
 * address is now READ rather than typed.
 *
 * ONE INPUT, TWO JOBS. The field filters the Slack directory as you type, and it also
 * accepts a full email address directly. Those are not two modes with a toggle between
 * them, because a toggle is a thing to be in the wrong one of: an address that matches
 * nobody in Slack is simply invited as typed. That fallback is not a nicety - see
 * `unavailable` below.
 *
 * WHY THIS STILL DRAWS A BLOCK OF TEXT TO COPY
 *
 * Cognito does email the new account its temporary password, so the credentials arrive
 * on their own. Two things are wrong with that email and neither is fixable from this
 * repo:
 *
 *   1. It contains no link. Username and password, nothing about where to sign in.
 *   2. It is branded "QWealth Marketing Compliance Review", because the pool is
 *      shared with that tool and the invite template is per-POOL, not per-app.
 *
 * Rebranding it would change what the compliance tool's invitees receive, and the
 * template may well be managed by that repo's CDK, in which case editing it from here
 * gets silently reverted on their next deploy. So the gap is closed by a message. When
 * the person came from the picker the API sends that message as a Slack DM itself and
 * this block is unnecessary; when they were typed, or when the DM failed, the admin
 * sends it. Both paths exist and the copy block is the one that always works.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import styled from 'styled-components';

import { describeError, fetchSlackPeople, invitePerson } from '../services/api';
import { palette, radius, shadow } from '../styles/theme';
import { ErrorText, Hint, Input, Label, PrimaryButton, SecondaryButton } from '../styles/ui';
import type { InviteResult, SlackDirectory, SlackPerson } from '../types';

const Form = styled.form`
  display: flex;
  align-items: flex-end;
  gap: 10px;
  flex-wrap: wrap;
`;

const Field = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 280px;
  flex: 1;
  /* The suggestion list is absolutely positioned against this, so it can overlap the
     content below instead of shoving the panel around on every keystroke. */
  position: relative;
`;

const Suggestions = styled.ul`
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  z-index: 20;
  margin: 4px 0 0;
  padding: 4px;
  list-style: none;
  max-height: 280px;
  overflow-y: auto;
  background: ${palette.card};
  border: 1px solid ${palette.border};
  border-radius: ${radius.md};
  box-shadow: ${shadow.raised};
`;

/*
  A button rather than a bare <li onClick>. It has to be reachable by keyboard, and
  a div with a click handler is exactly the control that works perfectly in testing
  and is unusable for anyone not holding a mouse.
*/
const Suggestion = styled.button<{ $active: boolean }>`
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 7px 8px;
  border: 0;
  border-radius: ${radius.sm};
  background: ${(p) => (p.$active ? palette.blush : 'transparent')};
  cursor: pointer;
  text-align: left;
  font: inherit;
  color: ${palette.ink};

  &:hover {
    background: ${palette.blush};
  }
`;

const Avatar = styled.img`
  width: 26px;
  height: 26px;
  border-radius: ${radius.pill};
  flex-shrink: 0;
  background: ${palette.blush};
`;

/* Shown when Slack has no picture for somebody, so rows keep a common left edge. */
const AvatarFallback = styled.span`
  width: 26px;
  height: 26px;
  border-radius: ${radius.pill};
  flex-shrink: 0;
  background: ${palette.blush};
  color: ${palette.inkSoft};
  font-size: 11px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
`;

const SuggestionText = styled.span`
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
`;

const SuggestionName = styled.span`
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const SuggestionMeta = styled.span`
  font-size: 11.5px;
  color: ${palette.inkSoft};
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`;

const Tag = styled.span`
  margin-left: auto;
  flex-shrink: 0;
  font-size: 11px;
  padding: 2px 7px;
  border-radius: ${radius.pill};
  background: ${palette.blush};
  color: ${palette.inkSoft};
  border: 1px solid ${palette.border};
`;

/* The chosen person, once picked. Deliberately shows the ADDRESS as well as the name:
   the whole point of the picker is which address gets the account, and a row showing
   only "Piper Chen" hides the one fact worth confirming. */
const Chosen = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 8px;
  border: 1px solid ${palette.border};
  border-radius: ${radius.md};
  background: ${palette.card};
  min-height: 40px;
`;

const ClearButton = styled.button`
  margin-left: auto;
  border: 0;
  background: transparent;
  color: ${palette.inkSoft};
  cursor: pointer;
  font-size: 13px;
  padding: 4px 6px;
  border-radius: ${radius.sm};

  &:hover {
    color: ${palette.ink};
    background: ${palette.blush};
  }
`;

const Result = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
  padding: 12px 14px;
  border-radius: ${radius.lg};
  background: rgba(224, 33, 138, 0.05);
  border: 1px solid rgba(224, 33, 138, 0.18);
`;

const Summary = styled.p`
  margin: 0;
  font-size: 13px;
  color: ${palette.ink};
`;

/*
  A readonly textarea rather than a <pre>. The point of this block is that it leaves
  here and lands in Teams, so it has to survive a manual select-all on the browsers
  where the clipboard API is unavailable - and a textarea is the one element that
  makes that a drag-free triple-click.
*/
const Message = styled.textarea`
  width: 100%;
  min-height: 132px;
  resize: vertical;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.5;
  padding: 10px;
  border-radius: ${radius.sm};
  border: 1px solid rgba(224, 33, 138, 0.25);
  background: #ffffff;
  color: ${palette.ink};
`;

const Row = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
`;

/* How many suggestions are drawn. A workspace of a few hundred people rendered in a
   dropdown is not a list anybody reads - it is a wall to scroll past, and the answer
   to "too many matches" is to type more of the name, not to scroll. */
const MAX_SUGGESTIONS = 8;

/*
  The message itself is NOT built here; `result.message` arrives from the API. It moved
  when Slack became a second sender - see fast/app/invites.py. The browser also had the
  wrong URL to offer: it used window.location.origin, so an invite composed from a dev
  build cheerfully told a colleague to sign in at localhost. The server knows the
  address the app actually answers on.
*/

/** Good enough to tell "a typed address" from "a half-typed name". Not validation —
    the API and the browser's own type="email" both do that properly. This only decides
    whether to let the form submit something that matched nobody in Slack. */
function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

/** The one-line answer to "what just happened", which is not always "invited". */
function summarise(result: InviteResult): string {
  if (result.onboarded) {
    return `${result.email} already has an account and is already on the roster. Nothing changed.`;
  }
  if (!result.account_created && !result.group_added) {
    return `${result.email} already had access. They still need to fill in their roster entry.`;
  }
  if (!result.account_created) {
    return `${result.email} already had an account; added to the planning group.`;
  }
  return `Invited ${result.email}. Cognito has emailed them a temporary password.`;
}

export default function InvitePanel({ onInvited }: { onInvited?: () => void }) {
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<SlackPerson | null>(null);
  const [directory, setDirectory] = useState<SlackDirectory | null>(null);
  const [loadingDirectory, setLoadingDirectory] = useState(true);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<InviteResult | null>(null);
  const [copied, setCopied] = useState(false);

  const fieldRef = useRef<HTMLDivElement | null>(null);

  /*
    Fetched once, when the panel opens. This component is only mounted while the admin
    has the invite panel open (see TeamPage), so this is not a page-load cost - and the
    API caches the directory for five minutes anyway, because users.list is rate
    limited and two admins with the page open would otherwise hit it.
  */
  useEffect(() => {
    let live = true;
    fetchSlackPeople()
      .then((fetched) => {
        if (live) {
          setDirectory(fetched);
        }
      })
      .catch(() => {
        /*
          Deliberately swallowed. The API answers 200 with `unavailable` for every
          Slack problem, so a rejection here is the REQUEST failing - and the only
          thing that costs is the picker. Surfacing it as an error banner would imply
          the invite itself was broken, when typing an address still works perfectly.
        */
        if (live) {
          setDirectory({ people: [], filtered: 0, unavailable: 'The directory could not be loaded.' });
        }
      })
      .finally(() => {
        if (live) {
          setLoadingDirectory(false);
        }
      });
    return () => {
      live = false;
    };
  }, []);

  /* Close the suggestions when the click lands anywhere else. Without this the list
     stays open over the rest of the panel and swallows the next click. */
  useEffect(() => {
    if (!open) {
      return;
    }
    function onDocumentClick(event: MouseEvent) {
      if (fieldRef.current && !fieldRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocumentClick);
    return () => document.removeEventListener('mousedown', onDocumentClick);
  }, [open]);

  const matches = useMemo(() => {
    const people = directory?.people ?? [];
    const needle = query.trim().toLowerCase();
    if (!needle) {
      return people.slice(0, MAX_SUGGESTIONS);
    }
    return people
      .filter(
        (person) =>
          person.name.toLowerCase().includes(needle) ||
          person.email.toLowerCase().includes(needle)
      )
      .slice(0, MAX_SUGGESTIONS);
  }, [directory, query]);

  function choose(person: SlackPerson) {
    setChosen(person);
    setQuery('');
    setOpen(false);
    setError(null);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || matches.length === 0) {
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlight((h) => (h + 1) % matches.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlight((h) => (h - 1 + matches.length) % matches.length);
    } else if (event.key === 'Enter') {
      /*
        Enter picks the highlighted person INSTEAD of submitting. Without the
        preventDefault the form submits whatever raw text is in the box, which for a
        half-typed name is nothing valid and for a name that happens to look like an
        address would invite the wrong string entirely.
      */
      event.preventDefault();
      choose(matches[highlight]);
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();

    const typed = query.trim();
    const address = chosen ? chosen.email : typed;
    if (!address) {
      return;
    }
    if (!chosen && !looksLikeEmail(typed)) {
      setError('Pick somebody from the list, or type their full email address.');
      return;
    }

    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const invited = await invitePerson(address, chosen?.slack_user_id);
      setResult(invited);
      setQuery('');
      setChosen(null);
      onInvited?.();
    } catch (err) {
      setError(describeError(err));
      setResult(null);
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!result) {
      return;
    }
    try {
      await navigator.clipboard.writeText(result.message);
      setCopied(true);
    } catch {
      // Clipboard access is refused over plain http and in some locked-down
      // profiles. The textarea is right there and selectable, so this is a missing
      // convenience rather than a failure worth an error banner.
      setCopied(false);
    }
  }

  const unavailable = directory?.unavailable ?? null;
  const showSuggestions = open && matches.length > 0;

  /* The message is redundant once it has been delivered, so it is only drawn when it
     was not - which is a typed address, a failed DM, or somebody already onboarded
     (who is sent nothing on purpose and needs no instructions either). */
  const needsCopyBlock = result !== null && !result.onboarded && !result.dm_sent;

  return (
    <div>
      <Form onSubmit={submit}>
        <Field ref={fieldRef}>
          <Label htmlFor="invite-person">
            {unavailable ? 'Email address' : 'Who are you inviting?'}
          </Label>

          {chosen ? (
            <Chosen>
              {chosen.avatar ? (
                <Avatar src={chosen.avatar} alt="" />
              ) : (
                <AvatarFallback aria-hidden="true">{initials(chosen.name)}</AvatarFallback>
              )}
              <SuggestionText>
                <SuggestionName>{chosen.name}</SuggestionName>
                <SuggestionMeta>{chosen.email}</SuggestionMeta>
              </SuggestionText>
              <ClearButton type="button" onClick={() => setChosen(null)}>
                Change
              </ClearButton>
            </Chosen>
          ) : (
            <Input
              id="invite-person"
              type={unavailable ? 'email' : 'text'}
              autoComplete="off"
              role="combobox"
              aria-expanded={showSuggestions}
              aria-controls="invite-suggestions"
              placeholder={
                unavailable ? 'somebody@qwealth.com' : 'Search Slack, or type an email address'
              }
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setOpen(true);
                setHighlight(0);
              }}
              onFocus={() => setOpen(true)}
              onKeyDown={onKeyDown}
            />
          )}

          {showSuggestions ? (
            <Suggestions id="invite-suggestions" role="listbox">
              {matches.map((person, index) => (
                <li key={person.slack_user_id}>
                  <Suggestion
                    type="button"
                    role="option"
                    aria-selected={index === highlight}
                    $active={index === highlight}
                    onMouseEnter={() => setHighlight(index)}
                    onClick={() => choose(person)}
                  >
                    {person.avatar ? (
                      <Avatar src={person.avatar} alt="" />
                    ) : (
                      <AvatarFallback aria-hidden="true">{initials(person.name)}</AvatarFallback>
                    )}
                    <SuggestionText>
                      <SuggestionName>{person.name}</SuggestionName>
                      <SuggestionMeta>
                        {person.title ? `${person.title} · ` : ''}
                        {person.email}
                      </SuggestionMeta>
                    </SuggestionText>
                    {/* on_roster first: it is the one that changes whether inviting
                        them does anything at all, and only one tag fits the row. */}
                    {person.on_roster ? (
                      <Tag>On the roster</Tag>
                    ) : person.is_guest ? (
                      <Tag>Guest</Tag>
                    ) : null}
                  </Suggestion>
                </li>
              ))}
            </Suggestions>
          ) : null}
        </Field>

        <PrimaryButton type="submit" disabled={busy}>
          {busy ? 'Inviting…' : 'Invite'}
        </PrimaryButton>
      </Form>

      <Hint>
        Creates a sign-in and adds it to the planning group. It does not add them to the roster —
        they fill that in themselves the first time they sign in.
      </Hint>

      {loadingDirectory ? <Hint>Loading the Slack directory…</Hint> : null}

      {/*
        Not an error. Slack being unreachable costs the convenience of picking a name;
        inviting by typing an address is what this panel did before Slack existed and
        still works, so this says what is missing and gets out of the way.
      */}
      {unavailable ? <Hint>Slack directory unavailable: {unavailable}</Hint> : null}

      {/*
        The `users:read.email` case, which is the one that would otherwise send somebody
        hunting in entirely the wrong place: the scope is missing, so every profile
        arrives with no address and gets dropped, and the picker looks like a workspace
        with nobody in it. Saying how many were dropped names the actual problem.
      */}
      {!unavailable && directory && directory.people.length === 0 && directory.filtered > 0 ? (
        <Hint>
          Slack returned {directory.filtered}{' '}
          {directory.filtered === 1 ? 'account' : 'accounts'} but no email addresses. The
          Slack app is probably missing the <code>users:read.email</code> scope.
        </Hint>
      ) : null}

      {error ? <ErrorText role="alert">{error}</ErrorText> : null}

      {result ? (
        <Result>
          <Summary>{summarise(result)}</Summary>

          {result.dm_sent ? <Summary>They have been sent the instructions on Slack.</Summary> : null}

          {/*
            The invite worked and the DM did not, which is why this is a Hint rather
            than an ErrorText: the account exists, and the copy block below is the way
            to finish the job by hand.
          */}
          {result.dm_error ? (
            <Hint>Could not send the Slack message: {result.dm_error}</Hint>
          ) : null}

          {needsCopyBlock ? (
            <>
              <Label htmlFor="invite-message">Send them this — it has the link</Label>
              <Message id="invite-message" readOnly value={result.message} />
              <Row>
                <SecondaryButton type="button" onClick={copy}>
                  {copied ? 'Copied' : 'Copy'}
                </SecondaryButton>
                <Hint>Cognito&rsquo;s own email has the password but no link.</Hint>
              </Row>
            </>
          ) : null}
        </Result>
      ) : null}
    </div>
  );
}
