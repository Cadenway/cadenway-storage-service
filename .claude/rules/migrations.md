---
paths:
  - 'migrations/**'
  - 'src/**/migrations/**'
---

# Migrations

- During a V2 source migration that moves schemas, update and check the schema glob before
  generating any migration. A move alone must leave the database schema unchanged.

- Keep the running version working. Follow [expand/contract](../skills/cw-expand-contract-migrations/SKILL.md)
  for the release sequence.
- Never edit a merged migration; write a new one.
- Backfills run in batches, are resumable and do not lock large tables.
- Each migration has a down step when the ORM supports it, and the PR states the rollback plan.
