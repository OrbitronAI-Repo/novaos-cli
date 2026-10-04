# novaos-cli

The NovaOS command-line interface: build, run and publish agents, MCP
servers and connectors for NovaOS.

Source, documentation and issues: <https://github.com/OrbitronAI-Repo/novaos-cli>.

## Install

```bash
npm install -g novaos-cli
novaos-cli --help
```

Or run it without installing:

```bash
npx novaos-cli --help
```

pnpm and bun work too:

```bash
pnpm add -g novaos-cli
bun add -g novaos-cli
```

Both block dependency install scripts by default, as does
`npm install --ignore-scripts`. That is fine: the first time you run
`novaos-cli`, it downloads and verifies the binary itself (see
[How this package works](#how-this-package-works)) and prints one line
saying so.

Node.js 18 or newer is required.

## Supported platforms

| OS            | Architecture |
| ------------- | ------------ |
| macOS         | arm64, x64   |
| Linux (glibc) | x64, arm64   |

On any other platform the install fails with an error saying so; it never
installs without a working binary. That includes Windows, which is not
supported yet, and musl-based Linux such as Alpine and the `node:*-alpine`
images, since the Linux binaries are built against glibc.

## How this package works

`novaos-cli` is compiled to a standalone binary that needs no Node.js or Bun
runtime. This npm package contains no CLI code of its own, only an installer
and a small launcher. The npm version and the GitHub Release tag are always
the same version.

The installer downloads the binary for your platform from the GitHub Release
whose tag matches the package version (`v<version>`). It normally runs as the
package's `postinstall` script. When install scripts were skipped, the
launcher runs the same download on first use, into the package's own
directory, or, if that is not writable (for example a global install owned by
root), into a per-user cache:

- `$XDG_CACHE_HOME/novaos-cli/<version>/` when `XDG_CACHE_HOME` is set;
- otherwise `~/Library/Caches/novaos-cli/<version>/` on macOS and
  `~/.cache/novaos-cli/<version>/` on Linux.

## Verification

- **Checksums.** Every download, at install time or on first run, is checked
  against the SHA-256 in the release's `checksums.txt`. A mismatch, or a
  `checksums.txt` without an entry for your platform, fails the install and
  leaves no binary behind. There is no option to skip this check.
- **Provenance.** The package is published from the CLI repository's release
  workflow with npm trusted publishing, so every version carries a signed
  provenance attestation linking it to the source commit and workflow run.
  Check it in any project that depends on `novaos-cli`:

  ```bash
  npm audit signatures
  ```

  The package page on npmjs.com shows the same attestation.

## Environment variables

| Variable                                                  | Purpose                                                                                                                        |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `NOVAOS_CLI_GITHUB_TOKEN` (or `GITHUB_TOKEN`, `GH_TOKEN`) | Optional GitHub token used for the download. Only needed to lift GitHub's API rate limit for unauthenticated requests.         |
| `NOVAOS_CLI_RELEASE_REPO`                                 | `owner/repo` of a GitHub mirror to download releases from instead of the package's `repository`. Checksums are still verified. |

## Troubleshooting

**`novaos-cli: the platform binary is missing ... and downloading it failed`**:
the binary was not installed and the first-run download could not complete.
The message says why. Fix the cause (network access to GitHub, an
unsupported platform), then run `novaos-cli` again, or re-run the installer:

```bash
node "$(npm root -g)/novaos-cli/install.js"
```

**`not found (HTTP 404)`**: the release for this package version has no
binary for your platform, or `NOVAOS_CLI_RELEASE_REPO` names a repository
without that release.

## Uninstall

```bash
npm uninstall -g novaos-cli    # or: pnpm remove -g novaos-cli / bun remove -g novaos-cli
```

If the binary was fetched into the per-user cache, remove that too:

```bash
rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/novaos-cli"   # Linux
rm -rf ~/Library/Caches/novaos-cli                    # macOS
```

## License

MIT, see [`LICENSE`](LICENSE).
