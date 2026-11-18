import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChangeLogRow } from "@genesiscz/utils/agents/change-log";
import { SafeJSON } from "@genesiscz/utils/json";

export const REPO = "/work/acme";

/** Seconds past a fixed instant, as the ISO text transcripts carry. */
export const at = (seconds: number): string => new Date(Date.UTC(2026, 0, 2, 10, 0, 0) + seconds * 1000).toISOString();

export type Line = Record<string, unknown>;

export function prompt(promptId: string, text: string, seconds: number): Line {
    return {
        type: "user",
        promptId,
        uuid: `msg-${promptId}`,
        timestamp: at(seconds),
        cwd: REPO,
        message: { role: "user", content: text },
    };
}

export function use(id: string, name: string, input: Record<string, unknown>, seconds: number): Line {
    return {
        type: "assistant",
        timestamp: at(seconds),
        cwd: REPO,
        message: { role: "assistant", content: [{ type: "tool_use", id, name, input }] },
    };
}

export function result(
    promptId: string,
    id: string,
    seconds: number,
    extra: { toolUseResult?: unknown; isError?: boolean } = {}
): Line {
    return {
        type: "user",
        promptId,
        timestamp: at(seconds),
        cwd: REPO,
        message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: id, is_error: extra.isError === true }],
        },
        toolUseResult: extra.toolUseResult,
    };
}

export function jsonl(lines: Line[]): string {
    return lines.map((line) => SafeJSON.stringify(line, { strict: true })).join("\n");
}

export interface Fixture {
    home: string;
    session: string;
    transcript: string | null;
    log: string;
    rows: ChangeLogRow[];
    turns: number;
}

export function fixture(name: string, turns: number): Fixture {
    const home = mkdtempSync(join(tmpdir(), "changes-window-"));
    const log = join(home, "changes.jsonl");
    writeFileSync(log, "");
    return { home, session: name, transcript: null, log, turns, rows: [] };
}

export function row(f: Fixture, turn: string, file: string, seconds: number, toolUseId?: string): ChangeLogRow {
    return {
        session: f.session,
        provider: "fixture",
        turn,
        path: file,
        cwd: REPO,
        ts: at(seconds),
        source: "bash",
        tool: "Bash",
        toolUseId,
        beforeOid: "a".repeat(40),
        afterOid: "b".repeat(40),
    };
}

export function createFile(turn: string, id: string, file: string, seconds: number, content = id): Line[] {
    return [
        use(id, "Write", { file_path: file, content }, seconds),
        result(turn, id, seconds + 1, { toolUseResult: { type: "create" } }),
    ];
}

export const claudeFixtureNames = ["basic", "subagents", "backups", "heredoc", "rows", "roots", "wrap"] as const;
export type ClaudeFixture = (typeof claudeFixtureNames)[number];

