import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { env } from "@genesiscz/utils/env";

// Root via `env.tools.getHome()` (falls back to `homedir()`) so the test
// sandbox's GENESIS_TOOLS_HOME is honoured — a test writing the real port file
// would point every CLI at a port the running launchd server does not own.
export const SERVER_BASE_DIR = join(env.tools.getHome(), ".genesis-tools", "youtube-server");
export const PORT_FILE = join(SERVER_BASE_DIR, "port");

export interface PortFileOptions {
    portFile?: string;
}

export function writePortFile({ port, portFile = PORT_FILE }: { port: number } & PortFileOptions): void {
    const directory = dirname(portFile);

    if (!existsSync(directory)) {
        mkdirSync(directory, { recursive: true });
    }

    writeFileSync(portFile, String(port));
}

export function readPortFile({ portFile = PORT_FILE }: PortFileOptions = {}): number | null {
    if (!existsSync(portFile)) {
        return null;
    }

    const port = parseInt(readFileSync(portFile, "utf-8").trim(), 10);

    if (Number.isNaN(port)) {
        return null;
    }

    return port;
}

export function clearPortFile({ portFile = PORT_FILE }: PortFileOptions = {}): void {
    if (existsSync(portFile)) {
        unlinkSync(portFile);
    }
}
