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

  .amplify-input,
  .amplify-select {
    background: ${palette.blush};
    border: 1px solid ${palette.border};
    border-radius: ${radius.sm};
    font-family: ${fontStack};
  }

  .amplify-button--primary {
    background: ${palette.hotPink};
    border-radius: ${radius.pill};
    font-family: ${fontStack};
    font-weight: 700;

    &:hover:not(:disabled) {
      background: ${palette.deepMagenta};
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
    </AuthShell>
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
