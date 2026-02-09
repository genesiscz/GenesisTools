import logger from "@app/logger";
import type { ServerInfo } from "@app/mcp-tsc/core/interfaces.js";
import { LspServer } from "@app/mcp-tsc/providers/LspServer.js";
import { ensureServersDir, getServerInfoPath, SERVERS_DIR } from "@app/mcp-tsc/utils/helpers.js";
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import path from "path";

// Global map to store persistent LSP servers
const persistentServers = new Map<string, LspServer>();

/**
 * Get or create a persistent LSP server for a directory
 */
export async function getPersistentServer(cwd: string, debug: boolean = false): Promise<LspServer> {
    logger.debug(
        {
            component: "mcp-tsc",
            subcomponent: "ServerManager",
            pid: process.pid,
            cwd,
            debug,
            mapSize: persistentServers.size,
            mapKeys: Array.from(persistentServers.keys()),
        },
        "getPersistentServer() called"
    );

    const existing = persistentServers.get(cwd);
    if (existing) {
        logger.debug(
            {
                component: "mcp-tsc",
                subcomponent: "ServerManager",
                pid: process.pid,
                cwd,
            },
            "Found existing server in memory, reusing it"
        );

        // Check if server info file exists and matches current PID
        const infoPath = getServerInfoPath(cwd);
        if (existsSync(infoPath)) {
            try {
                const info: ServerInfo = JSON.parse(readFileSync(infoPath, "utf-8"));
                logger.debug(
                    {
                        component: "mcp-tsc",
                        subcomponent: "ServerManager",
                        pid: process.pid,
                        infoPid: info.pid,
                        infoStarted: new Date(info.started).toISOString(),
                        cwd,
                    },
                    "Server info file exists"
                );

                if (info.pid !== process.pid) {
                    logger.warn(
                        {
                            component: "mcp-tsc",
                            subcomponent: "ServerManager",
                            pid: process.pid,
                            infoPid: info.pid,
                            cwd,
                        },
                        "PID mismatch - server may have been created by different process"
                    );
                }
            } catch (error) {
                logger.warn(
                    {
                        component: "mcp-tsc",
                        subcomponent: "ServerManager",
                        pid: process.pid,
                        cwd,
                        error: error instanceof Error ? error.message : String(error),
                    },
                    "Failed to read server info file"
                );
            }
        } else {
            logger.warn(
                {
                    component: "mcp-tsc",
                    subcomponent: "ServerManager",
                    pid: process.pid,
                    cwd,
                },
                "Server exists in memory but info file missing"
            );
        }

        return existing;
    }

    logger.info(
        {
            component: "mcp-tsc",
            subcomponent: "ServerManager",
            pid: process.pid,
            cwd,
        },
        "No existing server found, creating new server"
    );

    // Check if server info file exists from previous process
    const infoPath = getServerInfoPath(cwd);
    if (existsSync(infoPath)) {
        try {
            const info: ServerInfo = JSON.parse(readFileSync(infoPath, "utf-8"));
            logger.warn(
                {
                    component: "mcp-tsc",
                    subcomponent: "ServerManager",
                    pid: process.pid,
                    stalePid: info.pid,
                    staleStarted: new Date(info.started).toISOString(),
                    cwd,
                },
                "Found stale server info file - possible process restart"
            );
        } catch (error) {
            logger.warn(
                {
                    component: "mcp-tsc",
                    subcomponent: "ServerManager",
                    pid: process.pid,
                    cwd,
                    error: error instanceof Error ? error.message : String(error),
                },
                "Failed to read stale server info file"
            );
        }
    }

    // Create new server
    logger.debug(
        {
            component: "mcp-tsc",
            subcomponent: "ServerManager",
            pid: process.pid,
            cwd,
        },
        "Creating new LspServer instance"
    );
    const server = new LspServer({ cwd, debug });

    logger.debug(
        {
            component: "mcp-tsc",
            subcomponent: "ServerManager",
            pid: process.pid,
            cwd,
        },
        "Initializing LspServer"
    );
    await server.initialize();
    logger.info(
        {
            component: "mcp-tsc",
            subcomponent: "ServerManager",
            pid: process.pid,
            cwd,
        },
        "LspServer initialized successfully"
    );

    persistentServers.set(cwd, server);
    logger.debug(
        {
            component: "mcp-tsc",
            subcomponent: "ServerManager",
            pid: process.pid,
            cwd,
            newMapSize: persistentServers.size,
        },
        "Server stored in persistentServers map"
    );

    // Save server info
    ensureServersDir();
    const serverInfo: ServerInfo = {
        pid: process.pid,
        cwd,
        started: Date.now(),
    };
    writeFileSync(infoPath, JSON.stringify(serverInfo, null, 2));
    logger.debug(
        {
            component: "mcp-tsc",
            subcomponent: "ServerManager",
            pid: process.pid,
            infoPid: serverInfo.pid,
            infoStarted: new Date(serverInfo.started).toISOString(),
            infoPath,
            cwd,
        },
        "Server info saved"
    );

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
