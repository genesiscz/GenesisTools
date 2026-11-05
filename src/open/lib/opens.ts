import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { STAMP_FACETS, whoIsCallingHere } from "@genesiscz/utils/agent/caller-identity";
import type { AgentRuntimeContext } from "@genesiscz/utils/agent/context";
import { toRuntimeContext } from "@genesiscz/utils/agent/identity";
import { readLastLines } from "@genesiscz/utils/fs/read-lines";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { toolDataDir } from "@genesiscz/utils/storage/root";

const { log } = logger.scoped("open");

export type OpenTargetKind = "file" | "folder" | "url" | "missing";

export interface OpenTarget {
    /** What the caller passed. */
    given: string;
    /** The absolute path of a file or folder; absent for a URL. */
    path?: string;
    kind: OpenTargetKind;
}

export interface OpenRequest {
    targets: string[];
    /** `open -a <app>`. */
    app?: string;
    /** `open -b <bundle id>`. */
    bundleId?: string;
    /** `open -R`: reveal in Finder. */
    reveal?: boolean;
    /** `open -g`: do not bring the app to the front. */
    background?: boolean;
    /** Why the caller opens it, kept in the log. */
    why?: string;
}

/** One line of the open log: what was opened, how, the result, and who asked (the same stamp the answer log keeps). */
export interface OpenRecord {
    at: string;
    targets: OpenTarget[];
    app?: string;
    bundleId?: string;
    reveal?: boolean;
    background?: boolean;
    why?: string;
    argv: string[];
    exitCode: number;
    stderr?: string;
    caller: AgentRuntimeContext;
}

export function openLogPath(): string {
    return toolDataDir("open", "opens.jsonl");
}

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export function classifyTarget(given: string, cwd: string): OpenTarget {
    if (URL_SCHEME.test(given) && !given.startsWith("/")) {
        return { given, kind: "url" };
    }

    const path = resolve(cwd, given.replace(/^~(?=\/|$)/, homedir()));

    if (!existsSync(path)) {
        return { given, path, kind: "missing" };
    }

    return { given, path, kind: statSync(path).isDirectory() ? "folder" : "file" };
}

/** The `/usr/bin/open` argv for a request, with each file target as its absolute path. */
export function openArgv(request: OpenRequest, targets: OpenTarget[]): string[] {
    return [
        "open",
        ...(request.app ? ["-a", request.app] : []),
        ...(request.bundleId ? ["-b", request.bundleId] : []),
        ...(request.reveal ? ["-R"] : []),
        ...(request.background ? ["-g"] : []),
        ...targets.map((target) => target.path ?? target.given),
    ];
}

/** Opens the targets the way `open` does and appends one record with the caller's agent context to the open log. */
export async function openAndLog(request: OpenRequest): Promise<OpenRecord> {
    const caller = toRuntimeContext(whoIsCallingHere({ facets: STAMP_FACETS }));
    const targets = request.targets.map((given) => classifyTarget(given, process.cwd()));
    const argv = openArgv(request, targets);
    const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "pipe" });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    const record: OpenRecord = {
        at: new Date().toISOString(),
        targets,
        ...(request.app ? { app: request.app } : {}),
        ...(request.bundleId ? { bundleId: request.bundleId } : {}),
        ...(request.reveal ? { reveal: true } : {}),
        ...(request.background ? { background: true } : {}),
        ...(request.why ? { why: request.why } : {}),
        argv,
        exitCode,
        ...(stderr.trim() ? { stderr: stderr.trim() } : {}),
        caller,
    };
    appendOpenRecord(record);
    log.debug({ argv, exitCode, agent: caller.agent, sessionId: caller.sessionId }, "opened");
    return record;
}

export function appendOpenRecord(record: OpenRecord, path = openLogPath()): void {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${SafeJSON.stringify(record)}\n`);
}

/** The newest records first, read from the end of the log. */
export function readOpenRecords(
    { limit = 20, sessionId }: { limit?: number; sessionId?: string } = {},
    path = openLogPath()
): OpenRecord[] {
    if (!existsSync(path)) {
        return [];
    }

    const records: OpenRecord[] = [];

    for (const line of readLastLines(path, { maxBytes: 4 * 1024 * 1024 }).lines.reverse()) {
        try {
            const record = SafeJSON.parse(line, { strict: true }) as OpenRecord;

            if (!sessionId || record.caller.sessionId?.startsWith(sessionId)) {
                records.push(record);
            }
        } catch (err) {
            log.warn({ err, path }, "an open log line did not parse");
        }

        if (records.length >= limit) {
            break;
        }
    }

    return records;
}
