# Attachments

## Purpose

Owns task attachment metadata, signed transfers and the lifecycle of staged and verified objects.
The API gateway establishes current task access through task-service. Garage stores bytes locally
and OVH Object Storage stores bytes in production.

## Public entry points

| Entry point | Consumers |
| ----------- | --------- |
| None        | None      |

## Owned tables

| Table                               | Purpose                                                          |
| ----------------------------------- | ---------------------------------------------------------------- |
| `attachments`                       | Reservation and verified metadata, including `scan_status`       |
| `attachment_candidates`             | Staging, candidate election, and durable object cleanup          |
| `attachment_reconciliation_cursors` | System-owned cursor and lease for physical object reconciliation |
| `attachment_task_tombstones`        | Task key locks, permanent purge records, and pending cleanup     |
| `attachment_upload_claims`          | Active signing lease and encrypted response for 24-hour replay   |

The attachment tables use forced organization isolation. The reconciliation cursor uses a forced
system-only policy.

## API

The P4 routes are defined in `openapi/internal/storage-service.yaml`.

| Route                                                                     | Purpose                              |
| ------------------------------------------------------------------------- | ------------------------------------ |
| `GET /internal/v1/tasks/{taskKey}/attachments`                            | Page through ready attachments       |
| `POST /internal/v1/tasks/{taskKey}/attachments`                           | Reserve a signed upload              |
| `GET /internal/v1/tasks/{taskKey}/attachments/{attachmentId}`             | Read ready metadata                  |
| `POST /internal/v1/tasks/{taskKey}/attachments/{attachmentId}/completion` | Verify and finalize the upload       |
| `GET /internal/v1/tasks/{taskKey}/attachments/{attachmentId}/download`    | Sign a ready attachment download     |
| `DELETE /internal/v1/tasks/{taskKey}/attachments/{attachmentId}`          | Remove metadata and schedule cleanup |
| `GET /internal/v1/attachments/largest`                                    | Page through the largest ready files |

Every call requires a signed API gateway token for a user in the verified organization. The
gateway uses the single-snapshot Task attachment access check before calling. Reads can include a readable
archived task. Mutations require edit access and an active task and list. Completion is bound
to the account that reserved the upload. The largest-files route is an internal quota input for
an authorized organization owner or administrator.

## Events emitted

- `file.uploaded.v1` when a verified object becomes a ready attachment.
- `file.deleted.v1` when a ready attachment is removed manually or by a task purge.

Facts carry the organization, actor, file ID, stable task key, verified byte count and attachment
version. Finalizing a ready upload again or expiring an unfinished reservation adds no fact.
The outbox assigns the event ID and occurrence time in the tenant transaction. Consumers can
reconcile file state by organization, file ID and version using the published Storage facts.

## Events consumed

- `task.purged.v1` records the permanent revocation of the task key and schedules bounded cleanup
  of pending and ready attachments in that organization. Duplicate delivery has a single effect.

The broker's Task publisher permission authorizes the subject. The envelope actor identifies the
cause of the purge and is carried forward to the resulting deletion facts. The durable
`storage-service__record-task-purge` consumer replays retained events and commits the processed ID,
the version for the individual task key and the cleanup request in one tenant transaction. Database
failures retry after 1 s, 5 s, 30 s and 2 min. Invalid deliveries and a fifth failure reach
`EVENTS_DLQ`. Operators inspect the affected delivery and replay the original Task fact after
correcting the cause.

## Invariants

- An upload authorizes a five-minute multipart POST to one staging key in the organization prefix
  `org/<organizationId>/`, with a fixed media type and a file length from 1 byte to 25 MiB.
  The declared type must match the registered type of the final filename extension.
- Finalization verifies the stored length and media type against the reservation. It checks up
  to the first 4 KiB using `file-type` and resolves the type from the detected format. For
  `text/plain` with no binary signature, it checks for UTF-8 without NUL. The verification applies
  to the same bytes that are made ready.
- Lists, metadata and downloads expose only ready attachments within the authorized task or
  organization scope. Deletion and task purge stop new signed downloads.
- Signed downloads use `Content-Disposition: attachment`. HTML and SVG are never served inline.
  Keep signed URLs, upload fields and storage object keys out of logs, traces and published facts.

## Transactions

Each lifecycle write owns its organization transaction. Finalization, deletion or purge cleanup
commits the metadata change, the outbox fact when applicable and any pending cleanup work together.
Calls to object storage run outside database transactions. Finalization rechecks the reservation
under the same database lock as task revocation before committing, and concurrent completions
must preserve the first accepted object and fact. Erasing a missing object is a successful
cleanup retry.

The reservation commits a short signing lease and validates its ownership before persisting the
signed expiry and encrypted response. The scheduled pg-boss sweep scans due work in bounded pages
and enters the tenant scope before changing attachment state or appending facts. It fences an
object before erasing it and acknowledges the selected generation after confirmation. A separate
leased scan advances through physical keys in the object store and requeues known late writes.
The storage principal needs `s3:ListBucket` for the configured attachment bucket.

## Decisions

- Use the stable task key for attachment ownership through task moves. Storage does not import
  task-service data or resolve task permissions.
- Sign transfers for the browser-facing object storage endpoint. Keep staged and finalized
  objects separate. An upload capability may be used again until its expiry, so schedule staged
  object cleanup after that expiry even if finalization has succeeded.
- Validate the object storage settings together at startup. In a local mode with all storage
  settings absent, starts, downloads and verification report object storage unavailable.
