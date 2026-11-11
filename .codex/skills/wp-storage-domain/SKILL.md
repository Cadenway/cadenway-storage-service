---
name: wp-storage-domain
description: "The data, rules, events and screens waypoint-storage-service owns, taken from the mockup, the integration guide and the repositories document. Load it before naming, modeling or testing anything in this service."
---

# storage-service domain

## What this service owns

File storage for attachments.

**Data**: File metadata (name, type, size, author, linked task or comment); the files themselves live in object storage.

**API**: Signed upload and download URLs, the 25 MB per-file limit, an organization's largest files.

**Events emitted**: `file.uploaded`, `file.deleted`.

**Events consumed**: `task.purged` (deletes its attachments).

**External systems**: OVH Object Storage in production, MinIO locally.

**Mockup screens**: Attachments and their full-screen preview; Organisation › Quotas (largest files).

## Rules this service guards

- 25 MB per file; the type is derived from the extension.
- The service never streams file bytes through itself: clients use signed URLs.

## Notes

Starts as a module of waypoint-task-service.

Everything above comes from the [repositories document](https://claude.ai/artifact/BPinmYxoF3mbK8w9BMB43N) and the
[integration guide](https://claude.ai/artifact/CpJHVCiFfF9j3KbHQ2S1Et). When the mockup and this skill disagree, the mockup wins and
this skill is corrected in the same change.
