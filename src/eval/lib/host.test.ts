import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvalIo } from "@genesiscz/utils/eval-engine";
import { loadRun, openRun } from "@genesiscz/utils/eval-engine/store";
import { fakeClock } from "@genesiscz/utils/eval-engine/testing";
import { SafeJSON } from "@genesiscz/utils/json";
import { z } from "zod";
import { project } from "../projects/mini-agent";
import { createEvalHost, loadEvalProject } from "./host";

const dirs: string[] = [];
afterAll(async () => {
    for (const dir of dirs) {
        await rm(dir, { recursive: true, force: true });
    }
});

async function fixture() {
    const dir = await mkdtemp(join(tmpdir(), "eval-host-"));
    dirs.push(dir);
    const module = join(dir, "project.ts");
    const source = new URL("../projects/mini-agent.ts", import.meta.url).href;
    await writeFile(
        module,
        `import { project as base } from ${SafeJSON.stringify(source)};\nexport const project = { ...base, runsDir: ${SafeJSON.stringify(join(dir, "runs"))} };\n`
    );
    return { dir, module, runsDir: join(dir, "runs") };
}

class Exit extends Error {}

async function cli(args: string[], stdin = "") {
    let stdout = "";
    let stderr = "";
    let exitCode = -1;
    const io: EvalIo = {
        stdout: (text) => {
            stdout += text;
        },
        stderr: (text) => {
            stderr += text;
        },
        readStdin: async () => stdin,
        setExitCode: (code) => {
            exitCode = code;
        },
        exit: (code) => {
            exitCode = code;
            throw new Exit();
        },
        clock: fakeClock({ auto: true }),
        signal: new AbortController().signal,
    };
    try {
        await createEvalHost(io).parseAsync(args, { from: "user" });
    } catch (error) {
        if (!(error instanceof Exit)) {
            throw error;
        }
    }

    const parsed: unknown = SafeJSON.parse(stdout, { strict: true });
    return { stdout, stderr, exitCode, json: z.record(z.string(), z.unknown()).parse(parsed) };
}

async function snapshot(dir: string): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const file = join(dir, entry.name);
        if (entry.isDirectory()) {
            Object.assign(result, await snapshot(file));
        } else {
            result[file] = await readFile(file, "utf8");
        }
    }

    return result;
}

