/**
 * The form an invited colleague meets on their first sign-in, before anything else.
 *
 * WHY THIS BLOCKS RATHER THAN NUDGES
 *
 * A person with a login but no roster row is in a state the rest of the app has no
 * good way to draw. They cannot be made DRI of anything, they do not appear on the
 * Team page, and the schedule they are looking at is one they are absent from. A
 * dismissible banner would leave them in that state indefinitely, and the roster
 * would drift into "everyone except the people who clicked the X" - which is worse
 * than no roster, because it looks complete.
 *
 * It is a real gate, not a security one. Every route stays open server-side; skipping
 * this screen would grant nothing, and `onboarded` is explicitly documented as a
 * routing hint that FAILS OPEN. If /api/me cannot reach DynamoDB it says `true`, and
 * an older backend that never heard of the field leaves it undefined - both mean the
 * app is used as normal. The failure this avoids is locking the whole team out of a
 * working roadmap over a roster lookup, which is a far likelier outcome than somebody
 * wanting to dodge a form that takes a minute.
 *
 * There is no Cancel. The only way past is to fill it in or sign out, and sign-out is
 * offered explicitly because "I am not who this account says I am" has to have an
 * answer that is not "close the tab".
 *
 * IT ASKS WHAT YOU SPECIALISE IN, TOO
 *
 * An email, a name, a role, and what you can be staffed onto. The last of those is here
 * rather than "later, from the Team page" because later is a page a new colleague has no
 * particular reason to open: they are told they are not on the team list, they fill in
 * the form that fixes it, and that is plausibly the last time they think about their own
 * row for months. A roster whose skills nobody ever rated cannot answer the question it
 * exists to answer - who could pick this up - so the question is asked on the one
 * occasion the person is certain to be looking at the form.
 *
 * NONE OF THE STARS ARE REQUIRED, deliberately. This screen blocks, which makes every
 * required field on it a field somebody must satisfy before they can use the app at
 * all, and a rating extracted under those conditions is a rating somebody invented.
 * Zero stars with the box unticked is a real answer and is treated as one: it is dropped
 * by buildSpecialisations on the way out and by SpecialisationIn.must_say_something on
 * the way in, so a row created here carries exactly the specialisations it was actually
 * given. Only a name and a role are enforced, as before.
 *
 * The scale is not spelled out above the rows - `starScale={false}` - because a
 * four-line key is the wrong thing to make somebody read before their first click. Each
 * star still names itself on hover and to a screen reader, so the words are where they
 * are needed rather than gone.
 *
 * The cost is one more round trip before the form can draw: GET /skills, requested
 * alongside GET /roles rather than after it, so it is one wait and not two.
 */

import { useCallback, useEffect, useState } from 'react';
import styled from 'styled-components';

import { describeError, getRoles, getSkills } from '../services/api';
import { palette, radius } from '../styles/theme';
import { ErrorText, Panel, SecondaryButton } from '../styles/ui';
import type { RoleInfo, SkillInfo } from '../types';
import PersonEditor from './PersonEditor';

const Wrap = styled(Panel)`
  max-width: 900px;
  margin: 32px auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
`;

const Title = styled.h2`
  margin: 0;
  font-size: 20px;
  color: ${palette.deepMagenta};
`;

const Lede = styled.p`
  margin: 0;
  color: ${palette.inkSoft};
  font-size: 14px;
  line-height: 1.55;
`;

const Footer = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  padding-top: 4px;
  border-top: 1px solid ${palette.border};
`;

const Aside = styled.span`
  font-size: 12px;
  color: ${palette.inkSoft};
`;

const Loading = styled.p`
  margin: 0;
  color: ${palette.inkSoft};
  border-radius: ${radius.lg};
`;

interface OnboardingProps {
  /**
   * The signed-in address, from /api/me.
   *
   * Passed down to PersonEditor as `lockedEmail`, so the field is filled and fixed:
   * this form can only ever create the caller's own row. Somebody typing a colleague's
   * address here would be refused by the API anyway (non-admins may only add
   * themselves), but being refused after filling the form in is a poor way to find
   * that out.
   */
  email: string;
  /** Re-reads /api/me so the app unblocks once the row exists. */
  onDone: () => void;
  signOut?: () => void;
}

export default function Onboarding({ email, onDone, signOut }: OnboardingProps) {
  const [roles, setRoles] = useState<RoleInfo[]>([]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const load = useCallback(async () => {
    try {
      // Both vocabularies, in parallel: the form needs the roles to draw its chips and
      // the skills to draw its rows, and neither depends on the other. Awaited in
      // sequence this would be two round trips of dead time in front of somebody who
      // cannot get into the app until this screen renders.
      //
      // All or nothing on purpose. A half-loaded form - roles present, skills missing -
      // would look complete and quietly create a row with no specialisations, which is
      // the exact outcome asking here is meant to stop.
      const [fetchedRoles, fetchedSkills] = await Promise.all([getRoles(), getSkills()]);
      setRoles(fetchedRoles);
      setSkills(fetchedSkills);
      setReady(true);
    } catch (err) {
      setError(describeError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Wrap>
      <Title>Welcome — tell us what you do</Title>
      <Lede>
        You are signed in as <strong>{email}</strong>, but you are not on the team list yet. This
        is what puts you there, so work can be assigned to you and your name shows up on the
        schedule alongside everybody else&rsquo;s.
      </Lede>
      {/* The one thing on the form that needs saying and that the fieldset's own legend
          cannot say: the stars are a claim about what you can be handed, not a test, and
          leaving a skill at nothing is an answer rather than a blank. Said here because
          PersonEditor is shared with the Team page, where the reader already knows. */}
      <Lede>
        The specialisations tell us what you can be handed. Rate the ones that apply, tick
        &ldquo;wants to learn&rdquo; for anything you would like more of, and leave the rest
        alone &mdash; nothing there is required, and you can change all of it later.
      </Lede>

      {error ? <ErrorText role="alert">{error}</ErrorText> : null}

      {ready ? (
        <PersonEditor
          person={null}
          skills={skills}
          roles={roles}
          admin={false}
          // The rows, without the scale printed above them. See the header.
          starScale={false}
          lockedEmail={email}
          onSaved={onDone}
        />
      ) : error ? null : (
        <Loading>Loading the form…</Loading>
      )}

      <Footer>
        {signOut ? (
          <SecondaryButton type="button" onClick={signOut}>
            Sign out
          </SecondaryButton>
        ) : null}
        {/* Names the Team page, because this form is the same form there: everything
            asked here can be revised, and somebody who left the stars alone on their
            first day needs to know where to go once they know the answer. */}
        <Aside>You can change any of this later from the Team page.</Aside>
      </Footer>
    </Wrap>
  );
}
