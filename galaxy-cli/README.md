# `novaos-cli`

**novaos-cli** — Agent Development Lifecycle tooling for NovaOS.

## Purpose

Command-line tool for agent developers to **build, test, publish, activate, and manage** agents on the NovaOS platform. The entry point is the `novaos-cli` command. It targets the **developer experience** layer: it does not run as a cluster service but orchestrates calls to control- and execution-plane HTTP APIs.

## Public API surface

CLI surface (commands under `src/`):

| Command group           | Examples                                                                                                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scaffolding & migration | `novaos-cli init`, `novaos-cli migrate`                                                                                                                                          |
| Shipping & lifecycle    | `novaos-cli publish`, `novaos-cli activate`, `novaos-cli release`, `novaos-cli shadow`                                                                                           |
| Execution & evaluation  | `novaos-cli run`, `novaos-cli eval`                                                                                                                                              |
| MCP tooling             | `novaos-cli mcp validate`, `novaos-cli mcp publish`, `novaos-cli mcp init`, `novaos-cli mcp invoke`, `novaos-cli mcp register`, `novaos-cli mcp logs`, `novaos-cli mcp pod-logs` |
| **Connector tooling**   | `novaos-cli connector list`, `novaos-cli connector init`, `novaos-cli connector publish`, `novaos-cli connector register`                                                        |
| Environment management  | `novaos-cli env add`, `novaos-cli env use`, `novaos-cli env list`, `novaos-cli env show`                                                                                         |

The **public contract** is the stable CLI interface and documented flags; internal modules are not considered a semver API for external plugins.

---

## Agent publish runtime validation

`novaos-cli publish` captures the Python SDK Agent Card after building and before
pushing. Set `agent_module` to the **AgentBuilder instance**, for example
`"agent_module": "agent:agent"` for `src/agent.py` containing `agent = AgentBuilder(...)`.
The ASGI server target `agent:app` is a different object and cannot emit this card.
The default remains `server:agent` for existing Python scaffolds.

Capture failure, malformed output, or skill drift blocks publishing for Python
agents with declared skills, and for any manifest with an explicit `agent_module`.
V2 manifests use top-level `skills[].name` as exact runtime IDs. When that array
is absent or empty, legacy `metadata.capabilities` supplies the declarations.
Manifests without a language are treated as Python for this check. Other languages
without an explicit Python target retain best-effort card discovery, as do legacy
manifests without declared skills. `--dry-run` skips build and runtime validation.

When target and host architectures match, capture runs inside the built image.
Cross-architecture capture uses `python3` from `PATH`; activate an environment with
the agent's dependencies installed. Imports use the manifest directory and its
`src/` subdirectory, plus `vendor/novaos-agent-client-sdk/src` or
`sdk/novaos-client-sdk/src` under the Docker build context. Existing `PYTHONPATH`
entries are preserved. Pip-installed SDKs remain supported. Missing SDK imports
continue to block Python publishing, including legacy manifests. A host capture validates source, not the built image.

For real SDK subprocess regression coverage, activate a Python environment with
the SDK dependencies and FastAPI, then run from this package:

```sh
NOVAOS_TEST_SDK_PATH=/absolute/path/to/novaos-client-sdk bun run test:runtime-card
```

This verifies nested and scaffold imports, rejects ASGI objects, and checks that
capture errors and drift prevent push/finalization. Docker and publishing HTTP
are test doubles; no image or agent is published.

## Environment configuration

The CLI ships with exactly one built-in environment, `local` — plain `localhost` URLs on conventional ports, so a fresh install works out of the box for local development without any config. Every other environment (pointing at a hosted NovaOS instance, self-hosted or otherwise) is supplied by you, not compiled in.

Add one:

```
novaos-cli env add staging --api-base https://api.staging.example.com --client-id <oauth-client-id>
```

`--api-base` derives the agent-ops/mcp-ops/review/gateway/iam/connector-host URLs as `<api-base>/<service>`; pass `--agent-ops-url`, `--mcp-ops-url`, `--review-url`, `--gateway-url`, `--iam-url`, or `--connector-host-url` individually to override any of those, or skip `--api-base` and pass all six explicitly. `--client-id` is always required. Run `novaos-cli env add --help` for the full flag list.

This writes the entry to `~/.novaos/environments.json` (or the path in `NOVAOS_ENV_CONFIG`, if set):

```json
{
  "environments": {
    "staging": {
      "apiBase": "https://api.staging.example.com",
      "clientId": "<oauth-client-id>"
    }
  }
}
```

Then `novaos-cli env use staging` to make it active, `novaos-cli env list` to see everything configured, or `novaos-cli --env staging env show --verbose` to confirm where each value resolved from.

Per-URL resolution priority (highest wins): a CLI flag (e.g. `--agent-ops-url`) → the matching `NOVAOS_*_URL` env var → the named environment's entry in the config file → the `local` default. Naming an environment that isn't `local` and isn't in the config file fails with an error naming exactly what to run to add it.

