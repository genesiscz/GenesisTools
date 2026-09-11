import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as p from "@clack/prompts";
import { resumeCommandLine } from "@genesiscz/utils/agent-sessions/resume-argv";
import type { AgentSession } from "@genesiscz/utils/agent-sessions/types";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { resolveCodexBinary } from "@genesiscz/utils/ai/openai/codex-binary";
import { resolveNativeCodexModel } from "@genesiscz/utils/ai/openai/resolve-native-model";
import { registerBuiltInPlugins } from "@genesiscz/utils/ai/providers/plugins";
import { providerPlugin } from "@genesiscz/utils/ai/providers/registry";
import { withTimeout } from "@genesiscz/utils/async";
import { env } from "@genesiscz/utils/env";
import { logger, out } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { CodexAccountBinding } from "./account";
import { formatActiveWriter, inspectActiveWriter, isActiveWriterError } from "./active-writer";
import { type AppServerProcess, spawnAppServer } from "./app-server-client";
import { computerUseLaunchOverrides } from "./computer-use";
import { assignThreadToProject } from "./desktop-project";
import { ACCOUNT_ENV_UNSET, buildAccountLaunchOptions, validateTuiArgs } from "./launch-options";
import { buildNativeRunArgs, type CodexRunOptions } from "./run-options";
import { CodexHomeBusyError, openTerminalServer } from "./terminal-server";
import { createTerminalShutdown } from "./terminal-shutdown";
import { detectCodexVersion } from "./version";

/**
 * Starts allowed while another app-server is initializing the same home.
 *
 * Three is two waits of 500ms and 1000ms. The winner of the race needs well under a second,
 * so a start that is still refused after that is a real failure and has to surface.
 */
const HOME_BUSY_ATTEMPTS = 3;

/** The shared Codex home a `run` targets: `--home`, else `~/.codex` regardless of an inherited CODEX_HOME. */
export function sharedCodexHome(home: string | undefined): string {
    return resolve(home ?? join(homedir(), ".codex"));
}

/** A recorded home may be gone since the index last saw it; compare it as written then. */
export async function realHome(home: string): Promise<string> {
    return realpath(home).catch((error: unknown) => {
        logger.debug({ error, home }, "the home has no realpath; comparing it as written");
        return home;
    });
}

