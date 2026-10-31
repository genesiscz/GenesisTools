import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { moduleDir } from "@genesiscz/utils/fs/module-dir";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { isProcessAlive } from "@genesiscz/utils/process-alive";
import { HostedSupervisor } from "./hosted";

const CHILD_LIBRARY = join(moduleDir(import.meta), "hosted-child.ts");

const started: HostedSupervisor[] = [];

afterEach(() => {
    for (const supervisor of started.splice(0)) {
        supervisor.stop();
    }
});

function handlerSource(version: number): string {
    return `export async function serve(request, peer) {
        return Response.json({ version: ${version}, pid: process.pid, peer, path: new URL(request.url).pathname });
    }\n`;
}

describe("HostedSupervisor", () => {
    test("serves the module in a child, keeps that child while the code is unchanged, and runs edited code on the next call", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-hosted-"));
        const module = join(dir, "handler.ts");
        writeFileSync(module, handlerSource(1));
        const entry = join(dir, "entry.ts");
        writeFileSync(
            entry,
            `import { runHostedChild } from ${SafeJSON.stringify(CHILD_LIBRARY)};\nimport { serve } from "./handler.ts";\nawait runHostedChild(serve);\n`
        );
        const supervisor = new HostedSupervisor(
            "fixture",
            { entry, sourceRoot: dir },
            { socketDir: dir, checkMs: 100 }
        );
        started.push(supervisor);
        const call = async () => {
            const response = await supervisor.forward(
                new Request("http://127.0.0.1:8318/mcp/fixture", { method: "POST", body: "{}" }),
                { clientPort: 50_001, serverPort: 8318 }
            );
            return (await response.json()) as { version: number; pid: number; peer: unknown; path: string };
        };

        const first = await call();
        expect(first).toMatchObject({
            version: 1,
            peer: { clientPort: 50_001, serverPort: 8318 },
            path: "/mcp/fixture",
        });
        expect(first.pid).not.toBe(process.pid);
        const again = await call();
        expect(again.pid).toBe(first.pid);

        writeFileSync(module, handlerSource(2));
        const later = new Date(Date.now() + 2_000);
        utimesSync(module, later, later);
        const deadline = Date.now() + 10_000;
        let next = await call();

        while (next.version !== 2 && Date.now() < deadline) {
            await Bun.sleep(150);
            next = await call();
        }

        expect(next.version).toBe(2);
        expect(next.pid).not.toBe(first.pid);
    }, 20_000);
});

/** What the supervisor answers a call whose child did not get ready. */
interface StartFailureBody {
    jsonrpc: string;
    id: number | string | null;
    error: {
        code: number;
        message: string;
        data: { failure: string; pid: number; code: number | null; signal: string | null };
    };
}

/**
 * A stand-in hosted child: no MCP server and no repo imports, only the ready-line protocol on the socket it is given.
 * It exits when the test process does.
 */
function fixtureChild(dir: string, name: string, body: string): string {
    const entry = join(dir, `${name}.ts`);
    writeFileSync(
        entry,
        `import { existsSync, watch } from "node:fs";
const socket = process.argv[process.argv.indexOf("--socket") + 1];
const parent = process.ppid;
const listen = () => {
    Bun.serve({ unix: socket, fetch: () => Response.json({ pid: process.pid }) });
    process.stdout.write("ready\\n");
};
setInterval(() => {
    if (process.ppid !== parent) {
        process.exit(0);
    }
}, 200);
${body}
`
    );
    return entry;
}

/** The child listens once the file `go` exists in its folder: the test decides when it becomes ready. */
function gatedChild(dir: string): { entry: string; open: () => void } {
    const go = join(dir, "go");
    const entry = fixtureChild(
        dir,
        "gated",
        `let open = false;
const check = () => {
    if (!open && existsSync(${SafeJSON.stringify(go)})) {
        open = true;
        listen();
    }
};
watch(${SafeJSON.stringify(dir)}, check);
setInterval(check, 200);
check();`
    );
    return { entry, open: () => writeFileSync(go, "") };
}

function rpc(id: number): Request {
    return new Request("http://127.0.0.1:8318/mcp/fixture", {
        method: "POST",
        body: SafeJSON.stringify({ jsonrpc: "2.0", id, method: "tools/call" }),
    });
}

async function failureOf(response: Response): Promise<StartFailureBody> {
    expect(response.status).toBe(503);
    return (await response.json()) as StartFailureBody;
}

/** The fields of the logger.warn call with this message, or undefined. */
function loggedFields(spy: { mock: { calls: unknown[][] } }, message: string): Record<string, unknown> | undefined {
    for (const [fields, msg] of spy.mock.calls) {
        if (msg === message && typeof fields === "object" && fields !== null) {
            return { ...fields };
        }
    }

    return undefined;
}

function supervise(entry: string, dir: string, options: { startMs: number; giveUpMs?: number }): HostedSupervisor {
    const supervisor = new HostedSupervisor(
        "fixture",
        { entry, sourceRoot: dir },
        { socketDir: dir, forwardStderr: false, ...options }
    );
    started.push(supervisor);
    return supervisor;
}

