#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getConfig, saveConfig } from "@app/dev-dashboard/config";
import { createBasicAuthCredentials } from "@app/dev-dashboard/lib/auth";
import { startFrontProxy } from "@app/dev-dashboard/lib/front-proxy";
import { findFreePort } from "@app/dev-dashboard/lib/ttyd/free-port";
import logger from "@app/logger";
import { PROJECT_ROOT } from "@app/utils/paths";
import { stripAnsi } from "@app/utils/string";
import { Command } from "commander";

const program = new Command()
    .name("dev-dashboard")
    .description("Personal dev dashboard (ttyd, cmux, obsidian) at mac.foltyn.dev")
    .version("0.1.0");

async function runUiServer(): Promise<void> {
    const uiDir = resolve(import.meta.dirname, "ui");
    const configPath = resolve(uiDir, "vite.config.ts");
    const viteEntry = resolve(PROJECT_ROOT, "node_modules", "vite", "bin", "vite.js");

    if (!existsSync(configPath)) {
        console.error(`Could not find dev-dashboard Vite config at ${configPath}`);
        process.exit(1);
    }

    if (!existsSync(viteEntry)) {
        console.error(`Could not find Vite at ${viteEntry}`);
        console.error(`Run "bun install" in ${PROJECT_ROOT} first.`);
        process.exit(1);
    }

    const { port } = await getConfig();
    const url = `http://localhost:${port}`;
    // Vite runs on a private loopback port; a Bun.serve front proxy owns the
    // public port so WebSockets (ttyd + Vite HMR) work — Bun's node:http
    // upgrade socket is broken (oven-sh/bun#28396).
    const internalPort = await findFreePort();

    console.log(`Starting dev-dashboard at ${url} ...`);
    console.log("(first start can take a few seconds; output below comes from Vite)\n");

    const child = spawn(
        "bun",
        [
            "--bun",
            viteEntry,
            "dev",
            "--config",
            configPath,
            "--strictPort",
            "--port",
            String(internalPort),
            "--host",
            "127.0.0.1",
        ],
        {
            cwd: PROJECT_ROOT,
            stdio: "inherit",
            env: {
                ...process.env,
                FORCE_COLOR: "1",
                GENESIS_TOOLS_ROOT: PROJECT_ROOT,
                DEV_DASHBOARD_PUBLIC_PORT: String(port),
            },
            shell: process.platform === "win32",
        }
    );

    // Teardown hooks below are registered after this line; if startFrontProxy
    // throws, the already-spawned Vite child would be orphaned. Kill it here.
    let frontProxy: ReturnType<typeof startFrontProxy>;

    try {
        frontProxy = startFrontProxy({ publicPort: port, internalPort });
    } catch (err) {
        try {
            child.kill("SIGTERM");
        } catch (killErr) {
            logger.debug({ err: killErr }, "failed terminating Vite after front-proxy startup failure");
        }

        throw err;
    }
    const stopFrontProxy = () => {
        try {
            frontProxy.stop(true);
        } catch (err) {
            logger.debug({ err }, "front proxy stop failed (already stopped?)");
        }
    };

    child.on("error", (err) => {
        logger.error({ err }, "failed to start Vite");
        stopFrontProxy();
        process.exit(1);
    });

    const killChild = () => {
        try {
            child.kill("SIGTERM");
        } catch (err) {
            logger.debug({ err }, "Vite child kill failed (already gone?)");
        }
    };

    const shutdown = (signal: NodeJS.Signals) => {
        stopFrontProxy();
        killChild();
        process.exit(signal === "SIGTERM" || signal === "SIGINT" ? 0 : 1);
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGHUP", () => shutdown("SIGHUP"));
    process.on("exit", () => {
        killChild();
    });

    setTimeout(() => {
        // Best-effort browser open. Detached spawns have no "error" listener by
        // default; an unhandled "error" (opener binary missing) would crash the
        // dashboard ~2s post-startup, so swallow it.
        const [cmd, args] =
            process.platform === "darwin"
                ? (["open", [url]] as const)
                : process.platform === "win32"
                  ? (["cmd", ["/c", "start", "", url]] as const)
                  : (["xdg-open", [url]] as const);
        const opener = spawn(cmd, args, { stdio: "ignore", detached: true });
        opener.on("error", (err) => logger.debug({ err, cmd }, "failed to auto-open browser"));
        opener.unref();
    }, 2000);

    const exitCode: number = await new Promise((resolveExit) => {
        child.on("exit", (code) => resolveExit(code ?? 1));
    });

    if (exitCode !== 0) {
        console.error(`\nVite exited with code ${exitCode}`);
    }

    process.exit(exitCode);
}

async function pidsListeningOn(port: number): Promise<number[]> {
    const proc = Bun.spawn(["lsof", "-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
        stdout: "pipe",
        stderr: "ignore",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;

    return out
        .split("\n")
        .map((line) => Number.parseInt(line.trim(), 10))
        .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

async function pidsMatching(pattern: string): Promise<number[]> {
    const proc = Bun.spawn(["pgrep", "-f", pattern], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;

    return out
        .split("\n")
        .map((line) => Number.parseInt(line.trim(), 10))
        .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

function signalPids(pids: number[], signal: NodeJS.Signals): void {
    for (const pid of pids) {
        try {
            process.kill(pid, signal);
        } catch (err) {
            logger.debug({ err, pid, signal }, "dev-dashboard restart: kill failed (process already gone?)");
        }
    }
}

async function waitForPortFree(port: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if ((await pidsListeningOn(port)).length === 0) {
            return true;
        }

        await Bun.sleep(200);
    }

    return (await pidsListeningOn(port)).length === 0;
}

async function stopRunningDashboard(port: number): Promise<void> {
    const pids = await pidsListeningOn(port);

    if (pids.length === 0) {
        console.log(`No dev-dashboard listening on :${port}.`);
        return;
    }

    console.log(`Stopping dev-dashboard (pid ${pids.join(", ")}) on :${port} ...`);
    // SIGTERM lets index.ts's handler stop the front-proxy and reap its Vite
    // child gracefully; SIGKILL is the fallback if the port is still held.
    signalPids(pids, "SIGTERM");

    if (!(await waitForPortFree(port, 6000))) {
        const stuck = await pidsListeningOn(port);
        console.log(`Port :${port} still held by ${stuck.join(", ")}; sending SIGKILL.`);
        signalPids(stuck, "SIGKILL");

        if (!(await waitForPortFree(port, 4000))) {
            // Abort here — proceeding would only fail later as an opaque
            // EADDRINUSE inside runUiServer().
            throw new Error(`Port :${port} is still in use after SIGTERM+SIGKILL; aborting restart.`);
        }

        // Only reachable on the force-kill path. A SIGKILLed parent can't reap
        // its Vite child (the graceful SIGTERM path's shutdown handler does),
        // so sweep the orphan here only — scoping it to this branch keeps a
        // dev-dashboard running from another worktree/checkout untouched.
        const orphanVite = await pidsMatching("src/dev-dashboard/ui/vite.config.ts");

        if (orphanVite.length > 0) {
            signalPids(orphanVite, "SIGTERM");
        }
    }
}

program.action(runUiServer);

program.command("ui").alias("dashboard").description("Launch the dev-dashboard web UI").action(runUiServer);

program
    .command("restart")
    .description("Stop any running dev-dashboard, relaunch it detached in the background, then exit")
    .action(async () => {
        const { port } = await getConfig();
        await stopRunningDashboard(port);

        const url = `http://localhost:${port}`;
        // Daemonize: the UI is Vite + an in-process front-proxy, so we can't
        // just background Vite — we re-spawn the whole `dev-dashboard ui`
        // command detached, echo its output until it's ready, then exit and
        // leave it running (unlike `ui`, which stays foreground).
        const child = spawn("tools", ["dev-dashboard", "ui"], {
            cwd: PROJECT_ROOT,
            detached: true,
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, FORCE_COLOR: "1" },
            shell: process.platform === "win32",
        });

        // Match against ANSI-stripped, ACCUMULATED output: with FORCE_COLOR the
        // banner is colored (`Local\x1b[22m:`) and arrives split across stdout
        // chunks, so a per-raw-chunk test never matched and we always hit the
        // 30s fallback. Accumulate + strip first.
        const READY = /ready in \d+\s*m?s|Local:\s*http|localhost:\d+|press h \+ enter/i;
        let acc = "";
        let settled = false;

        const finish = (note: string): void => {
            if (settled) {
                return;
            }

            settled = true;
            console.log(`\n${note}`);
            console.log(`dev-dashboard running in background → ${url}  (pid ${child.pid})`);
            console.log(`stop it with: tools dev-dashboard restart   (or kill ${child.pid})`);
            child.stdout?.removeAllListeners();
            child.stderr?.removeAllListeners();
            child.unref();
            process.exit(0);
        };

        const onChunk = (buf: Buffer): void => {
            const text = buf.toString();
            process.stdout.write(text);
            acc += stripAnsi(text);
            if (READY.test(acc)) {
                finish("✓ dev-dashboard is up.");
            }
        };

        child.stdout?.on("data", onChunk);
        child.stderr?.on("data", onChunk);
        child.on("error", (err) => {
            console.error(`Failed to launch dev-dashboard: ${err.message}`);
            process.exit(1);
        });
        child.on("exit", (code) => {
            if (!settled) {
                console.error(`dev-dashboard exited before becoming ready (code ${code ?? "?"})`);
                process.exit(code ?? 1);
            }
        });

        // Safety net: if the ready marker never matches, still detach and exit
        // rather than holding the terminal forever.
        setTimeout(() => finish("⚠ ready marker not seen in 30s — detaching anyway; check the URL."), 30_000);
    });

const auth = program.command("auth").description("Manage dev-dashboard Basic Auth");

auth.command("reset")
    .description("Reset the Basic Auth username/password")
    .option("--username <username>", "Basic Auth username", "martin")
    .option("--password <password>", "Basic Auth password; generated when omitted")
    .action(async (options: { username: string; password?: string }) => {
        const config = await getConfig();
        const { auth: nextAuth, password } = createBasicAuthCredentials({
            username: options.username,
            password: options.password,
        });
        await saveConfig({ ...config, auth: nextAuth });

        console.log("dev-dashboard Basic Auth updated");
        console.log(`username: ${nextAuth.username}`);
        console.log(`password: ${password}`);
    });

program.parseAsync().catch((err) => {
    logger.error({ err }, "dev-dashboard failed");
    process.exit(1);
});
