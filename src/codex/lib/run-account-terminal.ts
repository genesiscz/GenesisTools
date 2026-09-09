import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as p from "@clack/prompts";
import { createCodexAdapter } from "@genesiscz/utils/agent-sessions/codex-sessions";
import { resumeCommandLine } from "@genesiscz/utils/agent-sessions/resume-argv";
import { selectResumeSession } from "@genesiscz/utils/agent-sessions/select-resume";
import type { AgentSession } from "@genesiscz/utils/agent-sessions/types";
import { resolveNativeCodexModel } from "@genesiscz/utils/ai/openai/resolve-native-model";
import { registerBuiltInPlugins } from "@genesiscz/utils/ai/providers/plugins";
import { providerPlugin } from "@genesiscz/utils/ai/providers/registry";
import { env } from "@genesiscz/utils/env";
import { out } from "@genesiscz/utils/logger";
import { nativeSessionRootsForHome } from "@genesiscz/utils/providers/session-paths";
import { CodexAccountBinding } from "./account";
import { type AppServerProcess, spawnAppServer } from "./app-server-client";
import { computerUseLaunchOverrides } from "./computer-use";
import { ACCOUNT_ENV_UNSET, buildAccountLaunchOptions, validateTuiArgs } from "./launch-options";
import { buildNativeRunArgs, type CodexRunOptions } from "./run-options";
import { openTerminalServer } from "./terminal-server";
import { createTerminalShutdown } from "./terminal-shutdown";
import { detectCodexVersion } from "./version";

export async function runAccountTerminal(input: {
    selector: string;
    args: string[];
    options: CodexRunOptions;
}): Promise<void> {
    const { selector, args, options } = input;
    validateTuiArgs(args);
    if (process.platform === "win32") {
        throw new Error("Account-bound Codex terminals currently require macOS or Linux Unix sockets");
    }

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error("tools codex run needs an interactive terminal; use tools codex spawn --account for workers");
    }

    const version = await detectCodexVersion();
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

    const account = await CodexAccountBinding.create(selector, { allowRefresh: true });
    const home = resolve(options.home ?? join(homedir(), ".codex"));
    const cwd = resolve(options.cwd ?? process.cwd());
    const model = options.model ? await resolveNativeCodexModel(account.accountId, options.model) : undefined;
    let resumedId: string | undefined;
    let copySession: AgentSession | undefined;
    let unarchiveId: string | undefined;
    registerBuiltInPlugins();
    const native = providerPlugin("openai-sub").codingAgent;
    if (typeof options.resume === "string") {
        const roots = [...new Set([...nativeSessionRootsForHome("codex", home), ...(native?.roots() ?? [])])];
        const targetHome = await realpath(home).catch(() => home);
        const session = await selectResumeSession({
            preferredHome: targetHome,
            adapter: createCodexAdapter(roots),
            query: options.resume,
            filters: { cwd: options.all ? undefined : cwd, all: options.all },
        });
        if (!session) {
            return;
        }
        // A home the user has since deleted is still in the index until the next prune, and an
        // unguarded realpath turned that into a raw ENOENT out of the launcher.
        const sourceHome = session.sourceHome
            ? await realpath(session.sourceHome).catch(() => session.sourceHome)
            : undefined;
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
    process.on("SIGTERM", terminate);
    process.on("SIGINT", interrupt);
    try {
        child = spawnAppServer(launch);
        server = await openTerminalServer({ account, child, signal: initialization.signal });
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
            const imported = await native.importSession(copySession, {
                targetHome: home,
                nativeClient: server.client,
            });
            nativeArgs = buildNativeRunArgs({
                args,
                options: { ...options, model },
                sessionId: imported.sessionId,
            });
            out.log.info(
                `Resuming copied session ${imported.sessionId}; original ${imported.sourceSessionId} retained.`
            );
        }
        tui = Bun.spawn(["codex", "--remote", server.address, ...nativeArgs], {
            cwd,
            env: childEnv,
            stdin: "inherit",
            stdout: "inherit",
            stderr: "inherit",
        });
        process.exitCode = await Promise.race([
            tui.exited,
            child.exited.then(() => {
                throw new Error("Account-bound Codex app-server exited");
            }),
        ]);
    } finally {
        process.off("SIGTERM", terminate);
        process.off("SIGINT", interrupt);
        tui?.kill("SIGTERM");
        if (shutdown) {
            await shutdown.close();
        } else {
            child?.kill("SIGTERM");
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