export function claudeFixture(name: ClaudeFixture): Fixture {
    const f = fixture(name, 8);
    const project = join(f.home, "projects", "-work-acme");
    mkdirSync(project, { recursive: true });
    const session = `1000000${claudeFixtureNames.indexOf(name)}-1111-4111-8111-111111111111`;
    f.session = session;
    const main = join(project, `${session}.jsonl`);
    f.transcript = main;
    const turns = Array.from({ length: 8 }, (_, i) => [prompt(`p${i + 1}`, `turn ${i + 1}`, (i + 1) * 10)]);
    const shell = (turn: number, id: string, command: string) => {
        turns[turn - 1].push(use(id, "Bash", { command }, turn * 10 + 1), result(`p${turn}`, id, turn * 10 + 2));
    };
    const capture = (turn: number, file: string, id?: string) => {
        f.rows.push(row(f, `p${turn}`, `${REPO}/${file}`, turn * 10 + 3, id));
    };
    const agent = (id: string, parent: string | null, records: Line[], seconds: number, workflow = false) => {
        const folder = join(project, session, "subagents", workflow ? "workflows/run-a" : "");
        mkdirSync(folder, { recursive: true });
        const path = join(folder, `agent-${id}.jsonl`);
        writeFileSync(path, `${jsonl(records)}\n`);
        utimesSync(path, new Date(at(seconds)), new Date(at(seconds)));
        if (parent) {
            writeFileSync(join(folder, `agent-${id}.meta.json`), SafeJSON.stringify({ toolUseId: parent }));
        }
    };
    switch (name) {
        case "basic": {
            turns[0].push(...createFile("p1", "create", `${REPO}/a`, 11));
            for (const [i, tool] of ["Edit", "MultiEdit", "NotebookEdit"].entries()) {
                const id = `edit-${i}`;
                const edit = { old_string: "old", new_string: "new" };
                const input = { file_path: `${REPO}/${id}`, ...(i === 1 ? { edits: [edit] } : edit) };
                turns[i + 1].push(
                    use(id, tool, input, i * 10 + 21),
                    result(`p${i + 2}`, id, i * 10 + 22, { toolUseResult: { originalFile: "old" } })
                );
            }
            turns[5].push(
                use("failed", "Edit", { file_path: `${REPO}/bad` }, 61),
                result("p6", "failed", 62, { isError: true })
            );
            shell(7, "named", "echo hi > out");
            capture(7, "out", "named");
            capture(7, "bun.lock", "named");
            shell(8, "install", "bun add example");
            capture(8, "node_modules/example", "install");
            capture(8, "bun.lock", "install");
            break;
        }
        case "subagents": {
            turns[0].push(use("bg", "Agent", {}, 11));
            turns[1].push(use("launch", "Agent", {}, 21));
            turns[6].push(use("external", "Write", { file_path: `${REPO}/external`, content: "external" }, 71));
            agent(
                "a",
                "launch",
                [
                    prompt("p2", "", 22),
                    ...createFile("p2", "edit-a", `${REPO}/a`, 23),
                    use("nested", "Agent", {}, 25),
                    prompt("p7", "", 72),
                    ...createFile("p7", "revived", `${REPO}/revived`, 73),
                ],
                74
            );
            agent("b", "bg", [prompt("p1", "", 12), ...createFile("p1", "background", `${REPO}/background`, 61)], 62);
            agent("c", "nested", [prompt("p2", "", 26), ...createFile("p2", "nested-edit", `${REPO}/nested`, 27)], 28);
            agent(
                "d",
                null,
                [prompt("foreign", "", 23), ...createFile("foreign", "phantom", `${REPO}/phantom`, 24)],
                25
            );
            agent(
                "w",
                null,
                [
                    prompt("p7", "", 75),
                    result("p7", "external", 76, { toolUseResult: { type: "create" } }),
                    ...createFile("p7", "workflow", `${REPO}/workflow`, 77),
                ],
                78,
                true
            );
            break;
        }
        case "backups": {
            const backup = (file: string, seconds: number) => ({ backupFileName: file, backupTime: at(seconds) });
            const snapshot = (turn: string, file: string, seconds: number) => ({
                type: "file-history-snapshot",
                messageId: `msg-${turn}`,
                snapshot: { trackedFileBackups: { [`${REPO}/seed`]: backup(file, seconds) } },
            });
            turns[0].push(snapshot("p1", "stale", 60));
            turns[5].push(snapshot("p7", "seed", 55), { type: "metadata" }, { type: "metadata" });
            turns[6].push(
                use("seed", "Edit", { file_path: `${REPO}/seed`, old_string: "old", new_string: "new" }, 71),
                result("p7", "seed", 72),
                {
                    type: "file-history-delta",
                    snapshotMessageId: "msg-p7",
                    trackingPath: `${REPO}/delta`,
                    backup: backup("seed", 55),
                },
                use("delta", "Edit", { file_path: `${REPO}/delta`, old_string: "old", new_string: "new" }, 73)
            );
            turns[7].push(
                snapshot("p8", "stale", 20),
                use("stale", "Edit", { file_path: `${REPO}/seed` }, 81),
                {
                    type: "file-history-delta",
                    snapshotMessageId: "msg-p8",
                    trackingPath: `${REPO}/missing`,
                    backup: backup("absent", 82),
                },
                use("missing", "Edit", { file_path: `${REPO}/missing` }, 83)
            );
            const dir = join(f.home, "file-history", session);
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, "seed"), "old");
            writeFileSync(join(dir, "stale"), "wrong");
            break;
        }
        case "heredoc": {
            shell(1, "generate", "cat > gen.sh <<'OUTER'\ncat > out.txt <<'INNER'\nhi\nINNER\nOUTER");
            turns[2].push(...createFile("p3", "script", `${REPO}/run.sh`, 31, "cat > other.txt <<'END'\nhello\nEND"));
            shell(7, "run-gen", "bash gen.sh");
            shell(7, "run-written", "zsh run.sh");
            // A capture exists throughout this session. Only observed shell targets enter its answer.
            f.rows.push(row(f, "ignored", "/outside/start", 1));
            capture(1, "gen.sh", "generate");
            capture(7, "out.txt", "run-gen");
            capture(7, "other.txt", "run-written");
            break;
        }
        case "rows": {
            shell(2, "named", "echo yes > named");
            capture(2, "named", "named");
            turns[2].push(use("long", "Bash", { command: "echo yes > long" }, 31));
            turns[3].push(result("p3", "long", 42));
            capture(4, "long", "long");
            turns[4].push(use("late", "Write", { file_path: `${REPO}/late`, content: "late" }, 51));
            turns[5].push(result("p6", "late", 62, { toolUseResult: { type: "create" } }));
            shell(7, "near", "cd /work/acme-tools && echo hi > near");
            f.rows.push(row(f, "p7", "/work/acme-tools/near", 73), row(f, "p7", "/elsewhere/no", 73));
            f.rows.push(row(f, "unmatched", `${REPO}/orphan`, 85, "unmatched"));
            break;
        }
        case "wrap": {
            shell(8, "bulk", "bun codemod.ts");
            for (let i = 0; i < 1003; i++) {
                capture(8, `bulk-${String(i).padStart(4, "0")}`, "bulk");
            }
            // The repeated path straddles the old modulo boundary.
            f.rows.push({ ...f.rows[2], beforeOid: "b".repeat(40), afterOid: "c".repeat(40) });
            break;
        }
        case "roots": {
            shell(1, "cd", "cd /work/acme-tools");
            turns[0].push(
                ...createFile("p1", "other", "/work/acme-tools/a", 13).map((line) => ({
                    ...line,
                    cwd: "/work/acme-tools",
                }))
            );
            agent("tree", null, [{ ...prompt("p2", "", 22), cwd: "/work/acme-tools/build/worktree" }], 22);
            turns[7].push(
                { ...use("root", "Bash", { command: "echo hi > /work/acme-tools/build/worktree/src" }, 81), cwd: null },
                result("p8", "root", 82)
            );
            f.rows.push(row(f, "p8", "/work/acme-tools/build/worktree/src", 83, "root"));
            break;
        }
    }

    writeFileSync(main, `${jsonl(turns.flat())}\n`);
    utimesSync(main, new Date(at(90)), new Date(at(90)));
    return f;
}
