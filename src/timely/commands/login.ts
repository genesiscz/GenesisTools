import type { TimelyApiClient } from "@app/timely/api/client";
import { probeAndSaveCookie } from "@app/timely/api/cookie-probe";
import type { OAuthApplication } from "@app/timely/types";
import { describeCookie, extractCookie } from "@app/timely/utils/cookie";
import { Browser } from "@genesiscz/utils/browser";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { readFromClipboard } from "@genesiscz/utils/clipboard";
import { logger } from "@genesiscz/utils/logger";
import { multilineText } from "@genesiscz/utils/prompts/clack/multiline";
import * as p from "@genesiscz/utils/prompts/p";
import type { Storage } from "@genesiscz/utils/storage";
import chalk from "chalk";
import type { Command } from "commander";

export function registerLoginCommand(program: Command, storage: Storage, client: TimelyApiClient): void {
    const login = program
        .command("login")
        .description("Authenticate with Timely (api-key for the API, cookies for memories)")
        .action(async () => {
            await routeLogin(storage, client);
        });

    login
        .command("api-key")
        .description("OAuth2 flow for api.timelyapp.com (events, projects, accounts)")
        .action(async () => {
            await apiKeyLogin(storage, client);
        });

    login
        .command("cookies")
        .description("Store a browser Cookie header for app.timelyapp.com (memories)")
        .option("--from-clipboard", "Take the cookie straight from the clipboard, no prompts (works without a TTY)")
        .action(async (options: { fromClipboard?: boolean }) => {
            await cookieLogin(storage, { fromClipboard: options.fromClipboard === true });
        });
}

/** Bare `tools timely login`: ask which credential, or explain both when there is no TTY. */
async function routeLogin(storage: Storage, client: TimelyApiClient): Promise<void> {
    if (!isInteractive()) {
        logger.error("Choose a login method in non-interactive mode.");
        logger.info(
            `API access (events, projects, accounts): ${suggestCommand("tools timely", { replaceCommand: ["login", "api-key"] })}`
        );
        logger.info(
            `Memories (browser session cookie): ${suggestCommand("tools timely", { replaceCommand: ["login", "cookies"] })}`
        );
        process.exit(1);
    }

    const method = (await p.select({
        message: "What do you want to authenticate?",
        options: [
            { value: "api-key", label: "api-key - OAuth2 for the API (events, projects, accounts)" },
            { value: "cookies", label: "cookies - browser session for memories (suggested entries)" },
        ],
    })) as string;

    if (method === "cookies") {
        await cookieLogin(storage, { fromClipboard: false });
        return;
    }

    await apiKeyLogin(storage, client);
}

