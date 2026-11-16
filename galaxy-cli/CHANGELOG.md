# Changelog

All notable changes to `novaos-cli` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.2.0] - 2026-11-16

### Added

- `agent list` shows the agents of your publisher profile with the agent ID that `agent logs`, `agent pod-logs` and `release list --agent` need. Filter with `--name`, cap with `--limit`, or use `--json`. It needs the Marketplace URL for the environment (`marketplaceUrl` in the environments config, or `NOVAOS_MARKETPLACE_URL`).
- `publish` prints the agent ID, and includes it as `agent_uuid` with `--json`.
- Manifests take an optional `resumable` boolean. Set it to `true` when the agent saves and resumes through the SDK save-and-resume interface. `publish` and `validate` warn when `permissions.tools` grants a write tool (`memory`, `files`, `notify`, `http`, `browser`, `code`, `agents` or `connectors`) and `resumable` is not `true`. The warning does not block the publish.
- Manifests take an optional `in_run_check` block that declares the check an agent runs on its own output: `judge_model`, `rubrics` (each a built-in `{"builtin": "name"}` or a published rubric pinned to a version `{"ref": "publisher/name@3"}`), and optional `threshold`, `max_refinements`, `budget_ms`, `deterministic` and `regulated_outputs`. Misspelt settings are errors. A `file` rubric is refused with "custom rubric files are not available yet; use a built-in or a published rubric reference". `publish` and `validate` check the shape only; the platform resolves built-ins and checks the rubric versions and the judge model.
- MCP manifests take an optional `capability` on each tool: `read`, `write` or `read_write`. `mcp validate` and `mcp publish` reject any other value, and `mcp init` declares its `hello_world` tool as `read`.
- `connector init --spec` takes `--include-path <prefix>` and `--risk <level>`, both repeatable, to split one large API into narrow connectors, for example a read-only one. An unknown risk level is an error.
- `connector init --spec` prints the operations it skipped (such as multipart bodies) and review warnings on stderr: a tenant-specific server URL, a missing license, OAuth with no scopes, ignored security schemes, more than 150 operations, and a manifest near the publish size limit.
- Manifests take an optional `progress_bridge` block for an agent that starts a job with one skill and polls it with another: `start_skill`, `check_skill`, an optional `cancel_skill`, `poll_interval_seconds` (whole seconds, 5 to 3600), `status_mapping` (non-empty `running`, `completed` and `failed` lists, each status in one list only) and `date_to_move` (`YYYY-MM-DD`, not before today). The three skills must differ and be listed in `skills`. `validate` and `publish` check the block and report each fault at its field, without echoing what you wrote. The platform runs the same check when it publishes the manifest and has the final say.
- `publish` prints the next step on stderr (`novaos-cli publish-status <review-id> --wait`). `publish-status` explains each review state in one sentence and takes `--wait [--timeout <seconds>]` to poll until the version is ACTIVE, REJECTED or ROLLED_BACK (default 900 seconds). `--json` output is unchanged.
- `init --lang python` writes `AGENTS.md`, which coding assistants such as Claude Code and Codex read on their own, and a `CLAUDE.md` that imports it. `AGENTS.md` lists the lifecycle commands in order, which command checks what, which ID is which, the interim calls to install and run a published agent, and the steps where a person must act (sign-in, admin approval, a web-UI install) and how an assistant should stop and ask there.

### Changed

