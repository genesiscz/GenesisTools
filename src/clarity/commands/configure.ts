import { ClarityApi } from "@app/utils/clarity";
import { parseCurl } from "@app/utils/curl";
import * as clack from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";
import type { ClarityConfig } from "../config.js";
import { getConfig, saveConfig } from "../config.js";

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

    const curlInput = await clack.text({
        message: "Paste the cURL command:",
        placeholder: "curl 'https://...' -H 'authToken: ...' ...",
        validate(value) {
            if (!value?.trim()) {
                return "cURL command is required";
            }
            if (!value.includes("curl") && !value.includes("http")) {
                return "Doesn't look like a valid cURL command";
            }
        },
    });

    if (clack.isCancel(curlInput)) {
        clack.cancel("Configuration cancelled.");
        process.exit(0);
    }

    const spinner = clack.spinner();
    spinner.start("Parsing cURL command...");

    let parsed: ReturnType<typeof parseCurl>;

    try {
        parsed = parseCurl(curlInput);
    } catch (err) {
        spinner.stop("Failed to parse cURL command");
        clack.log.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
    }

    // Extract base URL
    const urlObj = new URL(parsed.url);
    const baseUrl = `${urlObj.protocol}//${urlObj.host}`;

    // Extract authToken from headers
    const authToken = parsed.headers.authToken || parsed.headers.AuthToken || parsed.headers.AUTHTOKEN;

    if (!authToken) {
        spinner.stop("No authToken header found in cURL");
        clack.log.error("The pasted cURL must contain an 'authToken' header.");
        process.exit(1);
    }

    // Extract sessionId from cookies
    const sessionId = parsed.cookies.sessionId || parsed.cookies.JSESSIONID;

    if (!sessionId) {
        spinner.stop("No sessionId cookie found in cURL");
        clack.log.error("The pasted cURL must contain a 'sessionId' cookie.");
        process.exit(1);
    }

    spinner.stop("cURL parsed successfully");

    clack.log.info(`Base URL: ${pc.cyan(baseUrl)}`);
    clack.log.info(`Auth Token: ${pc.dim(`${authToken.slice(0, 12)}...`)}`);
    clack.log.info(`Session ID: ${pc.dim(`${sessionId.slice(0, 12)}...`)}`);

    // Test connection
    spinner.start("Testing connection...");

    const api = new ClarityApi({ baseUrl, authToken, sessionId });

    try {
        // Try to fetch any timesheet data to validate the credentials
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
    console.log(`  Auth Token:   ${config.authToken.slice(0, 12)}...`);
    console.log(`  Session ID:   ${config.sessionId.slice(0, 12)}...`);
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

async function manageMappings(): Promise<void> {
    const config = await getConfig();

    if (!config) {
        console.error("Clarity not configured. Run: tools clarity configure");
        process.exit(1);
    }

    clack.intro(pc.bgCyan(pc.black(" Clarity Mappings ")));

    if (config.mappings.length === 0) {
        clack.log.info("No mappings configured. Use 'tools clarity link-workitems' to create mappings.");
        clack.outro("Done");
        return;
    }

    console.log("\nCurrent Mappings:");

    for (const [i, m] of config.mappings.entries()) {
        console.log(`  ${i + 1}. ADO #${m.adoWorkItemId} (${m.adoWorkItemTitle})`);
        console.log(`     -> ${m.clarityTaskName} [${m.clarityInvestmentName}]`);
    }

    const action = await clack.select({
        message: "What would you like to do?",
        options: [
            { value: "remove", label: "Remove a mapping" },
            { value: "clear", label: "Remove all mappings" },
            { value: "done", label: "Done" },
        ],
    });

    if (clack.isCancel(action) || action === "done") {
        clack.outro("Done");
        return;
    }

    if (action === "clear") {
        const confirm = await clack.confirm({
            message: `Remove all ${config.mappings.length} mappings?`,
            initialValue: false,
        });

        if (clack.isCancel(confirm) || !confirm) {
            clack.outro("Cancelled");
            return;
        }

        config.mappings = [];
        await saveConfig(config);
        clack.outro("All mappings removed.");
        return;
    }

    if (action === "remove") {
        const toRemove = await clack.select({
            message: "Select mapping to remove:",
            options: config.mappings.map((m, i) => ({
                value: i,
                label: `ADO #${m.adoWorkItemId} -> ${m.clarityTaskName}`,
            })),
        });

        if (clack.isCancel(toRemove)) {
            clack.outro("Cancelled");
            return;
        }

        const removed = config.mappings.splice(toRemove as number, 1)[0];
        await saveConfig(config);
        clack.outro(`Removed mapping: ADO #${removed.adoWorkItemId} -> ${removed.clarityTaskName}`);
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
        .description("Manage ADO-to-Clarity task mappings")
        .action(async () => {
            await manageMappings();
        });

    // Default action: run interactive setup
    cmd.action(async () => {
        await runInteractiveSetup();
    });
}
