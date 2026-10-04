#!/usr/bin/env node
"use strict";

// Binary installer for the `novaos-cli` npm package.
//
// This package is a thin wrapper: it ships no CLI code of its own. It
// downloads the standalone binary for the host platform from the GitHub
// Release whose tag matches this package's version (v<version>), verifies it
// against the release's checksums.txt, and places it next to the launcher in
// bin/. The launcher (bin/novaos-cli.js) then execs it.
//
// The download normally happens in this script's postinstall entry point.
// Package managers that skip install scripts (npm --ignore-scripts, and pnpm
// and bun, which block dependency lifecycle scripts by default) leave no
// binary, so the launcher calls ensureBinary() on its first run: the same
// verified download, into bin/ when that directory is writable, otherwise
// into a per-user cache directory (see cacheBinaryPathFor).
//
// The release repository comes from package.json's "repository" field, so
// the published package always points at the repo whose release it was
// built from. Environment overrides:
//
//   NOVAOS_CLI_RELEASE_REPO   owner/repo to download from instead (a mirror)
//   NOVAOS_CLI_GITHUB_TOKEN   GitHub token (also honours GITHUB_TOKEN and
//                             GH_TOKEN): lifts the unauthenticated GitHub API
//                             rate limit, and is needed to read a release
//                             repository that is not public

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

const SUPPORTED_ASSETS = {
  "darwin-arm64": "novaos-cli-darwin-arm64",
  "darwin-x64": "novaos-cli-darwin-x64",
  "linux-x64": "novaos-cli-linux-x64",
  "linux-arm64": "novaos-cli-linux-arm64",
};

const BINARY_FILENAME = "novaos-cli-bin";
const CHECKSUMS_ASSET = "checksums.txt";
const USER_AGENT = "novaos-cli-npm-installer";

class InstallError extends Error {}

// The Linux binaries are built against glibc. On a musl host (Alpine and
// the node:*-alpine images) they download fine but cannot be executed, so
// musl is treated as unsupported here rather than discovered at first run.
// Inspects the host this script runs on; null on anything but Linux.
function detectLibc() {
  if (os.platform() !== "linux") return null;
  try {
    if (process.report && typeof process.report.getReport === "function") {
      const header = process.report.getReport().header || {};
      return header.glibcVersionRuntime ? "glibc" : "musl";
    }
  } catch {
    // fall through to the filesystem probe
  }
  for (const dir of ["/lib", "/usr/lib", "/lib64"]) {
    try {
      if (fs.readdirSync(dir).some((name) => name.startsWith("ld-musl-"))) return "musl";
    } catch {
      // directory absent or unreadable
    }
  }
  return "glibc";
}

function assetNameFor(platform, arch, libc) {
  if (platform === "linux" && libc === "musl") return null;
  return SUPPORTED_ASSETS[`${platform}-${arch}`] || null;
}

function unsupportedPlatformMessage(platform, arch, libc) {
  const supported = Object.keys(SUPPORTED_ASSETS).join(", ");
  if (platform === "linux" && libc === "musl") {
    return (
      `novaos-cli has no prebuilt binary for musl-based Linux (${platform}-${arch}, e.g. Alpine); ` +
      `the Linux binaries are built against glibc. Use a glibc-based image or host. ` +
      `Supported platforms: ${supported} (glibc).`
    );
  }
  if (platform === "win32") {
    return (
      `novaos-cli does not support Windows (${platform}-${arch}) yet. ` +
      `Supported by this package: ${supported}.`
    );
  }
  return (
    `novaos-cli has no prebuilt binary for ${platform}-${arch}. ` +
    `Supported platforms: ${supported}.`
  );
}

// Accepts the shapes npm allows for "repository": a "github:owner/repo" or
// bare "owner/repo" shorthand, a GitHub URL (git+https, https, git@, with or
// without .git), or an object with a "url" property. Returns "owner/repo".
function parseRepository(repository) {
  const raw = typeof repository === "string" ? repository : repository && repository.url;
  if (typeof raw !== "string" || raw.length === 0) return null;
  let value = raw.trim();
  value = value.replace(/^git\+/, "").replace(/^github:/, "");
  const url = value.match(
    /^(?:https?:\/\/|git:\/\/|ssh:\/\/(?:git@)?|git@)github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/
  );
  if (url) return `${url[1]}/${url[2]}`;
  const short = value.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (short) return `${short[1]}/${short[2]}`;
  return null;
}

function releaseTagFor(version) {
  return `v${version}`;
}

function githubToken(env) {
  return env.NOVAOS_CLI_GITHUB_TOKEN || env.GITHUB_TOKEN || env.GH_TOKEN || "";
}