## Connector commands

> **Requires:** `CONNECTOR_HOST_ENABLED=true` on the connector-host service. Consult your platform operator's runbook for the enable order.

### `novaos-cli connector list`

Lists connectors registered in the Connector Registry.

```bash
novaos-cli connector list [--publisher <name>] [--json]
```

| Flag                 | Description                                   |
| -------------------- | --------------------------------------------- |
| `--publisher <name>` | Filter by publisher name                      |
| `--json`             | Emit output as JSON (`{ connectors: [...] }`) |

**Target:** `GET /api/v1/connectors` on connector-host, at the active environment's `connectorHostUrl` (see [Environment configuration](#environment-configuration) — override with `--connector-host-url` or `NOVAOS_CONNECTOR_HOST_URL`).

Returns 404 or 501 when the Connector Registry is not yet deployed; the command prints an informational notice and exits cleanly.

---

### `novaos-cli connector init`

Scaffolds a new connector package. Two modes:

#### Stub mode (no `--spec`)

Generates a minimal connector scaffold:

```bash
novaos-cli connector init --name stripe --publisher acme-corp [--dir ./packages/connector-stripe]
```

Output:

```
./stripe/
  connector.json
  src/index.ts
  package.json
  Dockerfile
```

#### OpenAPI codegen mode (`--spec`)

Generates typed TypeScript operation handlers from an OpenAPI 3.x spec:

```bash
novaos-cli connector init \
  --name stripe \
  --publisher acme-corp \
  --spec ./openapi/stripe.yaml \
  --dir ./packages/connector-stripe
```

Output:

```
./packages/connector-stripe/
  connector.json          # starter manifest — edit governance fields before deploying
  src/
    connector.ts          # entry point
    operations/
      list-charges.ts     # one file per operationId
  tsconfig.json
  package.json
```

The pipeline:

1. Reads the OpenAPI spec
2. Extracts server hostnames → `allowed_domains` in `connector.json`
3. Generates a typed handler stub for each operation with an `operationId`
4. Writes a starter `connector.json` with `data_tier: "information"` — **edit governance fields before deploying**

> The generated `connector.json` uses a merge-safe write strategy. If `connector.json` already exists, only new operation entries are added; manually edited fields are preserved.

**Flags:**

| Flag                      | Required | Description                                      |
| ------------------------- | -------- | ------------------------------------------------ |
| `--name <name>`           | ✓        | Connector slug (lowercase, hyphens)              |
| `--publisher <publisher>` | ✓        | Publisher identifier                             |
| `--spec <path>`           | —        | Path to OpenAPI 3.x spec. Triggers codegen mode. |
| `--dir <dir>`             | —        | Output directory. Defaults to `./<name>`         |

---

### `novaos-cli connector publish`

Publishes a connector manifest to the Connector Registry.

```bash
novaos-cli connector publish <manifest-path> [--dry-run] [--json]
```

| Argument / Flag   | Description                              |
| ----------------- | ---------------------------------------- |
| `<manifest-path>` | Path to `connector.json`                 |
| `--dry-run`       | Validate the manifest without persisting |
| `--json`          | Emit output as JSON                      |

**Target:** `POST /api/v1/connectors/publish` on connector-host, at the active environment's `connectorHostUrl` (see [Environment configuration](#environment-configuration) — override with `--connector-host-url` or `NOVAOS_CONNECTOR_HOST_URL`).

Returns a 404 or 501 with an informational message when the Connector Registry is not yet deployed.

---

### `novaos-cli connector register`

Registers a connector for a tenant: configures its credentials, then grants an entitlement.

> **Requires the `platform-admin` role** (not just `developer`) — it writes a tenant's live
> credentials and directly enables their access, the same risk tier as `shadow deploy`/`promote`/`rollback`.

```bash
novaos-cli connector register <name> --tenant-id <id> --max-tier <tier> \
  [--credential-file <path> | --credential-stdin | --credential KEY=VALUE ...] [--dry-run]
```

