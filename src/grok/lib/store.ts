import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";
import { sessionMetaPath, sessionsDir } from "./paths";

const log = logger.child({ component: "grok:store" });

export interface GrokTurnRecord {
    turn: number;
    ended: boolean;
    exitCode: number | null;
    at: string;
}

export interface GrokSessionMeta {
    name: string;
    sessionId: string;
    cwd: string;
    workerHome: string;
    model?: string;
    readOnly: boolean;
    turns: number;
    createdAt: string;
    lastTurn?: GrokTurnRecord;
}

export class GrokSessionStore {
    ensureSessionsDir(): string {
        const path = sessionsDir();
        mkdirSync(path, { recursive: true });
        return path;
    }

    readMeta(name: string): GrokSessionMeta | null {
        const path = sessionMetaPath(name);
        if (!existsSync(path)) {
            return null;
        }

        try {
            return SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }) as GrokSessionMeta;
        } catch (err) {
            log.warn({ err, path, name }, "failed to read grok session metadata");
            return null;
        }
    }

    writeMeta(meta: GrokSessionMeta): void {
        this.ensureSessionsDir();
        atomicWriteFileSync(sessionMetaPath(meta.name), SafeJSON.stringify(meta, null, 2));
    }

    updateMeta(name: string, update: Partial<GrokSessionMeta>): GrokSessionMeta {
        const current = this.readMeta(name);
        if (!current) {
            throw new Error(`Grok session not found: ${name}`);
        }

        const next = { ...current, ...update };
        this.writeMeta(next);
        return next;
    }

    listNames(): string[] {
        const dir = this.ensureSessionsDir();
        return readdirSync(dir)
            .filter((file) => file.endsWith(".meta.json"))
            .map((file) => file.slice(0, -".meta.json".length))
            .sort();
    }
}
