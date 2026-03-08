import { createInterface } from "node:readline";
import { parseAuthCurl } from "@app/clarity/lib/parse-auth-curl";
import { ClarityApi } from "@app/utils/clarity";
import * as clack from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import type { ClarityConfig } from "../config.js";
import { getConfig, saveConfig } from "../config.js";
import { runInteractiveLinking } from "./link-workitems.js";

/**
 * Read multiline cURL input from stdin.
 * Collects lines until: empty line entered, or a line without trailing backslash
 * (with a short debounce to handle fast paste).
 */
async function readMultilineCurl(): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const lines: string[] = [];
    let finishTimer: ReturnType<typeof setTimeout> | null = null;

    return new Promise((resolve) => {
        console.log(pc.gray("  (paste cURL, press Enter on blank line to finish)"));
        process.stdout.write(pc.cyan("  > "));

        function finish() {
            if (finishTimer) {
                clearTimeout(finishTimer);
            }

            rl.close();
            const result = lines
                .map((l) => l.replace(/\\\s*$/, ""))
                .join(" ")
                .trim();
            resolve(result);
        }

        rl.on("line", (line) => {
            if (finishTimer) {
                clearTimeout(finishTimer);
                finishTimer = null;
            }

            // Empty line after content = done
            if (lines.length > 0 && line.trim() === "") {
                finish();
                return;
            }

            lines.push(line);

            // Line ends with backslash = more input expected
            if (line.trim().endsWith("\\")) {
                process.stdout.write(pc.cyan("  > "));
                return;
            }

            // No backslash: debounce 200ms in case paste buffer has more lines
            finishTimer = setTimeout(finish, 200);
        });

        rl.on("close", () => {
            if (lines.length > 0) {
                finish();
            }
        });
    });
}

async function runInteractiveSetup(): Promise<void> {
    clack.intro(pc.bgCyan(pc.black(" Clarity PPM Configuration ")));

    const existingConfig = await getConfig();

    if (existingConfig) {
        const shouldReconfigure = await clack.confirm({
            message: "Existing configuration found. Reconfigure?",
            initialValue: false,
        });

        if (clack.isCancel(shouldReconfigure) || !shouldReconfigure) {
            clack.outro("Configuration unchanged.");
            return;
        }
    }

    clack.note(
        [
            "To configure Clarity, you need to paste a cURL command from your browser.",
            "",
            "Steps:",
            "  1. Open Clarity PPM in your browser and navigate to Timesheets",
            "  2. Open Developer Tools (F12) -> Network tab",
            "  3. Right-click any request to /ppm/rest/v1/",
            "  4. Select Copy > Copy as cURL",
            "  5. Paste it below (multi-line is OK, press Enter twice to finish)",
        ].join("\n"),
        "How to get the cURL command"
    );

    clack.log.step("Paste the cURL command:");
    const curlInput = await readMultilineCurl();

    if (!curlInput.trim()) {
        clack.cancel("No cURL command provided.");
        process.exit(0);
    }

    if (!curlInput.includes("curl") && !curlInput.includes("http")) {
        clack.log.error("Doesn't look like a valid cURL command.");
        process.exit(1);
    }

    const spinner = clack.spinner();
    spinner.start("Parsing cURL command...");

    let baseUrl: string;
    let authToken: string;
    let sessionId: string;
    let cookies: string;

    try {
        ({ baseUrl, authToken, sessionId, cookies } = parseAuthCurl(curlInput));
    } catch (err) {
        spinner.stop("Failed to parse cURL command");
        clack.log.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
    }

    spinner.stop("cURL parsed successfully");

    clack.log.info(`Base URL: ${pc.cyan(baseUrl)}`);
    clack.log.info("Auth Token: [configured]");
    clack.log.info("Session ID: [configured]");

    // Test connection
    spinner.start("Testing connection...");

    const api = new ClarityApi({ baseUrl, authToken, sessionId, cookies });

    try {
        // Try to fetch any timesheet data to validate the credentials
        // 0 fetches the default/current timesheet app list, not tied to a specific period
        const appData = await api.getTimesheetApp(0);
        const resource = appData.resource._results[0];

        spinner.stop("Connection successful!");

        if (resource) {
            clack.log.info(`Logged in as: ${pc.green(resource.full_name)} (${resource.email})`);
        }

        const config: ClarityConfig = {
            baseUrl,
            authToken,
            sessionId,
            cookies,
            resourceId: resource?.id,
            uniqueName: resource?.email,
            mappings: existingConfig?.mappings ?? [],
        };

        await saveConfig(config);
        clack.outro(pc.green("Configuration saved!"));
    } catch (err) {
        spinner.stop("Connection failed");
        clack.log.error(err instanceof Error ? err.message : String(err));
        clack.log.warn("The credentials may be expired. Try copying a fresh cURL from the browser.");
        process.exit(1);
    }
}

