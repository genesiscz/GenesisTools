#!/usr/bin/env bun

import { Command } from "commander";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { Storage } from "@app/utils/storage/storage";
import { multilineText, isMultilineCancel } from "@app/utils/prompts/clack";

// Types
interface Order {
    id: number;
    itemsCount: number;
    priceComposition: {
        total: { amount: number; currency: string };
    };
    orderTime: string;
}

interface OrderDetail {
    id: number;
    items: Array<{
        name: string;
        quantity: number;
        totalPrice: { amount: number };
    }>;
    priceComposition: {
        total: { amount: number; currency: string };
    };
    orderTime: string;
}

interface RohlikConfig {
    cookies: string;
    savedAt: string;
}

// Storage
const storage = new Storage("rohlik");

// API Headers (cookies added dynamically)
function getHeaders(cookies: string): Record<string, string> {
    return {
        accept: "*/*",
        "accept-language": "cs-CZ,cs;q=0.9",
        "cache-control": "no-cache",
        pragma: "no-cache",
        referer: "https://www.rohlik.cz/uzivatel/profil",
        "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
        "x-origin": "WEB",
        cookie: cookies,
    };
}

// API Functions
async function fetchOrders(cookies: string, offset: number, limit: number): Promise<Order[]> {
    const url = `https://www.rohlik.cz/api/v3/orders/delivered?offset=${offset}&limit=${limit}`;
    const response = await fetch(url, { headers: getHeaders(cookies) });

    if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
            throw new Error("AUTH_FAILED");
        }
        throw new Error(`HTTP error! status: ${response.status}`);
    }

    return response.json();
}

async function fetchOrderDetail(cookies: string, orderId: number): Promise<OrderDetail> {
    const url = `https://www.rohlik.cz/api/v3/orders/${orderId}`;
    const response = await fetch(url, { headers: getHeaders(cookies) });

    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }

    return response.json();
}

// Extract cookies from cURL command or raw cookie string
function extractCookies(input: string): string | null {
    // Normalize: remove line continuations and join
    const normalized = input
        .replace(/\\\r?\n/g, " ") // Remove line continuations
        .replace(/\r?\n/g, " ") // Join lines
        .trim();

    // Try -b 'cookies' format (single quotes - everything inside is literal)
    const bSingleMatch = normalized.match(/-b\s+'([^']+)'/);
    if (bSingleMatch) return bSingleMatch[1].trim();

    // Try -b "cookies" format (double quotes)
    const bDoubleMatch = normalized.match(/-b\s+"([^"]+)"/);
    if (bDoubleMatch) return bDoubleMatch[1].trim();

    // Try --cookie 'cookies' format
    const cookieSingleMatch = normalized.match(/--cookie\s+'([^']+)'/);
    if (cookieSingleMatch) return cookieSingleMatch[1].trim();

    const cookieDoubleMatch = normalized.match(/--cookie\s+"([^"]+)"/);
    if (cookieDoubleMatch) return cookieDoubleMatch[1].trim();

    // Try -H 'cookie: ...' format (header form)
    const headerSingleMatch = normalized.match(/-H\s+'[Cc]ookie:\s*([^']+)'/);
    if (headerSingleMatch) return headerSingleMatch[1].trim();

    const headerDoubleMatch = normalized.match(/-H\s+"[Cc]ookie:\s*([^"]+)"/);
    if (headerDoubleMatch) return headerDoubleMatch[1].trim();

    // If input looks like raw cookies (has = and ;), use as-is
    // But filter out curl command parts
    if (normalized.includes("=") && normalized.includes(";") && !normalized.startsWith("curl")) {
        return normalized;
    }

    return null;
}

