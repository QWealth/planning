"""
Files on a task: the three-step upload, and the rules that stop a broken link.

The tests that matter here are the ones about the states between the three calls,
because that is where this design pays for its speed. A row exists before the bytes do,
so the interesting questions are: what does a list show while an upload is in flight,
what happens when the browser says it finished and it did not, and what is left behind
when somebody deletes one.

Nothing here signs a real URL against real S3 - moto's S3 is what `aws` gives us, and
generate_presigned_post against it produces a well-formed URL that no test uploads to.
What is asserted is the metadata and the refusals, which is where the bugs would be.
"""

import pytest

from app import config, storage
from app.db.queries import work as q


@pytest.fixture
def bucket(aws, monkeypatch):
    """A configured attachments bucket, and the app pointed at it."""
    import boto3

    name = "planning-roadmap-attachments-test"
    boto3.client("s3", region_name="ca-central-1").create_bucket(
        Bucket=name,
        CreateBucketConfiguration={"LocationConstraint": "ca-central-1"},
    )
    monkeypatch.setattr(config, "ATTACHMENTS_BUCKET", name)
    # The client is memoised, and a previous test may have built one against a
    # different mock. Cleared so each test signs with this one.
    monkeypatch.setattr(storage, "_client", None)
    return name


def _task(client) -> str:
    created = client.post("/api/tasks", json={"title": "Wire it up", "status": "backlog"})
    assert created.status_code == 201, created.text
    return created.json()["item_id"]


def _start(client, item_id: str, **overrides):
    body = {"filename": "notes.pdf", "content_type": "application/pdf", "size": 1234}
    body.update(overrides)
    return client.post(f"/api/tasks/{item_id}/attachments", json=body)


# --- the three steps ---------------------------------------------------------


def test_starting_an_upload_returns_a_signed_post(client, bucket) -> None:
    item_id = _task(client)
    response = _start(client, item_id)

    assert response.status_code == 201
    body = response.json()
    assert body["upload_url"]
    # The signature and the policy ride in the fields, which the browser posts back
    # verbatim alongside the file.
    assert "policy" in body["fields"]
    assert body["attachment"]["filename"] == "notes.pdf"


def test_a_started_upload_is_not_listed_until_it_finishes(client, bucket) -> None:
    """
    The rule that makes an abandoned upload invisible rather than broken. The row exists
    from the moment the URL is signed, so anything the browser started and did not
    finish would otherwise draw a row whose download 404s.
    """
    item_id = _task(client)
    _start(client, item_id)
    assert client.get(f"/api/tasks/{item_id}/attachments").json() == []


def test_finishing_without_the_file_arriving_is_refused(client, bucket) -> None:
    # The browser's word for it is not enough. A row flipped on that word alone is an
    # attachment in the list that 404s on click.
    item_id = _task(client)
    attachment_id = _start(client, item_id).json()["attachment"]["attachment_id"]

    response = client.post(f"/api/tasks/{item_id}/attachments/{attachment_id}/done")
    assert response.status_code == 409
    assert client.get(f"/api/tasks/{item_id}/attachments").json() == []


def test_the_whole_round_trip(client, bucket) -> None:
    import boto3

    item_id = _task(client)
    started = _start(client, item_id).json()
    attachment_id = started["attachment"]["attachment_id"]

    # Stand in for the browser's POST to S3.
    row = q.get_attachment(item_id, attachment_id)
    boto3.client("s3", region_name="ca-central-1").put_object(
        Bucket=bucket, Key=row["storage_key"], Body=b"hello"
    )

    done = client.post(f"/api/tasks/{item_id}/attachments/{attachment_id}/done")
    assert done.status_code == 200

    listed = client.get(f"/api/tasks/{item_id}/attachments").json()
    assert [a["filename"] for a in listed] == ["notes.pdf"]
    # The key and the URL are internal. One is an address and the other is a
    # capability; neither belongs in a list response.
    assert "storage_key" not in listed[0]
    assert "url" not in listed[0]


def test_a_download_link_is_minted_per_click(client, bucket) -> None:
    import boto3

    item_id = _task(client)
    started = _start(client, item_id).json()
    attachment_id = started["attachment"]["attachment_id"]
    row = q.get_attachment(item_id, attachment_id)
    boto3.client("s3", region_name="ca-central-1").put_object(
        Bucket=bucket, Key=row["storage_key"], Body=b"hello"
    )
    client.post(f"/api/tasks/{item_id}/attachments/{attachment_id}/done")

    response = client.get(f"/api/tasks/{item_id}/attachments/{attachment_id}/download")
    assert response.status_code == 200
    url = response.json()["url"]
    # Forced to download rather than render. An uploaded .html or .svg opening as a
    # page in the viewer's browser is the thing this prevents - see app/storage.py.
    assert "attachment" in url or "Disposition" in url
    assert response.json()["expires_in"] == config.DOWNLOAD_URL_TTL


def test_a_pending_attachment_cannot_be_downloaded(client, bucket) -> None:
    item_id = _task(client)
    attachment_id = _start(client, item_id).json()["attachment"]["attachment_id"]
    assert (
        client.get(f"/api/tasks/{item_id}/attachments/{attachment_id}/download").status_code
        == 404
    )


# --- the refusals ------------------------------------------------------------


def test_a_filename_with_a_path_in_it_is_reduced_to_its_name(client, bucket) -> None:
    """
    It never becomes a storage key - storage_key uses a uuid, so a traversal has
    nowhere to go - but it does become a Content-Disposition and a line on the page.
    """
    item_id = _task(client)
    body = _start(client, item_id, filename="../../etc/passwd").json()
    assert body["attachment"]["filename"] == "passwd"


def test_an_oversized_file_is_refused_before_anything_is_written(client, bucket) -> None:
    item_id = _task(client)
    response = _start(client, item_id, size=config.MAX_ATTACHMENT_BYTES + 1)
    assert response.status_code == 422
    assert client.get(f"/api/tasks/{item_id}/attachments").json() == []


def test_attachments_on_a_task_that_does_not_exist_are_a_404(client, bucket) -> None:
    assert client.get("/api/tasks/tsk_nope/attachments").status_code == 404
    assert _start(client, "tsk_nope").status_code == 404


def test_an_unconfigured_deployment_lists_nothing_rather_than_erroring(client, aws) -> None:
    """
    The state of every local run. A task page rendering "no files" is correct; an error
    banner on every task would be noise about a feature nobody switched on.
    """
    item_id = _task(client)
    assert client.get(f"/api/tasks/{item_id}/attachments").json() == []


def test_an_unconfigured_deployment_refuses_an_upload_with_501(client, aws) -> None:
    # Not a 500. Nothing is broken; the deployment does not have the feature.
    item_id = _task(client)
    assert _start(client, item_id).status_code == 501


def test_deleting_removes_the_row_and_the_object(client, bucket) -> None:
    import boto3

    s3 = boto3.client("s3", region_name="ca-central-1")
    item_id = _task(client)
    started = _start(client, item_id).json()
    attachment_id = started["attachment"]["attachment_id"]
    key = q.get_attachment(item_id, attachment_id)["storage_key"]
    s3.put_object(Bucket=bucket, Key=key, Body=b"hello")
    client.post(f"/api/tasks/{item_id}/attachments/{attachment_id}/done")

    assert client.delete(f"/api/tasks/{item_id}/attachments/{attachment_id}").status_code == 204
    assert client.get(f"/api/tasks/{item_id}/attachments").json() == []
    with pytest.raises(Exception):
        s3.head_object(Bucket=bucket, Key=key)
