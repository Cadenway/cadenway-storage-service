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
| `intake_attachments`                | Anonymous reservations and immutable Task decisions              |
| `intake_attachment_candidates`      | Opaque staging and immutable candidates awaiting decisions       |
| `intake_attachment_upload_claims`   | Active signing lease and encrypted response for intake replay    |
| `storage_byte_entitlements`         | Latest Billing version and effective byte ceiling per tenant     |

The attachment tables use forced organization isolation. The reconciliation cursor uses a forced
system-only policy.

## API

The signed Search system identity can page `GET /internal/v1/attachment-search-projections`
and resolve an ordered batch with `POST /internal/v1/attachment-search-projections/resolve`.
Both use the signed organization and return private, uncacheable metadata. An authenticated
cursor fixes the upper UUID bound for the export. The projection includes ready attachments
whose task Storage has not fenced for permanent purge. Task owns the current visibility
decision. Resolution returns the retained terminal version of a deleted attachment.

The signed Billing system identity can page `GET /internal/v1/billing-attachment-usage`.
It uses the signed organization and a separate cursor scope. Each returned row carries the
verified ready bytes or a retained terminal version. A task purge changes measured usage when
Storage commits the attachment deletion. The endpoint and its refusals are private and uncacheable.

With byte admission enabled, authenticated finalization and Intake verification add the actual
verified bytes under the same tenant transaction lock. The quota counts ready files and verified
Intake reservations. A tenant starts at the Free baseline of 2,000,000,000 bytes and uses its
latest accepted Billing projection when present. A claim transfers its reservation to a ready
file atomically. A verified reservation lasts until the authoritative claim or release. Rejected
completion returns the opaque `409 attachment.storage-quota-exceeded` problem.

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

| Intake route                                                                                  | Purpose                           |
| --------------------------------------------------------------------------------------------- | --------------------------------- |
| `POST /internal/v1/intake-publications/{publicationId}/attachments`                           | Sign a Task-allocated upload      |
| `POST /internal/v1/intake-publications/{publicationId}/attachments/{attachmentId}/completion` | Verify and pin the immutable copy |

Both intake operations require a signed API gateway system token with the organization returned by
Task. The gateway authorizes the exact publication, draft and attachment with Task before calling.
Storage returns only the published response fields with `Cache-Control: no-store`.

## Events emitted

- `file.uploaded.v1` when a verified object becomes a ready attachment.
- `file.deleted.v1` when a ready attachment is removed manually or by a task purge.
- `intake.attachment-verified.v1` when the tenant transaction pins a verified intake copy.

Facts carry the organization, actor, file ID, stable task key, verified byte count and attachment
version. Finalizing a ready upload again or expiring an unfinished reservation adds no fact.
The outbox assigns the event ID and occurrence time in the tenant transaction. Consumers can
reconcile file state by organization, file ID and version using the published Storage facts.
The intake verification actor is the Storage system. It carries only the organization,
publication and reserved attachment identifiers. Verification alone neither attaches the object to
a task nor adds bytes to the ready file count.

## Events consumed

- `task.purged.v1` records the permanent revocation of the task key and schedules bounded cleanup
  of pending and ready attachments in that organization. Duplicate delivery has a single effect.
- `intake.attachment-claimed.v1` and `intake.attachment-released.v1` record the authoritative Task
  decisions, including decisions that arrive before the reservation is seen locally.

The broker's Task publisher permission authorizes the subject. The envelope actor identifies the
cause of the purge and is carried forward to the resulting deletion facts. The durable
`storage-service__record-task-purge` consumer replays retained events and commits the processed ID,
the version for the individual task key and the cleanup request in one tenant transaction. Database
failures retry after 1 s, 5 s, 30 s and 2 min. Invalid deliveries and a fifth failure reach
`EVENTS_DLQ`. Operators inspect the affected delivery and replay the original Task fact after
correcting the cause.

The separate `storage-service__claim-intake-attachment` and
`storage-service__release-intake-attachment` durables replay retained decisions from the Task system
actor in the delivery deduplication transaction. A claim binds an elected copy only if the task
purge fence permits it. A ready anonymous attachment has a null account author and the Storage
system actor on its `file.uploaded.v1` fact. A release suppresses a later start or verification.

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
- Intake staging keys use `intake/<uuid>` without a tenant or publication identifier. The received
  organization scopes all database access and the eventual ready file uses a verified tenant key.
  Storage persists the exact signed deadline with the receipt and checks it before copying and
  before electing a new pin. A pinned copy remains until Task makes its terminal decision even
  after the draft expires.

## Transactions

Search exports read the upper bound and page in an organization-scoped `REPEATABLE READ READ
ONLY` snapshot. Search resolution reads the attachment rows and their task purge fences in one
organization-scoped query.

The Billing usage reader uses a tenant snapshot and a fixed upper attachment ID. It reads the
verified size of a ready attachment and the terminal version of a previously ready attachment.
A task purge leaves the attachment in measured usage until Storage commits its deletion.

Byte admission and the internal `ApplyStorageEntitlement` command share the tenant storage quota
lock under `READ COMMITTED`. Admissions read usage and the effective limit in a single statement
after the lock. Billing entitlement versions only advance with an equal or higher limit. A replay
of the current version and limit succeeds without a write. An older version, conflicting replay
or lower limit leaves the current projection in effect.

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
The same schedules drain expired encrypted receipts from both paths and reconcile the separate
`org/` and opaque `intake/` inventories under independent cursor leases. The object storage policy
needs to allow listing both prefixes when intake uploads are enabled.

## Decisions

- Use the stable task key for attachment ownership through task moves. Storage does not import
  task-service data or resolve task permissions.
- Sign transfers for the browser-facing object storage endpoint. Keep staged and finalized
  objects separate. An upload capability may be used again until its expiry, so schedule staged
  object cleanup after that expiry even if finalization has succeeded.
- Validate the object storage settings together at startup. In a local mode with all storage
  settings absent, starts, downloads and verification report object storage unavailable.
- The entitlement table is additive. Older application versions continue to enforce their
  Free ceiling while the projection remains available for the next deployment.
