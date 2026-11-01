import { pickLaunchAccount } from "@app/ai/lib/accounts/pick-launch-account";
import type { EmbedLauncher } from "@app/ai/lib/embed/types";
import { accountEnvVar } from "@genesiscz/utils/ai/account-env";
import { resolveCodexBinary } from "@genesiscz/utils/ai/openai/codex-binary";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { env } from "@genesiscz/utils/env";
import { logger, out } from "@genesiscz/utils/logger";
import { nativeHome } from "@genesiscz/utils/providers/session-paths";
import { CodexAccountBinding } from "./account";
import { CodexEmbedProxy, LineSplitter } from "./embed-proxy";
import { buildAccountLaunchOptions } from "./launch-options";

/** `app-server` options that take a value, so the value is never read as a subcommand. */
const APP_SERVER_VALUE_OPTIONS = new Set([
    "-c",
    "--config",
    "--enable",
    "--disable",
    "--startup-client-info",
    "--cloud-skills-snapshot",
    "--code-mode-host",
    "--listen",
    "--ws-auth",
    "--ws-token-file",
    "--ws-token-sha256",
    "--ws-shared-secret-file",
    "--ws-issuer",
    "--ws-audience",
    "--ws-max-clock-skew-seconds",
]);

/** `app-server` subcommands that print and exit; they need no account. */
const APP_SERVER_PRINT_COMMANDS = new Set(["help", "generate-ts", "generate-json-schema"]);

/** Config keys that decide where the login comes from. The embed launch sets them; the host may not. */
const AUTH_CONFIG_KEYS = new Set([
    "cli_auth_credentials_store",
    "forced_login_method",
    "model_provider",
    "profile",
    "chatgpt_base_url",
    "openai_base_url",
]);

/**
 * What an embed argv asks for. `serve` is an app-server on stdio, which runs as the account. `native` is anything
 * else the host runs to inspect the binary (`--version`, `app-server --help`, `codex exec`); it goes to the real
 * binary unchanged and bills whatever the home's own login is, so it is not stamped with an account.
 */
export type EmbedArgvMode = "serve" | "native";

function configKey(value: string): string {
    return value.split("=", 1)[0]?.trim() ?? "";
}

/** Throws for an app-server launch that would bypass the account (its own login source, a socket, a sign-out). */
export function embedArgvMode(argv: readonly string[]): EmbedArgvMode {
    if (argv[0] !== "app-server") {
        if (argv.includes("app-server")) {
            throw new Error(`${toolCommand("codex embed")} needs app-server as the first native argument`);
        }

        return "native";
    }

    let subcommand: string | undefined;

    for (let index = 1; index < argv.length; index++) {
        const arg = argv[index] ?? "";
        let flag = arg;
        let value: string | undefined;

        if (arg.startsWith("--") && arg.includes("=")) {
            flag = arg.slice(0, arg.indexOf("="));
            value = arg.slice(arg.indexOf("=") + 1);
        } else if (/^-c./.test(arg)) {
            flag = "-c";
            value = arg.slice(2).replace(/^=/, "");
        } else if (APP_SERVER_VALUE_OPTIONS.has(arg)) {
            value = argv[index + 1];
            index++;
        }

        if (flag === "-h" || flag === "--help" || flag === "--print-startup-config") {
            return "native";
        }

        if (flag === "--startup-sign-out") {
            throw new Error(`${toolCommand("codex embed")} refuses --startup-sign-out: it would sign the home out`);
        }

        if ((flag === "-c" || flag === "--config") && AUTH_CONFIG_KEYS.has(configKey(value ?? ""))) {
            throw new Error(
                `${toolCommand("codex embed")} sets ${configKey(value ?? "")} itself; remove it from the launch arguments`
            );
        }

        if (flag === "--listen" && value !== "stdio://") {
            throw new Error(`${toolCommand("codex embed")} serves the app-server on stdio only, not --listen ${value}`);
        }

        if (!arg.startsWith("-")) {
            subcommand ??= arg;
        }
    }

    if (subcommand === undefined) {
        return "serve";
    }

    if (APP_SERVER_PRINT_COMMANDS.has(subcommand)) {
        return "native";
    }

    throw new Error(`${toolCommand("codex embed")} runs the app-server itself, not app-server ${subcommand}`);
}

interface ChildProcess {
    exitCode: number | null;
    exited: Promise<number>;
    kill(signal: NodeJS.Signals): void;
}

const FORWARDED_SIGNALS: NodeJS.Signals[] = ["SIGTERM", "SIGINT", "SIGHUP"];

/** Passes the host's stop signals on to the child for as long as `body` runs. */
async function withForwardedSignals(child: ChildProcess, body: () => Promise<number>): Promise<number> {
    const forward = (signal: NodeJS.Signals) => {
        logger.info({ signal }, "[codex-embed] forwarding a stop signal to codex");

        if (child.exitCode === null) {
            child.kill(signal);
        }
    };

    for (const signal of FORWARDED_SIGNALS) {
        process.on(signal, forward);
    }

    try {
        return await body();
    } finally {
        for (const signal of FORWARDED_SIGNALS) {
            process.off(signal, forward);
        }
    }
}

async function runNative(argv: string[]): Promise<number> {
    const child = Bun.spawn({
        cmd: [resolveCodexBinary(), ...argv],
        stdio: ["inherit", "inherit", "inherit"],
        env: env.getProcessEnv(),
    });

    return withForwardedSignals(child, () => child.exited);
}

