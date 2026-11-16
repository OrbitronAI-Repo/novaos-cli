import { existsSync } from "node:fs";
import path from "node:path";

/** Where the host Python for the Agent Card emitter came from. */
export type HostPythonSource = "active-venv" | "project-venv" | "path";

export interface HostPython {
  /** What to spawn: `python3`, or the absolute path of a project venv's interpreter. */
  command: string;
  /** How messages name it: `python3 on PATH`, or the venv interpreter's path. */
  label: string;
  source: HostPythonSource;
}

/** Venv folder names checked in the project, in order. `init` tells users to create `.venv`. */
const PROJECT_VENV_DIRS = [".venv", "venv"];

/**
 * Picks the Python that runs the Agent Card emitter on this machine, when the
 * image's architecture differs from the host's (every Apple Silicon Mac
 * publishing `linux/amd64`).
 *
 * 1. An active venv (`VIRTUAL_ENV`) wins: the user chose it. Its own
 *    interpreter runs, so PATH order does not matter.
 * 2. Otherwise the project's own `.venv` or `venv`, run directly, looking in
 *    each of `projectDirs` in order (the manifest's folder, then the build
 *    context). A venv's interpreter works without activation, and this is
 *    where the `init` next steps install the SDK.
 * 3. Otherwise `python3` on `PATH`, as before.
 *
 * Without step 2, a developer who followed the next steps but opened a new
 * shell got the system Python, which has no SDK, and an error telling them
 * to install a package they had already installed.
 */
export function resolveHostPython(
  projectDirs: string[],
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform
): HostPython {
  const relativeInterpreter = platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"];
  if (env.VIRTUAL_ENV) {
    // Run the venv's own interpreter: VIRTUAL_ENV can be exported without its
    // bin folder first on PATH, and a Windows venv has no python3.exe.
    const interpreter = path.join(env.VIRTUAL_ENV, ...relativeInterpreter);
    return exists(interpreter)
      ? { command: interpreter, label: interpreter, source: "active-venv" }
      : {
          command: "python3",
          label: `python3 (active venv ${env.VIRTUAL_ENV})`,
          source: "active-venv",
        };
  }
  for (const projectDir of [...new Set(projectDirs)]) {
    for (const dir of PROJECT_VENV_DIRS) {
      const interpreter = path.join(projectDir, dir, ...relativeInterpreter);
      if (exists(interpreter)) {
        return { command: interpreter, label: interpreter, source: "project-venv" };
      }
    }
  }
  return { command: "python3", label: "python3 on PATH", source: "path" };
}

const SDK_INSTALL_COMMAND = "pip install -r requirements.txt";

/**
 * The error shown when the emitter cannot import `novaos_client_sdk`.
 * `python` is set when the emitter ran on this machine; the message then
 * names that interpreter, and says to activate a venv when none was found.
 */
export function sdkNotImportableMessage(detail: string, python?: HostPython): string {
  const base = `novaos-agent-sdk is not installed or importable by the Agent Card emitter (${detail}).`;
  if (!python) return `${base} Run: ${SDK_INSTALL_COMMAND}`;
  const where = ` The image targets another CPU architecture, so the emitter ran on this machine with ${python.label}.`;
  if (python.source === "path") {
    return (
      `${base}${where} No project venv (.venv or venv) was found and none is active. ` +
      `Activate the venv where you installed the SDK and publish again, or install it there: ${SDK_INSTALL_COMMAND}`
    );
  }
  // Name the interpreter: a bare `pip` may belong to another Python.
  const pip = python.command === "python3" ? "pip" : `"${python.command}" -m pip`;
  return `${base}${where} Install the SDK in that venv: ` + `${pip} install -r requirements.txt`;
}
