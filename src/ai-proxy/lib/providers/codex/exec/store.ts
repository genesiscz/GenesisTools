import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExecStore } from "@app/ai-proxy/lib/providers/codex/exec/types";
import { getAiProxyStorage } from "@app/ai-proxy/lib/storage";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isObject } from "@genesiscz/utils/object";

/** The file that holds `store`d values of one Claude Code session, in the proxy's state folder. */
export function execStorePath(sessionId: string | undefined): string {
    const name = (sessionId ?? "").replace(/[^A-Za-z0-9_-]/g, "") || "no-session";
    return join(getAiProxyStorage().getBaseDir(), "exec-store", `${name}.json`);
}

function readValues(path: string): Record<string, unknown> {
    try {
        const parsed = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true });
        return isObject(parsed) ? parsed : {};
    } catch (err) {
        if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) {
            logger.warn({ err, path }, "ai-proxy exec: the store file could not be read; it starts empty");
        }

        return {};
    }
}

/**
 * A store in one JSON file. Each `store` re-reads the file and replaces it whole (write, then rename), so two `exec`
 * calls of one session that run at the same time lose at most each other's last write, never the file.
 */
export function fileExecStore(path: string): ExecStore {
    return {
        load: (key) => readValues(path)[key],
        store: (key, value) => {
            const values = { ...readValues(path), [key]: value };
            const temp = `${path}.${process.pid}.tmp`;
            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(temp, SafeJSON.stringify(values, null, 2));
            renameSync(temp, path);
        },
    };
}

/** A store that lives for one script only. */
export function memoryExecStore(): ExecStore {
    const values = new Map<string, unknown>();

    return {
        load: (key) => values.get(key),
        store: (key, value) => {
            values.set(key, value);
        },
    };
}
