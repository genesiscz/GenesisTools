import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { env as appEnv } from "@genesiscz/utils/env";
import { setupTaskIntegrationHome, waitForSessionPid, withTaskSession } from "./task-integration-env";

const taskEnv = setupTaskIntegrationHome();
const TASK_TOOL = resolve(import.meta.dir, "../../../tools");

test("tools task stop marks a running session stopped, never a signal's exit code (143)", async () => {
    const S = `stop-cli-${Date.now()}`;

    await withTaskSession(taskEnv, S, async () => {
        spawnSync(
            "bash",
            [
                "-c",
                `
        export GENESIS_TOOLS_HOME="${taskEnv.homeDir}"
        ${TASK_TOOL} task run --session ${S} --no-tty -- bash -c 'sleep 30' </dev/null >/dev/null 2>&1 &
        disown
    `,
            ],
            { encoding: "utf-8", env: { ...appEnv.getProcessEnv(), GENESIS_TOOLS_HOME: taskEnv.homeDir } }
        );

        await waitForSessionPid(taskEnv, S);

        const stop = taskEnv.task(["stop", "--session", S, "--timeout", "1"]);
        expect(stop.code).toBe(0);
        expect(stop.stderr).toContain("SIGTERM");

        const get = taskEnv.task(["get", "--session", S]);
        const combined = get.stdout + get.stderr;
        expect(combined).toMatch(/stopped/);
        expect(combined).not.toMatch(/exited \(code 143/);
        expect(combined).not.toMatch(/exited \(code 130/);
    });
}, 20_000);

async function waitForPortListening(port: number, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const result = spawnSync("lsof", [`-iTCP:${port}`, "-sTCP:LISTEN", "-n", "-P"], {
            encoding: "utf-8",
            env: process.env,
        });

        if (result.status === 0 && result.stdout.trim().length > 0) {
            return;
        }

        await Bun.sleep(100);
    }

    throw new Error(`nothing is listening on port ${port} within ${timeoutMs}ms`);
}

test("tools task stop --port stops the task session whose process holds that listener", async () => {
    const S = `stop-port-${Date.now()}`;

    await withTaskSession(taskEnv, S, async () => {
        // Pick a free port by binding ephemeral (0) once, then releasing it —
        // the background session below binds that same port for real.
        const probe = Bun.serve({ port: 0, fetch: () => new Response("ok") });
        const port = probe.port;
        probe.stop(true);

        if (port === undefined) {
            throw new Error("Bun.serve did not report an ephemeral port");
        }

        const script = `Bun.serve({port:${port},fetch:()=>new Response("ok")});setInterval(()=>{},1000);`;

        spawnSync(
            "bash",
            [
                "-c",
                `
        export GENESIS_TOOLS_HOME="${taskEnv.homeDir}"
        ${TASK_TOOL} task run --session ${S} --no-tty -- ${process.execPath} -e '${script}' </dev/null >/dev/null 2>&1 &
        disown
    `,
            ],
            { encoding: "utf-8", env: { ...appEnv.getProcessEnv(), GENESIS_TOOLS_HOME: taskEnv.homeDir } }
        );

        await waitForSessionPid(taskEnv, S);
        await waitForPortListening(port);

        const stop = taskEnv.task(["stop", "--port", String(port), "--timeout", "1"]);
        expect(stop.code).toBe(0);
        expect(stop.stderr).toContain(S);

        const get = taskEnv.task(["get", "--session", S]);
        expect(get.stdout + get.stderr).toMatch(/stopped/);
    });
}, 20_000);