// Cookie Setup Guide
async function showCookieGuide(): Promise<string | null> {
    p.log.step(pc.bold("How to get your Rohlik cookies:"));
    p.log.message("");
    p.log.message(pc.cyan("1.") + " Open " + pc.underline("https://www.rohlik.cz") + " and log in");
    p.log.message(pc.cyan("2.") + " Open DevTools " + pc.dim("(F12 or Cmd+Option+I)"));
    p.log.message(pc.cyan("3.") + " Go to " + pc.bold("Network") + " tab");
    p.log.message(pc.cyan("4.") + " Navigate to " + pc.underline("https://www.rohlik.cz/uzivatel/profil"));
    p.log.message(pc.cyan("5.") + " Find any request to " + pc.bold("api/v3/") + pc.dim(" (e.g., 'orders')"));
    p.log.message(pc.cyan("6.") + " Right-click the request -> " + pc.bold("Copy") + " -> " + pc.bold("Copy as cURL"));
    p.log.message("");

    const input = await multilineText({
        message: "Paste the cURL command (or just cookie value):",
        placeholder: "curl 'https://...' -b '...' OR language=cs-CZ; userId=...",
        validate: (value) => {
            if (!value || value.trim().length < 20) {
                return "Input too short";
            }
            const cookies = extractCookies(value);
            if (!cookies) {
                return "Could not find cookies. Make sure to paste the full cURL command with -b flag";
            }
        },
    });

    if (isMultilineCancel(input)) {
        return null;
    }

    const cookies = extractCookies(input);
    return cookies;
}

async function ensureCookies(forceNew: boolean = false): Promise<string | null> {
    await storage.ensureDirs();

    // Check if we have saved cookies
    if (!forceNew) {
        const config = await storage.getConfig<RohlikConfig>();
        if (config?.cookies) {
            const savedAt = new Date(config.savedAt);
            const age = Date.now() - savedAt.getTime();
            const hoursAgo = Math.floor(age / (1000 * 60 * 60));

            p.log.info(`Using saved cookies ${pc.dim(`(saved ${hoursAgo < 1 ? "recently" : hoursAgo + "h ago"})`)}`);

            // Test if cookies still work
            const spinner = p.spinner();
            spinner.start("Verifying cookies...");

            try {
                await fetchOrders(config.cookies, 0, 1);
                spinner.stop(pc.green("Cookies are valid"));
                return config.cookies;
            } catch (error) {
                if (error instanceof Error && error.message === "AUTH_FAILED") {
                    spinner.stop(pc.yellow("Cookies expired, need new ones"));
                } else {
                    spinner.stop(pc.red("Failed to verify cookies"));
                    throw error;
                }
            }
        }
    }

    // Need to get new cookies
    const cookies = await showCookieGuide();

    if (!cookies) {
        return null;
    }

    // Test the new cookies
    const spinner = p.spinner();
    spinner.start("Testing cookies...");

    try {
        await fetchOrders(cookies, 0, 1);
        spinner.stop(pc.green("Cookies work!"));

        // Save cookies
        await storage.setConfig<RohlikConfig>({
            cookies,
            savedAt: new Date().toISOString(),
        });

        p.log.success(`Cookies saved to ${pc.dim(storage.getConfigPath())}`);

        return cookies;
    } catch (error) {
        spinner.stop(pc.red("Cookies don't work"));
        p.log.error("The provided cookies are invalid or expired. Please try again.");
        return null;
    }
}

