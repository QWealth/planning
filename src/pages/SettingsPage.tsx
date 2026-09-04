/**
 * Your own Monday digest: whether it arrives, how far ahead it looks, and what it says.
 *
 * ONE PERSON'S PAGE
 * -----------------
 * Everything here is read and written for the signed-in address and nobody else. There
 * is deliberately no "manage everyone's reminders" view: this switch decides whether a
 * colleague gets a direct message, and that is theirs to answer. An admin who needs it
 * off for somebody can edit their roster row on the Team page, which already has the
 * permission tier for acting on other people.
 *
 * SAVED ON CHANGE, NOT ON SUBMIT
 * ------------------------------
 * The other editors in this app are React Hook Form and a Save button, because they
 * carry several fields that only make sense together - a phase with a start and no end
 * is not a state worth persisting halfway. This page is three independent switches, and
 * a Save button next to a toggle is a second thing to click and a new way to lose a
 * change by navigating away. So each control writes immediately and the panel says so.
 *
 * The preview refetches after every save rather than being recomposed here. The text is
 * built by fast/app/digest.py and a second implementation in TypeScript would drift -
 * and would drift SILENTLY, since the only way to notice would be to receive a real DM
 * that read differently from the preview that talked you into switching it on.
 *
 * WHAT AN EMPTY PREVIEW MEANS
 * ---------------------------
 * That you would be sent nothing. A digest with no milestones in it is not delivered at
 * all - see compose_digest - so "nothing this week" is the honest rendering, not an
 * error and not an empty box. The window picker is the interesting control here for
 * exactly that reason: it is how somebody finds out that 7 days is silent for them and
 * 30 is not.
 */

import { useCallback, useEffect, useState } from 'react';
import styled from 'styled-components';

import { useIdentity } from '../components/AppShell';
import { describeError, getDigestPreview, getPerson, patchPerson } from '../services/api';
import { monoStack, palette, radius } from '../styles/theme';
import { ErrorText, Hint, Panel, ToggleButton } from '../styles/ui';
import { DIGEST_WINDOWS } from '../types';
import type { DigestPreview, Person } from '../types';

const Head = styled.h2`
  font-size: 14px;
  color: ${palette.deepMagenta};
  margin: 0 0 8px;
`;

/*
  A sub-heading, styled as a field label rather than as a smaller Head.

  Sized like one deliberately: these name the two controls under the panel's own
  heading, and drawn at heading weight all three lines competed and the panel read as
  three unrelated sections rather than one setting with two dials.
*/
const SubHead = styled.h3`
  margin: 0;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: ${palette.inkSoft};
`;

const Rows = styled.div`
  display: flex;
  flex-direction: column;
  gap: 16px;
`;

const Row = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
`;

const Controls = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
`;

const Status = styled.p`
  margin: 0;
  font-size: 12px;
  color: ${palette.inkSoft};
`;

/*
  The composed message, in the font it will not be read in.

  Monospace because this is a quotation of a machine's output rather than prose, and the
  Slack mrkdwn is shown raw - the asterisks around a heading are left visible instead of
  being rendered bold. Faking Slack's own formatting here would be a worse lie than the
  asterisks are an ugliness: the preview would then differ from the message in a way that
  looks like a rendering bug when the real one arrives.
*/
const Message = styled.pre`
  margin: 0;
  padding: 12px 14px;
  border: 1px solid ${palette.border};
  border-radius: ${radius.md};
  background: ${palette.blush};
  font-family: ${monoStack};
  font-size: 12px;
  line-height: 1.5;
  color: ${palette.ink};
  white-space: pre-wrap;
  word-break: break-word;
`;