function baseHeaders(token) {
  const headers = { "User-Agent": USER_AGENT };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

// Returns { [assetName]: { url, headers } } for the assets requested.
//
// Without a token, the direct browser_download_url is used: it needs no API
// call, so it is immune to the unauthenticated API rate limit. With a token
// the release is looked up through the API and each asset is fetched via
// its API url with Accept: application/octet-stream — the only way to
// download a release asset from a private repository.
async function resolveAssets({ repo, tag, assetNames, token, fetchImpl }) {
  if (!token) {
    const resolved = {};
    for (const name of assetNames) {
      resolved[name] = {
        url: `https://github.com/${repo}/releases/download/${tag}/${name}`,
        headers: baseHeaders(""),
      };
    }
    return resolved;
  }

  const releaseUrl = `https://api.github.com/repos/${repo}/releases/tags/${tag}`;
  const response = await fetchImpl(releaseUrl, {
    headers: { ...baseHeaders(token), Accept: "application/vnd.github+json" },
  });
  if (response.status === 404) {
    throw new InstallError(
      `Release ${tag} was not found in ${repo} (or the token cannot read it). ` +
        `This package's version is set from the release tag at publish time; ` +
        `a source checkout of the wrapper is not installable directly.`
    );
  }
  if (!response.ok) {
    throw new InstallError(`GitHub API returned HTTP ${response.status} for ${releaseUrl}`);
  }
  const release = await response.json();
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const resolved = {};
  for (const name of assetNames) {
    const asset = assets.find((a) => a && a.name === name);
    if (!asset) {
      throw new InstallError(
        `Release ${tag} in ${repo} has no asset named ${name}. ` +
          `Available: ${assets.map((a) => a.name).join(", ") || "(none)"}.`
      );
    }
    resolved[name] = {
      url: asset.url,
      headers: { ...baseHeaders(token), Accept: "application/octet-stream" },
    };
  }
  return resolved;
}

async function fetchOrThrow(fetchImpl, { url, headers }, description) {
  const response = await fetchImpl(url, { headers, redirect: "follow" });
  if (response.status === 404) {
    throw new InstallError(
      `${description} not found (HTTP 404): ${url}\n` +
        `If the release repository is private, set NOVAOS_CLI_GITHUB_TOKEN to a token that can read it.`
    );
  }
  if (!response.ok) {
    throw new InstallError(
      `Failed to download ${description}: HTTP ${response.status} from ${url}`
    );
  }
  return response;
}

async function downloadToFile(fetchImpl, target, destination, description) {
  const response = await fetchOrThrow(fetchImpl, target, description);
  if (!response.body) throw new InstallError(`Empty response body downloading ${description}`);
  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(destination));
}

// checksums.txt is `sha256sum` output: "<hex>  <filename>" per line.
//
// Parsed manually rather than with a single ^(hex)\s+\*?(.+)$ regex: that
// pattern lets \s+ and the trailing .+ both match whitespace, so a line
// with many repeated spaces and no real filename makes the engine backtrack
// through every split point between them (CodeQL: polynomial ReDoS on
// uncontrolled input, since checksums.txt is downloaded from GitHub Releases).
// Slicing the fixed-length hex prefix off first removes the ambiguity.
function expectedChecksumFor(checksumsText, assetName) {
  for (const rawLine of checksumsText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length < 64) continue;
    const hex = line.slice(0, 64);
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) continue;
    let rest = line.slice(64).trimStart();
    if (rest.startsWith("*")) rest = rest.slice(1);
    if (rest.trim() === assetName) return hex.toLowerCase();
  }
  return null;
}

async function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest("hex");
}

function binaryPathFor(packageDir) {
  return path.join(packageDir, "bin", BINARY_FILENAME);
}

// Per-user location for a binary fetched on first run when the package's own
// bin/ is not writable (for example a global install owned by root):
// $XDG_CACHE_HOME/novaos-cli/<version>/ when XDG_CACHE_HOME is set, otherwise
// ~/Library/Caches/novaos-cli/<version>/ on macOS and
// ~/.cache/novaos-cli/<version>/ elsewhere.
function cacheBinaryPathFor({ version, env, platform, homedir }) {
  let root;
  if (env.XDG_CACHE_HOME && path.isAbsolute(env.XDG_CACHE_HOME)) {
    root = env.XDG_CACHE_HOME;
  } else if (platform === "darwin") {
    root = path.join(homedir, "Library", "Caches");
  } else {
    root = path.join(homedir, ".cache");
  }
  return path.join(root, "novaos-cli", version, BINARY_FILENAME);
}

function readPackage(packageDir) {
  return JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
}

