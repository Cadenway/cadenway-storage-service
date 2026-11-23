# Upload transfers

## Purpose

Receives the one-shot form capabilities issued by Attachments, Intake and Profile Media
in `STORAGE_UPLOAD_TRANSFER_MODE=local-one-shot`. This mode requires the browser loopback URL
in `STORAGE_UPLOAD_TRANSFER_URL`. The default hosted `presigned-post` mode rejects that URL
and issues provider-signed forms with a bounded staging lifetime. A provider-signed form can be
submitted again before it expires. Finalization promotes an observed staging version to a
separate key and grants read access to the finalized object. The issuing modules still own
declarations, authorization, finalization and cleanup.

## Public entry points

`POST /internal/v1/upload-transfers` receives a multipart form containing one opaque `ticket`
and one `file`. The browser reaches it through a local development proxy on a dedicated
listener at port 3016. The ticket authorizes the transfer. The internal API listener never mounts
this route. Hosted configurations leave the browser listener disabled.

## Persistence

`upload_transfer_uses` stores the digest of a staging key and its retention deadline. Row-level
security is forced and permits only system transactions. Each admission also prunes a bounded
page of expired records.

## Invariants

- Verify the ticket before admitting its staging key. Accept only the exact declared length
  and media type. The multipart adapter uses bounded private temporary files.
- Commit admission before the single S3 request. A failed or uncertain request consumes the
  ticket. The client can complete an object that arrived or start a fresh reservation.
- Dispatch stops at the ticket deadline. Staging cleanup waits another 15 seconds for an
  interrupted request to settle.
- Local development uses one Storage replica. A process restart invalidates outstanding
  tickets, including receipts restored from an earlier database dump. A replayed reservation
  can return its previous ticket, so start a new reservation after a restart. Profile owners
  allocate UUIDv7 values on the same host clock and must also allocate a fresh ID after a restart.
- The parent service drains the browser listener before shutting down the shared database pool and
  the transfer's S3 client.

## Events

None. Object verification and completion still belong to the issuing module.
