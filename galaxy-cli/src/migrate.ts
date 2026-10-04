/**
 * Migrate — Convert v1.x agent manifests to v2.0 format.
 *
 * Wraps the existing upgradeV1toV2() logic with file I/O and
 * post-upgrade validation so developers get a clean v2 manifest.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { validateManifest, upgradeV1toV2 } from "./manifest.js";

export interface MigrateOptions {
  output?: string;
  inPlace?: boolean;
  json?: boolean;
}

export function migrateManifest(manifestPath: string, opts: MigrateOptions): void {
  const resolvedPath = path.resolve(manifestPath);
  const content = readFileSync(resolvedPath, "utf-8");
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    throw new Error(`Failed to parse JSON from "${manifestPath}"`);
  }

  if (typeof raw !== "object" || raw === null) {
    throw new Error("Manifest must be a JSON object");
  }

  const manifest = raw as Record<string, unknown>;
  const schemaVersion = manifest.schema_version as string | undefined;

  if (schemaVersion === "2.0") {
    if (opts.json) {
      process.stdout.write(JSON.stringify({ migrated: false, reason: "already_v2" }) + "\n");
    } else {
      process.stdout.write("Manifest is already v2.0 — no migration needed.\n");
    }
    return;
  }

  const upgraded = upgradeV1toV2(manifest);
  const validation = validateManifest(upgraded);

  if (!validation.valid) {
    const details = validation.errors?.map((e) => `  ${e.path}: ${e.message}`).join("\n") ?? "";
    throw new Error(
      `Migration produced an invalid v2 manifest. Manual fixes required:\n${details}`
    );
  }

  const outputJson = JSON.stringify(validation.manifest, null, 2) + "\n";

  if (opts.inPlace) {
    writeFileSync(resolvedPath, outputJson);
    if (!opts.json) {
      process.stderr.write(
        `Migrated ${manifestPath} from v${schemaVersion ?? "1.0"} to v2.0 (in-place)\n`
      );
    }
  } else if (opts.output) {
    writeFileSync(path.resolve(opts.output), outputJson);
    if (!opts.json) {
      process.stderr.write(
        `Migrated ${manifestPath} → ${opts.output} (v${schemaVersion ?? "1.0"} → v2.0)\n`
      );
    }
  } else {
    process.stdout.write(outputJson);
    return;
  }

  if (opts.json) {
    process.stdout.write(
      JSON.stringify({
        migrated: true,
        from_version: schemaVersion ?? "1.0",
        to_version: "2.0",
        output: opts.inPlace ? manifestPath : opts.output,
      }) + "\n"
    );
  }
}
