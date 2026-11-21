# Profile Media

## Purpose

Owns signed profile image transfers, immutable PNG derivatives and their object lifecycle. Identity
owns the current account avatar reference. Organization owns the current organization logo reference.
Gateway establishes current read authorization before forwarding the exact owner and asset.

## Public entry points

| Entry point | Consumers |
| ----------- | --------- |
| None        | None      |

## Owned tables

| Table                    | Purpose                                                        |
| ------------------------ | -------------------------------------------------------------- |
| `profile_media_owners`   | Current reference, image generation and account deletion fence |
| `profile_media_uploads`  | Exact declaration, preparation and terminal reservation state  |
| `profile_media_objects`  | Candidates and staging keys with durable cleanup leases        |
| `profile_media_receipts` | Encrypted signing receipts and signing leases                  |
| `profile_media_cursors`  | System-owned cleanup and inventory positions                   |

Forced row-level security applies to every table. Avatar records use the account-scoped system
transaction, and logo operations use the signed tenant transaction. The cursor is system-only.

## API

The HTTP surface follows `openapi/internal/storage-service.yaml` in the installed contracts.

| Route                                                            | Purpose                           |
| ---------------------------------------------------------------- | --------------------------------- |
| `POST /internal/v1/profile-media-uploads/{uploadId}/transfer`    | Sign the owner's reservation      |
| `POST /internal/v1/profile-media-uploads/{uploadId}/preparation` | Verify and prepare one derivative |
| `GET /internal/v1/avatars/{assetId}`                             | Return an authorized avatar PNG   |
| `GET /internal/v1/organization/logo-assets/{assetId}`            | Return an authorized logo PNG     |

The routes require a signed Gateway token with a verified user actor. An avatar belongs to its
account. A directory avatar read also requires the organization used in Gateway's live member
check. A logo belongs to the verified token organization. A transfer binds the owner, uploader,
reservation, declaration and original expiry. A mismatched owner and asset receives the same
`media.not-found` response as an unknown reference. Responses use `no-store`. Each successful
image read uses `private` and `nosniff` and sends the complete derivative.

## Events emitted

None. Preparation stores a candidate. Publication of an account or organization reference belongs
to its owner service.

## Events consumed

- `user.avatar-changed.v1` and `organization.logo-changed.v1` apply the authoritative active
  reference by image generation and retire each explicitly replaced asset, including on delivery
  of an older event.
- `user.avatar-upload-abandoned.v1` and `organization.logo-upload-abandoned.v1` permanently fence
  that owner's upload ID and schedule reclamation, including when the reservation arrives late.
- `user.deleted.v1` permanently fences the account and schedules cleanup of its avatar and
  reservations.

The five retained durables are `storage-service__apply-avatar-change`,
`storage-service__abandon-avatar-upload`, `storage-service__delete-avatar-owner`,
`storage-service__apply-organization-logo-change` and
`storage-service__abandon-organization-logo-upload`. Avatar mutations carry their owner actor.
Logo changes come from Organization as a user decision. Terminal abandonment and account deletion
require the exact producer system actor. Lower image generations can still retire their explicit
old asset, so the handler relies on event ID deduplication and the owner watermark.

## Invariants

- The signed multipart POST has one staging key, an exact media type, a 5 MiB source cap and an
  expiry set by the owner, at most five minutes after reservation. An authorized replay preserves
  the original signed response and expiry.
- Verify the declared type and size using one pinned source generation. Decode a static square
  image within byte, pixel, memory and time limits. Avatars accept PNG, JPEG or WebP with a minimum
  side of 256 pixels. Logos accept PNG or static self-contained SVG with external access disabled.
  Source dimensions are bounded at 4,096 pixels per side. Encode a metadata-free PNG at most 512
  pixels per side without upscaling.
- The derivative is immutable and uses the upload ID as its asset ID. An authorized reference can
  read a prepared derivative before the adoption event arrives. A retired derivative is
  unavailable. Original bytes, object keys and signed response fields stay private.

## Transactions

Serialize owner decisions under the owner lock before reservation state. Apply a fact's deduplication
record, lifecycle transition and cleanup work in the same transaction. Run object storage and image
processing outside that transaction. Recheck the reservation under the same lock before electing a
candidate and recheck authorized availability before returning buffered bytes. Concurrent attempts
preserve the first accepted preparation.

## Decisions

- Keep prepared derivatives pinned until an authoritative owner decision. Fence retired and
  abandoned candidates before erasure. Defer staging cleanup until the original signed expiry and
  reconcile late writes in bounded batches.
- Keep the original sealed signing response for at least 24 hours, including after retirement
  while the uploader remains authorized. The response keeps its original expiry and cannot restart
  preparation. A deleted owner cannot access any receipt. Once their objects and receipts have
  been reclaimed, keep only the opaque upload fences needed to recognize late writes.
- Process bounded owner batches in `storage.sweep-profile-media` and a separate leased inventory
  page in `storage.reconcile-profile-media`. Only configured stores run the schedules.
