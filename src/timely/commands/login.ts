import Enquirer from "enquirer";
import chalk from "chalk";
import logger from "@app/logger";
import { Storage } from "@app/utils/storage";
import { TimelyApiClient } from "../api/client";
import type { TimelyArgs, OAuthApplication } from "../types";

const prompter = new Enquirer();

export async function loginCommand(args: TimelyArgs, storage: Storage, client: TimelyApiClient): Promise<void> {
    // Check if already logged in
    if (await client.isAuthenticated()) {
        const { confirm } = (await prompter.prompt({
            type: "confirm",
            name: "confirm",
            message: "You are already logged in. Do you want to re-authenticate?",
            initial: false,
        })) as { confirm: boolean };

        if (!confirm) {
            logger.info("Login cancelled.");
            return;
        }
    }

    // Get or prompt for OAuth credentials
    let oauth = await storage.getConfigValue<OAuthApplication>("oauth");

    if (!oauth?.client_id || !oauth?.client_secret) {
        logger.info(chalk.yellow("\nOAuth application credentials not found."));
        logger.info("Create an OAuth application at: https://app.timelyapp.com/settings/oauth_applications\n");

        const { clientId, clientSecret, redirectUri } = (await prompter.prompt([
            {
                type: "input",
                name: "clientId",
                message: "Client ID:",
            },
            {
                type: "password",
                name: "clientSecret",
                message: "Client Secret:",
            },
            {
                type: "input",
                name: "redirectUri",
                message: "Redirect URI (press Enter for default):",
                initial: "urn:ietf:wg:oauth:2.0:oob",
            },
        ])) as { clientId: string; clientSecret: string; redirectUri: string };

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
    const { code } = (await prompter.prompt({
        type: "input",
        name: "code",
        message: "Paste the authorization code:",
    })) as { code: string };

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
