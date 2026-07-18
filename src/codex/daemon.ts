#!/usr/bin/env bun

import { appendFileSync, readFileSync } from "node:fs";
import { SafeJSON } from "@app/utils/json";
import { logger } from "@app/utils/logger";
import { AgentsBridge } from "./lib/agents-bridge";
import { AppServerClient, type RpcNotification, spawnAppServer } from "./lib/app-server-client";
import { readControlRequests, respondToControl } from "./lib/control-channel";
import { sessionDaemonLogPath, sessionLaunchPath } from "./lib/paths";
import { CodexSessionRuntime } from "./lib/session";
import type { LaunchConfig } from "./lib/spawn";
import { CodexSessionStore } from "./lib/store";

const log = logger.child({ component: "codex:daemon" });

function parseName(): string {
    const index = Bun.argv.indexOf("--name");
    const name = index >= 0 ? Bun.argv[index + 1] : undefined;
    if (!name) {
        throw new Error("codex daemon requires --name <session>");
    }

    return name;
}

async function run(): Promise<void> {
    const name = parseName();
    const store = new CodexSessionStore();
    const meta = await store.readMeta(name);
    if (!meta) {
        throw new Error(`Codex session metadata not found: ${name}`);
    }

    const launch = SafeJSON.parse(readFileSync(sessionLaunchPath(name), "utf8"), { strict: true }) as LaunchConfig;
    const config = [`sandbox_mode=${meta.sandbox}`];
    if (launch.writableRoots.length > 0) {
        config.push(
            `sandbox_workspace_write.writable_roots=${SafeJSON.stringify(launch.writableRoots, { strict: true })}`
        );
    }

    let runtime: CodexSessionRuntime | null = null;
    let bridge: AgentsBridge | null = null;
    let exiting = false;
    const child = spawnAppServer({
        cwd: meta.cwd,
        home: meta.home,
        config,
        envOverrides: { GT_RENDEZVOUS_SESSION: meta.rendezvousSession },
    });
    await store.updateMeta(name, { appServerPid: child.pid, daemonPid: process.pid });

    const client = new AppServerClient(child, {
        onNotification: async (notification: RpcNotification) => {
            await runtime?.handleNotification(notification);
            void bridge?.publish(notification).catch((err) => {
                log.warn({ err, method: notification.method }, "publishing Codex event to agents bus failed");
            });
        },
        onStderr: (text) => {
            appendFileSync(sessionDaemonLogPath(name), text);
        },
        onServerRequest: async (request) => {
            if (!runtime) {
                throw new Error(`Codex server request arrived before runtime initialization: ${request.method}`);
            }

            return runtime.handleServerRequest(request);
        },
        onExit: async (code) => {
            if (!exiting) {
                exiting = true;
                await store.updateMeta(name, {
                    status: code === 0 ? "closed" : "failed",
                    exitCode: code,
                    activeTurnId: undefined,
                    lastEventAt: new Date().toISOString(),
                });

                try {
                    await bridge?.publishEvent({
                        event: "error",
                        message: `Codex app-server exited with code ${code}`,
                    });
                } catch (err) {
                    log.warn({ err, code }, "publishing app-server exit to agents bus failed");
                }

                await bridge?.close();
            }
        },
    });
    runtime = new CodexSessionRuntime({
        client,
        store,
        meta: (await store.readMeta(name)) ?? meta,
        onApprovalRequest: async (notice) => {
            store.appendEvent(name, { source: "daemon", method: "approval_request", params: notice });
            if (!meta.agentsEnabled) {
                return;
            }

            const deadline = Date.now() + 5_000;
            while (!bridge && Date.now() < deadline) {
                await Bun.sleep(50);
            }

            if (!bridge) {
                throw new Error("Agents bridge was not ready to forward an approval request");
            }

            await bridge.publishEvent(notice);
        },
    });

    const shutdown = async (): Promise<void> => {
        if (exiting) {
            return;
        }

        exiting = true;
        await bridge?.close();
        await runtime?.close();
    };

    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());

    try {
        await runtime.start({ prompt: launch.prompt });

        if (meta.agentsEnabled) {
            bridge = new AgentsBridge({
                agentName: meta.agentName,
                rendezvousSession: meta.rendezvousSession,
                afterSeq: meta.lastAgentSeq,
                onSeq: async (seq) => {
                    await store.updateMeta(name, { lastAgentSeq: seq });
                },
                onControl: async (control) => {
                    try {
                        const result = await runtime?.execute(control);
                        await bridge?.publishEvent({ event: "control_result", op: control.op, result });
                    } catch (err) {
                        const message = err instanceof Error ? err.message : String(err);
                        await bridge?.publishEvent({ event: "error", op: control.op, message });
                    }
                },
            });
            const agentId = await bridge.start();
            await store.updateMeta(name, { agentId });
        }

        let lastControlSeq = 0;

        while (!exiting) {
            const requests = await readControlRequests(name, lastControlSeq);
            for (const request of requests) {
                lastControlSeq = request.seq;
                store.appendEvent(name, { source: "control", method: request.control.op, params: request.control });

                if (request.control.op === "stop") {
                    respondToControl(name, request.id, { ok: true, result: { stopped: true } });
                    await shutdown();
                    break;
                }

                try {
                    const result = await runtime.execute(request.control);
                    respondToControl(name, request.id, { ok: true, result });
                } catch (err) {
                    respondToControl(name, request.id, {
                        ok: false,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
            }

            if (!exiting) {
                await Bun.sleep(50);
            }
        }
    } catch (err) {
        log.error({ err, name }, "codex daemon failed");
        try {
            await shutdown();
        } catch (shutdownError) {
            log.warn({ err: shutdownError, name }, "codex daemon cleanup after failure failed");
        }

        await store.updateMeta(name, {
            status: "failed",
            activeTurnId: undefined,
            lastEventAt: new Date().toISOString(),
        });
        throw err;
    }
}

await run();