// Main command
async function main() {
    const program = new Command();

    program
        .name("rohlik-spending")
        .description("Calculate total spending on Rohlik.cz")
        .option("-v, --verbose", "Show individual orders")
        .option("-d, --details <orderId>", "Show details for a specific order")
        .option("--reconfigure", "Re-enter cookies (ignore saved)")
        .option("--clear", "Clear saved cookies")
        .action(async (options) => {
            p.intro(pc.bgGreen(pc.black(" rohlik-spending ")));

            // Handle clear option
            if (options.clear) {
                await storage.clearConfig();
                p.log.success("Saved cookies cleared");
                p.outro(pc.green("Done!"));
                return;
            }

            // Get cookies
            const cookies = await ensureCookies(options.reconfigure);

            if (!cookies) {
                p.cancel("Operation cancelled");
                process.exit(0);
            }

            // Handle details for specific order
            if (options.details) {
                const orderId = parseInt(options.details);
                const spinner = p.spinner();
                spinner.start(`Fetching order #${orderId}...`);

                try {
                    const order = await fetchOrderDetail(cookies, orderId);
                    spinner.stop(`Order #${orderId}`);

                    p.log.message("");
                    p.log.message(pc.bold(`Order #${order.id}`));
                    p.log.message(pc.dim(`Date: ${new Date(order.orderTime).toLocaleDateString("cs-CZ")}`));
                    p.log.message(pc.dim(`Total: ${order.priceComposition.total.amount.toFixed(2)} Kč`));
                    p.log.message("");
                    p.log.message(pc.bold("Items:"));

                    for (const item of order.items) {
                        p.log.message(
                            `  ${pc.cyan(item.quantity + "x")} ${item.name} - ${pc.green(item.totalPrice.amount.toFixed(2) + " Kč")}`
                        );
                    }

                    p.outro(pc.green("Done!"));
                    return;
                } catch (error) {
                    spinner.stop(pc.red("Failed"));
                    p.log.error(`Failed to fetch order: ${error}`);
                    process.exit(1);
                }
            }

            // Fetch all orders
            const spinner = p.spinner();
            spinner.start("Fetching orders...");

            let allOrders: Order[] = [];

            try {
                // Fetch with large limit to get all orders at once
                const orders = await fetchOrders(cookies, 0, 10000);
                allOrders = orders;
                spinner.stop(`Fetched ${pc.cyan(allOrders.length.toString())} orders`);
            } catch (error) {
                spinner.stop(pc.red("Failed to fetch orders"));
                p.log.error(`Error: ${error}`);
                process.exit(1);
            }

            if (allOrders.length === 0) {
                p.log.warn("No orders found");
                p.outro(pc.yellow("No data"));
                return;
            }

            // Sort by date (oldest first for verbose output)
            allOrders.sort((a, b) => new Date(a.orderTime).getTime() - new Date(b.orderTime).getTime());

            // Calculate totals
            let totalSpending = 0;

            if (options.verbose) {
                p.log.message("");
                p.log.message(pc.bold("All orders:"));
            }

            for (const order of allOrders) {
                const price = order.priceComposition.total.amount;
                totalSpending += price;

                if (options.verbose) {
                    const date = new Date(order.orderTime).toLocaleDateString("cs-CZ");
                    p.log.message(
                        `  ${pc.dim(date)} ${pc.dim(`(${order.itemsCount} items)`)} - ${pc.green(price.toFixed(2) + " Kč")} ${pc.dim(`#${order.id}`)}`
                    );
                }
            }

            // Group by year for summary
            const byYear = new Map<number, { count: number; total: number }>();
            for (const order of allOrders) {
                const year = new Date(order.orderTime).getFullYear();
                const existing = byYear.get(year) ?? { count: 0, total: 0 };
                existing.count++;
                existing.total += order.priceComposition.total.amount;
                byYear.set(year, existing);
            }

            // Build summary
            const sortedYears = [...byYear.keys()].sort();
            const yearSummary = sortedYears
                .map((year) => {
                    const data = byYear.get(year)!;
                    const avg = Math.round(data.total / data.count);
                    return `${pc.bold(year.toString())}: ${pc.green(data.total.toLocaleString("cs-CZ", { minimumFractionDigits: 0 }) + " Kč")} ${pc.dim(`(${data.count} orders, avg ${avg} Kč)`)}`;
                })
                .join("\n");

            p.note(
                yearSummary +
                    "\n\n" +
                    pc.bold("Total: ") +
                    pc.green(totalSpending.toLocaleString("cs-CZ", { minimumFractionDigits: 0 }) + " Kč") +
                    pc.dim(` from ${allOrders.length} orders`) +
                    "\n" +
                    pc.dim(`Average: ${Math.round(totalSpending / allOrders.length)} Kč/order`),
                pc.bold("Rohlik Spending Summary")
            );

            p.outro(pc.green("Done!"));
        });

    await program.parseAsync();
}

main().catch((error) => {
    p.log.error(`Error: ${error.message}`);
    process.exit(1);
});
