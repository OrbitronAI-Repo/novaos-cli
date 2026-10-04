# Changelog

All notable changes to `novaos-cli` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
