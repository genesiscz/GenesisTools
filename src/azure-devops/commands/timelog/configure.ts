import { Command } from "commander";
import { $ } from "bun";
import { readFileSync, writeFileSync } from "fs";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { loadConfig, findConfigPath } from "@app/azure-devops/utils";
import type { AzureConfigWithTimeLog, TimeLogConfig } from "@app/azure-devops/types";

// Common work item types in Azure DevOps
const COMMON_WORK_ITEM_TYPES = [
    "Bug",
    "Task",
    "User Story",
    "Incident",
    "Feature",
    "Epic",
] as const;

// Common work item states in Azure DevOps
const COMMON_STATES = [
    "New",
    "Active",
    "In Progress",
    "Development",
    "Blocked",
    "Resolved",
    "Closed",
    "Done",
] as const;

// Well-known terminal states (deprioritized by default)
const WELL_KNOWN_TERMINAL_STATES = ["Closed", "Done", "Resolved", "Removed"];

interface ConfigureOptions {
    allowedWorkItemTypes?: string;
    allowedStatesForType?: string[];
    deprioritizedStates?: string;
}

function hasExplicitFlags(options: ConfigureOptions): boolean {
    return options.allowedWorkItemTypes !== undefined
        || (options.allowedStatesForType !== undefined && options.allowedStatesForType.length > 0)
        || options.deprioritizedStates !== undefined;
}

function loadExistingConfig(): { config: AzureConfigWithTimeLog; configPath: string } {
    const config = loadConfig() as AzureConfigWithTimeLog | null;

    if (!config?.org) {
        console.error("Run 'tools azure-devops configure <url>' first");
        process.exit(1);
    }

    const configPath = findConfigPath();

    if (!configPath) {
        console.error("Config file not found");
        process.exit(1);
    }

    return { config, configPath };
}

