# Architecture and ownership

[Documentation index](README.md) · [Repository instructions](../AGENTS.md)

## Status

The checkout contains NestJS startup, health and configuration code. Business modules will follow the structure below as their capabilities are implemented.

## Purpose and target structure

cadenway-storage-service owns file storage for attachments. NestJS, its own PostgreSQL database (one database and one user in the shared PostgreSQL of the VPS), events over NATS JetStream through `@cadenway/nest-messaging`, internal REST for the API gateway. Local port 3015.

|            |                                                                                                                |
| ---------- | -------------------------------------------------------------------------------------------------------------- |
| Data       | File metadata (name, type, size, author, linked task or comment); the files themselves live in object storage. |
| API        | Signed upload and download URLs, the 25 MB per-file limit, an organization's largest files.                    |
| Emits      | `file.uploaded`, `file.deleted`                                                                                |
| Listens to | `task.purged` (deletes its attachments)                                                                        |
| External   | OVH Object Storage in production, Garage locally.                                                              |
| Phase      | Extracted later, when needed                                                                                   |

Starts as a module of cadenway-task-service.

## Architectural ownership

Follow the [Cadenway NestJS architecture reference](https://github.com/Cadenway/cadenway-service-kit/blob/main/docs/hexagonal-architecture.md) for module structure, dependency direction, naming and test placement.

- Business code lives in modules under `src/modules/<module>/`, each with `domain/`, `application/`, `infrastructure/`, `api/` and a `MODULE.md`.
- Cross-cutting plumbing (config, logging, tracing, errors, auth guards, messaging) comes from the cadenway-service-kit packages (`@cadenway/nest-common`, `@cadenway/nest-messaging`); development-only `@cadenway/nest-testing` is maintained in [cadenway-tooling](https://github.com/Cadenway/cadenway-tooling).
- The domain is pure; use cases own transactions; controllers and handlers translate.
- Rendering of anything user-facing belongs to the webapp; this service returns data and stable error codes.

## Boundaries

- No access to another service's database or internal code; cross-service needs use `@cadenway/contracts` routes or events.
- NATS only through `@cadenway/nest-messaging`; config, logs, errors, health and auth guards through `@cadenway/nest-common`.
- Routes and event payloads come from the installed `@cadenway/contracts`; never redefine them locally.
- The service is internal: no Traefik label, no public route; the API gateway is its only HTTP caller.
- No sibling sources imported, no `file:` or `link:` dependency on a sibling.

## Cross-repository changes

Each checkout owns its implementation and release. Use published `@cadenway/*` packages instead of sibling source imports or local dependency links. For contract changes, make the contract and generated package available first, then update the producing service, gateways and listeners, and finally the webapp. Each step should remain deployable independently.

## Architecture checks

`pnpm test:architecture` runs the service profile against this repository's TypeScript configuration. It requires a published release of [`@cadenway/nest-testing`](https://github.com/Cadenway/cadenway-tooling) that exports `/architecture`. Once that release is available and this repository's GitHub Actions has package read access, update the development dependency and frozen lockfile and run the script as part of `pnpm quality` and pull request CI.