export default function SettingsPage() {
  const identity = useIdentity();
  const email = identity?.email ?? null;
  const isAdmin = identity?.is_admin ?? false;

  const [person, setPerson] = useState<Person | null>(null);
  const [preview, setPreview] = useState<DigestPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  /*
    The roster row AND the preview, because neither answers the whole page. The row
    carries digest_admin_report, which the preview cannot report: an empty
    unowned_report means "not subscribed" and "nothing unowned this week" equally, and
    a switch drawn from that would sit in the off position for a subscriber in a quiet
    week. The preview carries the text, which the row does not hold at all.
  */
  const load = useCallback(async () => {
    if (!email) {
      return;
    }
    setError(null);
    try {
      const [row, composed] = await Promise.all([getPerson(email), getDigestPreview()]);
      setPerson(row);
      setPreview(composed);
    } catch (err) {
      setError(describeError(err));
    }
  }, [email]);

  useEffect(() => {
    void load();
  }, [load]);

  /*
    Write one field, then re-read both.

    The local state is replaced with what the API returned rather than with what was
    sent: digest_days is clamped server-side to the offered set, so echoing the request
    would let this page show a window the job will not use.
  */
  const save = useCallback(
    async (patch: Partial<Pick<Person, 'digest_enabled' | 'digest_days' | 'digest_admin_report'>>) => {
      if (!email) {
        return;
      }
      setError(null);
      setSaved(false);
      setSaving(true);
      try {
        setPerson(await patchPerson(email, patch));
        setPreview(await getDigestPreview());
        setSaved(true);
      } catch (err) {
        setError(describeError(err));
        // Re-read, so the controls go back to what is actually stored. Leaving them on
        // the rejected value would show somebody a setting they do not have.
        await load();
      } finally {
        setSaving(false);
      }
    },
    [email, load]
  );

  if (!email) {
    // Identity is still in flight, or the API declined to name the caller. Either way
    // there is no address to read settings for, and guessing one is not an option.
    return (
      <Panel>
        <Status>Loading…</Status>
      </Panel>
    );
  }

  const enabled = person?.digest_enabled ?? false;
  const days = person?.digest_days ?? 14;
  const adminReport = person?.digest_admin_report ?? false;

  return (
    <>
      <Panel>
        <Head>Milestone reminders</Head>
        <Rows>
          <Row>
            <Controls>
              <ToggleButton
                type="button"
                $on={enabled}
                aria-pressed={enabled}
                disabled={saving || person === null}
                onClick={() => void save({ digest_enabled: !enabled })}
              >
                {enabled ? 'On' : 'Off'}
              </ToggleButton>
              <Hint>
                A Slack DM on Monday morning listing the milestones you are DRI on. Nothing
                is sent in a week where you have none.
              </Hint>
            </Controls>
          </Row>

          <Row>
            <SubHead>How far ahead</SubHead>
            <Controls>
              {DIGEST_WINDOWS.map((window) => (
                <ToggleButton
                  key={window}
                  type="button"
                  $on={days === window}
                  aria-pressed={days === window}
                  disabled={saving || person === null}
                  onClick={() => void save({ digest_days: window })}
                >
                  {window} days
                </ToggleButton>
              ))}
            </Controls>
            {/* Overdue milestones are not governed by this. They are in every digest
                however old they are, because a date that has passed unacknowledged is
                the thing a reminder exists for. */}
            <Hint>
              Milestones already past their date are always included, whichever window you
              pick.
            </Hint>
          </Row>

          {isAdmin ? (
            <Row>
              <SubHead>Unowned milestones</SubHead>
              <Controls>
                <ToggleButton
                  type="button"
                  $on={adminReport}
                  aria-pressed={adminReport}
                  disabled={saving || person === null}
                  onClick={() => void save({ digest_admin_report: !adminReport })}
                >
                  {adminReport ? 'On' : 'Off'}
                </ToggleButton>
                <Hint>
                  A second DM listing milestones on projects with no DRI - the ones nobody
                  was reminded about. Admins only.
                </Hint>
              </Controls>
            </Row>
          ) : null}

          {saving ? <Status>Saving…</Status> : null}
          {saved && !saving ? <Status>Saved.</Status> : null}
          {error ? <ErrorText role="alert">{error}</ErrorText> : null}
        </Rows>
      </Panel>

      <Panel>
        <Head>What you would be sent</Head>
        {preview === null ? (
          <Status>Loading…</Status>
        ) : (
          <Rows>
            {/*
              Shown whether or not the switch above is on, and that is the point of the
              page. Somebody deciding whether to opt in can read the actual message
              first; a preview that only worked once you had already agreed to be
              messaged would be useless for the one decision it exists to inform.
            */}
            <Status>
              For the week of {preview.week}, looking {preview.days} days ahead.
            </Status>

            {preview.digest ? (
              <Message>{preview.digest}</Message>
            ) : (
              <Hint>
                Nothing this week - you have no milestones due in the next {preview.days}{' '}
                days and none past their date. No message would be sent.
              </Hint>
            )}

            {preview.unowned_report ? (
              <>
                <Status>And, as an admin, a second message:</Status>
                <Message>{preview.unowned_report}</Message>
              </>
            ) : null}

            {/*
              The deployment-level switch, which is a different question from the one at
              the top of this page. With it off the schedule still runs and logs that it
              is disabled, so this line is the only place the distinction is visible to
              somebody who has just switched their own reminders on and is wondering why
              Monday was quiet. See cdk/cdk.json:digest_enabled.
            */}
            {!preview.sending_enabled ? (
              <Hint>
                Sending is switched off for this deployment, so no reminders go out yet
                whatever you set here. Your choice is saved and will be honoured once it is
                turned on.
              </Hint>
            ) : null}
          </Rows>
        )}
      </Panel>
    </>
  );
}