function saveConfig(configPath: string, config: AzureConfigWithTimeLog): void {
    writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function extractOrgName(config: AzureConfigWithTimeLog): string {
    const orgMatch = config.org.match(/dev\.azure\.com\/([^/]+)/);
    const orgName = orgMatch?.[1];

    if (!orgName) {
        console.error("Could not extract organization name from config.org");
        process.exit(1);
    }

    return orgName;
}

async function fetchFunctionsKey(orgName: string): Promise<string> {
    const result =
        await $`az rest --method GET --resource "499b84ac-1321-427f-aa17-267ca6975798" --uri "https://extmgmt.dev.azure.com/${orgName}/_apis/ExtensionManagement/InstalledExtensions/TimeLog/time-logging/Data/Scopes/Default/Current/Collections/%24settings/Documents?api-version=7.1-preview"`.quiet();

    const data = JSON.parse(result.text());
    const configDoc = data.find((d: { id: string }) => d.id === "Config");

    if (!configDoc?.value) {
        throw new Error("TimeLog extension not configured in Azure DevOps");
    }

    const settings = JSON.parse(configDoc.value);
    const apiKey = settings.find((s: { id: string }) => s.id === "ApiKeyTextBox")?.value;

    if (!apiKey) {
        throw new Error("API key not found in TimeLog settings");
    }

    return apiKey;
}

function formatCurrentConfig(timelog: TimeLogConfig | undefined): string {
    const lines: string[] = [];

    if (!timelog) {
        lines.push(pc.dim("  No timelog configuration found yet."));
        return lines.join("\n");
    }

    lines.push(`  functionsKey: ${timelog.functionsKey ? pc.green("configured") : pc.red("missing")}`);

    if (timelog.defaultUser) {
        lines.push(`  defaultUser: ${pc.cyan(timelog.defaultUser.userName)} <${timelog.defaultUser.userEmail}>`);
    } else {
        lines.push(`  defaultUser: ${pc.yellow("not configured")}`);
    }

    if (timelog.allowedWorkItemTypes?.length) {
        lines.push(`  allowedWorkItemTypes: ${pc.cyan(timelog.allowedWorkItemTypes.join(", "))}`);
    } else {
        lines.push(`  allowedWorkItemTypes: ${pc.dim("not configured (all types allowed)")}`);
    }

    if (timelog.allowedStatesPerType && Object.keys(timelog.allowedStatesPerType).length > 0) {
        lines.push("  allowedStatesPerType:");
        for (const [type, states] of Object.entries(timelog.allowedStatesPerType)) {
            lines.push(`    ${pc.bold(type)}: ${pc.cyan((states as string[]).join(", "))}`);
        }
    } else {
        lines.push(`  allowedStatesPerType: ${pc.dim("not configured (all states allowed)")}`);
    }

    if (timelog.deprioritizedStates?.length) {
        lines.push(`  deprioritizedStates: ${pc.yellow(timelog.deprioritizedStates.join(", "))} ${pc.dim("(fallback only)")}`);
    } else {
        lines.push(`  deprioritizedStates: ${pc.dim("using defaults (Closed, Done, Resolved, Removed)")}`);
    }

    return lines.join("\n");
}

async function handleInteractive(config: AzureConfigWithTimeLog, configPath: string): Promise<void> {
    p.intro(pc.bold("TimeLog Configuration"));

    p.note(
        formatCurrentConfig(config.timelog),
        "Current Configuration"
    );

    p.log.info(pc.dim("For non-interactive use, run: tools azure-devops timelog configure --help"));

    config.timelog = config.timelog || {} as TimeLogConfig;

    // Step 1: Fetch functionsKey if missing
    if (!config.timelog.functionsKey) {
        const shouldFetch = await p.confirm({
            message: "API key is missing. Fetch it from Azure DevOps now?",
            initialValue: true,
        });

        if (p.isCancel(shouldFetch)) {
            p.cancel("Operation cancelled.");
            process.exit(0);
        }

        if (shouldFetch) {
            const orgName = extractOrgName(config);
            const spinner = p.spinner();
            spinner.start("Fetching TimeLog API key from Azure DevOps...");

            try {
                const apiKey = await fetchFunctionsKey(orgName);
                config.timelog.functionsKey = apiKey;
                spinner.stop("API key fetched successfully");
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                spinner.stop(pc.red(`Failed to fetch API key: ${message}`));

                const manualKey = await p.text({
                    message: "Enter API key manually (or press Escape to skip):",
                    placeholder: "your-api-key",
                });

                if (p.isCancel(manualKey)) {
                    p.log.warn("Skipping API key configuration.");
                } else if (manualKey) {
                    config.timelog.functionsKey = manualKey;
                }
            }
        }
    } else {
        p.log.success("API key is already configured.");
    }

    // Step 2: Default user
    if (!config.timelog.defaultUser) {
        p.log.warn("Default user is not configured.");

        const userName = await p.text({
            message: "Enter your display name:",
            placeholder: "John Doe",
            validate: (value) => {
                if (!value?.trim()) {
                    return "Display name is required";
                }
            },
        });

        if (p.isCancel(userName)) {
            p.cancel("Operation cancelled.");
            process.exit(0);
        }

        const userEmail = await p.text({
            message: "Enter your email:",
            placeholder: "john.doe@example.com",
            validate: (value) => {
                if (!value?.trim()) {
                    return "Email is required";
                }

                if (!value.includes("@")) {
                    return "Must be a valid email address";
                }
            },
        });

        if (p.isCancel(userEmail)) {
            p.cancel("Operation cancelled.");
            process.exit(0);
        }

        const userId = await p.text({
            message: "Enter your Azure AD Object ID (GUID):",
            placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
            validate: (value) => {
                if (!value?.trim()) {
                    return "User ID is required";
                }

                if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim())) {
                    return "Must be a valid GUID (e.g., xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx)";
                }
            },
        });

        if (p.isCancel(userId)) {
            p.cancel("Operation cancelled.");
            process.exit(0);
        }

        config.timelog.defaultUser = {
            userId: (userId as string).trim(),
            userName: (userName as string).trim(),
            userEmail: (userEmail as string).trim(),
        };
    } else {
        p.log.success(`Default user: ${config.timelog.defaultUser.userName} <${config.timelog.defaultUser.userEmail}>`);
    }

    // Step 3: Allowed work item types
    const currentTypes = config.timelog.allowedWorkItemTypes || [];

    const selectedTypes = await p.multiselect({
        message: `Select allowed work item types ${pc.dim("(space to toggle)")}`,
        options: COMMON_WORK_ITEM_TYPES.map((type) => ({
            value: type,
            label: type,
            hint: currentTypes.includes(type) ? "currently selected" : undefined,
        })),
        initialValues: currentTypes.length > 0
            ? currentTypes.filter((t) => (COMMON_WORK_ITEM_TYPES as readonly string[]).includes(t))
            : [],
        required: false,
    });

    if (p.isCancel(selectedTypes)) {
        p.cancel("Operation cancelled.");
        process.exit(0);
    }

    const typesArray = selectedTypes as string[];

    if (typesArray.length > 0) {
        config.timelog.allowedWorkItemTypes = typesArray;
    } else {
        delete config.timelog.allowedWorkItemTypes;
    }

    // Step 4: Allowed states per type
    const typesToConfigure = typesArray.length > 0 ? typesArray : [...COMMON_WORK_ITEM_TYPES];
    const currentStatesPerType = config.timelog.allowedStatesPerType || {};

    const shouldConfigureStates = await p.confirm({
        message: "Configure allowed states per work item type?",
        initialValue: Object.keys(currentStatesPerType).length > 0,
    });

    if (p.isCancel(shouldConfigureStates)) {
        p.cancel("Operation cancelled.");
        process.exit(0);
    }

    if (shouldConfigureStates) {
        const newStatesPerType: Record<string, string[]> = {};

        for (const type of typesToConfigure) {
            const currentStates = currentStatesPerType[type] || [];

            const selectedStates = await p.multiselect({
                message: `Allowed states for ${pc.bold(type)} ${pc.dim("(space to toggle)")}`,
                options: COMMON_STATES.map((state) => ({
                    value: state,
                    label: state,
                    hint: currentStates.includes(state) ? "currently selected" : undefined,
                })),
                initialValues: currentStates.filter((s) => (COMMON_STATES as readonly string[]).includes(s)),
                required: false,
            });

            if (p.isCancel(selectedStates)) {
                p.cancel("Operation cancelled.");
                process.exit(0);
            }

            const statesArray = selectedStates as string[];

            if (statesArray.length > 0) {
                newStatesPerType[type] = statesArray;
            }
        }

        if (Object.keys(newStatesPerType).length > 0) {
            config.timelog.allowedStatesPerType = newStatesPerType;
        } else {
            delete config.timelog.allowedStatesPerType;
        }
    } else {
        delete config.timelog.allowedStatesPerType;
    }

    // Step 5: Deprioritized states (fallback states like Closed/Done/Resolved)
    const allSelectedStates = new Set<string>();
    if (config.timelog.allowedStatesPerType) {
        for (const states of Object.values(config.timelog.allowedStatesPerType)) {
            for (const s of states as string[]) allSelectedStates.add(s);
        }
    }

    const terminalCandidates = allSelectedStates.size > 0
        ? [...allSelectedStates].filter((s) => WELL_KNOWN_TERMINAL_STATES.includes(s))
        : [...WELL_KNOWN_TERMINAL_STATES];

    if (terminalCandidates.length > 0) {
        const currentDeprioritized = config.timelog.deprioritizedStates || [];

        const selectedDeprioritized = await p.multiselect({
            message: `Which states are fallback-only? ${pc.dim("(active states of default user are preferred)")}`,
            options: terminalCandidates.map((state) => ({
                value: state,
                label: state,
                hint: currentDeprioritized.includes(state) ? "currently deprioritized" : undefined,
            })),
            initialValues: currentDeprioritized.length > 0
                ? currentDeprioritized.filter((s) => terminalCandidates.includes(s))
                : terminalCandidates,
            required: false,
        });

        if (p.isCancel(selectedDeprioritized)) {
            p.cancel("Operation cancelled.");
            process.exit(0);
        }

        const deprioritizedArray = selectedDeprioritized as string[];

        if (deprioritizedArray.length > 0) {
            config.timelog.deprioritizedStates = deprioritizedArray;
        } else {
            delete config.timelog.deprioritizedStates;
        }
    }

    // Step 6: Summary and confirm
    p.note(
        formatCurrentConfig(config.timelog),
        "New Configuration"
    );

    const shouldSave = await p.confirm({
        message: "Save this configuration?",
        initialValue: true,
    });

    if (p.isCancel(shouldSave) || !shouldSave) {
        p.cancel("Configuration not saved.");
        process.exit(0);
    }

    const fullConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    fullConfig.timelog = config.timelog;
    saveConfig(configPath, fullConfig);

    p.outro(pc.green("Configuration saved successfully."));
}

