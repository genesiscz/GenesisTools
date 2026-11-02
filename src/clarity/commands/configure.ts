import { saveSignIn } from "@app/clarity/lib/auth/client";
import { authDriverIds, chooseAuthDriver, DEFAULT_AUTH_DRIVER } from "@app/clarity/lib/auth/drivers";
import { claritySessionStore } from "@app/clarity/lib/auth/session-store";
import type { ClarityAuthDriver } from "@app/clarity/lib/auth/types";
import * as clack from "@clack/prompts";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import pc from "picocolors";
import type { ClarityConfig } from "../config.js";
import { getConfig, saveConfig } from "../config.js";
import { runInteractiveLinking } from "../lib/interactive-linking.js";

/** Sign in with the driver, test the connection, and save. False when any step failed (already reported). */
async function signInAndSave(driver: ClarityAuthDriver, existing: ClarityConfig | null): Promise<boolean> {
    let auth: Awaited<ReturnType<ClarityAuthDriver["signIn"]>>;

    try {
        auth = await driver.signIn({ baseUrl: existing?.baseUrl });
    } catch (err) {
        clack.log.error(err instanceof Error ? err.message : String(err));
        return false;
    }

    clack.log.info(`Base URL: ${pc.cyan(auth.baseUrl)}`);
    const spinner = clack.spinner();
    spinner.start("Testing connection...");

    try {
        const { resource } = await saveSignIn({ auth, driver, existing });
        spinner.stop("Connection successful!");

        if (resource) {
            clack.log.info(`Logged in as: ${pc.green(resource.full_name)} (${resource.email})`);
        }

        return true;
    } catch (err) {
        spinner.stop("Connection failed");
        clack.log.error(err instanceof Error ? err.message : String(err));
        clack.log.warn("The credentials may be expired. Sign in again.");
        return false;
    }
}

async function runInteractiveSetup(driverFlag?: string): Promise<void> {
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

    const driver = await chooseAuthDriver(driverFlag, existingConfig?.auth?.driver);

    if (!driver) {
        clack.cancel("Configuration unchanged.");
        process.exit(0);
    }

    if (!(await signInAndSave(driver, existingConfig))) {
        process.exit(1);
    }

    clack.outro(pc.green("Configuration saved!"));
}

async function showConfig(config: ClarityConfig): Promise<void> {
    const session = await claritySessionStore.read();

    out.println("\nClarity Configuration:");
    out.println(`  Base URL:     ${config.baseUrl}`);
    out.println(`  Session:      ${session ? "saved" : "none"} (${claritySessionStore.describe()})`);
    out.println(`  Auth driver:  ${config.auth?.driver ?? DEFAULT_AUTH_DRIVER}`);
    out.println(`  Resource ID:  ${config.resourceId ?? "not set"}`);
    out.println(`  User:         ${config.uniqueName ?? "not set"}`);
    out.println(`  Mappings:     ${config.mappings.length}`);

    if (config.mappings.length > 0) {
        out.println("\n  ADO Work Item -> Clarity Task:");

        for (const m of config.mappings) {
            out.println(
                `    #${m.adoWorkItemId} (${m.adoWorkItemTitle}) -> ${m.clarityTaskName} [${m.clarityInvestmentName}]`
            );
        }
    }
}

export function registerConfigureCommand(program: Command): void {
    const cmd = program.command("configure").description("Configure Clarity PPM connection and mappings");

    cmd.command("auth")
        .description("Set up authentication (interactive)")
        .option("--driver <id>", `How to sign in: ${authDriverIds()}`)
        .action(async (options: { driver?: string }) => {
            await runInteractiveSetup(options.driver);
        });

    cmd.command("show")
        .description("Show current configuration")
        .action(async () => {
            const config = await getConfig();

            if (!config) {
                out.error(`Clarity not configured. Run: ${toolCommand("clarity configure auth")}`);
                process.exit(1);
            }

            await showConfig(config);
        });

    cmd.command("mappings")
        .description("Add/manage ADO-to-Clarity task mappings (interactive)")
        .action(async () => {
            await runInteractiveLinking();
        });

    cmd.command("update-auth")
        .description("Sign in again; mappings are kept")
        .option("--driver <id>", `How to sign in: ${authDriverIds()}`)
        .action(async (options: { driver?: string }) => {
            const config = await getConfig();

            if (!config) {
                out.error(`Clarity not configured. Run: ${toolCommand("clarity configure auth")}`);
                process.exit(1);
            }

            clack.intro(pc.bgCyan(pc.black(" Update Clarity Auth ")));
            const driver = await chooseAuthDriver(options.driver, config.auth?.driver);

            if (!driver) {
                clack.cancel("Auth unchanged.");
                process.exit(0);
            }

            if (!(await signInAndSave(driver, config))) {
                process.exit(1);
            }

            clack.outro(pc.green(`Auth updated! ${config.mappings.length} mappings preserved.`));
        });

    // Default action: show config + menu
    cmd.action(async () => {
        let config = await getConfig();

        if (!config) {
            clack.intro(pc.bgCyan(pc.black(" Clarity PPM Configuration ")));
            clack.log.warn("Not configured yet.");
            clack.log.info(`Run: ${toolCommand("clarity configure auth")}`);
            clack.outro("");
            return;
        }

        // Multi-loop: show menu repeatedly, Esc on menu exits
        while (true) {
            // Refresh config each iteration (may have changed)
            config = (await getConfig())!;
            await showConfig(config);

            const action = await clack.select({
                message: "What would you like to do?",
                options: [
                    { value: "done", label: "Done" },
                    { value: "link", label: "Add/update mappings (link work items)" },
                    { value: "remove-mapping", label: "Remove a mapping" },
                    { value: "update-auth", label: "Update auth credentials (sign in again)" },
                    { value: "reconfigure", label: "Full reconfigure (reset everything)" },
                ],
            });

            if (clack.isCancel(action) || action === "done") {
                break;
            }

            if (action === "update-auth") {
                const driver = await chooseAuthDriver(undefined, config.auth?.driver);

                if (driver && (await signInAndSave(driver, config))) {
                    clack.log.success(`Auth updated! ${config.mappings.length} mappings preserved.`);
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
