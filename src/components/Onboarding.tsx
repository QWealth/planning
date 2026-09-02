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
  border-top: 1px solid rgba(224, 33, 138, 0.15);
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
   * themselves), but being refused after filling in eleven skills is a poor way to
   * find that out.
   */
  email: string;
  /** Re-reads /api/me so the app unblocks once the row exists. */
  onDone: () => void;
  signOut?: () => void;
}

export default function Onboarding({ email, onDone, signOut }: OnboardingProps) {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [roles, setRoles] = useState<RoleInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const load = useCallback(async () => {
    try {
      // Both vocabularies, in parallel - the form cannot render a picker for either
      // until its list arrives, so there is nothing to show after only one.
      const [skillList, roleList] = await Promise.all([getSkills(), getRoles()]);
      setSkills(skillList);
      setRoles(roleList);
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
        is what puts you there, so work can be assigned to you and people can find you when they
        are looking for someone who knows a thing.
      </Lede>

      {error ? <ErrorText role="alert">{error}</ErrorText> : null}

      {ready ? (
        <PersonEditor
          person={null}
          skills={skills}
          roles={roles}
          admin={false}
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
        <Aside>You can change any of this later from the Team page.</Aside>
      </Footer>
    </Wrap>
  );
}