describe("trusted eval project host", () => {
    test("loads only an explicit local project and refuses malformed exports and URLs", async () => {
        const { module, dir } = await fixture();
        const invalid = join(dir, "invalid.ts");
        await writeFile(invalid, "export const project = { system: {} };\n");
        const loaded = await loadEvalProject(module);
        expect(loaded.system.name).toBe("mini-agent-offline");
        await expect(loadEvalProject("https://example.com/project.ts")).rejects.toThrow("local file");
        await expect(loadEvalProject(invalid)).rejects.toThrow("named project");
        expect((await cli(["run"])).exitCode).toBe(2);
        expect((await cli(["--project", module, "run", "--repeats", "zero"])).exitCode).toBe(2);
    });

    test("check and list stay offline without creating a run folder", async () => {
        const { dir, module } = await fixture();
        const connect = project.system.connect;
        project.system.connect = () => {
            throw new Error("offline command connected");
        };
        try {
            expect((await cli(["--project", module, "check", "--print"])).json.schema).toBe("eval-check/1");
            expect((await cli(["--project", module, "list"])).json.schema).toBe("eval-list/1");
            expect(await readdir(dir)).toEqual(["project.ts"]);
        } finally {
            project.system.connect = connect;
        }
    });

    test("creates, reopens, resumes, shows and compares immutable records with ordered evidence", async () => {
        const { module, runsDir } = await fixture();
        const capped = await cli(["--project", module, "run", "--matrix", "offline", "--max-cost-usd", "0.005"]);
        expect(capped.exitCode).toBe(4);
        const run = z.string().parse(capped.json.run);
        const initial = await loadRun(run, runsDir);
        expect(initial.records).toHaveLength(1);
        expect(initial.missing).toHaveLength(2);
        const manifestPath = join(initial.dir, "manifest.json");
        const manifestBytes = await readFile(manifestPath, "utf8");
        const firstFile = initial.recordFiles[initial.records[0].key];
        const firstBytes = await readFile(firstFile, "utf8");
        expect(initial.records[0].turns.flatMap((turn) => turn.toolCalls.map((call) => call.name))).toEqual([
            "lookup_task",
            "complete_task",
        ]);
        expect(initial.records[0].turns[1].signals).toMatchObject({
            completed: true,
            orderedCalls: ["lookup_task", "complete_task"],
        });

        const resumed = await cli(["--project", module, "run", "--resume", run, "--max-cost-usd", "1"]);
        expect(resumed.exitCode).toBe(0);
        const reopened = await loadRun(run, runsDir);
        expect(reopened.records).toHaveLength(3);
        expect(reopened.missing).toHaveLength(0);
        expect(await readFile(manifestPath, "utf8")).toBe(manifestBytes);
        expect(await readFile(firstFile, "utf8")).toBe(firstBytes);
        const store = await openRun(run, runsDir);
        expect(await store.writeFinal({ ...reopened.records[0], outcome: "failed" })).toBe("exists");
        expect(await readFile(firstFile, "utf8")).toBe(firstBytes);

        await writeFile(join(initial.dir, "summary.json"), "not trusted summary data");
        const beforeReads = await snapshot(runsDir);
        const shown = await cli(["--project", module, "show", run]);
        expect(shown.json.verdict).toBe("passed");
        const compared = await cli(["--project", module, "compare", run, run]);
        expect(compared.json.verdict).toBe("same");
        expect(compared.exitCode).toBe(0);
        expect((await cli(["--project", module, "runs"])).json.schema).toBe("eval-runs/1");
        expect(await snapshot(runsDir)).toEqual(beforeReads);
    });

    test("preserves strict scenario JSON and strict persisted manifest parsing", async () => {
        const { module, runsDir } = await fixture();
        const bad = await cli(["--project", module, "check", "--stdin"], '{"id":"bad","steps":[{"user":"hi"}],}');
        expect(bad.exitCode).toBe(2);
        const good = await cli(["--project", module, "run", "confirm-task", "--model", "offline"]);
        expect(good.exitCode).toBe(0);
        const run = z.string().parse(good.json.run);
        const view = await loadRun(run, runsDir);
        const manifest = join(view.dir, "manifest.json");
        const bytes = await readFile(manifest, "utf8");
        await writeFile(manifest, `// comment\n${bytes}`);
        await expect(loadRun(run, runsDir)).rejects.toThrow();
    });

    test("the portable standalone command survives duplicated forwarded interrupts", async () => {
        const { dir, module } = await fixture();
        const runner = join(dir, "interrupt.ts");
        const engine = new URL("../../utils/eval-engine/index.ts", import.meta.url).href;
        await writeFile(
            runner,
            `
import { createEvalCommand } from ${SafeJSON.stringify(engine)};
import { project as base } from ${SafeJSON.stringify(module)};
const connection = base.system.connect(undefined);
let sent = false;
const project = { ...base, system: { ...base.system, connect: () => ({ ...connection,
    send: async (handle, text, context) => {
        if (!sent) {
            sent = true;
            setTimeout(() => process.kill(process.pid, "SIGINT"), 10);
            setTimeout(() => process.kill(process.pid, "SIGINT"), 20);
            await new Promise((done) => setTimeout(done, 50));
        }
        return connection.send(handle, text, context);
    }
}) } };
await createEvalCommand(project).parseAsync(["run", "--matrix", "offline"], { from: "user" });
`
        );
        const child = Bun.spawn([process.execPath, runner], {
            env: process.env,
            stdout: "pipe",
            stderr: "pipe",
            signal: AbortSignal.timeout(5000),
        });
        const [stdout, stderr, code] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
        ]);
        expect(code, stderr).toBe(4);
        const result: unknown = SafeJSON.parse(stdout, { strict: true });
        expect(result).toMatchObject({ schema: "eval-run/1", stopped: { reason: "aborted" } });
    });

    test("the bundled project is an explicit importable module", async () => {
        const selected = await loadEvalProject(fileURLToPath(new URL("../projects/mini-agent.ts", import.meta.url)));
        expect(selected.system.name).toBe("mini-agent-offline");
    });
});
