/**
 * The frame both pages sit in: masthead, navigation, and the authorisation check.
 *
 * WHY IDENTITY LIVES HERE AND NOT IN EACH PAGE
 *
 * /api/me answers "what does the API think of this token", which is a different
 * question from "is this user signed in" - the Cognito pool is shared with the
 * marketing compliance tool and API Gateway's authorizer accepts any token the pool
 * ever issued, so a perfectly valid sign-in can still be refused by this API.
 * Hoisting the call means it happens once per session rather than once per page, and
 * a refused user gets one specific explanation instead of two pages of empty state.
 *
 * The refusal renders INSTEAD of the navigation, not beside it. Offering a Team tab
 * to somebody the API will 403 is an invitation to conclude the tool is broken.
 *
 * The same answer is handed down through the router's outlet context, because /api/me
 * also carries `is_admin` and the Team page needs it to decide which controls to draw.
 * Context rather than a prop because the pages are rendered by the router, not by this
 * component, so there is nowhere to put a prop; and one call rather than one per page
 * because a second /api/me would be a second chance to disagree with the first.
 */

import { Suspense, useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useOutletContext } from 'react-router-dom';
import styled from 'styled-components';

import { describeError, getIdentity } from '../services/api';
import { displayStack, palette, radius } from '../styles/theme';
import { ErrorText, Panel, PageLoading, SecondaryButton } from '../styles/ui';
import type { Identity } from '../types';
import type { AuthState } from './LoginGate';
import Backdrop from './Backdrop';
import Onboarding from './Onboarding';

const Page = styled.div`
  position: relative;
  /* Above both background layers. Without this the whole app renders behind the scrim
     and reads as though somebody left a translucent sheet over the screen. */
  z-index: 10;
  /*
    Narrower and further apart than a dense tool would normally warrant, so the sunset
    is visible around and between the panels rather than only in the strip below the
    last one.

    1380 rather than something dramatic, because the roadmap's timeline is the widest
    thing here and squeezing it to show a video would be a bad trade in a tool people
    actually plan with. On a 1500px window this buys about 60px a side; on a 1920 it
    buys 270. The vertical gaps do most of the work.
  */
  max-width: 1380px;
  margin: 0 auto;
  /*
    The horizontal padding scales with the window rather than sitting at one number,
    because the two ends of the range want opposite things: at 1024 every pixel of
    width belongs to the timeline, and at 1920 the content has already stopped at
    1380 and the padding is only deciding how the leftover is split. clamp gives 24px
    on a laptop and 56px on a wide monitor off one declaration.
  */
  padding: 32px clamp(24px, 3vw, 56px) 96px;
  display: flex;
  flex-direction: column;
  gap: 28px;
`;

const Masthead = styled.header`
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
`;

/*
  The masthead, and the one place the display face is unmistakable.

  Heavy, uppercase, .02em - the heading tracking from decision 4, which is tighter than
  the .1em used on small labels. Red rather than ink, because decision 5 gives red to
  headings as well as to primary actions.
*/
const Title = styled.h1`
  font-family: ${displayStack};
  font-size: 24px;
  font-weight: 400;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: ${palette.deepMagenta};
  margin: 0;
`;

/*
  The credit line.

  Quiet on purpose: it is an acknowledgement, not a banner, so it takes the same
  small-label treatment as every other label in the app - heavy, uppercase, .1em - at
  the muted ink rather than at an accent. Inside Page so it sits above the background
  video like everything else, and after the outlet so it is the last thing on every
  page rather than a fixed bar competing with the content.
*/
const Footer = styled.footer`
  margin-top: 8px;
  padding-top: 12px;
  border-top: 1px solid ${palette.hairline};
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: ${palette.inkSoft};
  text-align: center;
`;

const Spacer = styled.div`
  flex: 1;
`;

const Status = styled.p`
  margin: 0;
  color: ${palette.inkSoft};
`;

const Nav = styled.nav`
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px;
  background: ${palette.pinkWash};
  border-radius: ${radius.pill};
`;

/*
  A real link, not a button that calls navigate(). Middle-click, ctrl-click and
  "copy link address" all work for free, and the address bar stays honest - which
  matters here because the whole point of adding a router was that /team is a place
  somebody can be sent to.
*/
const Tab = styled(NavLink)`
  display: inline-block;
  padding: 6px 16px;
  border-radius: ${radius.pill};
  font-size: 13px;
  font-weight: 600;
  text-decoration: none;
  color: ${palette.inkSoft};
  transition: background 0.15s ease, color 0.15s ease;

  &:hover {
    color: ${palette.deepMagenta};
  }

  &.active {
    background: ${palette.hotPink};
    color: ${palette.onAccent};
  }
`;

const Denied = styled(Panel)`
  max-width: 620px;
  margin: 40px auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
`;

