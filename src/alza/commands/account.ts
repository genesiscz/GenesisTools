import { spawn } from "node:child_process";
import { isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { logger, out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import type { Command } from "commander";
import { type AccountStatus, afterSignIn, openAccountContext } from "../lib/account";
import { REDIRECT_URI } from "../lib/auth";
import { parseIntArg, parseNumberArg, resolveStorefront, runAccountOperation, TOOL } from "./run";

const REDIRECT_HELP = [
    "Sign in to your Alza account in the browser window.",
    `After the sign-in the browser tries to open ${REDIRECT_URI}?code=…&state=… and cannot: that is expected.`,
    "Copy that full URL. It is in the address bar or in the browser's 'open this app?' message; if neither shows it,",
    "open DevTools (Network tab, 'Preserve log') before signing in and copy the last request to alza://identity.",
    "The code is valid for a few minutes only.",
].join("\n");

function isAccountStatus(data: unknown): data is AccountStatus {
    return typeof data === "object" && data !== null && "signedIn" in data && typeof data.signedIn === "boolean";
}

function openInBrowser(url: string): void {
    const [cmd, args]: [string, string[]] =
        process.platform === "darwin"
            ? ["open", [url]]
            : process.platform === "win32"
              ? ["cmd", ["/c", "start", "", url]]
              : ["xdg-open", [url]];
    const opener = spawn(cmd, args, { stdio: "ignore", detached: true });
    opener.on("error", (error) => {
        logger.debug({ error, cmd }, "could not open the browser");
    });
    opener.unref();
}

interface LoginFlags {
    printUrl?: boolean;
    redirectUrl?: string;
    open?: boolean;
}

async function login(flags: LoginFlags, command: Command): Promise<void> {
    const storefront = await resolveStorefront(command);
    if (!storefront) {
        return;
    }

    if (!flags.printUrl && !flags.redirectUrl && !isInteractive()) {
        out.log.error("Sign-in needs a terminal, or the two steps as flags.");
        out.log.info(suggestCommand(TOOL, { replaceCommand: ["auth", "login", "--print-url"] }));
        out.log.info(
            suggestCommand(TOOL, { replaceCommand: ["auth", "login", "--redirect-url", "<alza://identity?…>"] })
        );
        process.exitCode = 1;
        return;
    }

    const ctx = openAccountContext({ storefront });
    try {
        let redirect = flags.redirectUrl;
        if (!redirect) {
            const { url } = await ctx.auth.startLogin();
            if (flags.printUrl) {
                out.println(url);
                const next = suggestCommand(TOOL, {
                    replaceCommand: ["auth", "login", "--redirect-url", "<the alza://identity URL>"],
                });
                out.printlnErr(`\n${REDIRECT_HELP}\n\nThen: ${next}`);
                return;
            }

            out.printlnErr(`Open this URL and sign in:\n\n  ${url}\n\n${REDIRECT_HELP}\n`);
            if (flags.open !== false) {
                openInBrowser(url);
            }

            redirect = await p.text({
                message: "Paste the alza://identity redirect URL (or just the code)",
                validate: (value) => (value.trim() ? undefined : "Paste the URL from the browser"),
            });
        }

        await ctx.auth.completeLogin(redirect);
        let userName: string | undefined;
        try {
            userName = (await afterSignIn(ctx)).userName;
        } catch (error) {
            logger.warn({ error }, "alza account read after sign-in failed");
        }

        out.log.success(`Signed in${userName ? ` as ${userName}` : ""}.`);
        out.log.info(suggestCommand(TOOL, { replaceCommand: ["auth", "status"] }));
    } catch (error) {
        logger.debug({ error }, "alza sign-in failed");
        out.log.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    } finally {
        await ctx.close();
    }
}

async function logout(command: Command): Promise<void> {
    const storefront = await resolveStorefront(command);
    if (!storefront) {
        return;
    }

    const ctx = openAccountContext({ storefront });
    try {
        const { removed } = ctx.auth.logout();
        out.log.success(removed ? "Signed out: the stored Alza tokens are gone." : "Nobody was signed in.");
    } finally {
        await ctx.close({ save: false });
    }
}

export function registerAccountCommands(program: Command): void {
    const auth = program.command("auth").description("Sign in to your Alza account (browser sign-in, OAuth PKCE)");
    auth.command("login")
        .description("Sign in: open the Alza sign-in page, then paste the alza://identity redirect URL")
        .option("--print-url", "Step 1 without a terminal: print the sign-in URL and exit")
        .option("--redirect-url <url>", "Step 2 without a terminal: the alza://identity?code=… URL from the browser")
        .option("--no-open", "Print the URL instead of opening the browser")
        .action(async (flags: LoginFlags, command: Command) => {
            await login(flags, command);
        });
    auth.command("status")
        .description("Who is signed in and until when (reads only; never renews the token)")
        .action(async (_flags: unknown, command: Command) => {
            const result = await runAccountOperation(command, "account_status", {});
            const status = result?.data;
            if (isAccountStatus(status) && (!status.signedIn || status.check?.ok === false)) {
                process.exitCode = 1;
            }
        });
    auth.command("logout")
        .description("Forget the stored tokens (the visitor basket stays)")
        .action(async (_flags: unknown, command: Command) => {
            await logout(command);
        });

    const cart = program.command("cart").description("The basket: works signed in and as an anonymous visitor");
    cart.command("show", { isDefault: true })
        .description("Products in the basket and the total")
        .action(async (_flags: unknown, command: Command) => {
            await runAccountOperation(command, "cart_show", {});
        });
    cart.command("add")
        .description("Add a product to the basket (orders nothing)")
        .argument("<product>", "Code, numeric id or product URL")
        .option("--qty <n>", "How many (default 1)", parseIntArg)
        .action(async (product: string, flags: { qty?: number }, command: Command) => {
            await runAccountOperation(command, "cart_add", { product, quantity: flags.qty });
        });
    cart.command("remove")
        .description("Remove a product from the basket")
        .argument("<product>", "Code, numeric id or product URL")
        .action(async (product: string, _flags: unknown, command: Command) => {
            await runAccountOperation(command, "cart_remove", { product });
        });

    program
        .command("favorites")
        .description("Products in the favourites list (Oblíbené)")
        .action(async (_flags: unknown, command: Command) => {
            await runAccountOperation(command, "favorites_list", {});
        });

    const orders = program.command("orders").description("Your orders (signed in)");
    orders
        .command("list", { isDefault: true })
        .description("Active and archived orders")
        .option("--active-only", "Leave the archive out")
        .option("--hide-cancelled", "Leave cancelled orders out of the archive")
        .option("--limit <n>", "Archive page size (max 100)", parseIntArg)
        .action(async (flags: { activeOnly?: boolean; hideCancelled?: boolean; limit?: number }, command: Command) => {
            await runAccountOperation(command, "orders_list", {
                archive: !flags.activeOnly,
                hide_cancelled: flags.hideCancelled,
                limit: flags.limit,
            });
        });
    orders
        .command("show")
        .description("One order: parts, status, dates (--json for the full answer)")
        .argument("<id>", "Order number, e.g. 1058423434")
        .action(async (id: string, _flags: unknown, command: Command) => {
            await runAccountOperation(command, "order_show", { order: id });
        });

    const watchdog = program
        .command("watchdog")
        .description("Price and stock watchdogs (Hlídací pes, signed in): Alza emails you");
    watchdog
        .command("list", { isDefault: true })
        .description("Your watchdogs")
        .option("--limit <n>", "How many (max 100)", parseIntArg)
        .action(async (flags: { limit?: number }, command: Command) => {
            await runAccountOperation(command, "watchdog_list", { limit: flags.limit });
        });
    watchdog
        .command("add")
        .description("Watch a product: price below --price, back in --stock, or both (default: stock)")
        .argument("<product>", "Code, numeric id or product URL")
        .option("--price <max>", "Alert when the price drops below this", parseNumberArg)
        .option("--stock", "Alert when it is back in stock")
        .action(async (product: string, flags: { price?: number; stock?: boolean }, command: Command) => {
            await runAccountOperation(command, "watchdog_add", {
                product,
                max_price: flags.price,
                stock: flags.stock,
            });
        });
    watchdog
        .command("remove")
        .description("Remove a watchdog by its id or by the watched product")
        .argument("<id>", "Watchdog id from `watchdog list`, or the product")
        .action(async (id: string, _flags: unknown, command: Command) => {
            await runAccountOperation(command, "watchdog_remove", { watchdog: id });
        });
}