describe("HostedSupervisor start failures", () => {
    test("a normal start serves the call", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-hosted-"));
        const supervisor = supervise(fixtureChild(dir, "normal", "listen();"), dir, { startMs: 5_000 });

        const response = await supervisor.forward(rpc(1), null);

        expect(response.status).toBe(200);
        const body = (await response.json()) as { pid: number };
        expect(body.pid).not.toBe(process.pid);
        expect(supervisor.pid).toBe(body.pid);
    });

    test("a child gets the environment as it is now, not as the process started with it", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-hosted-"));
        const entry = fixtureChild(
            dir,
            "env",
            `if (process.env.GT_HOSTED_ENV_PROBE !== "set-at-runtime") {\n    process.exit(7);\n}\nlisten();`
        );
        const supervisor = supervise(entry, dir, { startMs: 5_000 });
        const warn = spyOn(logger, "warn").mockImplementation(() => {});
        env.testing.set("GT_HOSTED_ENV_PROBE", "set-at-runtime");

        try {
            expect((await supervisor.forward(rpc(4), null)).status).toBe(200);
        } finally {
            env.testing.unset("GT_HOSTED_ENV_PROBE");
            warn.mockRestore();
        }
    });

    test("a child not ready by the call's deadline fails the call as still running, and the log line has its pid", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-hosted-"));
        const entry = fixtureChild(dir, "delayed", `process.stderr.write("warming up\\n");\nsetTimeout(listen, 100);`);
        const supervisor = supervise(entry, dir, { startMs: 50 });
        const warn = spyOn(logger, "warn").mockImplementation(() => {});

        try {
            const body = await failureOf(await supervisor.forward(rpc(2), null));

            expect(body.id).toBe(2);
            expect(body.error.data.failure).toBe("timeout");
            expect(body.error.message).toContain("still running");
            expect(body.error.message).toContain(`pid ${body.error.data.pid}`);
            expect(isProcessAlive(body.error.data.pid)).toBe(true);
            const logged = loggedFields(warn, "hosted child not ready by the call's deadline; it keeps starting");
            expect(logged?.pid).toBe(body.error.data.pid);
            expect(typeof logged?.stderr).toBe("string");
        } finally {
            warn.mockRestore();
        }
    });

    test("an early exit fails the call with its code, signal and the stderr tail, bounded to 4 KB", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-hosted-"));
        const entry = fixtureChild(
            dir,
            "crash",
            `await Bun.write(Bun.stderr, "x".repeat(6000) + "boom\\n");\nprocess.exit(3);`
        );
        const supervisor = supervise(entry, dir, { startMs: 5_000 });
        const warn = spyOn(logger, "warn").mockImplementation(() => {});

        try {
            const body = await failureOf(await supervisor.forward(rpc(3), null));

            expect(body.error.data).toMatchObject({ failure: "exited", code: 3, signal: null });
            expect(body.error.message).toContain("code 3");
            expect(body.error.message).toContain("boom");
            const logged = loggedFields(warn, "hosted child failed to start");
            expect(logged?.pid).toBe(body.error.data.pid);
            expect(logged?.code).toBe(3);
            const stderr = String(logged?.stderr);
            expect(stderr.endsWith("boom")).toBe(true);
            expect(Buffer.byteLength(stderr)).toBeLessThanOrEqual(4_096);
            expect(supervisor.pid).toBeUndefined();
        } finally {
            warn.mockRestore();
        }
    });

    test("after a timeout, the next call gets the same child once it is ready", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-hosted-"));
        const gated = gatedChild(dir);
        const supervisor = supervise(gated.entry, dir, { startMs: 250 });
        const warn = spyOn(logger, "warn").mockImplementation(() => {});

        try {
            const first = await failureOf(await supervisor.forward(rpc(4), null));
            expect(first.error.data.failure).toBe("timeout");

            gated.open();
            const response = await supervisor.forward(rpc(5), null);

            expect(response.status).toBe(200);
            expect(((await response.json()) as { pid: number }).pid).toBe(first.error.data.pid);
        } finally {
            warn.mockRestore();
        }
    });

    test("a child still not ready at the give-up ceiling is stopped, and the next call starts a new one", async () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-hosted-"));
        const gated = gatedChild(dir);
        const supervisor = supervise(gated.entry, dir, { startMs: 100, giveUpMs: 250 });
        const warn = spyOn(logger, "warn").mockImplementation(() => {});

        try {
            const failures: StartFailureBody[] = [];

            while (failures.length < 6 && failures.at(-1)?.error.data.failure !== "gave-up") {
                failures.push(await failureOf(await supervisor.forward(rpc(6), null)));
            }

            const gaveUp = failures.at(-1);
            expect(gaveUp?.error.data.failure).toBe("gave-up");
            expect(gaveUp?.error.message).toContain("was stopped");

            gated.open();
            const response = await supervisor.forward(rpc(7), null);

            expect(response.status).toBe(200);
            expect(((await response.json()) as { pid: number }).pid).not.toBe(gaveUp?.error.data.pid);
        } finally {
            warn.mockRestore();
        }
    });
});
