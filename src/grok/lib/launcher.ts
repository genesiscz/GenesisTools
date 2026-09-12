import { basename, dirname } from "node:path";
import type { AgentLauncher } from "@app/ai/commands/agent/spec";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { materialiseGrokGrant } from "@genesiscz/utils/ai/grok/grant-file";
import { resolveGrokHome } from "@genesiscz/utils/ai/grok/paths";
import { grokRoot } from "@genesiscz/utils/grok/worker-paths";
import { logger, out } from "@genesiscz/utils/logger";
import { surfacesFromFlags } from "@genesiscz/utils/worker/isolation";
import pc from "picocolors";
import { buildGrokTuiSpawn } from "./tui-resume";
import { printTurn, resolveGrokBinary, runSession } from "./worker";

/**
 * The login a grok account launches with, and the home its new sessions land in.
 *
 * Grok identifies a login by a file, never by a name. An account bound with `--home` or
 * `--auth-file` IS that file, and its home is the directory around it. A vault-only account
 * has no file, so its grant is materialised for the session and released afterwards; its
 * sessions go to the default home, the only tree the history readers walk.
 */
export async function grokLaunchAuth(
    account: AccountEntry
): Promise<{ authPath: string; home: string; release: () => Promise<unknown> }> {
    const bound = account.credentials.authFile;

    if (bound) {
        return {
            authPath: bound,
            home: basename(bound) === "auth.json" ? dirname(bound) : resolveGrokHome(),
            release: async () => undefined,
        };
    }

    const grant = await materialiseGrokGrant(account);

    return { authPath: grant.authPath, home: resolveGrokHome(), release: grant.release };
}

interface LegacyWorkerFlags {
    name?: string;
    cwd?: string;
    prompt?: string;
    promptFile?: string;
    model?: string;
    readonly?: boolean;
    workerHome?: string;
    auth?: string;
    skills?: boolean;
    rules?: boolean;
}

export const grokLauncher: AgentLauncher = {
    extendRun(command) {
        // `tools grok run --name x --cwd y` was the headless worker before `run` meant the TUI on
        // every tool. The flags stay, hidden, and route to the worker with a notice.
        for (const [flags, description] of [
            ["--name <name>", "worker session name (headless worker; use tools grok spawn)"],
            ["--prompt-file <path>", "worker brief file (headless worker)"],
            ["--prompt <text>", "worker inline brief (headless worker)"],
            ["--readonly", "worker review mode (headless worker)"],
            ["--worker-home <path>", "worker GROK_HOME override (headless worker)"],
            ["--auth <mode>", "worker credential: subscription | api-key (headless worker)"],
            ["--skills", "worker loads your personal skills (headless worker)"],
            ["--no-skills", "worker hides your personal skills (headless worker)"],
            ["--rules", "worker loads your personal rules (headless worker)"],
            ["--no-rules", "worker hides your personal rules (headless worker)"],
            ["-l, --list", "with --resume, list the matching sessions instead of launching"],
            ["-n, --limit <n>", "with --list, number of sessions to show"],
        ] as const) {
            command.addOption(command.createOption(flags, description).hideHelp());
        }
    },

    async preflight({ flags }) {
        const legacy = flags as LegacyWorkerFlags;

        if (legacy.name === undefined) {
            return undefined;
        }

        if (!legacy.cwd) {
            throw new Error("Worker mode needs --name and --cwd. To open the TUI, drop --name.");
        }

        if (legacy.auth !== undefined && legacy.auth !== "subscription" && legacy.auth !== "api-key") {
            throw new Error(`--auth must be subscription or api-key, got '${legacy.auth}'.`);
        }

        out.printlnErr(
            pc.dim("`tools grok run --name` is the headless worker; `tools grok run [account]` is the TUI.")
        );
        const result = await runSession({
            name: legacy.name,
            cwd: legacy.cwd,
            ...(legacy.prompt === undefined ? {} : { prompt: legacy.prompt }),
            ...(legacy.promptFile === undefined ? {} : { promptFile: legacy.promptFile }),
            model: legacy.model ?? "grok-4.6",
            readOnly: legacy.readonly === true,
            ...(legacy.workerHome === undefined ? {} : { workerHome: legacy.workerHome }),
            ...(legacy.auth === undefined ? {} : { auth: legacy.auth }),
            surfaces: surfacesFromFlags({ skills: legacy.skills, rules: legacy.rules }),
        });
        printTurn(result);
        return "handled";
    },

    async launch(input) {
        const binary = resolveGrokBinary();
        const auth = await grokLaunchAuth(input.account);

        try {
            // A worker home is isolated on purpose and carries no subscription login of its own;
            // the account's login is handed over through GROK_AUTH_PATH, so say which one bills.
            if (input.session?.sourceHome?.startsWith(grokRoot())) {
                out.log.warn(
                    `This session lives in the managed worker home ${input.session.sourceHome}; it resumes there, billed to ${input.account.name}.`
                );
            }

            const spawn = buildGrokTuiSpawn({
                binary,
                ...(input.session === undefined ? {} : { session: input.session }),
                nativeResume: input.nativeResume,
                continueLast: input.continueLast,
                ...(input.model === undefined ? {} : { model: input.model }),
                passthrough: input.passthrough,
                cwd: input.cwd,
                account: input.account.name,
                authPath: auth.authPath,
                home: auth.home,
            });
            logger.info(
                { account: input.account.name, home: spawn.env.GROK_HOME, cwd: spawn.cwd, argv: spawn.cmd.slice(1) },
                "grok: launching the TUI"
            );
            out.log.info(`Grok account: ${input.account.name} · home: ${spawn.env.GROK_HOME}`);
            const proc = Bun.spawn({ ...spawn, stdio: ["inherit", "inherit", "inherit"] });
            process.exitCode = await proc.exited;
        } finally {
            await auth.release();
        }
    },
};
