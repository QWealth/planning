/**
 * Sign-in gate.
 *
 * Nothing renders until Cognito has a session. When the build has no pool
 * configured (local dev - see services/auth.ts) it renders straight through, so
 * `npm run dev` against a local uvicorn still works.
 *
 * Being past this gate does NOT mean being allowed in. The user pool is shared with
 * the marketing compliance tool, and API Gateway's Cognito authorizer accepts any
 * token the pool ever issued - so a marketing-only account signs in here perfectly
 * and is then refused by the API. AppShell handles that with /api/me; this file only
 * establishes who you are.
 *
 * The Authenticator ships its own stylesheet, which looks nothing like the rest of
 * this app. Rather than fight it element by element, the wrapper below remaps
 * Amplify's own CSS custom properties onto the palette - which keeps all of it
 * inside styled-components rather than inline styles.
 *
 * Auth status is read with `useAuthenticator` rather than by nesting the app inside
 * the Authenticator's render prop. Nesting leaves the login chrome - the centring
 * shell and the caption - wrapping the entire application after sign-in, because
 * Authenticator renders its children in place of the form.
 */

import type { ReactNode } from 'react';
import { Authenticator, useAuthenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import styled from 'styled-components';

import { isAuthConfigured } from '../services/auth';
import Backdrop from './Backdrop';
import { fontStack, palette, radius, shadow } from '../styles/theme';

export interface AuthState {
  /** Signed-in user's email. Absent when auth is not configured for this build. */
  email?: string;
  /** Sign out. Absent when auth is not configured for this build. */
  signOut?: () => void;
}

interface LoginGateProps {
  children: (auth: AuthState) => ReactNode;
}

const AuthShell = styled.div`
  /* Above the Backdrop's video and scrim. Without this the whole sign-in card renders
     behind the veil - see components/Backdrop.tsx for the three-layer stack. */
  position: relative;
  z-index: 10;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px;

  /* Amplify's design tokens, remapped. */
  --amplify-fonts-default-variable: ${fontStack};
  --amplify-fonts-default-static: ${fontStack};
  --amplify-colors-background-primary: ${palette.card};
  --amplify-colors-background-secondary: ${palette.blush};
  --amplify-colors-font-primary: ${palette.ink};
  --amplify-colors-font-secondary: ${palette.inkSoft};
  --amplify-colors-font-interactive: ${palette.deepMagenta};
  --amplify-colors-border-primary: ${palette.border};
  --amplify-colors-brand-primary-80: ${palette.hotPink};
  --amplify-colors-brand-primary-90: ${palette.deepMagenta};
  --amplify-colors-brand-primary-100: ${palette.deepMagenta};
  --amplify-components-authenticator-router-background-color: ${palette.card};
  --amplify-components-authenticator-router-border-width: 0;
  --amplify-components-authenticator-router-box-shadow: none;
  /*
    Card width. It is -container-width-max that does this, applied by Amplify inside
    a min-width: 30rem media query. The similarly named
    --amplify-components-authenticator-max-width is a real token in the theme and
    controls nothing here - setting that one leaves the card at its 480px default
    while looking like it has been dealt with.
  */
  --amplify-components-authenticator-container-width-max: 360px;
  --amplify-components-authenticator-form-padding: 20px;
  --amplify-radii-small: ${radius.sm};
  --amplify-radii-medium: ${radius.md};
  --amplify-radii-large: ${radius.lg};

  font-family: ${fontStack};

  [data-amplify-router] {
    background: ${palette.card};
    border: 1px solid ${palette.border};
    border-radius: ${radius.lg};
    box-shadow: ${shadow.raised};
  }

  /*
    Amplify's TEXT colours, set as a plain color property rather than through its
    tokens - and
    this is the one trap on the whole screen worth reading before editing.

    The token remaps above do inherit. --amplify-colors-font-primary computes to our
    ink on every node inside this shell, including the input itself. The input is still
    drawn in hsl(210 50% 10%), Amplify's own near-black blue-grey, because Amplify
    declares its COMPONENT tokens at :root -
    --amplify-components-fieldcontrol-color: var(--amplify-colors-font-primary) - and a
    custom property's var() is substituted where it is DECLARED, not where it is used.
    That substitution happened at :root against Amplify's default palette, long before
    anything we set on a descendant was visible. Adding more --amplify-colors-* remaps
    cannot fix it; only overriding the component token or setting the property wins, and
    setting the property does not require knowing every token name they ship.

    In light mode this was invisible - their near-black on our white is merely the wrong
    near-black. In dark mode it is a 1.15:1 input and a 1.79:1 label on a black card,
    i.e. a form you cannot read, which is exactly the failure a theme switch is prone to
    and exactly the one no unit test catches.
  */
  .amplify-label {
    color: ${palette.inkSoft};
  }

  .amplify-input,
  .amplify-select {
    background: ${palette.blush};
    border: 1px solid ${palette.border};
    border-radius: ${radius.sm};
    font-family: ${fontStack};
    color: ${palette.ink};

    &::placeholder {
      /* opacity:1 because Firefox dims the placeholder again on top of the colour. */
      color: ${palette.inkSoft};
      opacity: 1;
    }
  }

  /* The show/hide-password toggle: a field-group button, so it misses both the primary
     and the link rules and would otherwise keep Amplify's default ink. */
  .amplify-field__show-password,
  .amplify-field-group__outer-end .amplify-button {
    background: ${palette.blush};
    border: 1px solid ${palette.border};
    color: ${palette.inkSoft};
  }

  .amplify-button--primary {
    background: ${palette.hotPink};
    /* Not white. In dark mode the accent is LIGHTER than the page, so white-on-pink
       falls to 2.93:1; onAccent is the token that flips with the fill. */
    color: ${palette.onAccent};
    border-radius: ${radius.pill};
    font-family: ${fontStack};
    font-weight: 700;

    &:hover:not(:disabled) {
      background: ${palette.deepMagenta};
      color: ${palette.onAccent};
    }
  }

  .amplify-button--link {
    color: ${palette.deepMagenta};
    font-family: ${fontStack};
  }

  .amplify-alert {
    border-radius: ${radius.md};
    font-family: ${fontStack};
  }
`;

const Caption = styled.h1`
  margin-bottom: 4px;
  font-size: 28px;
  color: ${palette.deepMagenta};
  letter-spacing: -0.02em;
`;

const Sub = styled.p`
  margin: 0 0 18px;
  color: ${palette.inkSoft};
  font-size: 13px;
`;

const Footnote = styled.p`
  margin-top: 16px;
  max-width: 360px;
  text-align: center;
  font-size: 12px;
  color: ${palette.inkSoft};
`;

/*
  The same credit the app carries in its footer, in the same small-label treatment.
  Here it is under the card rather than under the content, because there is no content
  to be the last thing after.
*/
const Credit = styled.p`
  margin-top: 20px;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: ${palette.inkSoft};
`;

/** Must be inside Authenticator.Provider for useAuthenticator to have a context. */
function Gate({ children }: LoginGateProps) {
  const { authStatus, user, signOut } = useAuthenticator((context) => [
    context.authStatus,
    context.user,
  ]);

  if (authStatus === 'authenticated') {
    // The pool signs in by email alias, so the username is the email; the attribute
    // is preferred in case that ever changes.
    const attributes = (user as { attributes?: { email?: string } } | undefined)?.attributes;
    return <>{children({ email: attributes?.email ?? user?.getUsername?.(), signOut })}</>;
  }

  return (
    <>
      {/*
        The same sunset the app sits on, and that is the point: this is the first screen
        anybody sees, and it was the one place that still looked like the tool before
        the restyle. The card keeps its own opaque paper ground, so nothing here costs
        the sign-in form any contrast.
      */}
      <Backdrop />
    <AuthShell>
      <Caption>Planning Roadmap</Caption>
      <Sub>QWealth</Sub>
      {/*
        hideSignUp, because the pool's own sign-up is switched off. Accounts are
        created by an administrator, and everyone who needs this tool already has one
        from the marketing compliance app - the same credential works here. Leaving
        the tab visible would offer a form that can only fail.

        Not hidden: the first sign-in with a temporary password, and MFA. Cognito
        answers those with NEW_PASSWORD_REQUIRED / SOFTWARE_TOKEN_MFA and the
        Authenticator has its own steps for both, so nothing is needed here.

        loginMechanisms=['email'] so the field is labelled "Email" rather than
        Amplify's default "Username" - the pool's only sign-in alias is email, so
        "Username" asks for something that does not exist.
      */}
      <Authenticator hideSignUp loginMechanisms={['email']} />
      <Footnote>
        Same account as the marketing compliance tool. Access to the roadmap also
        requires membership of the <strong>planning</strong> group.
      </Footnote>
      <Credit>Styling powered by marketing</Credit>
    </AuthShell>
    </>
  );
}

export default function LoginGate({ children }: LoginGateProps) {
  // No pool in this build: render the app directly. The backend behaves the same
  // way locally and records edits against "system".
  if (!isAuthConfigured) {
    return <>{children({})}</>;
  }

  return (
    <Authenticator.Provider>
      <Gate>{children}</Gate>
    </Authenticator.Provider>
  );
}
