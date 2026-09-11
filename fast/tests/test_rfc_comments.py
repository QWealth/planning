"""
Comments on RFCs: who may write them, who may change them, and where they live.

WHAT THESE ARE GUARDING
-----------------------
Comments are the first child rows this table has ever held. Every read written before
them assumed one row per item - `items[0] is the item`, the kind-GSI listing, the
get_item on a fixed sort key - and none of those assumptions fails loudly if a child
row starts turning up in them. An RFC list that silently gains twelve blank entries
because comments leaked into it is the failure this file exists to catch first.

The second thing is attribution. A comment is a thing somebody said, so the two rules
worth testing by name are that the author comes from the token rather than the request
body, and that NOBODY can rewrite somebody else's text - admin included. Deleting is
different from editing and is allowed for an admin, and the asymmetry is deliberate
enough to be worth pinning down: removing a remark leaves an absence, while editing one
leaves a statement the named person never made.
"""

import pytest

from app.db.queries import work as q
from app.work import RfcStatus


def _rfc(**over):
    body = {"title": "Local AI queueing", "body": "A proposal.", "status": RfcStatus.REVIEW.value}
    body.update(over)
    return q.create_rfc(body)


def _as(monkeypatch, email, admin=True):
    """Re-point the dev-bypass identity, so one test can act as two people."""
    from app import auth

    monkeypatch.setattr(auth, "DEV_USER_EMAIL", email)
    monkeypatch.setattr(auth, "DEV_ADMIN", admin)


# ------------------------------------------------------------------ storage shape
def test_comments_do_not_leak_into_the_rfc_itself(aws):
    """
    The child row must not turn up anywhere the item is read.

    get_rfc reads a fixed sort key and _list_kind queries the kind GSI, so a comment -
    which carries no `kind` at all - should be invisible to both. If this ever breaks
    the symptom is an RFC list padded with untitled rows, which renders as real
    entries and looks like data corruption rather than a query bug.
    """
    rfc = _rfc()
    q.create_comment(rfc["item_id"], "a@qwealth.com", "first")
    q.create_comment(rfc["item_id"], "b@qwealth.com", "second")

    assert q.get_rfc(rfc["item_id"])["title"] == "Local AI queueing"
    assert [r["item_id"] for r in q.list_rfcs()] == [rfc["item_id"]]


def test_thread_is_oldest_first(aws):
    """
    Reading order comes out of the sort key, not a sort in the caller.

    The timestamp is in the sort key precisely so every reader gets this for free; a
    test here means a future switch to an id-only key cannot pass silently.
    """
    rfc = _rfc()
    for text in ("one", "two", "three"):
        q.create_comment(rfc["item_id"], "a@qwealth.com", text)

    assert [c["body"] for c in q.list_comments(rfc["item_id"])] == ["one", "two", "three"]


def test_deleting_an_rfc_takes_its_comments(aws):
    """
    A cascade, unlike subtasks under a task.

    Orphaned comment rows would be unreachable - nothing lists a partition whose item
    is gone - so they are invisible garbage rather than recoverable data.
    """
    rfc = _rfc()
    q.create_comment(rfc["item_id"], "a@qwealth.com", "will not survive")

    assert q.delete_rfc(rfc["item_id"]) is True
    assert q.list_comments(rfc["item_id"]) == []


def test_editing_moves_updated_at_only(aws):
    """`updated_at != created_at` is how a reader knows it was edited. No flag to forget."""
    rfc = _rfc()
    made = q.create_comment(rfc["item_id"], "a@qwealth.com", "before")
    assert made["created_at"] == made["updated_at"]

    edited = q.update_comment(rfc["item_id"], made["comment_id"], "after")
    assert edited["body"] == "after"
    assert edited["created_at"] == made["created_at"]
    assert edited["updated_at"] != made["created_at"]


def test_editing_cannot_change_the_author(aws):
    """
    COMMENT_UPDATABLE is an allowlist of exactly one field.

    Checked at the queries layer because that is where the guarantee lives - the route
    never offers author_email, but this is the thing that holds if a future route does.
    """
    rfc = _rfc()
    made = q.create_comment(rfc["item_id"], "a@qwealth.com", "mine")

    q.update_comment(rfc["item_id"], made["comment_id"], "still mine")
    assert q.get_comment(rfc["item_id"], made["comment_id"])["author_email"] == "a@qwealth.com"


# -------------------------------------------------------------------- through API
def test_post_and_read_a_comment(client):
    rfc = _rfc()
    posted = client.post(f"/api/rfcs/{rfc['item_id']}/comments", json={"body": "Looks right to me."})
    assert posted.status_code == 201
    assert posted.json()["body"] == "Looks right to me."
    # From the token, never the body.
    assert posted.json()["author_email"] == "tester@qwealth.com"

    listed = client.get(f"/api/rfcs/{rfc['item_id']}/comments")
    assert listed.status_code == 200
    assert [c["body"] for c in listed.json()] == ["Looks right to me."]


