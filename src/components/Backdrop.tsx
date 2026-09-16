/**
 * The sunset behind everything: a full-bleed video, a scrim over it, and whatever the
 * page is on top.
 *
 * Extracted from AppShell when the sign-in screen needed the same thing. The two
 * screens have nothing else in common - one is the authenticated app, the other is the
 * only page an unauthenticated visitor ever sees - and a second copy of the video tag
 * would have been two places to change the filename, two reduced-motion checks to keep
 * in step, and two z-index stacks to keep agreeing with each other.
 *
 * Three layers, and the z-index order is the whole of it: video 0, scrim 1, and the
 * page at 10. Anything rendering this must put itself above both, or it draws behind
 * the scrim and reads as though somebody left a translucent sheet over the screen.
 */

import { useMemo } from 'react';
import styled from 'styled-components';

import { palette } from '../styles/theme';

/*
  Fixed rather than absolute so it does not scroll away on a long roadmap, and
  `pointer-events: none` on both layers so neither ever eats a click. `object-fit:
  cover` because the clip has one aspect ratio and the window has all of them.
*/
const BgVideo = styled.video`
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  pointer-events: none;
  z-index: 0;
`;

/*
  The veil. Doing real work rather than decoration: the clip is a saturated sunset and
  the gaps between cards are where text sits directly over it. Warm white in the light
  theme, navy in the dark one - see palette.scrim.
*/
const Scrim = styled.div`
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background: ${palette.scrim};
  pointer-events: none;
  z-index: 1;
`;

export default function Backdrop() {
  /*
    Asked once, at mount, and not watched afterwards.

    Somebody who changes this system setting mid-session gets it on their next
    navigation, which is a reasonable trade for not holding a matchMedia listener open
    for the life of the app. `?.` because jsdom in the unit tests has no matchMedia.
  */
  const reducedMotion = useMemo(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false,
    []
  );

  return (
    <>
      {/*
        Skipped entirely, not merely paused, when the machine asks for reduced motion.

        This app already treats that setting as load-bearing rather than polite - see
        the note in styles/ui.ts about a nine-lane reflow being a genuine vestibular
        trigger - and a full-screen looping video is a stronger version of the same
        thing. Checked in JS rather than hidden in CSS so the 474KB is never fetched by
        somebody who asked not to see it; the body's gradient wash shows through
        instead, which is what the page looked like before the video existed.

        Served from /assets/ rather than the root, and that is not tidiness. The
        frontend stack caches everything except index.html for a year as `immutable`,
        and invalidates only /assets/* on deploy - so a stable filename at the root
        would be pinned at every edge for a year the first time it was replaced. This
        is the same trap index.html documents for the favicon, and the same answer.
      */}
      {!reducedMotion ? (
        <BgVideo autoPlay loop muted playsInline aria-hidden="true">
          <source src="/assets/bg.mp4" type="video/mp4" />
        </BgVideo>
      ) : null}
      <Scrim aria-hidden="true" />
    </>
  );
}
