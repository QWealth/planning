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
 */

import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import AppShell from './components/AppShell';
import LoginGate from './components/LoginGate';
import RoadmapPage from './pages/RoadmapPage';
import TeamPage from './pages/TeamPage';
import { GlobalStyle } from './styles/ui';

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
