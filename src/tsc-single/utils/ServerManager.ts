import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "fs";
import path from "path";
import { LspServer } from "../providers/LspServer.js";
import type { ServerInfo } from "../core/interfaces.js";
import { SERVERS_DIR, ensureServersDir, getServerInfoPath } from "./helpers.js";

// Global map to store persistent LSP servers
const persistentServers = new Map<string, LspServer>();

/**
 * Get or create a persistent LSP server for a directory
 */
export async function getPersistentServer(cwd: string, debug: boolean = false): Promise<LspServer> {
    const existing = persistentServers.get(cwd);
    if (existing) {
        return existing;
    }

    // Create new server
    const server = new LspServer({ cwd, debug });
    await server.initialize();
    persistentServers.set(cwd, server);

    // Save server info
    ensureServersDir();
    const serverInfo: ServerInfo = {
        pid: process.pid,
        cwd,
        started: Date.now(),
    };
    writeFileSync(getServerInfoPath(cwd), JSON.stringify(serverInfo, null, 2));

    return server;
}

/**
 * Kill server for a specific directory
 */
export async function killServerForDir(cwd: string): Promise<boolean> {
    const infoPath = getServerInfoPath(cwd);

    // Shutdown server if in memory
    const server = persistentServers.get(cwd);
    if (server) {
        await server.shutdown();
        persistentServers.delete(cwd);
    }

    // Remove info file
    if (existsSync(infoPath)) {
        unlinkSync(infoPath);
        return true;
    }

    return false;
}

/**
 * Kill all servers
 */
export async function killAllServers(): Promise<number> {
    ensureServersDir();
    const files = readdirSync(SERVERS_DIR).filter((f) => f.startsWith("server-") && f.endsWith(".json"));

    let killed = 0;
    for (const file of files) {
        try {
            const infoPath = path.join(SERVERS_DIR, file);
            const info: ServerInfo = JSON.parse(readFileSync(infoPath, "utf-8"));

            // Try to kill in-memory server
            const server = persistentServers.get(info.cwd);
            if (server) {
                await server.shutdown();
                persistentServers.delete(info.cwd);
            }

            unlinkSync(infoPath);
            killed++;
        } catch (error) {
            // Ignore errors for stale files
        }
    }

    return killed;
}

/**
 * List active servers
 */
export function listServers(): ServerInfo[] {
    ensureServersDir();
    const files = readdirSync(SERVERS_DIR).filter((f) => f.startsWith("server-") && f.endsWith(".json"));

    const servers: ServerInfo[] = [];
    for (const file of files) {
        try {
            const info: ServerInfo = JSON.parse(readFileSync(path.join(SERVERS_DIR, file), "utf-8"));
            servers.push(info);
        } catch (error) {
            // Ignore errors for corrupt files
        }
    }

    return servers;
}