| Argument / Flag            | Required | Description                                                                                                                                                       |
| -------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<name>`                   | ✓        | Connector name                                                                                                                                                    |
| `--tenant-id <id>`         | ✓        | Tenant (org) ID to grant the entitlement to                                                                                                                       |
| `--max-tier <tier>`        | ✓        | Entitlement tier: `raw` \| `enriched` \| `inferred`                                                                                                               |
| `--credential KEY=VALUE`   | —        | Repeatable. Secret values passed this way **are visible in shell history and `ps`** — prefer the two options below.                                               |
| `--credential-file <path>` | —        | **Recommended.** Path to a file of `KEY=VALUE` lines (same format as `.env`). Never touches shell history or `ps`. Overrides same-named keys from `--credential`. |
| `--credential-stdin`       | —        | **Recommended.** Read `KEY=VALUE` lines from stdin. Overrides same-named keys from `--credential` and `--credential-file`.                                        |
| `--dry-run`                | —        | Print the API calls that would be made (credential key names only — never values) without executing them.                                                         |

Credential sources layer in the order above (`--credential` lowest, `--credential-stdin` highest), later ones winning on key collision. Values are never printed or logged, in `--dry-run` output or `--debug` wire traces — only key names ever appear.

**Target:** `POST /admin/v1/connectors/<name>/configure` then `PUT /admin/v1/connectors/<name>/entitlements/<tenant-id>` on connector-host.

---

### Environment variables for connector commands

| Env var                     | Default                                                                                      | Description                                                                                                                                                                                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NOVAOS_CONNECTOR_HOST_URL` | The active named environment's `connectorHostUrl` (`local` default: `http://localhost:3700`) | Overrides the connector-host URL `connector list`/`register`/`publish` target — same precedence as the other `NOVAOS_*_URL` vars (see [Environment configuration](#environment-configuration)). Equivalent to `--connector-host-url`.                             |
| `CONNECTOR_HOST_URL`        | `http://connector-host.novaos-data-plane.svc.cluster.local:3000`                             | Only used inside a **scaffolded connector's own generated source** (`connector init`/`connector init --spec` output) as its runtime default for reaching connector-host from within the cluster — unrelated to the CLI's own `connector` command targeting above. |

---

## Failure modes & runbook links

| Symptom                                 | Likely cause                                                                        | Mitigation                                                                            |
| --------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Publish / activate fails mid-run        | **Auth token expired** during long operations                                       | Re-authenticate (login) and retry; keep sessions within token TTL for batch publishes |
| Command exits with validation error     | **Manifest or config schema** mismatch                                              | Error output includes file and line where possible—fix the manifest and re-run        |
| Connection refused / 5xx                | Target service (agent-ops, gateway, mcp-ops, connector-host) down or wrong base URL | Verify URLs and ports; use service READMEs and platform status                        |
| `connector list/publish` returns notice | Connector Registry not deployed (404/501)                                           | Feature is rolling out; check the operator runbook for deployment status              |

For service-side incidents, use the on-call runbooks for **agent-ops**, **gateway**, **mcp-ops**, and **connector-host** rather than changing CLI code.

## Upstream dependencies

- **agent-ops** — HTTP API for publish, activate, releases, shadow, logs
- **mcp-ops** — HTTP API for MCP tool operations
- **gateway** — execution-plane entry (e.g. runs routed through the gateway stack)
- **connector-host** — target for `novaos-cli connector list/register/publish` (`connectorHostUrl` / `--connector-host-url` / `NOVAOS_CONNECTOR_HOST_URL`)
- **Authentication** — tokens or credentials as configured for your environment (same identity plane as the marketplace)

## Downstream consumers

None. This package is a **standalone developer tool**; it is not imported as a library by other production services.

## Health / observability

There is no `/health` endpoint. Observability is **client-side**: structured stderr output, exit codes, and (where integrated) local telemetry. Use `novaos-cli` with verbose or debug flags per command help for troubleshooting.

## Local dev

Run directly with Bun, no build step needed:

```bash
bun src/cli.ts --help
```

Point the documented env vars (see [Environment configuration](#environment-configuration)) at your local or dev stack endpoints for agent-ops, gateway, and mcp-ops.

## Installation

`novaos-cli` is distributed as a standalone executable (no Bun or Node.js needed at run time), through GitHub Releases, Homebrew and npm, for macOS (arm64, x64) and Linux with glibc (x64, arm64). Windows is not supported yet.

### Standalone binaries

Each release attaches prebuilt binaries for macOS (arm64, x64) and Linux (x64, arm64), named `novaos-cli-<os>-<arch>`, together with a `checksums.txt` file. Download the binary for your platform and `checksums.txt`, verify it, and make it executable:

```bash
shasum -a 256 -c checksums.txt --ignore-missing   # sha256sum -c on Linux
chmod +x novaos-cli-<os>-<arch>
./novaos-cli-<os>-<arch> --help
```

Template content for `novaos-cli init` is compiled into the binary, so `init` works without any other files on disk.

### Homebrew (macOS and Linux)

```bash
brew install orbitronai-repo/novaos/novaos-cli
novaos-cli --help
```

### npm distribution

```bash
npm install -g novaos-cli
novaos-cli --help
```

The `novaos-cli` npm package is a thin wrapper with no CLI code of its own: its `postinstall` downloads the platform binary from the GitHub Release matching the package version (`v<version>`), verifies it against the release's `checksums.txt`, and execs it via a small launcher. The npm version always equals the release tag. See [`npm-wrapper/README.md`](npm-wrapper/README.md) for the supported platforms and environment variables.

## License

MIT — see [`LICENSE`](LICENSE).
