---
name: cw-hexagonal-module-layout
description: "Place files and review boundaries in a Cadenway NestJS module."
---

# V2 module layout

The [Cadenway architecture reference](https://github.com/Cadenway/cadenway-service-kit/blob/main/docs/hexagonal-architecture.md) defines the V2 target.
Follow the local layout while the repository uses its existing architecture check. Enable the
strict convention once the checker is published and coordinate source migration separately.

```text
src/modules/<module>/
  MODULE.md
  <module>.module.ts
  public/<area>/<operation>.ts
  domain/{aggregates,value-objects,policies,events,errors}/<area>/
  application/use-cases/{commands,queries}/<area>/<operation>/
  application/{models,projections,mappers,services}/<area>/
  application/ports/outbound/<concern>/<area>/
  presentation/http/{controllers,dto/input,dto/output,mappers,validation,errors,guards}/<resource>/
  presentation/http/webhooks/<provider>/
  presentation/messaging/handlers/<event-family>/
  presentation/jobs/handlers/<job-family>/
  presentation/websocket/gateways/<channel>/
  presentation/cli/commands/<area>/
  infrastructure/persistence/drizzle/{schemas,mappers,repositories,transactions}/<area>/
  infrastructure/messaging/{outbox,rebuild}/<area>/
  infrastructure/jobs/pg-boss/<area>/
  infrastructure/adapters/<integration>/
  composition/tokens/<area>/
  composition/providers/{use-cases,adapters}/<area>/
```

Create folders as needed. Use `<operation>.use-case.ts`, `.input.ts` and `.output.ts` for the
implementation and its named contracts. Keep one named exported type or interface per file. Keep
private helper types with their implementation, and colocate tests with their subjects.
Domain and application stay in plain TypeScript. Presentation calls application operations.
Infrastructure implements application ports. The root Nest module registers controllers and
providers. Composition holds the bindings.

Expose a use case with named re-exports in `public/<area>/<operation>.ts`, record the entry and
consumers in `MODULE.md` and export the same provider in Nest. Its `execute` input and output can
only reference public types, even through nested members. Instantiate use case classes in
composition. Consumers bind their own outgoing ports to the exported operation.
