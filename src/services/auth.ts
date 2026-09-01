/**
 * Cognito sign-in.
 *
 * The pool is SHARED with the marketing compliance tool - one credential and one
 * MFA enrolment for the team, which is why nobody has to be invited twice. The
 * consequence is the thing to keep in mind while reading this file: API Gateway's
 * Cognito authorizer authenticates but does not authorise. It accepts any token the
 * pool ever issued, including one minted for the marketing app's client. Being
 * signed in here therefore proves nothing about being allowed here; the `planning`
 * group check in fast/app/auth.py is what actually decides, and App.tsx asks
 * /api/me rather than inferring it from the presence of a session.
 *
 * Amplify's in-app Authenticator over SRP rather than the hosted UI, following the
 * marketing tool and QSuite: no per-environment callback URL list to maintain, and
 * localhost behaves exactly like CloudFront.
 *
 * Auth is opt-in on the frontend for the same reason it is opt-in on the backend:
 * `npm run dev` against a local uvicorn has no user pool, and a hard requirement
 * here would make local development impossible. When the pool variables are absent
 * the app renders with no login gate and sends no token. In a deployed build they
 * are always present - see .env.production.
 */

import { Amplify, Auth } from 'aws-amplify';

const USER_POOL_ID = import.meta.env.VITE_COGNITO_USER_POOL_ID;
const CLIENT_ID = import.meta.env.VITE_COGNITO_CLIENT_ID;
const REGION = import.meta.env.VITE_AWS_REGION || 'ca-central-1';

/**
 * Whether this build has a pool to talk to.
 *
 * Both values are required. A pool id without a client id cannot complete SRP, so
 * configuring Amplify half-way produces a login form that fails on submit rather
 * than an honest "no auth configured".
 */
export const isAuthConfigured: boolean = Boolean(USER_POOL_ID && CLIENT_ID);

if (isAuthConfigured) {
  Amplify.configure({
    Auth: {
      region: REGION,
      userPoolId: USER_POOL_ID,
      userPoolWebClientId: CLIENT_ID,
      // sessionStorage, not localStorage: the token dies with the tab. Same choice
      // as the marketing tool and QSuite. The refresh token is valid for twelve
      // hours (cdk/lib/cognito_stack.py) and this keeps that window from outliving
      // the browser session on a shared machine.
      storage: window.sessionStorage,
    },
  });
}

/**
 * The current ID token, or null when nobody is signed in.
 *
 * `currentSession()` renews an expired ID token off the refresh token, so callers
 * do not need a refresh timer - asking per request is both simpler and safer than
 * caching a token that may have gone stale. It rejects rather than returning null
 * when there is no user, which is what the catch is for; it is not swallowing a
 * real error.
 *
 * The ID token is the correct one to send. The API Gateway authorizer is configured
 * against the pool and validates ID tokens, and it is the ID token that carries the
 * `email` claim the audit log records against every edit.
 */
export async function getIdToken(): Promise<string | null> {
  if (!isAuthConfigured) {
    return null;
  }

  try {
    const session = await Auth.currentSession();
    return session.getIdToken().getJwtToken();
  } catch {
    return null;
  }
}

/** Sign out and drop the cached session. */
export async function signOut(): Promise<void> {
  if (!isAuthConfigured) {
    return;
  }
  await Auth.signOut();
}