function parseStatesForType(mappings: string[]): Record<string, string[]> {
    const result: Record<string, string[]> = {};

    for (const mapping of mappings) {
        const colonIndex = mapping.indexOf(":");

        if (colonIndex === -1) {
            console.error(`Invalid format: "${mapping}". Expected "Type:State1,State2"`);
            process.exit(1);
        }

        const type = mapping.slice(0, colonIndex).trim();
        const states = mapping
            .slice(colonIndex + 1)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);

        if (!type || states.length === 0) {
            console.error(`Invalid format: "${mapping}". Expected "Type:State1,State2"`);
            process.exit(1);
        }

        result[type] = states;
    }

    return result;
}

function handleNonInteractive(options: ConfigureOptions): void {
    const { configPath } = loadExistingConfig();
    const fullConfig = JSON.parse(readFileSync(configPath, "utf-8"));
    fullConfig.timelog = fullConfig.timelog || {};

    if (options.allowedWorkItemTypes !== undefined) {
        const types = options.allowedWorkItemTypes
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean);

        if (types.length === 0) {
            delete fullConfig.timelog.allowedWorkItemTypes;
            console.log("Cleared allowedWorkItemTypes");
        } else {
            fullConfig.timelog.allowedWorkItemTypes = types;
            console.log(`Set allowedWorkItemTypes: ${types.join(", ")}`);
        }
    }

    if (options.allowedStatesForType && options.allowedStatesForType.length > 0) {
        const statesPerType = parseStatesForType(options.allowedStatesForType);
        fullConfig.timelog.allowedStatesPerType = {
            ...fullConfig.timelog.allowedStatesPerType,
            ...statesPerType,
        };
        console.log("Updated allowedStatesPerType:");

        for (const [type, states] of Object.entries(statesPerType)) {
            console.log(`  ${type}: ${states.join(", ")}`);
        }
    }

    if (options.deprioritizedStates !== undefined) {
        const states = options.deprioritizedStates
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);

        if (states.length === 0) {
            delete fullConfig.timelog.deprioritizedStates;
            console.log("Cleared deprioritizedStates (using defaults: Closed, Done, Resolved, Removed)");
        } else {
            fullConfig.timelog.deprioritizedStates = states;
            console.log(`Set deprioritizedStates: ${states.join(", ")}`);
        }
    }

    saveConfig(configPath, fullConfig);
    console.log("\nConfiguration saved.");
}

function collectOption(value: string, previous: string[]): string[] {
    return [...previous, value];
}

export function registerConfigureSubcommand(parent: Command): void {
    parent
        .command("configure")
        .description("Configure TimeLog settings (interactive by default)")
        .option("--allowed-work-item-types <types>", "Comma-separated list of allowed work item types (e.g., \"Bug,Task\")")
        .option("--allowed-states-for-type <mapping>", "Type:State1,State2 mapping (repeatable)", collectOption, [])
        .option("--deprioritized-states <states>", "Comma-separated fallback states (e.g., \"Closed,Done,Resolved\")")
        .action(async (options: ConfigureOptions) => {
            if (hasExplicitFlags(options)) {
                handleNonInteractive(options);
                return;
            }

            const { config, configPath } = loadExistingConfig();
            await handleInteractive(config, configPath);
        });
}
