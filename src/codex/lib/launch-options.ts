export { ACCOUNT_ENV_UNSET, buildAccountLaunchOptions } from "@genesiscz/utils/ai/openai/account-launch-options";

export function validateTuiArgs(args: string[]): string[] {
    const nativeArgs = args[0] === "--" ? args.slice(1) : args;
    const nonTuiCommands = new Set([
        "login",
        "logout",
        "exec",
        "e",
        "review",
        "app-server",
        "app",
        "mcp",
        "plugin",
        "queue",
        "archive",
        "delete",
        "migrate-rollouts",
        "unarchive",
        "mcp-server",
        "remote-control",
        "exec-server",
        "cloud",
        "agents",
        "features",
        "doctor",
        "update",
        "completion",
        "sandbox",
        "debug",
        "apply",
        "a",
        "help",
    ]);
    const optionsWithValue = new Set([
        "--enable",
        "--image",
        "-i",
        "--disable",
        "--model",
        "-m",
        "--sandbox",
        "-s",
        "--cd",
        "-C",
        "--add-dir",
        "--ask-for-approval",
        "-a",
    ]);
    let skipValue = false;
    let foundPositional = false;
    for (const arg of nativeArgs) {
        if (arg === "--") {
            // Only the launcher's own leading separator is consumed (above). A later `--` is
            // ordinary native text, and stopping here let `-- foo -- --remote=…` walk straight
            // past the account guard.
            continue;
        }
        // The blocked-flag check runs BEFORE the value skip on purpose. `skipValue` swallowed the
        // next token whatever it was, so any value-taking flag in front of a blocked one walked
        // straight past the guard: `--add-dir --config=evil`, `--image --config=evil`,
        // `--model --profile=x`, `--sandbox -c trust=true` and `--cd --remote=http://evil` were
        // all accepted on an account-bound launch. A real option value never looks like one of
        // these flags, so checking first costs nothing.
        if (
            /^--(?:remote(?:-auth-token-env)?|config|profile|oss|local-provider)(?:=|$)/.test(arg) ||
            /^-[cp]/.test(arg)
        ) {
            throw new Error("Account-bound Codex does not accept --remote, --config/-c or --profile/-p overrides");
        }
        if (skipValue) {
            skipValue = false;
            continue;
        }
        if (foundPositional) {
            continue;
        }
        if (optionsWithValue.has(arg)) {
            skipValue = true;
            continue;
        }
        if (arg.startsWith("-")) {
            continue;
        }
        foundPositional = true;
        if (nonTuiCommands.has(arg)) {
            throw new Error("Use tools codex login separately; this command starts an account-bound terminal");
        }
    }

    return nativeArgs;
}
