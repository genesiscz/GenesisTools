import type { Command } from "commander";
import { runAuthStatus, runLogin, runLogout } from "../lib/mcp/login";

/** login/setup, logout and status: one stored Jenkins token for the CLI and the MCP server. */
export function registerAuth(jenkins: Command): void {
    jenkins
        .command("login")
        .alias("setup")
        .description("Log in once: opens <jenkins>/me/security/ for an API token and stores it in the secret store")
        .argument("[url]", "Jenkins URL — any page of it works (same as --url)")
        .option("--url <url>", "Jenkins base URL — skips the prompt")
        .option("--user <name>", "Jenkins username — skips the prompt")
        .option("--token <token>", "API token — skips the prompt and the browser")
        .option("--no-open", "Print the token page URL instead of opening a browser")
        .action(
            async (url: string | undefined, opts: { url?: string; user?: string; token?: string; open?: boolean }) => {
                process.exit(
                    await runLogin({
                        url: opts.url ?? url,
                        user: opts.user,
                        token: opts.token,
                        noOpen: opts.open === false,
                    })
                );
            }
        );

    jenkins
        .command("logout")
        .description("Remove the stored Jenkins token")
        .option("--url <url>", "Which Jenkins to forget (default: the stored one)")
        .action(async (opts: { url?: string }) => {
            process.exit(await runLogout(opts.url));
        });

    jenkins
        .command("status")
        .description("Show which Jenkins credentials are in use and who they authenticate as")
        .action(async () => {
            process.exit(await runAuthStatus());
        });
}
