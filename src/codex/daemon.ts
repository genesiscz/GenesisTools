#!/usr/bin/env bun

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { watchFileFeed } from "@genesiscz/utils/fs/file-feed-watcher";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { WorkerDeliveryRejectedError } from "@genesiscz/utils/worker/delivery";
import { CodexAccountBinding } from "./lib/account";
import { AgentsBridge } from "./lib/agents-bridge";
import { AppServerClient, type RpcNotification, spawnAppServer } from "./lib/app-server-client";
import { computerUseOverrides } from "./lib/computer-use";
import { ControlLogCursor, respondToControl } from "./lib/control-channel";
import { buildAccountLaunchOptions } from "./lib/launch-options";
import { sessionControlPath, sessionDaemonLogPath, sessionLaunchPath } from "./lib/paths";
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
    if (launch.computerUse) {
        config.push(...computerUseOverrides({ home: meta.home ?? join(homedir(), ".codex") }));
    }
    if (launch.writableRoots.length > 0) {
        config.push(
            `sandbox_workspace_write.writable_roots=${SafeJSON.stringify(launch.writableRoots, { strict: true })}`
        );
    }

    let runtime: CodexSessionRuntime | null = null;
    let bridge: AgentsBridge | null = null;
    let exiting = false;
    const account = launch.accountId
        ? await CodexAccountBinding.create(launch.accountId, { allowRefresh: true })
        : undefined;
    const accountOptions = account
        ? buildAccountLaunchOptions({ sharedHome: meta.home!, accountName: account.name, cwd: meta.cwd })
        : undefined;
    const child = spawnAppServer({
        ...accountOptions,
        cwd: meta.cwd,
        home: meta.home,
        config: [...(accountOptions?.config ?? []), ...config],
        envOverrides: { ...accountOptions?.envOverrides, GT_RENDEZVOUS_SESSION: meta.rendezvousSession },
    });
    await store.updateMeta(name, { appServerPid: child.pid, daemonPid: process.pid });

    // An unregistered recipient fails every event the same way (37 identical warnings in 22 s on
    // 2026-10-07), so each distinct failure warns once and its repeats stay in the file at debug.
    const reportedPublishFailures = new Set<string>();
    const client = new AppServerClient(child, {
        onNotification: async (notification: RpcNotification) => {
            await runtime?.handleNotification(notification);

            // A native subagent's events are its own, and the lead read them as the worker's turns.
            if (runtime && !runtime.isOwnThreadEvent(notification)) {
                return;
            }

            void bridge?.publish(notification, runtime?.turnCostEnvelope(notification)).catch((err) => {
                const reason = err instanceof Error ? err.message : String(err);
                const fields = { err, method: notification.method };

                if (reportedPublishFailures.has(reason)) {
                    log.debug(fields, "publishing Codex event to agents bus failed again");
                    return;
                }

                reportedPublishFailures.add(reason);
                log.warn(fields, "publishing Codex event to agents bus failed");
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
        account,
        client,
        store,
        meta: (await store.readMeta(name)) ?? meta,
        ...(launch.project ? { project: launch.project } : {}),
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
        await runtime.start({});

        if (meta.agentsEnabled) {
            const joining = new AgentsBridge({
                agentName: meta.agentName,
                rendezvousSession: meta.rendezvousSession,
                afterSeq: meta.lastAgentSeq,
                onSeq: async (seq) => {
                    await store.updateMeta(name, { lastAgentSeq: seq });
                },
                onControl: async (control) => {
                    try {
                        const result = await runtime?.execute(control);
                        await joining.publishEvent({ event: "control_result", op: control.op, result });
                    } catch (err) {
                        const message = err instanceof Error ? err.message : String(err);
                        await joining.publishEvent({ event: "error", op: control.op, message });
                    }
                },
            });
            // Registered with the root thread before the first turn starts, and handed to the notification
            // handler only then: the first turn's events used to race the registration and fail with
            // "sender not registered", and the thread id is what keeps subagents off this identity.
            const agentId = await joining.start((await store.readMeta(name))?.threadId);
            bridge = joining;
            await store.updateMeta(name, { agentId });
        }

        if (launch.prompt) {
            await runtime.startTurn(launch.prompt);
        }

        const generation = meta.generation ?? meta.startedAt;
        const controlCursor = new ControlLogCursor({ name, generation });
        const drainControl = async (): Promise<{ done: boolean }> => {
            const requests = await controlCursor.readAppendedRequests();

            for (const request of requests) {
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
                        ...(err instanceof WorkerDeliveryRejectedError ? { code: "rejected" as const } : {}),
                    });
                }
            }

            return { done: exiting };
        };

        // The daemon lives for hours. Re-reading the control file 20 times a second for all of it
        // bought nothing: a request is a file append, which the watcher sees. The file is created
        // empty first so `fs.watch` has something to attach to from the start; the one-second poll
        // behind it is the safety net for an event the platform drops.
        const controlPath = sessionControlPath(name);
        mkdirSync(dirname(controlPath), { recursive: true });
        appendFileSync(controlPath, "");
        await watchFileFeed({ path: controlPath, onChange: drainControl, pollFallbackMs: 1000 });
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