export default function AppShell({ auth }: { auth: AuthState }) {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setIdentity(await getIdentity());
    } catch (err) {
      setError(describeError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (identity && !identity.authorised) {
    return (
      <Denied>
        <h2>Not authorised for the planning roadmap</h2>
        <p>
          You are signed in as <strong>{identity.email ?? 'an unknown account'}</strong>, but the
          API requires membership of the <strong>{identity.required_group}</strong> group and this
          account is {identity.groups.length ? `in ${identity.groups.join(', ')}` : 'in no groups'}.
        </p>
        <p>
          The sign-in pool is shared with the marketing compliance tool, so a working password does
          not by itself grant access here. Ask an administrator to add you to the group.
        </p>
        {auth.signOut ? (
          <div>
            <SecondaryButton type="button" onClick={auth.signOut}>
              Sign out
            </SecondaryButton>
          </div>
        ) : null}
      </Denied>
    );
  }

  /*
    An invited colleague on their first sign-in: authorised, but with no roster row.

    Checked with `=== false` rather than `!identity.onboarded`, and that is the whole
    safety of it. The field is optional, so a backend deployed before it existed
    returns undefined - which `!` would read as "not onboarded" and would gate the
    entire team out of a working roadmap behind a form they have already filled in.
    Only an explicit false, from a backend that actually looked, blocks anybody.
  */
  if (identity?.authorised && identity.onboarded === false && identity.email) {
    return (
      <Page>
        <Masthead>
          <Title>Planning Roadmap</Title>
          <Spacer />
          <Status>{identity.email}</Status>
        </Masthead>
        {/* No nav: the tabs go nowhere useful until there is a row to go there with. */}
        <Onboarding email={identity.email} onDone={load} signOut={auth.signOut} />
      </Page>
    );
  }

  return (
    <>
      <Backdrop />
    <Page>
      <Masthead>
        <Title>Planning Roadmap</Title>
        <Nav>
          {/* `end` so that "/" does not stay highlighted while /team is open - NavLink
              matches by prefix otherwise and both tabs light up at once. */}
          <Tab to="/" end>
            Roadmap
          </Tab>
          <Tab to="/team">Team</Tab>
          {/* No `end`: /rfcs/{id} is still the RFCs section, and the tab should stay
              lit while you are reading one. The opposite of the index tab above. */}
          <Tab to="/rfcs">RFCs</Tab>
          {/* Also no `end`, for the same reason: /tasks/{id} is still the board's
              section. Last because it is the most day-to-day of the four and the
              order of the tabs is roughly widest scope to narrowest - the roadmap is
              the year, the board is the week. */}
          <Tab to="/tasks">Board</Tab>
          {/* Last, and outside the widest-to-narrowest ordering above rather than the
              end of it: the other four tabs are the work, this one is about you. It is
              a tab and not a menu under the address on the right because a Monday DM
              somebody did not ask for should be switchable off from somewhere obvious. */}
          {/* Only for business analysts, and hidden rather than disabled: a tab
              nobody may open is a question about what they are missing. `is_ba` is
              undefined on an older backend and reads as false, which is the right
              direction for a flag that mirrors a gate - see types.ts. The route
              enforces it again regardless. */}
          {identity?.is_ba ? <Tab to="/milestone-log">Log</Tab> : null}
          <Tab to="/settings">Settings</Tab>
        </Nav>
        <Spacer />
        {identity?.email ? <Status>{identity.email}</Status> : null}
        {auth.signOut ? (
          <SecondaryButton type="button" onClick={auth.signOut}>
            Sign out
          </SecondaryButton>
        ) : null}
      </Masthead>

      {error ? <ErrorText role="alert">{error}</ErrorText> : null}

      {/*
        Null until /api/me answers. Pages must treat that as "not an admin yet"
        rather than blocking on it - the roadmap is readable by everybody, so
        waiting for an authorisation answer to draw it would be a spinner for no
        reason. See useIdentity below.

        The Suspense boundary is here, INSIDE the shell, so the masthead and tabs
        stay on screen while a lazily-loaded page's chunk is in flight; wrapping the
        router instead would blank the whole window on every first navigation, which
        reads as a reload rather than a tab change.

        It also has to be here rather than in a pathless route in App.tsx, because
        the context above is passed through this very Outlet. A second Outlet inside
        a nested route would install its own provider holding undefined, and every
        page's useIdentity() would start reading null.
      */}
      <Suspense fallback={<PageLoading>Loading…</PageLoading>}>
        <Outlet context={identity} />
      </Suspense>

      <Footer>Styling powered by marketing</Footer>
    </Page>
    </>
  );
}

/**
 * The identity, for a page rendered inside this shell.
 *
 * Typed here rather than at each call site so that `useOutletContext<something-else>()`
 * cannot quietly be written somewhere and typecheck.
 */
export function useIdentity(): Identity | null {
  return useOutletContext<Identity | null>();
}
