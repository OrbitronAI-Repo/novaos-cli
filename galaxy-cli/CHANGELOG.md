# Changelog

All notable changes to `novaos-cli` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
