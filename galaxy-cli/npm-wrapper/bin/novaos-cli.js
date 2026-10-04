#!/usr/bin/env node
"use strict";

// Launcher for the `novaos-cli` npm package. The real CLI is the standalone
// binary that install.js downloads next to this file at install time; this
// shim only hands over argv, stdio and the exit status to it.
//
// When the install script did not run (npm --ignore-scripts, or pnpm and bun,
// which block dependency lifecycle scripts by default), the binary is fetched
// here on first run through the same checksum-verified download, into bin/
// when it is writable and otherwise into a per-user cache directory.

const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const installer = require("../install.js");

const packageDir = path.join(__dirname, "..");

function missingBinaryMessage(reason) {
  const binary = installer.binaryPathFor(packageDir);
  const installScript = path.join(packageDir, "install.js");
  return (
    `novaos-cli: the platform binary is missing at ${binary}, and downloading it failed:\n` +
    `  ${reason}\n` +
    `It is normally downloaded by this package's postinstall script; this usually means the ` +
    `package was installed with --ignore-scripts and the first-run download could not complete. ` +
    `Fix the cause above, then run novaos-cli again or re-run the install script with:\n\n` +
    `  node ${installScript}\n`
  );
}

function run(binary) {
  const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });

  // A terminal-generated SIGINT reaches the child directly (same process
  // group), so the launcher only has to stay alive until the child reports
  // its outcome. Signals sent to the launcher alone are forwarded.
  process.on("SIGINT", () => {});
  for (const signal of ["SIGTERM", "SIGHUP"]) {
    process.on(signal, () => child.kill(signal));
  }

  child.on("error", (error) => {
    console.error(`novaos-cli: failed to start ${binary}: ${error.message}`);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code === null ? 1 : code);
  });
}

async function main() {
  let resolved;
  try {
    resolved = await installer.ensureBinary({
      packageDir,
      env: process.env,
      platform: os.platform(),
      arch: os.arch(),
      homedir: os.homedir(),
      // Resolved lazily: an already-installed binary runs on any Node.js.
      fetchImpl: (...args) => installer.requireFetch()(...args),
    });
  } catch (error) {
    const reason =
      error instanceof installer.InstallError
        ? error.message
        : (error && error.message) || String(error);
    console.error(missingBinaryMessage(reason));
    process.exit(1);
  }
  if (resolved.fetched) {
    console.error(
      `novaos-cli: fetched the ${resolved.assetName} binary for ${resolved.tag} on first run ` +
        `(checksum verified) to ${resolved.path}`
    );
  }
  run(resolved.path);
}

main();
