import { formatSessionState } from "@app/task/lib/format-session-state";
import { sessionFilePaths } from "@app/task/lib/paths";
import { TaskSessionStore } from "@app/task/lib/session-store";
import { filterLineRecords, readJsonlFile } from "@app/utils/log-session/jsonl-reader";

export interface SessionSummary {
    name: string;
    state: string;
    command: string | null;
    cwd: string | null;
    mode: string | null;
    pid: number | null;
    jsonlSizeBytes: number;
    stdoutSizeBytes: number;
    stderrSizeBytes: number;
    firstSeq: number;
    lastSeq: number;
    jsonlPath: string;
}

export async function formatSessionsJson(): Promise<SessionSummary[]> {
    const store = new TaskSessionStore();
    const names = await store.listSessionNames();
    const out: SessionSummary[] = [];

    for (const name of names.sort()) {
        const meta = await store.reconcileSessionState(name);
        const paths = sessionFilePaths(name);
        const records = await readJsonlFile(paths.jsonl);
        const lines = filterLineRecords(records);

        out.push({
            name,
            state: formatSessionState(meta),
            command: meta?.command ?? null,
            cwd: meta?.cwd ?? null,
            mode: meta?.mode ?? null,
            pid: meta?.pid ?? null,
            jsonlSizeBytes: await store.getSessionFileSize(paths.jsonl),
            stdoutSizeBytes: await store.getSessionFileSize(paths.stdout),
            stderrSizeBytes: await store.getSessionFileSize(paths.stderr),
            firstSeq: lines[0]?.seq ?? 0,
            lastSeq: lines.length > 0 ? lines[lines.length - 1].seq : 0,
            jsonlPath: paths.jsonl,
        });
    }

    return out;
}
