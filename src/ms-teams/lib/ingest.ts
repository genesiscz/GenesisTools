import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { cacheDbPath, dumpIdbScript, venvDir, venvPython } from "./paths";
import { liveIdbMtimeMs, snapshotTeamsIdb } from "./snapshot";
import { TeamsCache } from "./store";
import type { TeamsDump } from "./types";

const log = logger.scoped("ms-teams").log;

/** Pin a reviewed ccl_chromium_reader revision. Bump the SHA deliberately when upgrading. */
const PIP_SPEC = "git+https://github.com/cclgroupltd/ccl_chromium_reader.git@ef840de30221c4d65bc96d2f4d9057e9ef2f526d";

export interface IngestResult {
    conversations: number;
    messages: number;
    people: number;
    dumpCounts: Record<string, number>;
}

export async function ingestIndexedDb(opts: { force?: boolean } = {}): Promise<IngestResult> {
    const path = cacheDbPath();

    if (!opts.force && existsSync(path)) {
        const existing = new TeamsCache(path, { readonly: true });

        try {
            const stored = Number(existing.getMeta("idb_mtime") ?? "0");
            const live = liveIdbMtimeMs();

            if (stored > 0 && live > 0 && live <= stored) {
                const counts = existing.counts();
                log.debug({ stored, live }, "[ms-teams] cache is current; skip snapshot");
                return { ...counts, dumpCounts: {} };
            }
        } finally {
            existing.close();
        }
    }

    await ensureVenv();
    const snap = snapshotTeamsIdb();
    const dumpCounts = await runDump(snap.leveldbDir, snap.blobDir, snap.dumpDir);
    const dump = readDumpDir(snap.dumpDir);
    const cache = new TeamsCache(path);

    try {
        const counts = cache.ingestDump(dump, { force: opts.force });
        cache.setMeta("idb_snapshot", snap.leveldbDir);
        cache.setMeta("idb_mtime", String(liveIdbMtimeMs()));
        return { ...counts, dumpCounts };
    } finally {
        cache.close();
    }
}

export function readDumpDir(dir: string): TeamsDump {
    return {
        conversations: readJsonl(join(dir, "conversations.jsonl")),
        replychains: readJsonl(join(dir, "replychains.jsonl")),
        profiles: readJsonl(join(dir, "profiles.jsonl")),
        calls: readJsonl(join(dir, "calls.jsonl")),
        activity: readJsonl(join(dir, "activity.jsonl")),
    };
}

function readJsonl(path: string): unknown[] {
    if (!existsSync(path)) {
        return [];
    }

    const text = readFileSync(path, "utf8");
    const rows: unknown[] = [];

    for (const line of text.split("\n")) {
        if (!line.trim()) {
            continue;
        }

        try {
            rows.push(SafeJSON.parse(line, { strict: true }));
        } catch (err) {
            log.debug({ err, path }, "[ms-teams] skipped a bad JSONL line");
        }
    }

    return rows;
}

export async function ensureVenv(): Promise<string> {
    const venv = venvDir();
    const py = venvPython();

    if (!existsSync(py)) {
        mkdirSync(venv, { recursive: true });
        const created = await spawnOk(["python3", "-m", "venv", venv]);

        if (!created.ok) {
            throw new Error(`Could not create a Python venv at ${venv}: ${created.stderr}`);
        }
    }

    const check = await spawnOk([py, "-c", "from ccl_chromium_reader.ccl_chromium_indexeddb import WrappedIndexDB"]);

    if (!check.ok) {
        const pip = join(venv, "bin", "pip");
        const installed = await spawnOk([pip, "install", "-q", PIP_SPEC], 180_000);

        if (!installed.ok) {
            throw new Error(
                `Could not install ccl_chromium_reader. Run: ${pip} install ${PIP_SPEC}\n${installed.stderr}`
            );
        }
    }

    return py;
}

async function runDump(idb: string, blob: string, out: string): Promise<Record<string, number>> {
    const py = venvPython();
    const script = dumpIdbScript();
    const result = await spawnOk([py, script, "--idb", idb, "--blob", blob, "--out", out], 300_000);

    if (!result.ok) {
        throw new Error(`IndexedDB dump failed:\n${result.stderr || result.stdout}`);
    }

    try {
        const parsed = SafeJSON.parse(result.stdout.trim().split("\n").at(-1) ?? "{}", { strict: true }) as {
            counts?: Record<string, number>;
        };
        return parsed.counts ?? {};
    } catch (err) {
        log.debug({ err, stdout: result.stdout }, "[ms-teams] dump summary was not JSON");
        return {};
    }
}

async function spawnOk(cmd: string[], timeout = 60_000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
    const timeoutId = setTimeout(() => proc.kill(), timeout);
    const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    clearTimeout(timeoutId);
    return { ok: exitCode === 0, stdout, stderr };
}
