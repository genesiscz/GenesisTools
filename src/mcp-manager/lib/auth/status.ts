import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";
import { authStatusPath } from "./paths.ts";

export interface AuthStatusRow {
    server: string;
    issuer?: string;
    resource?: string;
    clientId?: string;
    expiresAt?: number;
    updatedAt: number;
    lastError?: string;
}

export interface AuthStatusFile {
    servers: Record<string, AuthStatusRow>;
}

async function readFile(): Promise<AuthStatusFile> {
    try {
        const raw = await Bun.file(authStatusPath()).text();
        const parsed = SafeJSON.parse(raw, { strict: true }) as AuthStatusFile;

        if (!parsed || typeof parsed !== "object" || !parsed.servers) {
            return { servers: {} };
        }

        return parsed;
    } catch {
        return { servers: {} };
    }
}

export async function readAuthStatus(server?: string): Promise<AuthStatusRow | AuthStatusFile> {
    const file = await readFile();

    if (server) {
        return file.servers[server] ?? { server, updatedAt: 0 };
    }

    return file;
}

export async function writeAuthStatus(row: AuthStatusRow): Promise<void> {
    const path = authStatusPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const file = await readFile();
    file.servers[row.server] = row;
    atomicWriteFileSync(path, `${SafeJSON.stringify(file, { strict: true }, 2)}\n`, { mode: 0o600 });
}

export async function deleteAuthStatus(server: string): Promise<void> {
    const path = authStatusPath();
    const file = await readFile();

    if (!file.servers[server]) {
        return;
    }

    delete file.servers[server];
    atomicWriteFileSync(path, `${SafeJSON.stringify(file, { strict: true }, 2)}\n`, { mode: 0o600 });
}
