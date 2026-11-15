# cadenway-storage-service

cadenway-storage-service owns file storage for attachments. NestJS, its own PostgreSQL database (one database with a migrator role and an application role in the shared PostgreSQL of the VPS), events over NATS JetStream through `@cadenway/nest-messaging`, internal REST for the API gateway. Local port 3015.

|            |                                                                                                                |
| ---------- | -------------------------------------------------------------------------------------------------------------- |
| Data       | File metadata (name, type, size, author, linked task or comment); the files themselves live in object storage. |
| API        | Signed upload and download URLs, the 25 MB per-file limit, an organization's largest files.                    |
| Emits      | `file.uploaded`, `file.deleted`                                                                                |
| Listens to | `task.purged (deletes its attachments)`                                                                        |
| External   | OVH Object Storage in production, Garage locally.                                                              |
| Phase      | After the first version                                                                                        |

Built in this repository from the start: it never lives as a module of another service.

## Getting started

Requirements: Node.js LTS and pnpm (versions in `package.json`), and Docker.

1. Clone this repository next to the other Cadenway repositories, flat, in one folder.
2. To run it with the rest of Cadenway, start the stack from `cadenway-ops`; it builds the sibling
   folders, this one included with the `full` profile, which also starts Garage (see its
   `docs/development.md`):

   ```bash
   cd ../cadenway-ops/compose
   cp .env.example .env                        # once
   docker compose run --rm internal-token-keys # once: the key pairs of the internal token
   docker compose --profile full up -d
   ```

3. To work on this repository alone, against its own PostgreSQL and NATS:

   ```bash
   pnpm install
   cp .env.example .env                        # once
   docker compose -f compose.dev.yaml up -d --wait
   pnpm migration:run                          # as storage_migrator; again after a pull that adds one
   pnpm start:dev                              # http://localhost:3015/health/ready
   ```

The configuration is validated at start-up; [development](../docs/development.md) lists the
variables and explains how to call the service locally with an internal token.

## Checks

Run the narrowest check first; CI runs them all on every pull request.

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test src/modules/<module>      # targeted
pnpm test:integration                    # PostgreSQL and NATS in Docker
pnpm test:coverage
pnpm build
docker compose -f compose.dev.yaml config -q
```

## Contributing

- [Contributing guide](CONTRIBUTING.md): branches, commits, pull requests, releases.
- [Code of conduct](CODE_OF_CONDUCT.md), [security policy](SECURITY.md), [getting help](SUPPORT.md).
- AI assistants follow [AGENTS.md](../AGENTS.md); Claude Code also reads [CLAUDE.md](../CLAUDE.md) and the
  tooling described in [.claude/README.md](../.claude/README.md).

## License

This repository is proprietary. See [LICENSE](../LICENSE) for the rights and restrictions that apply.

## References

- [Interactive mockup](https://claude.ai/artifact/KYRM7AnsYLiBLBLKy8i4HE): every screen, state and interaction.
- [Integration guide](https://claude.ai/artifact/CpJHVCiFfF9j3KbHQ2S1Et): tokens, data shapes, component names.
- [Repositories and packages](https://claude.ai/artifact/BPinmYxoF3mbK8w9BMB43N): what each repository owns, deployment.
