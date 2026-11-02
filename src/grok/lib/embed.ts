import { pickLaunchAccount } from "@app/ai/lib/accounts/pick-launch-account";
import { runBinaryDirect } from "@app/ai/lib/embed/direct-run";
import type { EmbedLauncher, EmbedLaunchInput } from "@app/ai/lib/embed/types";
import type { AccountEntry } from "@genesiscz/utils/ai/config/schema";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { env } from "@genesiscz/utils/env";
import { logger, out } from "@genesiscz/utils/logger";
import { grokLaunchAuth } from "./launcher";
import { buildGrokTuiSpawn } from "./tui-resume";
import { redactArgs, resolveGrokBinary } from "./worker";

/**
 * A host's health probe (`grok --version`, `--help`) reads no login, so it runs without an account. T3 Code runs
 * `--version` on every status refresh, and a vault-only account would otherwise write and remove a grant each time.
 */
const ACCOUNTLESS_ARGV = new Set(["--version", "-V", "--help", "-h"]);

export function isAccountlessProbe(argv: readonly string[]): boolean {
    return argv.length === 1 && ACCOUNTLESS_ARGV.has(argv[0] ?? "");
}

export interface GrokEmbedSpawnInput {
    binary: string;
    argv: string[];
    account: string;
    authPath: string;
    home: string;
}

/**
 * The child an embed launch starts: the host's argv byte for byte after the real binary, with the same login
 * environment the interactive launcher builds (`GROK_HOME`, `GROK_AUTH_PATH`, no API key, `TOOLS_GROK_ACCOUNT`).
 */
export function grokEmbedSpawn(input: GrokEmbedSpawnInput): { cmd: string[]; env: Record<string, string | undefined> } {
    const spawn = buildGrokTuiSpawn({
        binary: input.binary,
        passthrough: input.argv,
        account: input.account,
        authPath: input.authPath,
        home: input.home,
    });

    return { cmd: spawn.cmd, env: spawn.env };
}

export interface GrokEmbedDeps {
    resolveBinary(): string;
    /** The enabled grok account `requested` names, or the `auto` pick; null after it has reported why not. */
    pickAccount(requested: string): Promise<AccountEntry | null>;
    launchAuth(account: AccountEntry): Promise<{ authPath: string; home: string; release: () => Promise<unknown> }>;
    /** Runs the child with the host's stdio, forwards SIGTERM, SIGINT and SIGHUP, and resolves with its exit code. */
    runChild(input: { argv: string[]; env: Record<string, string | undefined> }): Promise<number>;
}

const defaultDeps: GrokEmbedDeps = {
    resolveBinary: resolveGrokBinary,
    pickAccount: (requested) =>
        pickLaunchAccount({ alias: "grok", tool: toolCommand("grok embed"), subcommand: ["embed"], requested }),
    launchAuth: grokLaunchAuth,
    // Grok drops the rest of a line on a short write, so it gets a pipe of its own (see runBinaryDirect).
    runChild: (input) => runBinaryDirect({ ...input, relayStdout: true }),
};

/**
 * `tools grok embed [account] -- <argv>`: the grok binary for an app that embeds it (T3 Code runs
 * `grok [--permission-mode <mode>] agent [--always-approve] stdio` and speaks ACP on stdio). The launcher stays the
 * parent for the whole session, because a vault-only account's grant file must be released after the child exits.
 * Nothing goes to stdout but the child's own output: stdout is the ACP channel.
 */
export async function runGrokEmbed(input: EmbedLaunchInput, deps: GrokEmbedDeps = defaultDeps): Promise<void> {
    const { request, argv } = input;

    if (request.kind === "proxy") {
        out.error(
            `${toolCommand("grok embed")} cannot run through the ai-proxy (proxy:${request.target}). Name a grok account or auto.`
        );
        process.exitCode = 2;
        return;
    }

    const binary = deps.resolveBinary();

    if (isAccountlessProbe(argv)) {
        logger.info({ argv }, "[grok embed] health probe; runs without an account");
        process.exitCode = await deps.runChild({ argv: [binary, ...argv], env: env.getProcessEnv() });
        return;
    }

    const account = await deps.pickAccount(request.kind === "account" ? request.name : "auto");

    if (!account) {
        process.exitCode ||= 1;
        return;
    }

    const auth = await deps.launchAuth(account);

    try {
        const spawn = grokEmbedSpawn({
            binary,
            argv,
            account: account.name,
            authPath: auth.authPath,
            home: auth.home,
        });
        logger.info(
            {
                account: account.name,
                home: auth.home,
                bound: Boolean(account.credentials.authFile),
                argv: redactArgs(argv),
            },
            "[grok embed] launching"
        );
        process.exitCode = await deps.runChild({ argv: spawn.cmd, env: spawn.env });
        logger.info({ account: account.name, exitCode: process.exitCode }, "[grok embed] child exited");
    } finally {
        await auth.release();
    }
}

export const grokEmbed: EmbedLauncher = {
    alias: "grok",
    hostProtocol: "acp",
    // runGrokEmbed refuses a `proxy:<account>/<provider>` request.
    servesProxy: false,
    run: (input) => runGrokEmbed(input),
};