export async function runAccountTerminal(input: {
    /** Already resolved by the shared picker; bound here by id. */
    account: AccountEntry;
    /** Already resolved by the shared selector when `--resume <query>` was given. */
    session?: AgentSession;
    args: string[];
    options: CodexRunOptions;
}): Promise<void> {
    const { args, options } = input;
    validateTuiArgs(args);
    if (process.platform === "win32") {
        throw new Error("Account-bound Codex terminals currently require macOS or Linux Unix sockets");
    }

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error("tools codex run needs an interactive terminal; use tools codex spawn --account for workers");
    }

    // Startup latency here is user-visible, and the phases hide behind one wait: a version spawn,
    // an account bind that may go to the network, an app-server boot, a handshake, then the TUI.
    const prof = profiler.scope("codex-run");
    const version = await detectCodexVersion();
    prof.mark("version-detected");
    const [major, minor, patch] = version.split(".").map(Number);
    if (
        !Number.isFinite(major) ||
        !Number.isFinite(minor) ||
        !Number.isFinite(patch) ||
        (major === 0 && (minor < 153 || (minor === 153 && patch < 4)))
    ) {
        throw new Error(
            "Account-bound terminals require Codex CLI 0.153.4 or newer with --remote and external token auth"
        );
    }

    const account = await CodexAccountBinding.create(input.account.id, { allowRefresh: true });
    prof.mark("account-bound");
    const home = sharedCodexHome(options.home);
    const cwd = resolve(options.cwd ?? process.cwd());
    const model = options.model ? await resolveNativeCodexModel(account.accountId, options.model) : undefined;
    let resumedId: string | undefined;
    let resumedPath: string | undefined;
    let copySession: AgentSession | undefined;
    let unarchiveId: string | undefined;
    registerBuiltInPlugins();
    const native = providerPlugin("openai-sub").codingAgent;
    const session = input.session;
    if (session) {
        const targetHome = await realHome(home);
        // A home the user has since deleted is still in the index until the next prune, and an
        // unguarded realpath turned that into a raw ENOENT out of the launcher.
        const sourceHome = session.sourceHome ? await realHome(session.sourceHome) : undefined;
        if (sourceHome !== targetHome) {
            if (!native?.importSession) {
                throw new Error("This provider cannot import a session from another native home");
            }
            const choice = await p.select({
                message: `This session is in ${sourceHome ?? session.filePath}. Copy its history into ${targetHome} with a new native session ID? The original stays in place.`,
                options: [
                    { value: "copy", label: "Copy and resume" },
                    { value: "cancel", label: "Cancel" },
                ],
            });
            if (p.isCancel(choice) || choice === "cancel") {
                return;
            }
            copySession = session;
        } else if (session.archived) {
            unarchiveId = session.sessionId;
        }
        resumedId = session.sessionId;
        resumedPath = session.filePath;
        prof.mark("resume-resolved");
    }
    let nativeArgs = buildNativeRunArgs({ args, options: { ...options, model }, sessionId: resumedId });
    await account.tokens();
    out.log.info(`Codex account: ${account.name} (${account.accountId}) · shared home: ${home}`);
    const launch = buildAccountLaunchOptions({ sharedHome: home, accountName: account.name, cwd });
    launch.config = [...(launch.config ?? []), ...computerUseLaunchOverrides({ home, enabled: options.computerUse })];

    const initialization = new AbortController();
    let child: AppServerProcess | undefined;
    let server: Awaited<ReturnType<typeof openTerminalServer>> | undefined;
    let tui: ReturnType<typeof Bun.spawn> | undefined;
    let shutdown: ReturnType<typeof createTerminalShutdown> | undefined;
    const terminate = () => {
        if (shutdown) {
            shutdown.terminate();
        } else {
            initialization.abort(new Error("Codex terminal terminated during initialization"));
        }
    };
    const interrupt = () => {
        if (shutdown) {
            shutdown.interrupt();
        } else {
            initialization.abort(new Error("Codex terminal interrupted during initialization"));
        }
    };
    // `uncaughtExceptionMonitor` observes without swallowing, so the process still ends the way it
    // would have. The rejection handler DOES take ownership, and routes to the same shutdown, so a
    // lost promise ends as a clean close instead of a hang that keeps the thread's writer lock.
    const onCrash = (error: unknown) => logger.error({ error }, "Uncaught exception during the Codex terminal");
    const onRejection = (reason: unknown) => {
        logger.error({ error: reason }, "Unhandled rejection during the Codex terminal");
        terminate();
    };
    process.on("SIGTERM", terminate);
    process.on("SIGINT", interrupt);
    process.on("uncaughtExceptionMonitor", onCrash);
    process.on("unhandledRejection", onRejection);
    try {
        // Process boot, the JSON-RPC initialize and the login handshake, in one number: today a
        // slow start cannot be attributed to any of the three.
        const started = await prof.measureAsync("app-server-ready", async () => {
            for (let attempt = 1; ; attempt++) {
                const appServer = spawnAppServer(launch);

                child = appServer;

                try {
                    const bound = await openTerminalServer({
                        account,
                        child: appServer,
                        signal: initialization.signal,
                    });

                    return { appServer, bound };
                } catch (error) {
                    if (!(error instanceof CodexHomeBusyError) || attempt >= HOME_BUSY_ATTEMPTS) {
                        throw error;
                    }

                    // Another account's terminal is initializing this same home right now, and
                    // it finishes in well under a second. Waiting is the whole fix, and it is
                    // what lets two accounts be launched into one home at the same moment.
                    appServer.kill("SIGKILL");
                    logger.warn(
                        { attempt, home, account: account.name },
                        "Codex home was busy initializing; retrying the app-server start"
                    );
                    await Bun.sleep(attempt * 500);
                }
            }
        });
        const appServer = started.appServer;

        server = started.bound;
        shutdown = createTerminalShutdown(server, () => tui);
        const childEnv: Record<string, string | undefined> = {
            ...env.getProcessEnv(),
            CODEX_HOME: home,
            TOOLS_CODEX_ACCOUNT: account.name,
        };
        for (const key of ACCOUNT_ENV_UNSET) {
            delete childEnv[key];
        }

        if (unarchiveId) {
            await server.client.request("thread/unarchive", { threadId: unarchiveId });
        }
        if (copySession && native?.importSession) {
            const bound = server;
            const importSession = native.importSession;
            const source = copySession;
            const imported = await prof.measureAsync("import-session", () =>
                importSession(source, { targetHome: home, nativeClient: bound.client })
            );
            nativeArgs = buildNativeRunArgs({
                args,
                options: { ...options, model },
                sessionId: imported.sessionId,
            });
            out.log.info(
                `Resuming copied session ${imported.sessionId}; original ${imported.sourceSessionId} retained.`
            );
        }
        prof.mark("tui-spawning");
        tui = Bun.spawn([resolveCodexBinary(), "--remote", server.address, ...nativeArgs], {
            cwd,
            env: childEnv,
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
        });
        process.exitCode = await Promise.race([
            tui.exited,
            appServer.exited.then(() => {
                throw new Error("Account-bound Codex app-server exited");
            }),
        ]);
    } catch (error) {
        logger.error({ error, account: account.name, home, cwd, resumedId }, "Codex terminal failed");
        throw error;
    } finally {
        process.off("SIGTERM", terminate);
        process.off("SIGINT", interrupt);
        process.off("uncaughtExceptionMonitor", onCrash);
        process.off("unhandledRejection", onRejection);
        tui?.kill("SIGTERM");

        // While the app-server is still up. A thread that belongs to no project is filed under
        // `projectless-thread-ids` and never appears in Codex Desktop's sidebar, which is how a
        // `tools codex run` session went missing from the app with its rollout, its row and its
        // name all correct on disk.
        if (server?.threadId) {
            const filing = server.threadId;

            await withTimeout(
                assignThreadToProject(server.client, { threadId: filing, cwd }),
                5000,
                new Error("Codex project assignment")
            ).catch((error: unknown) => {
                logger.warn({ error, threadId: filing, cwd }, "Could not file the thread under a Desktop project");
            });
        }

        if (shutdown) {
            // A shutdown that hangs leaves the app-server alive holding the thread's writer lock,
            // and the next `--resume` of that thread is refused for as long as this process lives.
            await withTimeout(shutdown.close(), 5000, new Error("Codex terminal shutdown")).catch((err) => {
                logger.warn({ err, pid: child?.pid }, "Codex terminal shutdown timed out; killing the app-server");
                child?.kill("SIGKILL");
            });
        } else {
            child?.kill("SIGTERM");
        }
        const refused = server?.failures.find((failure) => isActiveWriterError(failure.error));

        if (refused && resumedId) {
            const report = inspectActiveWriter({ home, threadId: resumedId, rolloutPath: resumedPath });

            for (const line of formatActiveWriter(report, `tools codex run ${account.name}`)) {
                out.println(line);
            }
        }

        if (server?.threadId) {
            out.println(
                `Resume with this account: ${resumeCommandLine("codex", server.threadId, {
                    account: account.name,
                    home,
                    cwd,
                    model,
                })}`
            );
        }
    }
}
