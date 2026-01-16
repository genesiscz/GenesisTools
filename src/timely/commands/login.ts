import { Command } from "commander";
import { confirm, input, password } from "@inquirer/prompts";
import { ExitPromptError } from "@inquirer/core";
import chalk from "chalk";
import logger from "@app/logger";
import { Storage } from "@app/utils/storage";
import { TimelyApiClient } from "@app/timely/api/client";
import type { OAuthApplication } from "@app/timely/types";

export function registerLoginCommand(program: Command, storage: Storage, client: TimelyApiClient): void {
    program
        .command("login")
        .description("Authenticate with Timely via OAuth2")
        .action(async () => {
            try {
                await loginAction(storage, client);
            } catch (error) {
                if (error instanceof ExitPromptError) {
                    logger.info("\nOperation cancelled.");
                    process.exit(0);
                }
                throw error;
            }
        });
}

async function loginAction(storage: Storage, client: TimelyApiClient): Promise<void> {
    // Check if already logged in
    if (await client.isAuthenticated()) {
        const shouldReauth = await confirm({
            message: "You are already logged in. Do you want to re-authenticate?",
            default: false,
        });

        if (!shouldReauth) {
            logger.info("Login cancelled.");
            return;
        }
    }

    // Get or prompt for OAuth credentials
    let oauth = await storage.getConfigValue<OAuthApplication>("oauth");

    if (!oauth?.client_id || !oauth?.client_secret) {
        logger.info(chalk.yellow("\nOAuth application credentials not found."));
        logger.info("Create an OAuth application at: https://app.timelyapp.com/settings/oauth_applications\n");

        const clientId = await input({
            message: "Client ID:",
        });

        const clientSecret = await password({
            message: "Client Secret:",
        });

        const redirectUri = await input({
            message: "Redirect URI (press Enter for default):",
            default: "urn:ietf:wg:oauth:2.0:oob",
        });

        oauth = {
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri || "urn:ietf:wg:oauth:2.0:oob",
        };

        await storage.setConfigValue("oauth", oauth);
    }

    // Build authorization URL
    const authUrl = new URL("https://api.timelyapp.com/1.1/oauth/authorize");
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", oauth.client_id);
    authUrl.searchParams.set("redirect_uri", oauth.redirect_uri);

    logger.info(chalk.cyan("\nOpen this URL in your browser to authorize:"));
    logger.info(chalk.white(authUrl.toString()) + "\n");

    // Try to open browser automatically
    try {
        const proc = Bun.spawn({
            cmd: ["open", authUrl.toString()],
            stdio: ["ignore", "ignore", "ignore"],
        });
        await proc.exited;
    } catch {
        // Ignore if open command fails
    }

    // Prompt for authorization code
    const code = await input({
        message: "Paste the authorization code:",
    });

    // Exchange code for tokens
    logger.info(chalk.yellow("Exchanging code for tokens..."));

    try {
        const tokens = await client.exchangeCode(code.trim());
        logger.info(chalk.green("Successfully authenticated!"));
        logger.debug(`Access token: ${tokens.access_token.substring(0, 10)}...`);
    } catch (error) {
        logger.error(`Login failed: ${error}`);
        throw error;
    }
}
