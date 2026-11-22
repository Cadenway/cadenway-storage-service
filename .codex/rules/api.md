---
paths:
  - 'src/modules/**/api/**'
  - 'src/modules/**/presentation/**'
  - 'src/**/*.controller.ts'
---

# Presentation layer

- Use the [V2 module layout](../skills/cw-hexagonal-module-layout/SKILL.md) for HTTP files and webhooks. Apply these rules to existing `api/` paths until migration.
- Expose only routes and fields defined in installed `@cadenway/contracts`. Match paths, statuses
  and error codes.
- Controllers validate and map inputs and outputs around a use case call. Keep logic and repository
  access outside controllers.
- Errors use the common format of `@cadenway/nest-common` with a stable machine `code`.
- Every internal API route requires the internal token and the organization context (guards of
  nest-common). The separate opt-in browser listener exposes only the contracted upload transfer
  route, authorized by its single-use ticket.