- `connector init --spec` now generates a connector that builds and runs on the connector host. Before, the generated package imported a package that does not exist and used a handler signature and base URL the host does not provide. It now emits `(input, ctx)` handlers with the base URL embedded, built into a single file with no runtime dependencies. Regenerate into a clean directory: running it over a package from an earlier version mixes old and new files.
- `connector init --spec` maps the spec's authentication to the platform's credential classes. Authorization-code OAuth becomes an `oauth` block with the narrowest scope per operation. Bearer, API key and HTTP Basic become a `credentials_schema`. Parameters that carry credentials (such as `token` or `api_key`) are no longer tool inputs.
- `connector init --spec` sets a `risk` (`read`, `write` or `destructive`) on every operation, so destructive operations need an approval before they run. A POST that only reads, such as a search call, is classed `write`.
- `agent logs` and `agent pod-logs` say where to find the agent ID, and `agent pod-logs --help` states that only platform admins and members of the agent's publisher can read pod logs.
- When `agent logs` or `agent pod-logs` gets a 404, the error explains that these commands take the agent ID, not an installed instance ID such as the one in a chat page URL.
- `publish --json` prints manifest warnings on stderr. Before, `--json` hid them. stdout still holds only the JSON.
- `mcp invoke` says it calls the local sandbox gateway. Before, `--help` described `--mcp-gateway-url` as "sandbox or deployed", but a deployed gateway is reachable only from inside the cluster and accepts only platform-issued execution tokens, which the command does not send. The warning for a non-local gateway URL now says this instead of pointing at a `--token` option that does not exist.
- A manifest with `"resumable": true` now has an effect on the platform: when the agent's pod dies mid-run, the run continues on a new pod from its saved state (up to two new pods) instead of failing with `AGENT_EXECUTION_FAILED`. Agents without it fail as before.
- `agent logs`, `agent pod-logs` and `mcp pod-logs` show the reason the server gives when a request fails, taken from the `detail` of the error body (or the API's `errors[0].detail`), with the HTTP status after it. Before, `agent logs` read only `message` from the body of a failed request and ignored the body when the log stream could not connect.
- The CLI waits out a `Retry-After` header on a response it would retry, up to 10 seconds. A longer `Retry-After` ends the retries at once and shows that response, so a rate-limited command fails fast instead of spending more requests.
- `init --lang python` installs `novaos-agent-sdk` from PyPI as `novaos-agent-sdk>=2.1,<3` in `requirements.txt`. Before, it pinned the pre-release `2.0.0rc1` from TestPyPI in a separate `requirements-sdk.txt`, installed with `--no-deps`. The scaffold no longer has `requirements-sdk.txt`, and its `Dockerfile` and `README.md` install from `requirements.txt` only. Agents scaffolded earlier keep their own files.
- `init --lang python` now prints next steps that work from a fresh clone: install the requirements (`pip install -r requirements.txt -r requirements-dev.txt`, which includes the SDK), then `novaos-cli test`, `novaos-cli run --input "..."`, `novaos-cli manifest validate manifest.json` and `novaos-cli publish manifest.json --dry-run`. Before, the SDK was in a separate file that the steps skipped, so `python server.py` could not import it, and they stopped before test, run and publish.
- `init` without `--publisher` on the local env (the built-in default, so also a bare `init` when no env is set) and with no stored login no longer calls `whoami` or the Marketplace publisher lookup, so a local start needs no credentials or network. Before, it failed with "Not authenticated". The manifest gets the placeholder publisher `local-publisher`, a note on stderr says publishing needs a real one (`--publisher <slug>` or the `publisher` field), and the next steps add `novaos-cli auth login` and setting the publisher before `publish`. A logged-in user, and every other environment, still gets the publisher from the login or the Marketplace as before.
- `publish` rejects a manifest whose publisher is the `local-publisher` placeholder before logging in, building or calling any server, and says how to set a real one. `manifest validate` warns about it.
- `publish-status` exits 1 when the review is REJECTED or ROLLED_BACK, with or without `--wait`. Before, it exited 0 for any status it could read. `--verify` still exits 1 when the Agent Card does not resolve, including a 404.

### Fixed

- `mcp init --language python` now generates a server that serves the health path its manifest declares. Before, the manifest and the Dockerfile `HEALTHCHECK` pointed at `/health`, but the generated server had no such route and answered 404, although its tool worked. The generated server now returns 200 on `/health`. Servers generated earlier need the `custom_route` added by hand.
- `publish` no longer warns that every Python agent installs from TestPyPI. It warns only when the agent's own `requirements*.txt` files point pip at TestPyPI, and names those files.
- `auth login` now says what to do when the IAM URL was derived from `--api-base` and sign-in fails. Before, `env add --api-base <url>` quietly used `<url>/iam` as the IAM URL, which does not exist on every deployment, and `auth login` then timed out with no hint. A timeout, connection error or 404 against such a URL now ends with a note that the URL was derived and the `env add ... --iam-url <issuer-url>` command that fixes it, prefilled with the environment's client ID and other saved values. A URL you gave with `--iam-url` or `NOVAOS_IAM_URL` gets no such hint.
- `publish` and `mcp publish` now check for `docker buildx` up front. Before, a Docker without buildx failed later with a bare build error. The error now names `docker buildx` and says how to install it (Docker Desktop includes it; on Linux, install the docker-buildx plugin), plus Docker's own error output when it gave one.
- When `DOCKER_CONFIG` is set and buildx is not found, the buildx error now also says why: Docker looks for plugins in that folder, not `~/.docker`. It gives the fix: unset `DOCKER_CONFIG`, or link the installed plugin into its `cli-plugins` folder.
- `publish` on a machine whose CPU differs from the image's (every Apple Silicon Mac publishing `linux/amd64`) now runs the Agent Card step with the project's `.venv` or `venv` Python when no venv is active. Before, it used `python3` on `PATH`, which in a new shell is the system Python without the SDK, and the error then said to install an SDK that was already installed. An active venv still wins. If the SDK is still missing, the error names the Python it used and, when no venv was found, says to activate the one where the SDK is installed.

## [2.1.0] - 2026-10-15

### Added

- The local sandbox's memory stub supports `novaos.memory.update` (agent-scope memories, with a version check).
- `debug trace` prints the failure reason of a failed or rejected run, and includes it as `run.error` with `--json`.

### Fixed

- `run` takes the agent's language from the nearest `manifest.json`, so a Python agent is no longer started as TypeScript. Run from the repository root without `--cwd`, it now fails with a hint instead of guessing.
- `publish` checks that Docker is running before requesting publish authorization. `publish --dry-run` still does not need Docker.
- `debug trace`, `debug watch` and `debug compare` call the gateway routes that exist, read its `{ data }` responses correctly, and send `left`/`right` to `compare`.
- `debug` commands exit 1 with a clear message when the gateway does not serve a route (for example `watch` and `compare` while the debugger is disabled). An unknown run ID is a normal error, not "not yet available".
- `agent logs --json` includes the agent's structured fields plus `agent_id` and `instance_id`, and an agent whose pod is not running reports an explicit "Pod not running" error.
- `agent logs` prints the agent's error details (such as `error` and `exc_info`) under warn and error entries in text mode, including with `--follow`. Previously only `--json` showed them.

### Removed

- The `heartbeat` and `skill` command groups, which had no working backend.
- `debug breakpoint`, whose backend no longer exists.
- `release promote` and `release rollback`, which had no backend endpoint to call.

## [2.0.0]

`novaos-cli` is the command-line tool for building, testing, publishing and managing agents on the NovaOS platform. This is its first public release.

### What it does

- Scaffold agents (`init`, `migrate`) and run them locally (`run`, `eval`).
- Publish, activate and release agents to a NovaOS environment (`publish`, `activate`, `release`, `shadow`).
- Build and manage MCP servers and connectors (`mcp ...`, `connector ...`).
- Manage environments (`env add`, `env use`, `env list`, `env show`). The built-in `local` environment works without an account; other environments are configured by you.

### Installing

- Homebrew on macOS and Linux.
- Direct download of a prebuilt binary, with a `checksums.txt` to verify it.

### Supported platforms

- macOS (arm64, x64)
- Linux (x64, arm64)

### Notable changes

- Agent publishing now validates the agent's declared skills against the runtime Agent Card before pushing.
- macOS binaries carry valid code signatures.