async function apiKeyLogin(storage: Storage, client: TimelyApiClient): Promise<void> {
    // Check if already logged in
    if (await client.isAuthenticated()) {
        const shouldReauth = await p.confirm({
            message: "You are already logged in. Do you want to re-authenticate?",
            initialValue: false,
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

        const clientId = await p.text({
            message: "Client ID:",
        });

        const clientSecret = await p.password({
            message: "Client Secret:",
        });

        const redirectUri = await p.text({
            message: "Redirect URI (press Enter for default):",
            initialValue: "urn:ietf:wg:oauth:2.0:oob",
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
    logger.info(`${chalk.white(authUrl.toString())}\n`);

    // Try to open browser automatically
    await Browser.open(authUrl.toString());

    // Prompt for authorization code
    const code = await p.text({
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

/**
 * Memories live on app.timelyapp.com, which accepts only a browser session
 * cookie. Get that cookie from wherever the user has it — the clipboard, a
 * whole "Copy as cURL" paste, or a bare Cookie header — prove it works against
 * one real request, and store it. The value is never echoed or logged.
 */
async function cookieLogin(storage: Storage, options: { fromClipboard: boolean }): Promise<void> {
    const accountId = await storage.getConfigValue<number>("selectedAccountId");
    if (!accountId) {
        logger.error("No account selected. Run 'tools timely accounts --select' first.");
        process.exit(1);
    }

    const cookie = options.fromClipboard ? await cookieFromClipboardOnly() : await cookieFromClipboardOrPaste(storage);

    logger.info(chalk.yellow("Checking the cookie against suggested_entries..."));

    const outcome = await probeAndSaveCookie({ storage, accountId, cookie });

    if (outcome.status === "unreachable") {
        logger.error({ error: outcome.error }, "Could not reach Timely to check the cookie. Nothing was saved.");
        process.exit(1);
    }

    if (outcome.status === "rejected") {
        logger.error(`Timely rejected that cookie (HTTP ${outcome.httpStatus}). Nothing was saved.`);
        logger.info("Copy the request again from a page you are logged into, including every name=value pair.");
        process.exit(1);
    }

    const { saved } = outcome;
    logger.info(
        chalk.green(`Cookie accepted (HTTP 200) and saved to ${saved.path}${saved.ownerOnly ? " (mode 600)" : ""}.`)
    );

    if (!saved.ownerOnly) {
        logger.warn(`${saved.path} is not owner-only. Anyone able to read that path can reuse your Timely session.`);
    }

    logger.info("Memories work again: tools timely memories --day <YYYY-MM-DD>");
}

/** Read the clipboard without letting a headless/denied clipboard abort the command. */
async function readClipboardCookie(): Promise<string | undefined> {
    try {
        const clipboard = await readFromClipboard();
        const extracted = extractCookie(clipboard);
        if (!extracted) {
            logger.debug("Clipboard holds no usable cookie.");
            return undefined;
        }

        logger.debug(`Clipboard cookie found via ${extracted.source}.`);
        return extracted.cookie;
    } catch (err) {
        logger.debug(`Could not read the clipboard: ${err}`);
        return undefined;
    }
}

/** `--from-clipboard`: no prompts, so it works in a script or without a TTY. */
async function cookieFromClipboardOnly(): Promise<string> {
    const cookie = await readClipboardCookie();
    if (!cookie) {
        logger.error("The clipboard holds no cookie. Copy the request as cURL from DevTools and try again.");
        logger.info(
            `Or paste it yourself: ${suggestCommand("tools timely", { replaceCommand: ["login", "cookies"] })}`
        );
        process.exit(1);
    }

    logger.info(chalk.green(`Using the clipboard cookie (${describeCookie(cookie)}).`));
    return cookie;
}

/** Interactive path: offer the clipboard first, fall back to a paste. */
async function cookieFromClipboardOrPaste(storage: Storage): Promise<string> {
    if (!isInteractive()) {
        logger.error("Pasting a cookie needs a TTY. Run 'tools timely login cookies' in a terminal.");
        logger.info(
            `Without a TTY, copy the request as cURL and run: ${suggestCommand("tools timely", { replaceCommand: ["login", "cookies"], add: ["--from-clipboard"] })}`
        );
        process.exit(1);
    }

    logger.info(chalk.cyan("\nIn a browser tab logged in to https://app.timelyapp.com:"));
    logger.info("  DevTools > Network > any request to app.timelyapp.com > right-click > Copy > Copy as cURL");
    logger.info("  (the plain 'Cookie:' header value works too).\n");

    const fromClipboard = await readClipboardCookie();
    if (fromClipboard) {
        const useIt = await p.confirm({
            message: `Use the cookie already on your clipboard? (${describeCookie(fromClipboard)})`,
            initialValue: true,
        });

        if (useIt) {
            return fromClipboard;
        }
    } else {
        logger.info(chalk.gray("Nothing usable on the clipboard, so paste it instead."));
    }

    return promptForCookie(storage);
}

/**
 * Two paste surfaces: a multiline one for a whole curl command (which no
 * masked single-line prompt can take), and the masked one for a bare header.
 */
async function promptForCookie(storage: Storage): Promise<string> {
    const method = (await p.select({
        message: "How do you want to give it?",
        options: [
            { value: "curl", label: "paste the whole curl command (multiline; visible while you paste)" },
            { value: "header", label: "paste just the Cookie header (hidden)" },
        ],
    })) as string;

    const pasted =
        method === "curl"
            ? await pasteCurl()
            : await p.password({ message: "Paste the Cookie header (or the whole curl):" });

    const extracted = extractCookie(pasted);
    if (!extracted) {
        logger.error("Found no name=value cookie pairs in that. Nothing was saved.");
        logger.info(`Config untouched: ${storage.getConfigPath()}`);
        process.exit(1);
    }

    logger.debug(`Cookie extracted via ${extracted.source}.`);
    logger.info(chalk.gray(`Read ${describeCookie(extracted.cookie)}.`));
    return extracted.cookie;
}

async function pasteCurl(): Promise<string> {
    logger.warn("Unlike the hidden prompt, this one shows what you paste; it is wiped from the screen on submit.");

    const value = await multilineText({
        message: "Paste the curl command, then press Enter twice:",
    });

    if (typeof value !== "string") {
        logger.error("Cancelled. Cookie not saved.");
        process.exit(1);
    }

    return value;
}
