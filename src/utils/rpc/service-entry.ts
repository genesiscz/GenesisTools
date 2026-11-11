import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { classifyPid } from "@genesiscz/utils/process-identity";
import { z } from "zod";

const { log } = logger.scoped("rpc-service-entry");

export function serviceSocketPath(dir: string): string {
    return join(dir, "service.sock");
}

export function servicePidPath(dir: string): string {
    return join(dir, "service.pid");
}

export function serviceEntryPath(dir: string): string {
    return join(dir, "service.json");
}

/** `service.json`: where the running service listens, and what it speaks. */
export const serviceEntrySchema = z.object({
    version: z.literal(1),
    protocol: z.number().int(),
    pid: z.number().int().positive(),
    /** The service's command line when it wrote the entry, so a recycled pid reads as gone. */
    pidCommand: z.string().optional(),
    socket: z.string(),
    startedAt: z.string(),
    /** When the service started, in ms; a loaded module that changed after it makes the service exit. */
    codeStamp: z.number(),
    /** The code the service runs (a hash of its checkout), which a client compares before it connects. */
    code: z.string().optional(),
    /**
     * The checkout the service runs from, as a decoded absolute path with a trailing separator (`/…/GenesisTools/`),
     * as Bun loaded the code (symlinks already resolved: `/tmp/…` reads `/private/tmp/…`). A client that runs no
     * TypeScript (the Meetings window) compares it with the checkout of the `tools` it calls, both resolved, and reads
     * through the command on a mismatch.
     */
    sourceRoot: z.string().optional(),
});
export type ServiceEntry = z.infer<typeof serviceEntrySchema>;

/** The running service named in `<dir>/service.json`, or undefined when there is none or its process is gone. */
export function readLiveServiceEntry(dir: string): ServiceEntry | undefined {
    const path = serviceEntryPath(dir);

    if (!existsSync(path)) {
        return undefined;
    }

    try {
        const entry = serviceEntrySchema.parse(SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }));
        const status = classifyPid(entry.pid, entry.pidCommand).status;
        return status === "live" || status === "unverified" ? entry : undefined;
    } catch (error) {
        log.debug({ error, path }, "service.json does not read; no service");
        return undefined;
    }
}
