# Domain and integration

[Documentation index](README.md) · [Repository instructions](../AGENTS.md)

**Status:** This page records the target design from repository instructions and skills. Its behavior has not been verified as implemented in this snapshot.

The tables and rules on this page are **target domain behavior**, not proof of a running service or an approved API. Source: `cw-storage-domain` ([Claude](../.claude/skills/cw-storage-domain/SKILL.md), [Codex](../.codex/skills/cw-storage-domain/SKILL.md)). The linked mockup and guides remain the source for product details; confirm ambiguous values before implementation.

## What this service owns

File storage for attachments.

**Data**: File metadata (name, type, size, author, linked task or comment); the files themselves live in object storage.

**API**: Signed upload and download URLs, the 25 MB per-file limit, an organization's largest files.

**Events emitted**: `file.uploaded`, `file.deleted`.

**Events consumed**: `task.purged` (deletes its attachments).

**External systems**: OVH Object Storage in production, Garage locally.

**Mockup screens**: Attachments and their full-screen preview; Organisation › Quotas (largest files).

## Rules this service guards

- 25 MB per file; the type is derived from the extension.
- The service never streams file bytes through itself: clients use signed URLs.

## Upload policy

- Upload is a presigned POST valid 5 minutes, with imposed conditions: a size from 1 byte to 25 MB,
  the key `org/<organizationId>/<uuid>` and the content type.
- Finalizing an upload reads the first 4 KiB of the object and checks its real type with
  `file-type`.
- Download is a presigned URL served as an attachment; SVG and HTML are never displayed inline.
- File metadata has a `scan_status` column from the first migration.
- S3 client (`@aws-sdk/client-s3`): `requestChecksumCalculation: 'WHEN_REQUIRED'`; URLs are signed
  for the host the browser sees.

## Notes

Starts as a module of cadenway-task-service.

Everything above comes from the [repositories document](https://claude.ai/artifact/BPinmYxoF3mbK8w9BMB43N) and the
[integration guide](https://claude.ai/artifact/CpJHVCiFfF9j3KbHQ2S1Et). If the mockup disagrees with this guide, update the guide and its source skill for both assistants.

## Engineering standards

These skills fix the engineering standards this service follows. They are target conventions, not proof of an implementation in this snapshot.

| Skill                                                                                                                                                | What it fixes                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cw-database-conventions` ([Claude](../.claude/skills/cw-database-conventions/SKILL.md), [Codex](../.codex/skills/cw-database-conventions/SKILL.md)) | Plural snake_case tables, `id` from `uuidv7()`, `organization_id` first in tenant indexes, `version`, `timestamptz` dates, `text` with `CHECK` for enumerations, forced row-level security, a pool of 5 connections, timeouts per role. |
| `cw-logging-and-tracing` ([Claude](../.claude/skills/cw-logging-and-tracing/SKILL.md), [Codex](../.codex/skills/cw-logging-and-tracing/SKILL.md))    | JSON logs with fixed fields and masking, W3C `traceparent` over HTTP and NATS, the ESM start-up flags, metrics per route and lag alerts, health and shutdown semantics.                                                                 |

## Contract and delivery sequence

The `cadenway-api-contracts` repository owns HTTP and event specifications. Consumers use published `@cadenway/contracts` packages and `@cadenway/nest-messaging`; do not redefine payloads or connect to another service's database. Change contracts first, then the producing service, followed by gateways and listeners, and finally the webapp. Planned event names on this page must be checked against the actual published specification before use.

## References

[Interactive mockup](https://claude.ai/artifact/KYRM7AnsYLiBLBLKy8i4HE), [integration guide](https://claude.ai/artifact/CpJHVCiFfF9j3KbHQ2S1Et), and [repositories and packages](https://claude.ai/artifact/BPinmYxoF3mbK8w9BMB43N). Use [AGENTS.md](../AGENTS.md) as the local source for ownership and hard limits.