/**
 * `codex app-server` with the account's tokens in ephemeral storage, behind {@link CodexEmbedProxy}. The home is the
 * one the host chose (`CODEX_HOME`, else the default); its `auth.json` is never read for this login and never
 * written, because the credential store is ephemeral.
 */
async function serveAsAccount(input: { binding: CodexAccountBinding; argv: string[] }): Promise<number> {
    const launch = buildAccountLaunchOptions({
        sharedHome: nativeHome("codex"),
        accountName: input.binding.name,
        cwd: process.cwd(),
    });
    const childEnv: Record<string, string | undefined> = {
        ...env.getProcessEnv(),
        ...launch.envOverrides,
        CODEX_HOME: launch.home,
        [accountEnvVar("codex")]: input.binding.name,
    };

    for (const key of launch.unsetEnv ?? []) {
        delete childEnv[key];
    }

    const child = Bun.spawn({
        cmd: [resolveCodexBinary(), ...input.argv, ...(launch.config ?? []).flatMap((value) => ["-c", value])],
        env: childEnv,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
    });
    const hostOut = Bun.stdout.writer();
    let loginFailed = false;
    const fail = (error: Error) => {
        if (loginFailed) {
            return;
        }

        loginFailed = true;
        logger.error({ error, account: input.binding.name }, "[codex-embed] account login failed");
        out.printlnErr(`tools codex embed: ${input.binding.name} could not log in: ${error.message}`);
        child.kill("SIGTERM");
    };
    // The vault read takes seconds (the keychain unlocks the master key), so it runs while codex boots and answers the
    // host's initialize; only the login waits for it.
    const ready = input.binding.tokens();
    ready.catch((error: unknown) => fail(error instanceof Error ? error : new Error(String(error))));
    const proxy = new CodexEmbedProxy({
        account: {
            authenticate: async (client) => {
                await ready;
                await input.binding.authenticate(client);
            },
            refresh: (previousAccountId) => input.binding.refresh(previousAccountId),
        },
        toChild: (bytes) => {
            try {
                child.stdin.write(bytes);
                child.stdin.flush();
            } catch (error) {
                logger.debug({ error }, "[codex-embed] app-server stdin is closed; line dropped");
            }
        },
        endChild: () => {
            try {
                child.stdin.end();
            } catch (error) {
                logger.debug({ error }, "[codex-embed] app-server stdin was already closed");
            }
        },
        toHost: (bytes) => {
            hostOut.write(bytes);
        },
        onLoginFailed: fail,
    });
    logger.info({ pid: child.pid, account: input.binding.name }, "[codex-embed] app-server started");

    const hostIn = Bun.stdin.stream().getReader();
    const pumpHost = async () => {
        const splitter = new LineSplitter();

        try {
            for (;;) {
                const { done, value } = await hostIn.read();

                if (done) {
                    break;
                }

                for (const line of splitter.push(value)) {
                    proxy.hostLine(line);
                }
            }

            const rest = splitter.flush();

            if (rest) {
                proxy.hostLine(rest);
            }

            proxy.hostEnd();
        } catch (error) {
            logger.debug({ error }, "[codex-embed] host stdin closed");
        }
    };
    const pumpChild = async () => {
        const splitter = new LineSplitter();

        for await (const chunk of child.stdout) {
            for (const line of splitter.push(chunk)) {
                proxy.childLine(line);
            }

            hostOut.flush();
        }

        const rest = splitter.flush();

        if (rest) {
            proxy.childLine(rest);
        }

        await hostOut.flush();
    };

    return withForwardedSignals(child, async () => {
        void pumpHost();
        const [code] = await Promise.all([child.exited, pumpChild()]);
        // The host's stdin may stay open after codex is gone; a pending read would keep this process alive.
        await hostIn.cancel().catch((error: unknown) => logger.debug({ error }, "[codex-embed] stdin cancel"));
        logger.info({ code, account: input.binding.name }, "[codex-embed] app-server exited");
        return loginFailed && code === 0 ? 1 : code;
    });
}

/**
 * Codex for an embedding app: `codex app-server` that runs as the requested account. The vault stays the one owner of
 * the account's tokens: they reach the app-server as external tokens over JSON-RPC, it keeps them in memory only, and
 * its refresh requests come back to the vault. The shared home's `auth.json` is never swapped or rewritten.
 */
export const codexEmbed: EmbedLauncher = {
    alias: "codex",
    hostProtocol: "codex-app-server",
    async run({ request, argv }) {
        if (embedArgvMode(argv) === "native") {
            process.exitCode = await runNative(argv);
            return;
        }

        if (request.kind === "proxy") {
            throw new Error(
                `${toolCommand("codex embed")} cannot serve proxy:${request.target}: the Codex app-server logs in with ChatGPT tokens, and the ai-proxy has no app-server route. Name a Codex account or auto.`
            );
        }

        const entry = await pickLaunchAccount({
            alias: "codex",
            tool: "codex embed",
            subcommand: ["embed"],
            requested: request.kind === "auto" ? "auto" : request.name,
        });

        if (!entry) {
            return;
        }

        const binding = await CodexAccountBinding.create(entry.id, { allowRefresh: true });
        process.exitCode = await serveAsAccount({ binding, argv });
    },
};
