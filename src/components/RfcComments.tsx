/**
 * The discussion under an RFC.
 *
 * WHY THIS IS ON THE READER AND NOT THE EDITOR
 * --------------------------------------------
 * Commenting is what the `review` status ("Open for comment. Waiting on the team.")
 * actually asks people to do, and the reader is where they arrive from a link. Putting
 * the thread behind Edit would mean opening the editing form to reply, which both
 * invites accidental changes to the proposal and makes replying feel like an act of
 * authorship rather than of review.
 *
 * WHO SEES WHICH BUTTONS, AND WHY THEY DIFFER
 * -------------------------------------------
 * Edit appears only on your own comments - an admin looking at somebody else's does
 * not get one, because the API refuses it and drawing a control that always 403s is
 * worse than drawing none. Delete appears on your own and, for an admin, on anybody's.
 *
 * That asymmetry is the backend's rule and this file only reflects it: removing a
 * remark leaves an absence, while editing one would leave a statement attributed to
 * somebody who never made it. See the comments section of fast/app/routes/work.py.
 *
 * NOTHING HERE IS OPTIMISTIC
 * --------------------------
 * Every action waits for the server and then uses what it returned. A thread is the
 * one place where showing text that was not actually saved is genuinely harmful: the
 * author walks away believing they raised an objection that no one else can see.
 */

import { useCallback, useEffect, useState } from 'react';
import styled from 'styled-components';

import {
  createRfcComment,
  deleteRfcComment,
  describeError,
  getRfcComments,
  updateRfcComment,
} from '../services/api';
import { field, palette, radius } from '../styles/theme';
import { DangerButton, ErrorText, Hint, PrimaryButton, SecondaryButton } from '../styles/ui';
import type { RfcComment } from '../types';
import { formatTimestamp } from '../utils/dates';
import Markdown from './Markdown';
import { useIdentity } from './AppShell';

const Wrap = styled.section`
  border-top: 1px solid ${palette.border};
  margin-top: 22px;
  padding-top: 18px;
`;

const Head = styled.h3`
  margin: 0 0 12px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: ${palette.inkSoft};
`;

const List = styled.div`
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 16px;
`;

const Item = styled.article`
  border: 1px solid ${palette.border};
  border-radius: ${radius.md};
  background: ${palette.blush};
  padding: 10px 14px;
`;

const Byline = styled.div`
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 6px;
`;

const Author = styled.span`
  font-size: 12px;
  font-weight: 700;
  color: ${palette.ink};
`;

/*
  The comment text.

  Markdown, like the proposal above it, because a reply quoting a code fence or a
  bulleted list is the normal shape of a technical objection - and because rendering
  the RFC as markdown and the replies as plain text would make the same asterisks mean
  two different things on one page.
*/
const Text = styled.div`
  font-size: 13px;
  line-height: 1.55;

  /* The document renderer sets generous margins suited to a long article. Inside a
     reply they leave a one-line remark floating in whitespace. */
  & > *:first-child {
    margin-top: 0;
  }

  & > *:last-child {
    margin-bottom: 0;
  }
`;

const Editor = styled.textarea`
  ${field};
  width: 100%;
  min-height: 90px;
  line-height: 1.55;
  resize: vertical;
`;

