---
paths:
  - 'src/modules/**/api/**'
  - 'src/modules/**/presentation/**'
  - 'src/**/*.controller.ts'
---

# Presentation layer

- Under V2, put HTTP controllers, transport DTOs, mappers, validators and errors under
  `presentation/http/`, organized by resource. Webhooks use `presentation/http/webhooks/<provider>/`.
  Apply the same contract and validation rules to the existing `api/` layout until it migrates.

- A route exists only if it is in the installed `@cadenway/contracts`; its paths, fields, status
  codes and error codes match the spec exactly.
- Controllers validate, map to a use case input, call it, map the output. No logic, no repository.
- Errors use the common format of `@cadenway/nest-common` with a stable machine `code`.
- Every route requires the internal token and the organization context (guards of nest-common).
- Never return a field the contract does not declare.
