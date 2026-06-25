import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { logger } from "@app/logger";

export interface AuthStorageKey {
    /** Logical namespace; on macOS Keychain this becomes the entry's "service". */
    service: string;
    /** Identifier within the namespace; on macOS Keychain this becomes the entry's "account". */
    account: string;
}

export type AuthStorageBackendId = "macos-keychain" | "file" | "in-memory";

export interface AuthStorageBackend {
    readonly id: AuthStorageBackendId;
    get(key: AuthStorageKey): Promise<string | null>;
    set(key: AuthStorageKey, value: string): Promise<void>;
    delete(key: AuthStorageKey): Promise<void>;
}

export class MacKeychainBackend implements AuthStorageBackend {
    readonly id = "macos-keychain" as const;

    async get(key: AuthStorageKey): Promise<string | null> {
        try {
            const proc = Bun.spawn({
                cmd: ["security", "find-generic-password", "-s", key.service, "-a", key.account, "-w"],
                stdout: "pipe",
                stderr: "pipe",
            });

            const [stdoutText, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

            if (exitCode !== 0) {
                return null;
            }

            const trimmed = stdoutText.trim();
            return trimmed.length > 0 ? trimmed : null;
        } catch (err) {
            logger.debug({ err, service: key.service, account: key.account }, "AuthStorage: keychain get failed");
            return null;
        }
    }

    async set(key: AuthStorageKey, value: string): Promise<void> {
        if (/[\n\r]/.test(value)) {
            throw new Error("AuthStorage: keychain values cannot contain newlines");
        }

        const proc = Bun.spawn({
            cmd: ["security", "-i"],
            stdin: "pipe",
            stdout: "pipe",
            stderr: "pipe",
        });

        const command = `add-generic-password -s ${shellSingleQuote(key.service)} -a ${shellSingleQuote(key.account)} -w ${shellSingleQuote(value)} -U\n`;
        proc.stdin.write(command);
        proc.stdin.end();

        const [stderrText, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);

        if (exitCode !== 0) {
            throw new Error(
                `AuthStorage: failed to write keychain entry ${key.service}/${key.account}: ${stderrText.trim() || `exit ${exitCode}`}`
            );
        }
    }

    async delete(key: AuthStorageKey): Promise<void> {
        const proc = Bun.spawn({
            cmd: ["security", "delete-generic-password", "-s", key.service, "-a", key.account],
            stdout: "pipe",
            stderr: "pipe",
        });

        await proc.exited;
    }
}

export class FileBackend implements AuthStorageBackend {
    readonly id = "file" as const;
    private readonly root: string;

    constructor(root?: string) {
        this.root = root ?? join(homedir(), ".local", "share", "auth-storage");
    }

    private pathFor(key: AuthStorageKey): string {
        const safeService = encodeSegment(key.service);
        const safeAccount = encodeSegment(key.account);
        return join(this.root, safeService, safeAccount);
    }

    async get(key: AuthStorageKey): Promise<string | null> {
        const path = this.pathFor(key);
        try {
            const raw = readFileSync(path, "utf-8").trim();
            return raw.length > 0 ? raw : null;
        } catch (err) {
            if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
                return null;
            }
            logger.debug({ err, service: key.service, account: key.account }, "AuthStorage: file backend read failed");
            return null;
        }
    }

    async set(key: AuthStorageKey, value: string): Promise<void> {
        const path = this.pathFor(key);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, `${value.trim()}\n`, { encoding: "utf-8", mode: 0o600 });
        chmodSync(path, 0o600);
    }

    async delete(key: AuthStorageKey): Promise<void> {
        const path = this.pathFor(key);
        if (existsSync(path)) {
            unlinkSync(path);
        }
    }
}

export class InMemoryBackend implements AuthStorageBackend {
    readonly id = "in-memory" as const;
    private readonly store = new Map<string, string>();

    private keyFor(key: AuthStorageKey): string {
        return `${key.service}\x00${key.account}`;
    }

    async get(key: AuthStorageKey): Promise<string | null> {
        return this.store.get(this.keyFor(key)) ?? null;
    }

    async set(key: AuthStorageKey, value: string): Promise<void> {
        this.store.set(this.keyFor(key), value.trim());
    }

    async delete(key: AuthStorageKey): Promise<void> {
        this.store.delete(this.keyFor(key));
    }
}

function encodeSegment(value: string): string {
    return `k-${Buffer.from(value, "utf8").toString("hex")}`;
}

function shellSingleQuote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
}

function defaultBackend(): AuthStorageBackend {
    return platform() === "darwin" ? new MacKeychainBackend() : new FileBackend();
}

let activeBackend: AuthStorageBackend = defaultBackend();

export function setAuthStorageBackend(backend: AuthStorageBackend | null): void {
    activeBackend = backend ?? defaultBackend();
}

export function authStorageBackend(): AuthStorageBackend {
    return activeBackend;
}

export async function getAuthSecret(key: AuthStorageKey): Promise<string | null> {
    return activeBackend.get(key);
}

export async function setAuthSecret(key: AuthStorageKey, value: string): Promise<void> {
    return activeBackend.set(key, value);
}

export async function deleteAuthSecret(key: AuthStorageKey): Promise<void> {
    return activeBackend.delete(key);
}

export async function migrateFileToAuthStorage(
    key: AuthStorageKey,
    legacyFilePath: string
): Promise<{ migrated: boolean; value: string | null }> {
    if (!existsSync(legacyFilePath)) {
        return { migrated: false, value: null };
    }

    let raw: string;
    try {
        raw = readFileSync(legacyFilePath, "utf-8").trim();
    } catch (err) {
        logger.debug({ err, legacyFilePath }, "AuthStorage: legacy file read failed");
        return { migrated: false, value: null };
    }

    if (raw.length === 0) {
        return { migrated: false, value: null };
    }

    try {
        await setAuthSecret(key, raw);
    } catch (err) {
        logger.warn(
            { err, service: key.service, account: key.account, legacyFilePath },
            "AuthStorage: migration write failed; leaving legacy file in place"
        );
        return { migrated: false, value: raw };
    }

    try {
        unlinkSync(legacyFilePath);
        logger.info(
            { service: key.service, account: key.account, legacyFilePath },
            "AuthStorage: migrated legacy token file into auth storage and removed the file"
        );
    } catch (err) {
        logger.warn(
            { err, legacyFilePath },
            "AuthStorage: migrated token but failed to delete legacy file — delete it manually"
        );
    }

    return { migrated: true, value: raw };
}
