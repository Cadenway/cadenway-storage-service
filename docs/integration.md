# Domain and integration

[Documentation index](README.md) · [Repository instructions](../AGENTS.md)

**Status:** This page records the target design from repository instructions and skills. Its behavior has not been verified as implemented in this snapshot.

The tables and rules on this page are **target domain behavior**, not proof of a running service or an approved API. Source: `wp-storage-domain` ([Claude](../.claude/skills/wp-storage-domain/SKILL.md), [Codex](../.codex/skills/wp-storage-domain/SKILL.md)). The linked mockup and guides remain the source for product details; confirm ambiguous values before implementation.

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
[integration guide](https://claude.ai/artifact/CpJHVCiFfF9j3KbHQ2S1Et). If the mockup disagrees with this guide, update the guide and its source skill for both assistants.

## Contract and delivery sequence

The `waypoint-api-contracts` repository owns HTTP and event specifications. Consumers use published `@waypoint/contracts` packages and `@waypoint/nest-messaging`; do not redefine payloads or connect to another service's database. Change contracts first, then the producing service, followed by gateways and listeners, and finally the webapp. Planned event names on this page must be checked against the actual published specification before use.

## References

[Interactive mockup](https://claude.ai/artifact/KYRM7AnsYLiBLBLKy8i4HE), [integration guide](https://claude.ai/artifact/CpJHVCiFfF9j3KbHQ2S1Et), and [repositories and packages](https://claude.ai/artifact/BPinmYxoF3mbK8w9BMB43N). Use [AGENTS.md](../AGENTS.md) as the local source for ownership and hard limits.
