// src/automate/lib/credentials.ts

import { existsSync, mkdirSync, chmodSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import logger from "@app/logger";
import type { StoredCredential } from "./types";

const CREDENTIALS_DIR = join(homedir(), ".genesis-tools", "automate", "credentials");

/** Ensure credentials directory exists with restrictive permissions */
function ensureDir(): void {
  if (!existsSync(CREDENTIALS_DIR)) {
    mkdirSync(CREDENTIALS_DIR, { recursive: true, mode: 0o700 });
  }
}

/**
 * Save a credential to disk.
 * File permissions are set to 0600 (owner read/write only).
 */
export async function saveCredential(credential: StoredCredential): Promise<void> {
  ensureDir();
  const filePath = join(CREDENTIALS_DIR, `${credential.name}.json`);
  await Bun.write(filePath, JSON.stringify(credential, null, 2));
  chmodSync(filePath, 0o600);
  logger.debug(`Credential saved: ${credential.name}`);
}

/**
 * Load a credential by name.
 * Returns null if not found.
 */
export async function loadCredential(name: string): Promise<StoredCredential | null> {
  const filePath = join(CREDENTIALS_DIR, `${name}.json`);
  if (!existsSync(filePath)) return null;

  try {
    const content = await Bun.file(filePath).text();
    return JSON.parse(content) as StoredCredential;
  } catch (error) {
    logger.error(`Failed to load credential "${name}": ${error}`);
    return null;
  }
}

/** List all stored credential names */
export function listCredentials(): string[] {
  ensureDir();
  return readdirSync(CREDENTIALS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}

/** Delete a credential by name */
export function deleteCredential(name: string): boolean {
  const filePath = join(CREDENTIALS_DIR, `${name}.json`);
  if (!existsSync(filePath)) return false;
  unlinkSync(filePath);
  logger.debug(`Credential deleted: ${name}`);
  return true;
}

/**
 * Resolve credential values by expanding {{ env.X }} expressions.
 * Called at runtime just before use -- credentials on disk keep expressions intact.
 */
export function resolveCredentialValues(
  credential: StoredCredential,
  interpolate: (s: string) => string,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(credential)) {
    if (typeof value === "string") {
      resolved[key] = interpolate(value);
    } else if (typeof value === "object" && value !== null) {
      const obj: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        obj[k] = typeof v === "string" ? interpolate(v) : v;
      }
      resolved[key] = obj;
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

/**
 * Resolve a credential reference to HTTP headers for use in fetch requests.
 *
 * Supports credential types: bearer, basic, apikey, custom.
 * The credential can be inline (from preset) or loaded from disk (via $ref).
 */
export function resolveCredentialHeaders(
  credential: StoredCredential,
  interpolate: (s: string) => string,
): Record<string, string> {
  const resolved = resolveCredentialValues(credential, interpolate);
  const type = resolved.type as string;

  switch (type) {
    case "bearer": {
      const token = String(resolved.token ?? "");
      return { Authorization: `Bearer ${token}` };
    }
    case "basic": {
      const username = String(resolved.username ?? "");
      const password = String(resolved.password ?? "");
      const encoded = Buffer.from(`${username}:${password}`).toString("base64");
      return { Authorization: `Basic ${encoded}` };
    }
    case "apikey": {
      const headerName = String(resolved.headerName ?? "X-API-Key");
      const key = String(resolved.key ?? "");
      return { [headerName]: key };
    }
    case "custom": {
      const headers: Record<string, string> = {};
      if (resolved.headers && typeof resolved.headers === "object") {
        for (const [k, v] of Object.entries(resolved.headers as Record<string, string>)) {
          headers[k] = String(v);
        }
      }
      return headers;
    }
    default:
      return {};
  }
}