function showConfig(config: ClarityConfig): void {
    console.log("\nClarity Configuration:");
    console.log(`  Base URL:     ${config.baseUrl}`);
    console.log(`  Auth Token:   [configured]`);
    console.log(`  Session ID:   [configured]`);
    console.log(`  Resource ID:  ${config.resourceId ?? "not set"}`);
    console.log(`  User:         ${config.uniqueName ?? "not set"}`);
    console.log(`  Mappings:     ${config.mappings.length}`);

    if (config.mappings.length > 0) {
        console.log("\n  ADO Work Item -> Clarity Task:");

        for (const m of config.mappings) {
            console.log(
                `    #${m.adoWorkItemId} (${m.adoWorkItemTitle}) -> ${m.clarityTaskName} [${m.clarityInvestmentName}]`
            );
        }
    }
}

export function registerConfigureCommand(program: Command): void {
    const cmd = program.command("configure").description("Configure Clarity PPM connection and mappings");

    cmd.command("auth")
        .description("Set up authentication (interactive cURL paste)")
        .action(async () => {
            await runInteractiveSetup();
        });

    cmd.command("show")
        .description("Show current configuration")
        .action(async () => {
            const config = await getConfig();

            if (!config) {
                console.error("Clarity not configured. Run: tools clarity configure auth");
                process.exit(1);
            }

            showConfig(config);
        });

    cmd.command("mappings")
        .description("Add/manage ADO-to-Clarity task mappings (interactive)")
        .action(async () => {
            await runInteractiveLinking();
        });

    cmd.command("update-auth")
        .description("Update auth credentials (paste new cURL)")
        .action(async () => {
            const config = await getConfig();

            if (!config) {
                console.error("Clarity not configured. Run: tools clarity configure auth");
                process.exit(1);
            }

            clack.intro(pc.bgCyan(pc.black(" Update Clarity Auth ")));

            clack.note(
                [
                    "Paste a fresh cURL command from Clarity to update auth credentials.",
                    "Your mappings will be preserved.",
                    "",
                    "Steps:",
                    "  1. Open Clarity PPM in your browser",
                    "  2. Open Developer Tools (F12) -> Network tab",
                    "  3. Right-click any request to /ppm/rest/v1/",
                    "  4. Copy as cURL and paste below",
                ].join("\n"),
                "Update credentials"
            );

            clack.log.step("Paste the cURL command:");
            const curlInput = await readMultilineCurl();

            if (!curlInput.trim()) {
                clack.cancel("No cURL command provided.");
                process.exit(0);
            }

            let baseUrl: string;
            let authToken: string;
            let sessionId: string;
            let cookies: string;

            try {
                ({ baseUrl, authToken, sessionId, cookies } = parseAuthCurl(curlInput));
            } catch (err) {
                clack.log.error(err instanceof Error ? err.message : String(err));
                process.exit(1);
            }

            const spinner = clack.spinner();
            spinner.start("Testing connection...");

            const api = new ClarityApi({ baseUrl, authToken, sessionId, cookies });

            try {
                // 0 fetches the default/current timesheet app list, not tied to a specific period
                const appData = await api.getTimesheetApp(0);
                const resource = appData.resource._results[0];

                spinner.stop("Connection successful!");

                if (resource) {
                    clack.log.info(`Logged in as: ${pc.green(resource.full_name)} (${resource.email})`);
                }

                config.baseUrl = baseUrl;
                config.authToken = authToken;
                config.sessionId = sessionId;
                config.cookies = cookies;

                if (resource) {
                    config.resourceId = resource.id;
                    config.uniqueName = resource.email;
                }

                await saveConfig(config);
                clack.outro(pc.green(`Auth updated! ${config.mappings.length} mappings preserved.`));
            } catch (err) {
                spinner.stop("Connection failed");
                clack.log.error(err instanceof Error ? err.message : String(err));
                process.exit(1);
            }
        });

    // Default action: show config + menu
    cmd.action(async () => {
        let config = await getConfig();

        if (!config) {
            clack.intro(pc.bgCyan(pc.black(" Clarity PPM Configuration ")));
            clack.log.warn("Not configured yet.");
            clack.log.info("Run: tools clarity configure auth");
            clack.outro("");
            return;
        }

        // Multi-loop: show menu repeatedly, Esc on menu exits
        while (true) {
            // Refresh config each iteration (may have changed)
            config = (await getConfig())!;
            showConfig(config);

            const action = await clack.select({
                message: "What would you like to do?",
                options: [
                    { value: "done", label: "Done" },
                    { value: "link", label: "Add/update mappings (link work items)" },
                    { value: "remove-mapping", label: "Remove a mapping" },
                    { value: "update-auth", label: "Update auth credentials (paste new cURL)" },
                    { value: "reconfigure", label: "Full reconfigure (reset everything)" },
                ],
            });

            if (clack.isCancel(action) || action === "done") {
                break;
            }

            if (action === "update-auth") {
                clack.note(
                    "Paste a fresh cURL command from Clarity to update credentials.\nYour mappings will be preserved.",
                    "Update credentials"
                );

                clack.log.step("Paste the cURL command:");
                const curlInput = await readMultilineCurl();

                if (!curlInput.trim()) {
                    clack.log.warn("No cURL command provided.");
                    continue;
                }

                let baseUrl: string;
                let authToken: string;
                let sessionId: string;
                let cookies: string;

                try {
                    ({ baseUrl, authToken, sessionId, cookies } = parseAuthCurl(curlInput));
                } catch (err) {
                    clack.log.error(err instanceof Error ? err.message : String(err));
                    continue;
                }

                const spinner = clack.spinner();
                spinner.start("Testing connection...");
                const api = new ClarityApi({ baseUrl, authToken, sessionId, cookies });

                try {
                    // 0 fetches the default/current timesheet app list, not tied to a specific period
                    const appData = await api.getTimesheetApp(0);
                    const resource = appData.resource._results[0];
                    spinner.stop("Connection successful!");

                    config.baseUrl = baseUrl;
                    config.authToken = authToken;
                    config.sessionId = sessionId;
                    config.cookies = cookies;

                    if (resource) {
                        config.resourceId = resource.id;
                        config.uniqueName = resource.email;
                        clack.log.info(`Logged in as: ${pc.green(resource.full_name)} (${resource.email})`);
                    }

                    await saveConfig(config);
                    clack.log.success(`Auth updated! ${config.mappings.length} mappings preserved.`);
                } catch (err) {
                    spinner.stop("Connection failed");
                    clack.log.error(err instanceof Error ? err.message : String(err));
                }

                continue;
            }

            if (action === "link") {
                await runInteractiveLinking();
                continue;
            }

            if (action === "remove-mapping") {
                if (config.mappings.length === 0) {
                    clack.log.info("No mappings to remove.");
                    continue;
                }

                const toRemove = await clack.select({
                    message: "Select mapping to remove:",
                    options: config.mappings.map((m, i) => ({
                        value: i,
                        label: `ADO #${m.adoWorkItemId} (${m.adoWorkItemTitle}) → ${m.clarityTaskName}`,
                    })),
                });

                // Esc goes back to menu
                if (clack.isCancel(toRemove)) {
                    continue;
                }

                const removed = config.mappings.splice(toRemove as number, 1)[0];
                await saveConfig(config);
                clack.log.success(`Removed: ADO #${removed.adoWorkItemId} → ${removed.clarityTaskName}`);
                continue;
            }

            if (action === "reconfigure") {
                await runInteractiveSetup();
            }
        }
    });
}
