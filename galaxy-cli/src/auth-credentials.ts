/**
 * novaos-cli Credential Persistence
 *
 * On-disk storage of OAuth tokens issued by NovaOS ID (Logto).
 */

import { existsSync } from "node:fs";
import { readFile, writeFile, chmod, unlink } from "node:fs/promises";

import { CREDENTIALS_DIR, CREDENTIALS_FILE_PATH, FILE_PERMISSIONS } from "./constants.js";
import { ensureCredentialsDir } from "./ensure-credentials-dir.js";

export interface StoredCredentials {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  /** Cached from id_token or OIDC userinfo; survives token refreshes. */
  email?: string;
  /** Cached from id_token or OIDC userinfo; survives token refreshes. */
  name?: string;
  expires_at: number;
  iam_url: string;
  client_id: string;
}

export class CredentialStore {
  constructor(
    private paths: { dir: string; file: string } = {
      dir: CREDENTIALS_DIR,
      file: CREDENTIALS_FILE_PATH,
    }
  ) {}

  async save(credentials: StoredCredentials): Promise<void> {
    await ensureCredentialsDir(this.paths.dir);
    const data = JSON.stringify(credentials, null, 2);
    await writeFile(this.paths.file, data, { encoding: "utf-8" });
    await chmod(this.paths.file, FILE_PERMISSIONS);
  }

  async load(): Promise<StoredCredentials | null> {
    if (!existsSync(this.paths.file)) {
      return null;
    }
    const data = await readFile(this.paths.file, { encoding: "utf-8" });
    try {
      return JSON.parse(data) as StoredCredentials;
    } catch (error) {
      throw new Error(
        `Corrupted credentials file at ${this.paths.file} (${(error as Error).message}). ` +
          `Run 'novaos-cli auth logout' then 'novaos-cli auth login' to reset it.`
      );
    }
  }

  async clear(): Promise<void> {
    if (existsSync(this.paths.file)) {
      await unlink(this.paths.file);
    }
  }
}