// The one download path: resolves the release, fetches checksums.txt and the
// platform binary, verifies the binary's SHA-256 and only then moves it to
// `destination`. Every install route goes through here, so none of them can
// skip verification.
async function downloadBinary({
  version,
  repository,
  destination,
  env,
  platform,
  arch,
  libc,
  fetchImpl,
  log,
}) {
  const resolvedLibc = libc === undefined ? detectLibc() : libc;
  const assetName = assetNameFor(platform, arch, resolvedLibc);
  if (!assetName) throw new InstallError(unsupportedPlatformMessage(platform, arch, resolvedLibc));

  const repo = env.NOVAOS_CLI_RELEASE_REPO || parseRepository(repository);
  if (!repo) {
    throw new InstallError(
      `Cannot determine the release repository: package.json "repository" is ${JSON.stringify(repository)} ` +
        `and NOVAOS_CLI_RELEASE_REPO is unset.`
    );
  }
  const tag = releaseTagFor(version);
  const token = githubToken(env);

  log(
    `Downloading novaos-cli ${tag} (${assetName}) from ${repo}${token ? " (authenticated)" : ""}...`
  );
  const targets = await resolveAssets({
    repo,
    tag,
    assetNames: [assetName, CHECKSUMS_ASSET],
    token,
    fetchImpl,
  });

  const checksumsResponse = await fetchOrThrow(
    fetchImpl,
    targets[CHECKSUMS_ASSET],
    `${CHECKSUMS_ASSET} for ${tag}`
  );
  const expected = expectedChecksumFor(await checksumsResponse.text(), assetName);
  if (!expected) {
    throw new InstallError(
      `${CHECKSUMS_ASSET} for ${tag} has no entry for ${assetName}; refusing to install an unverified binary.`
    );
  }

  const destinationDir = path.dirname(destination);
  fs.mkdirSync(destinationDir, { recursive: true });
  const tmpPath = path.join(destinationDir, `.${BINARY_FILENAME}.${process.pid}.download`);
  try {
    await downloadToFile(fetchImpl, targets[assetName], tmpPath, `${assetName} for ${tag}`);
    const actual = await sha256File(tmpPath);
    if (actual !== expected) {
      throw new InstallError(
        `Checksum mismatch for ${assetName} ${tag}: expected ${expected}, got ${actual}. ` +
          `The download may be corrupted or tampered with; refusing to install it.`
      );
    }
    fs.chmodSync(tmpPath, 0o755);
    fs.renameSync(tmpPath, destination);
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }

  log(`Installed novaos-cli ${tag} to ${destination}`);
  return { path: destination, assetName, tag };
}

// The postinstall path: downloads into the package's own bin/.
async function install({ packageDir, env, platform, arch, libc, fetchImpl, log }) {
  const pkg = readPackage(packageDir);
  const result = await downloadBinary({
    version: pkg.version,
    repository: pkg.repository,
    destination: binaryPathFor(packageDir),
    env,
    platform,
    arch,
    libc,
    fetchImpl,
    log,
  });
  return result.path;
}

function isWritableDirectory(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// The launcher's path: returns the binary to exec, downloading it first when
// neither the package's bin/ nor the per-user cache has it. `fetched` is true
// when this call downloaded it.
async function ensureBinary({
  packageDir,
  env,
  platform,
  arch,
  libc,
  homedir,
  fetchImpl,
  isWritable = isWritableDirectory,
}) {
  const packaged = binaryPathFor(packageDir);
  if (fs.existsSync(packaged)) return { path: packaged, fetched: false };

  const pkg = readPackage(packageDir);
  const cached = cacheBinaryPathFor({ version: pkg.version, env, platform, homedir });
  if (fs.existsSync(cached)) return { path: cached, fetched: false };

  const destination = isWritable(path.dirname(packaged)) ? packaged : cached;
  const result = await downloadBinary({
    version: pkg.version,
    repository: pkg.repository,
    destination,
    env,
    platform,
    arch,
    libc,
    fetchImpl,
    log: () => {},
  });
  return { ...result, fetched: true };
}

function requireFetch() {
  if (typeof fetch !== "function") {
    throw new InstallError(
      `Node.js ${process.version} lacks the global fetch API; novaos-cli needs Node.js 18 or newer.`
    );
  }
  return fetch;
}

async function main() {
  await install({
    packageDir: __dirname,
    env: process.env,
    platform: os.platform(),
    arch: os.arch(),
    fetchImpl: requireFetch(),
    log: (message) => console.log(message),
  });
}

if (require.main === module) {
  main().catch((error) => {
    const message =
      error instanceof InstallError ? error.message : (error && error.stack) || String(error);
    console.error(`\nnovaos-cli install failed: ${message}\n`);
    process.exit(1);
  });
}

module.exports = {
  BINARY_FILENAME,
  InstallError,
  SUPPORTED_ASSETS,
  assetNameFor,
  binaryPathFor,
  cacheBinaryPathFor,
  detectLibc,
  downloadBinary,
  ensureBinary,
  expectedChecksumFor,
  install,
  parseRepository,
  releaseTagFor,
  requireFetch,
  resolveAssets,
  unsupportedPlatformMessage,
};
