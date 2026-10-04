# novaos-cli

`novaos-cli` is the command-line tool for building, testing, publishing and managing agents on the NovaOS platform. It scaffolds agents, runs them locally, publishes them to a NovaOS environment and manages releases from your terminal.

## Install

**Homebrew** (macOS and Linux)

```bash
brew install orbitronai-repo/novaos/novaos-cli
```

**npm** (Node.js 18 or newer)

```bash
npm install -g novaos-cli
# or run it without installing
npx novaos-cli --help
```

**Direct download**

Download the binary for your platform from the [latest release](../../releases/latest), together with `checksums.txt`, and verify it before running:

```bash
sha256sum --check --ignore-missing checksums.txt
chmod +x novaos-cli-<platform>
mv novaos-cli-<platform> /usr/local/bin/novaos-cli
```

On macOS use `shasum -a 256 --check --ignore-missing checksums.txt`.

## Supported platforms

| OS    | Architectures | Notes                                                                 |
| ----- | ------------- | --------------------------------------------------------------------- |
| macOS | arm64, x64    |                                                                       |
| Linux | x64, arm64    | glibc only; musl-based distributions such as Alpine are not supported |

Windows is not supported yet.

## Quick start

```bash
novaos-cli --help
novaos-cli env list
novaos-cli auth login --env <env>
novaos-cli init
```

The `local` environment works without an account. Every other environment needs a NovaOS account and a configured environment; see `novaos-cli env add --help`.

## Documentation

- [Full command reference](galaxy-cli/README.md)
- [License](LICENSE)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)
