import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import type {
    AgentSession,
    NativeSessionImportContext,
    NativeSessionImportResult,
} from "@genesiscz/utils/agent-sessions/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { NETWORKED_LOCK_WAIT_MS, withFileLock } from "@genesiscz/utils/storage/file-lock";
import { z } from "zod";

const headerSchema = z.object({
    type: z.literal("session_meta"),
    payload: z.object({
        id: z.string().optional(),
        session_id: z.string().optional(),
        history_mode: z.string().optional(),
    }),
});
const threadSchema = z.object({
    thread: z.object({ id: z.string(), path: z.string().nullable(), forkedFromId: z.string().nullable().optional() }),
});
const recordSchema = z.object({
    version: z.literal(1),
    sourceHome: z.string(),
    sourcePath: z.string(),
    sourceId: z.string(),
    hash: z.string(),
    status: z.enum(["pending", "complete"]),
    copiedId: z.string().optional(),
    createdAt: z.string(),
});
type ImportRecord = z.infer<typeof recordSchema>;

function digest(value: string | Buffer): string {
    return createHash("sha256").update(value).digest("hex");
}
async function readRecord(path: string): Promise<ImportRecord | undefined> {
    try {
        return recordSchema.parse(SafeJSON.parse(await readFile(path, "utf8"), { strict: true }));
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return undefined;
        }
        throw error;
    }
}
async function writeRecord(path: string, record: ImportRecord): Promise<void> {
    const staging = `${path}.${randomUUID()}.tmp`;
    await writeFile(staging, SafeJSON.stringify(record, { strict: true }), { mode: 0o600, flag: "wx" });
    try {
        await rename(staging, path);
    } finally {
        await unlink(staging).catch(() => undefined);
    }
}

/** Native fork copies legacy history and registers it; no native SQLite rows are fabricated. */
export async function importNativeCodexSession(
    session: AgentSession,
    context: NativeSessionImportContext
): Promise<NativeSessionImportResult> {
    if (session.kind !== "codex" || !context.nativeClient) {
        throw new Error("Codex import requires a Codex session and its authenticated native client");
    }
    const client = context.nativeClient;
    async function request<T>(method: string, params?: unknown): Promise<T> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            return await Promise.race([
                client!.request<T>(method, params),
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => reject(new Error(`Native import ${method} timed out`)), 180_000);
                }),
            ]);
        } finally {
            clearTimeout(timer);
        }
    }
    const sourcePath = await realpath(session.filePath);
    const bytes = await readFile(sourcePath);
    const lines = bytes.toString("utf8").split("\n");
    for (const line of lines) {
        if (line.trim()) {
            SafeJSON.parse(line, { strict: true });
        }
    }
    const firstLine = lines[0];
    const header = headerSchema.parse(SafeJSON.parse(firstLine, { strict: true })).payload;
    if ((header.id ?? header.session_id) !== session.sessionId) {
        throw new Error("Selected session ID does not match the native source file");
    }
    if (header.history_mode && header.history_mode !== "legacy") {
        throw new Error(
            `Cross-home import of ${header.history_mode} history is not supported by this native fork path; the source remains unchanged`
        );
    }
    const sourceHome = await realpath(session.sourceHome ?? dirname(sourcePath));
    const targetHome = await realpath(context.targetHome);
    const hash = digest(bytes);
    const importsDir = join(targetHome, ".genesis-tools", "session-imports");
    await mkdir(importsDir, { recursive: true, mode: 0o700 });
    const recordPath = join(importsDir, `${digest(`${sourceHome}\0${session.sessionId}`)}.json`);
    const result = (sessionId: string, copied: boolean): NativeSessionImportResult => ({
        sessionId,
        sourceSessionId: session.sessionId,
        targetHome,
        copied,
    });
    async function verifyThread(method: string, id: string) {
        const response = threadSchema.parse(
            await request<unknown>(method, { threadId: id, excludeTurns: true, includeTurns: false })
        );
        const thread = response.thread;
        if (thread.id !== id || thread.forkedFromId !== session.sessionId || !thread.path) {
            throw new Error("Native copied session identity does not match its provenance");
        }
        const path = await realpath(thread.path);
        const location = relative(targetHome, path);
        if (location === ".." || location.startsWith("../") || location.startsWith("/")) {
            throw new Error("Native copied session is outside the selected shared home");
        }
        return thread;
    }
    return withFileLock(
        `${recordPath}.lock`,
        async () => {
            const existing = await readRecord(recordPath);
            if (existing) {
                if (
                    existing.sourceHome !== sourceHome ||
                    existing.sourceId !== session.sessionId ||
                    existing.hash !== hash
                ) {
                    throw new Error(
                        "The source changed after its previous import; refusing to overwrite or duplicate the copied session"
                    );
                }
                if (existing.status !== "complete" || !existing.copiedId) {
                    throw new Error(`An interrupted import needs recovery before retrying: ${recordPath}`);
                }
                await verifyThread("thread/read", existing.copiedId);
                await verifyThread("thread/resume", existing.copiedId);
                return result(existing.copiedId, false);
            }
            const staging = await mkdtemp(join(tmpdir(), "gt-codex-import-"));
            let copiedId: string | undefined;
            let forkRequested = false;
            const record: ImportRecord = {
                version: 1,
                sourceHome,
                sourcePath,
                sourceId: session.sessionId,
                hash,
                status: "pending",
                createdAt: new Date().toISOString(),
            };
            try {
                const stagedPath = join(staging, basename(sourcePath));
                await writeFile(stagedPath, bytes, { mode: 0o600, flag: "wx" });
                if (digest(await readFile(sourcePath)) !== hash) {
                    throw new Error("Source changed while staging its snapshot");
                }
                await writeRecord(recordPath, record);
                forkRequested = true;
                const fork = threadSchema.parse(
                    await request<unknown>("thread/fork", {
                        threadId: session.sessionId,
                        path: stagedPath,
                        cwd: session.cwd,
                        modelProvider: "openai",
                        excludeTurns: true,
                        deferGoalContinuation: true,
                    })
                ).thread;
                // Never delete a pre-existing source ID on rollback, even after an invalid RPC response.
                if (fork.id === session.sessionId || !/^[0-9a-f-]{36}$/i.test(fork.id) || !fork.path) {
                    throw new Error("Native fork did not return a new valid session identity");
                }
                copiedId = fork.id;
                record.copiedId = copiedId;
                await writeRecord(recordPath, record);
                await verifyThread("thread/read", copiedId);
                await verifyThread("thread/resume", copiedId);
                if (digest(await readFile(sourcePath)) !== hash) {
                    throw new Error("Source changed during native import");
                }
                record.status = "complete";
                await writeRecord(recordPath, record);
                return result(copiedId, true);
            } catch (error) {
                if (copiedId) {
                    // The UUID was freshly generated by this fork, before any terminal attached.
                    try {
                        await request("thread/delete", { threadId: copiedId });
                        await unlink(recordPath);
                    } catch {
                        throw new Error(
                            `Import could not be completed or rolled back; recovery record retained: ${recordPath}`,
                            { cause: error }
                        );
                    }
                } else if (!forkRequested) {
                    await unlink(recordPath).catch(() => undefined);
                } else {
                    throw new Error(
                        `Native import failed with an uncertain outcome; recovery record retained: ${recordPath}`,
                        { cause: error }
                    );
                }
                throw error;
            } finally {
                await rm(staging, { recursive: true, force: true });
            }
        },
        NETWORKED_LOCK_WAIT_MS
    );
}