def test_author_in_the_request_body_is_ignored(client):
    """
    A client that can name the author can post as somebody else.

    The schema simply has no such field, so the extra key is dropped rather than
    honoured. Worth a test because "it is not in the model" is exactly the kind of
    protection a later convenience field removes without noticing.
    """
    rfc = _rfc()
    posted = client.post(
        f"/api/rfcs/{rfc['item_id']}/comments",
        json={"body": "not me", "author_email": "someone.else@qwealth.com"},
    )
    assert posted.status_code == 201
    assert posted.json()["author_email"] == "tester@qwealth.com"


@pytest.mark.parametrize("bad", ["", "   ", "\n\t "])
def test_an_empty_comment_is_refused(client, bad):
    """Whitespace-only posts an empty bubble that reads as a rendering bug."""
    rfc = _rfc()
    assert client.post(f"/api/rfcs/{rfc['item_id']}/comments", json={"body": bad}).status_code == 422


def test_body_is_stored_trimmed(client):
    rfc = _rfc()
    posted = client.post(f"/api/rfcs/{rfc['item_id']}/comments", json={"body": "  padded  "})
    assert posted.json()["body"] == "padded"


def test_commenting_on_a_missing_rfc_is_404(client):
    assert client.post("/api/rfcs/rfc_nope/comments", json={"body": "hello"}).status_code == 404
    assert client.get("/api/rfcs/rfc_nope/comments").status_code == 404


def test_author_can_edit_their_own(client):
    rfc = _rfc()
    made = client.post(f"/api/rfcs/{rfc['item_id']}/comments", json={"body": "typo"}).json()

    fixed = client.patch(
        f"/api/rfcs/{rfc['item_id']}/comments/{made['comment_id']}",
        json={"body": "fixed"},
    )
    assert fixed.status_code == 200
    assert fixed.json()["body"] == "fixed"


def test_an_admin_still_cannot_edit_somebody_elses(client, monkeypatch):
    """
    The rule with no override, and the reason this feature has an asymmetry at all.

    The caller here IS an admin - DEV_ADMIN stays on - and is still refused, because
    rewriting another person's words leaves a statement attributed to somebody who
    never made it. Deleting is the supported moderation action; see the next test.
    """
    rfc = _rfc()
    made = client.post(f"/api/rfcs/{rfc['item_id']}/comments", json={"body": "mine"}).json()

    _as(monkeypatch, "admin@qwealth.com", admin=True)
    refused = client.patch(
        f"/api/rfcs/{rfc['item_id']}/comments/{made['comment_id']}",
        json={"body": "words I never wrote"},
    )
    assert refused.status_code == 403
    # And nothing changed.
    assert q.get_comment(rfc["item_id"], made["comment_id"])["body"] == "mine"


def test_an_admin_can_delete_somebody_elses(client, monkeypatch):
    rfc = _rfc()
    made = client.post(f"/api/rfcs/{rfc['item_id']}/comments", json={"body": "off topic"}).json()

    _as(monkeypatch, "admin@qwealth.com", admin=True)
    assert client.delete(
        f"/api/rfcs/{rfc['item_id']}/comments/{made['comment_id']}"
    ).status_code == 204
    assert q.list_comments(rfc["item_id"]) == []


def test_a_plain_member_cannot_delete_somebody_elses(client, monkeypatch):
    rfc = _rfc()
    made = client.post(f"/api/rfcs/{rfc['item_id']}/comments", json={"body": "mine"}).json()

    _as(monkeypatch, "someone.else@qwealth.com", admin=False)
    assert client.delete(
        f"/api/rfcs/{rfc['item_id']}/comments/{made['comment_id']}"
    ).status_code == 403
    assert len(q.list_comments(rfc["item_id"])) == 1


def test_author_matching_ignores_address_case(client, monkeypatch):
    """
    require_planning_group returns the raw Cognito claim, which keeps its case.

    An author whose token says Tester@ and whose stored comment says tester@ must
    still be able to edit it; without normalisation they are locked out of their own
    remark with a 403 that looks like a permissions bug.
    """
    rfc = _rfc()
    made = client.post(f"/api/rfcs/{rfc['item_id']}/comments", json={"body": "mine"}).json()

    _as(monkeypatch, "Tester@QWealth.com", admin=False)
    assert client.patch(
        f"/api/rfcs/{rfc['item_id']}/comments/{made['comment_id']}",
        json={"body": "still mine"},
    ).status_code == 200


def test_editing_a_missing_comment_is_404(client):
    rfc = _rfc()
    assert client.patch(
        f"/api/rfcs/{rfc['item_id']}/comments/cmt_nope", json={"body": "x"}
    ).status_code == 404


def test_a_patch_with_no_body_is_refused(client):
    """
    There is one editable field, so an empty PATCH cannot mean anything.

    RfcUpdate treats absent as "leave alone" because it has several fields; here that
    reading would make a no-op return 200 and look like a successful edit.
    """
    rfc = _rfc()
    made = client.post(f"/api/rfcs/{rfc['item_id']}/comments", json={"body": "mine"}).json()
    assert client.patch(
        f"/api/rfcs/{rfc['item_id']}/comments/{made['comment_id']}", json={}
    ).status_code == 422
