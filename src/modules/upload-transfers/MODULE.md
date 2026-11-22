# Upload transfers

## Purpose

Receives the local one-shot form capabilities issued by Attachments, Intake and Profile Media
when `STORAGE_UPLOAD_TRANSFER_URL` is configured. Their modules still own declarations,
authorization, finalization and cleanup.

## Public entry points

`POST /internal/v1/upload-transfers` receives a multipart form containing one opaque `ticket`
and one `file`. The authenticated ticket replaces the internal token for this route. A loopback
development proxy can expose this path alone. The deployed configuration leaves it disabled.

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

## Events

None. Object verification and completion still belong to the issuing module.