const Actions = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 8px;
`;

function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  // The API lowercases the author on write, but the identity comes from a Cognito
  // claim that keeps whatever case the account was made with. Comparing them raw
  // hides your own Edit button from you.
  return (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
}

interface Props {
  itemId: string;
}

export default function RfcComments({ itemId }: Props) {
  const identity = useIdentity();
  const me = identity?.email ?? null;
  const isAdmin = identity?.is_admin ?? false;

  const [comments, setComments] = useState<RfcComment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);

  // Which comment is open in the inline editor, and which is mid-confirm for deletion.
  // Two ids rather than two booleans, so opening one closes nothing else by accident.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setComments(await getRfcComments(itemId));
    } catch (err) {
      setError(describeError(err));
    }
  }, [itemId]);

  useEffect(() => {
    void load();
  }, [load]);

  const onPost = async () => {
    const text = draft.trim();
    if (!text) {
      return;
    }
    setPosting(true);
    setError(null);
    try {
      const saved = await createRfcComment(itemId, text);
      setComments((prev) => [...(prev ?? []), saved]);
      // Cleared only after the server took it. Clearing first loses what somebody
      // wrote if the request fails, which is the one thing a comment box must not do.
      setDraft('');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPosting(false);
    }
  };

  const onSaveEdit = async (commentId: string) => {
    const text = editDraft.trim();
    if (!text) {
      return;
    }
    setBusyId(commentId);
    setError(null);
    try {
      const saved = await updateRfcComment(itemId, commentId, text);
      setComments((prev) =>
        (prev ?? []).map((c) => (c.comment_id === commentId ? saved : c))
      );
      setEditingId(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusyId(null);
    }
  };

  const onDelete = async (commentId: string) => {
    setBusyId(commentId);
    setError(null);
    try {
      await deleteRfcComment(itemId, commentId);
      setComments((prev) => (prev ?? []).filter((c) => c.comment_id !== commentId));
      setConfirmingId(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Wrap>
      <Head>Discussion</Head>

      {comments === null ? (
        <Hint>Loading…</Hint>
      ) : (
        <List>
          {comments.length === 0 ? (
            <Hint>No comments yet. If this proposal is open for comment, say so here.</Hint>
          ) : (
            comments.map((comment) => {
              const mine = sameAddress(comment.author_email, me);
              const editing = editingId === comment.comment_id;
              const busy = busyId === comment.comment_id;
              // Derived, never a stored flag - see RfcComment in types.ts.
              const edited =
                comment.updated_at !== null && comment.updated_at !== comment.created_at;

              return (
                <Item key={comment.comment_id}>
                  <Byline>
                    <Author>{comment.author_email ?? 'Unknown'}</Author>
                    <Hint>{formatTimestamp(comment.created_at)}</Hint>
                    {edited ? (
                      <Hint title={`Edited ${formatTimestamp(comment.updated_at)}`}>edited</Hint>
                    ) : null}
                  </Byline>

                  {editing ? (
                    <>
                      <Editor
                        value={editDraft}
                        onChange={(e) => setEditDraft(e.target.value)}
                        disabled={busy}
                        aria-label="Edit comment"
                      />
                      <Actions>
                        <PrimaryButton
                          type="button"
                          onClick={() => void onSaveEdit(comment.comment_id)}
                          disabled={busy || !editDraft.trim()}
                        >
                          {busy ? 'Saving…' : 'Save'}
                        </PrimaryButton>
                        <SecondaryButton
                          type="button"
                          onClick={() => setEditingId(null)}
                          disabled={busy}
                        >
                          Cancel
                        </SecondaryButton>
                      </Actions>
                    </>
                  ) : (
                    <>
                      <Text>
                        <Markdown>{comment.body}</Markdown>
                      </Text>

                      {/* Only the controls the API would actually honour. */}
                      {mine || isAdmin ? (
                        <Actions>
                          {mine ? (
                            <SecondaryButton
                              type="button"
                              onClick={() => {
                                setEditingId(comment.comment_id);
                                setEditDraft(comment.body);
                                setConfirmingId(null);
                              }}
                              disabled={busy}
                            >
                              Edit
                            </SecondaryButton>
                          ) : null}

                          {confirmingId === comment.comment_id ? (
                            <>
                              <Hint>Delete this comment?</Hint>
                              <SecondaryButton
                                type="button"
                                onClick={() => setConfirmingId(null)}
                                disabled={busy}
                              >
                                Keep it
                              </SecondaryButton>
                              <DangerButton
                                type="button"
                                onClick={() => void onDelete(comment.comment_id)}
                                disabled={busy}
                              >
                                {busy ? 'Deleting…' : 'Delete'}
                              </DangerButton>
                            </>
                          ) : (
                            /* Two-press, like deleting the RFC itself. A comment is
                               hard-deleted and the text survives only in the audit
                               row, so a stray click is not recoverable from the UI. */
                            <SecondaryButton
                              type="button"
                              onClick={() => setConfirmingId(comment.comment_id)}
                              disabled={busy}
                            >
                              Delete
                            </SecondaryButton>
                          )}
                        </Actions>
                      ) : null}
                    </>
                  )}
                </Item>
              );
            })
          )}
        </List>
      )}

      <Editor
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Add a comment. Markdown works."
        disabled={posting || me === null}
        aria-label="Add a comment"
      />
      <Actions>
        <PrimaryButton
          type="button"
          onClick={() => void onPost()}
          disabled={posting || !draft.trim() || me === null}
        >
          {posting ? 'Posting…' : 'Comment'}
        </PrimaryButton>
        {/* Identity is null until /api/me answers, and posting without it would
            attribute the remark to whoever the API decides the caller is. */}
        {me === null ? <Hint>Loading your account…</Hint> : null}
      </Actions>

      {error ? <ErrorText role="alert">{error}</ErrorText> : null}
    </Wrap>
  );
}
