import { mkdir, chmod, stat } from "node:fs/promises";

import { CREDENTIALS_DIR, DIR_PERMISSIONS } from "./constants.js";

/**
 * Ensure the credentials directory exists with restrictive permissions.
 *
 * On POSIX systems, the directory is created (if needed) and chmod'd to 0700
 * unconditionally -- both new and pre-existing directories are corrected.
 *
 * On Windows, POSIX file modes are not applicable (Node silently ignores them).
 * The directory is created but no ACL-based enforcement is currently configured.
 * Only the leaf directory is guaranteed 0700; intermediate directories created
 * by recursive mkdir inherit umask-derived permissions.
 */
export async function ensureCredentialsDir(dir: string = CREDENTIALS_DIR): Promise<void> {
  if (process.platform === "win32") {
    try {
      await mkdir(dir, { recursive: true });
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "EEXIST"
      ) {
        // Bun on Windows throws EEXIST even when the directory already exists
        // (recursive mkdir should be idempotent). Verify the path is actually
        // a directory -- if a file occupies it, surface the original error.
        const s = await stat(dir);
        if (!s.isDirectory()) {
          throw err;
        }
      } else {
        throw err;
      }
    }
    return;
  }
  await mkdir(dir, { recursive: true, mode: DIR_PERMISSIONS });
  await chmod(dir, DIR_PERMISSIONS);
}
