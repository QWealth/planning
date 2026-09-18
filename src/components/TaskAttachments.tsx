/**
 * Files on a task: the list, the upload, and removing one.
 *
 * WHY THE FILE DOES NOT GO THROUGH OUR API
 * ----------------------------------------
 * `uploadAttachment` in services/api.ts posts it straight to S3 with a signature the
 * API handed back. A Lambda behind API Gateway caps a request at 6MB, so an upload
 * through the API would cap every attachment there whatever the bucket allows — see
 * fast/app/storage.py, which has the whole argument.
 *
 * The cost lands here: adding a file is three round trips, and the middle one can fail
 * on its own. So the component tracks the upload separately from the list, and a
 * failure leaves the list exactly as it was rather than half-adding a row.
 *
 * DOWNLOADS ARE FETCHED ON THE CLICK
 * ----------------------------------
 * There is no href until somebody asks for one. A presigned URL works for anybody
 * holding it until it expires, so putting one in the list would mean every row shipping
 * a working link into the browser's cache and into any console log that saw the
 * response. The click asks the API, gets a five-minute URL, and follows it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import styled from 'styled-components';

import {
  deleteAttachment,
  describeError,
  getAttachmentDownload,
  getAttachments,
  uploadAttachment,
} from '../services/api';
import { palette, radius } from '../styles/theme';
import { ErrorText, Hint, SecondaryButton } from '../styles/ui';
import type { Attachment } from '../types';
import { formatTimestamp } from '../utils/dates';

const Wrap = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
`;

const Row = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
`;

const List = styled.ul`
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
`;

const Item = styled.li`
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border: 1px solid ${palette.border};
  border-radius: ${radius.md};
  background: ${palette.card};
`;

/*
  The filename is the control. A button rather than a link, because there is no href
  until the API has been asked for one — and a link with no destination that becomes one
  on click is the thing screen readers and middle-click both get wrong.
*/
const Name = styled.button`
  flex: 1;
  min-width: 0;
  text-align: left;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  color: ${palette.deepMagenta};
  background: transparent;
  border: 0;
  padding: 0;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;

  &:hover {
    text-decoration: underline;
  }

  &:disabled {
    color: ${palette.inkSoft};
    cursor: progress;
  }
`;

const Meta = styled.span`
  flex: none;
  font-size: 11px;
  color: ${palette.inkSoft};
  white-space: nowrap;
`;

/*
  A real <input type="file"> behind a button.

  The input itself is hidden rather than styled, because it cannot be styled usefully
  across browsers and the label-wrapping trick loses the disabled state. Hidden with
  `display: none` is fine here: it is driven by a ref from a button that is itself
  focusable, so nothing is unreachable by keyboard.
*/
const HiddenInput = styled.input`
  display: none;
`;

/** Bytes as somebody would say them. Not 1024-based: disks and files are sold in MB. */
function readableSize(bytes: number): string {
  if (bytes < 1000) {
    return `${bytes} B`;
  }
  if (bytes < 1000 * 1000) {
    return `${Math.round(bytes / 1000)} KB`;
  }
  return `${(bytes / 1000 / 1000).toFixed(1)} MB`;
}

export default function TaskAttachments({ itemId }: { itemId: string }) {
  const [files, setFiles] = useState<Attachment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    try {
      setFiles(await getAttachments(itemId));
    } catch (err) {
      setError(describeError(err));
      setFiles([]);
    }
  }, [itemId]);

  useEffect(() => {
    void load();
  }, [load]);

  const onPicked = async (chosen: FileList | null) => {
    const file = chosen?.[0];
    if (!file) {
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const added = await uploadAttachment(itemId, file);
      // Appended rather than refetched. The list is ordered oldest first and this is
      // the newest, so the local answer and the server's agree — and a refetch here
      // would be a third round trip on top of the three the upload already costs.
      setFiles((current) => [...(current ?? []), added]);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setUploading(false);
      // Cleared so the same file can be picked again after a failure. Without this the
      // input holds the value and the change event never fires a second time.
      if (picker.current) {
        picker.current.value = '';
      }
    }
  };

  const onDownload = async (attachment: Attachment) => {
    setBusyId(attachment.attachment_id);
    setError(null);
    try {
      const url = await getAttachmentDownload(itemId, attachment.attachment_id);
      /*
        Assigning rather than window.open, because a popup blocker stops the second one
        and not the first. The URL forces Content-Disposition: attachment, so the
        browser downloads it and stays on this page rather than navigating away.
      */
      window.location.assign(url);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusyId(null);
    }
  };

  const onRemove = async (attachment: Attachment) => {
    setBusyId(attachment.attachment_id);
    setError(null);
    try {
      await deleteAttachment(itemId, attachment.attachment_id);
      setFiles((current) =>
        (current ?? []).filter((f) => f.attachment_id !== attachment.attachment_id)
      );
      setConfirming(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Wrap>
      <Row>
        <SecondaryButton
          type="button"
          onClick={() => picker.current?.click()}
          disabled={uploading}
        >
          {uploading ? 'Uploading…' : 'Attach a file'}
        </SecondaryButton>
        <HiddenInput
          ref={picker}
          type="file"
          onChange={(e) => void onPicked(e.target.files)}
        />
        {files !== null && files.length === 0 && !uploading ? (
          <Hint>Nothing attached yet.</Hint>
        ) : null}
      </Row>

      {error ? <ErrorText role="alert">{error}</ErrorText> : null}

      {files && files.length > 0 ? (
        <List>
          {files.map((file) => (
            <Item key={file.attachment_id}>
              <Name
                type="button"
                title={`Download ${file.filename}`}
                disabled={busyId === file.attachment_id}
                onClick={() => void onDownload(file)}
              >
                {file.filename}
              </Name>
              <Meta>{readableSize(file.size)}</Meta>
              {/* Who and when, because a file on a shared task with no name against it
                  is one nobody will delete for fear of it being somebody else's. */}
              <Meta title={file.uploaded_by ?? undefined}>
                {file.uploaded_by} · {formatTimestamp(file.created_at)}
              </Meta>
              {confirming === file.attachment_id ? (
                <>
                  <Hint>Delete it?</Hint>
                  <SecondaryButton type="button" onClick={() => setConfirming(null)}>
                    Keep
                  </SecondaryButton>
                  <SecondaryButton
                    type="button"
                    disabled={busyId === file.attachment_id}
                    onClick={() => void onRemove(file)}
                  >
                    Delete
                  </SecondaryButton>
                </>
              ) : (
                /* Never one click. The file is recoverable from a bucket version by
                   somebody with console access, which is not a recovery anybody on this
                   page can perform. */
                <SecondaryButton
                  type="button"
                  onClick={() => setConfirming(file.attachment_id)}
                >
                  Remove
                </SecondaryButton>
              )}
            </Item>
          ))}
        </List>
      ) : null}
    </Wrap>
  );
}
