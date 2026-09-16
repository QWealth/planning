/**
 * The application: sign-in gate, router, and the two pages inside the shell.
 *
 * This file used to hold the roadmap itself and a note saying a router would be
 * added if a second real page ever arrived. The Team page is that second page, so
 * here it is.
 *
 * Deep links work because CloudFront is configured to answer both 403 and 404 with
 * /index.html at status 200 (cdk/lib/frontend_stack.py) - S3 returns 403, not 404,
 * for a key that does not exist when the bucket is private, so mapping only 404
 * would leave /team as an access-denied page for anybody who typed it or reloaded on
 * it. Verified against the deployed site, not just reasoned about.
 *
 * BrowserRouter rather than HashRouter for the same reason: /team is an address
 * somebody can be sent, and #/team in an email looks like a broken link.
 *
 * The layout route means AppShell mounts once and stays mounted while the tabs
 * change, so /api/me is called once per session rather than once per navigation.
 * Page state is deliberately NOT hoisted with it - switching tabs refetches the
 * roadmap, which is the correct behaviour for a board several people are editing at
 * the same time.
 *
 * THE PAGES ARE LAZY, AND THE RFC PAGES ARE WHY
 * ---------------------------------------------
 * Markdown rendering is a large dependency - the parser, the AST, the GitHub
 * extensions - and it is needed by exactly one route. Imported statically it lands in
 * the single bundle that everybody downloads before the roadmap can paint, so the
 * people who never open an RFC pay for it on every cold load.
 *
 * React.lazy puts each page in its own chunk, and Vite follows the import graph, so
 * the markdown code follows RfcPage into a chunk that is fetched the first time
 * somebody navigates there. The measured effect was worth doing before adding the
 * dependency rather than after: it is much easier to keep a bundle split than to
 * split one that has already grown.
 *
 * AppShell and LoginGate stay STATIC on purpose. Both are on the path to every route
 * - lazy-loading them would add a network round trip before anything at all can
 * render, in exchange for splitting out two files that are needed immediately.
 *
 * The Suspense boundary lives inside AppShell rather than here, wrapped around the
 * outlet it already renders. That is not a stylistic choice: AppShell passes the
 * identity down through `<Outlet context={identity} />`, and a second, pathless
 * <Route> holding its own <Outlet /> would provide `undefined` over the top of it -
 * react-router's useOutlet always installs a provider, with whatever it was given.
 * Every page's useIdentity() would then read null, and the Team page would quietly
 * stop drawing its admin controls with nothing on screen to explain why.
 */

import { lazy } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import AppShell from './components/AppShell';
import LoginGate from './components/LoginGate';
import { GlobalStyle } from './styles/ui';

const RoadmapPage = lazy(() => import('./pages/RoadmapPage'));
const TeamPage = lazy(() => import('./pages/TeamPage'));
const RfcsPage = lazy(() => import('./pages/RfcsPage'));
const RfcPage = lazy(() => import('./pages/RfcPage'));
const TasksPage = lazy(() => import('./pages/TasksPage'));
const TaskPage = lazy(() => import('./pages/TaskPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const MilestoneLogPage = lazy(() => import('./pages/MilestoneLogPage'));

export default function App() {
  return (
    <>
      <GlobalStyle />
      <LoginGate>
        {(auth) => (
          <BrowserRouter>
            <Routes>
              <Route element={<AppShell auth={auth} />}>
                <Route index element={<RoadmapPage />} />
                <Route path="team" element={<TeamPage />} />
                <Route path="rfcs" element={<RfcsPage />} />
                {/* The reader and the editor are one route: /rfcs/new is the editor
                    with nothing loaded, which keeps "write an RFC" a real address
                    somebody can be sent rather than a mode you can only reach by
                    clicking. */}
                <Route path="rfcs/:itemId" element={<RfcPage />} />
                <Route path="tasks" element={<TasksPage />} />
                {/* Same shape as the RFC pair, and for the same reason: /tasks/new is
                    the editor with nothing loaded, so "add a task" is an address
                    somebody can be sent. The `new` sentinel cannot collide with a
                    real id because ids carry a `tsk_` prefix. */}
                <Route path="tasks/:itemId" element={<TaskPage />} />
                {/* One person's own preferences, so there is no id in the path - the
                    page reads the signed-in address from the identity the shell already
                    fetched. /settings/{email} would imply somebody else's are editable
                    here, and they are not. */}
                <Route path="settings" element={<SettingsPage />} />
                {/* The milestone log. A real route rather than a panel on another
                    page, because it is a thing somebody links to - "see the log, this
                    is the third time" is a message people send. Unguarded here on
                    purpose: the page itself explains the refusal, and a route that
                    silently redirected would leave somebody who typed the address with
                    no idea why they are looking at the roadmap. */}
                <Route path="milestone-log" element={<MilestoneLogPage />} />
                {/* Anything else goes to the roadmap rather than to a 404 page. The
                    only ways to reach an unknown path are a typo and a stale link,
                    and both are better served by the board than by an apology. */}
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </BrowserRouter>
        )}
      </LoginGate>
    </>
  );
}
