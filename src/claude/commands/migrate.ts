import { type Dirent, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
    buildMigrationPlan,
    type DiscoveredSources,
    discoverMigrationSources,
    executeMigrationPlan,
    type MigrationComponent,
    type MigrationMode,
    type MigrationScope,
    type NameStyle,
    summarizeDiscovery,
    summarizeExecution,
    summarizePlan,
} from "@app/claude/lib/migrate-to-codex";
import { DiffUtil } from "@app/utils/diff";
import * as p from "@clack/prompts";
import type { Command } from "commander";
import pc from "picocolors";

interface MigrateCodexOptions {
    source?: string;
    target?: string;
    components?: string;
    mode?: string;
    nameStyle?: string;
    force?: boolean;
    dryRun?: boolean;
    list?: boolean;
    yes?: boolean;
    nonInteractive?: boolean;
}

type ConflictChoice = "overwrite" | "skip" | "rename";

interface WizardState {
    sourceScope: MigrationScope;
    targetScope: MigrationScope;
    components: MigrationComponent[];
    mode: MigrationMode;
    nameStyle: NameStyle;
}

const ALL_COMPONENTS: MigrationComponent[] = ["skills", "commands", "instructions"];

export function registerMigrateCommand(program: Command): void {
    const migrateTo = program.command("migrate-to").description("Migration helpers");

    migrateTo
        .command("codex")
        .description("Guide Claude -> Codex migration (ESC goes one step back in the wizard)")
        .option("--source <scope>", "Source scope: project | global | both")
        .option("--target <scope>", "Target scope: project | global | both", "project")
        .option(
            "--components <list>",
            "Comma-separated components: skills,commands,instructions (default: all components)"
        )
        .option("--mode <mode>", "Transfer mode: symlink | copy", "symlink")
        .option("--name-style <style>", "Target naming style: prefixed | preserve", "prefixed")
        .option("--force", "Overwrite existing destination entries")
        .option("--dry-run", "Preview migration without writing files")
        .option("--list", "List discovered Claude assets and exit")
        .option("-y, --yes", "Apply without final confirmation")
        .option("--non-interactive", "Run without interactive wizard")
        .addHelpText(
            "after",
            `
Examples:
  tools claude migrate-to codex
  tools claude migrate-to codex --list
  tools claude migrate-to codex --source global --target global --components skills,commands --mode symlink -y
  tools claude migrate-to codex --source project --target project --components instructions --mode copy --dry-run
`
        )
        .action(async (options: MigrateCodexOptions) => {
            await runMigrateToCodex(options);
        });
}

async function runMigrateToCodex(options: MigrateCodexOptions): Promise<void> {
    p.intro(pc.bgCyan(pc.black(" claude migrate-to codex ")));

    const projectRoot = process.cwd();
    const discovered = discoverMigrationSources(projectRoot);

    if (options.list) {
        renderDiscoveryList(discovered);
        p.outro("Discovery complete.");
        return;
    }

    const initialState: WizardState = {
        sourceScope: parseScope(options.source, "project"),
        targetScope: parseScope(options.target, "project"),
        components: parseComponents(options.components),
        mode: parseMode(options.mode),
        nameStyle: parseNameStyle(options.nameStyle),
    };

    const interactive = process.stdout.isTTY && process.stdin.isTTY && !options.nonInteractive;
    const state = interactive ? await runWizard(discovered, initialState, options) : initialState;
    if (!state) {
        return;
    }

    const plan = buildMigrationPlan(discovered, {
        projectRoot,
        sourceScope: state.sourceScope,
        targetScope: state.targetScope,
        components: state.components,
        mode: state.mode,
        nameStyle: state.nameStyle,
    });

    if (plan.operations.length === 0) {
        p.log.warn("No operations to apply. Try broader source/target scopes or different components.");
        if (plan.warnings.length > 0) {
            p.note(plan.warnings.join("\n"), "Warnings");
        }
        p.outro("Nothing changed.");
        return;
    }

    let overwriteTargets: string[] = [];
    if (interactive && !options.force) {
        const resolved = await resolveConflictsInteractive(plan);
        if (!resolved) {
            p.cancel("Migration cancelled.");
            return;
        }

        overwriteTargets = [...resolved.overwriteTargets];
    }

    if (!options.yes && !interactive) {
        p.log.warn("Non-interactive mode without -y defaults to preview only. Use -y to apply changes.");
    }

    if (!options.yes && !interactive && !options.dryRun) {
        p.note(summarizePlan(plan), "Planned operations");
        p.outro("Preview complete.");
        return;
    }

    if (!options.yes && interactive) {
        p.note(summarizePlan(plan), "Final plan");
        const confirmed = await p.confirm({
            message: options.dryRun ? "Run dry run?" : "Apply migration now?",
            initialValue: true,
        });

        if (p.isCancel(confirmed) || !confirmed) {
            p.cancel("Migration cancelled.");
            return;
        }
    }

    if (!options.dryRun) {
        for (const targetPath of overwriteTargets) {
            if (existsSync(targetPath)) {
                rmSync(targetPath, { recursive: true, force: true });
            }
        }
    }

    const results = executeMigrationPlan(plan, {
        dryRun: !!options.dryRun,
        force: !!options.force,
    });

    p.note(summarizeExecution(results), options.dryRun ? "Dry run summary" : "Migration summary");

    const failed = results.filter((item) => item.status === "failed");
    if (failed.length > 0) {
        p.note(
            failed
                .slice(0, 20)
                .map((item) => `${item.operation.targetPath} -> ${item.message}`)
                .join("\n"),
            "Failures"
        );
        process.exitCode = 1;
    }

    const skipped = results.filter((item) => item.status === "skipped");
    if (skipped.length > 0) {
        p.note(
            skipped
                .slice(0, 20)
                .map((item) => `${item.operation.targetPath} -> ${item.message}`)
                .join("\n"),
            "Skipped"
        );
    }

    if (plan.warnings.length > 0) {
        p.note(plan.warnings.join("\n"), "Warnings");
    }

    p.outro(options.dryRun ? "Dry run completed." : "Migration completed.");
}

async function runWizard(
    discovered: DiscoveredSources,
    initialState: WizardState,
    options: MigrateCodexOptions
): Promise<WizardState | null> {
    const state: WizardState = {
        sourceScope: initialState.sourceScope,
        targetScope: initialState.targetScope,
        components: [...initialState.components],
        mode: initialState.mode,
        nameStyle: initialState.nameStyle,
    };

    const steps = ["source", "components", "target", "mode", "name-style", "confirm"] as const;
    let currentStep = 0;

    while (currentStep < steps.length) {
        const step = steps[currentStep];

        if (step === "source") {
            const choice = await p.select({
                message: "Choose Claude source scope:",
                options: [
                    {
                        value: "project",
                        label: `Project only (${countScope(discovered, "project")} assets)`,
                    },
                    {
                        value: "global",
                        label: `Global ~/.claude only (${countScope(discovered, "global")} assets)`,
                    },
                    {
                        value: "both",
                        label: `Project + global (${countScope(discovered, "project") + countScope(discovered, "global")} assets)`,
                    },
                ],
                initialValue: state.sourceScope,
            });

            if (p.isCancel(choice)) {
                p.cancel("Migration cancelled.");
                return null;
            }

            state.sourceScope = choice as MigrationScope;
            currentStep += 1;
            continue;
        }

        if (step === "components") {
            const selected = await p.multiselect({
                message: "Select components to migrate:",
                options: [
                    {
                        value: "skills",
                        label: "Skills",
                        hint: "Claude SKILL.md folders -> Codex skill folders",
                        selected: state.components.includes("skills"),
                    },
                    {
                        value: "commands",
                        label: "Commands",
                        hint: "Claude command markdown -> Codex prompt files",
                        selected: state.components.includes("commands"),
                    },
                    {
                        value: "instructions",
                        label: "Instructions",
                        hint: "CLAUDE.md -> AGENTS.md (copy or symlink)",
                        selected: state.components.includes("instructions"),
                    },
                ],
                required: false,
            });

            if (p.isCancel(selected)) {
                currentStep -= 1;
                continue;
            }

            const components = selected as MigrationComponent[];
            if (components.length === 0) {
                p.log.warn("Select at least one component.");
                continue;
            }

            state.components = components;
            currentStep += 1;
            continue;
        }

        if (step === "target") {
            const choice = await p.select({
                message: "Choose Codex target scope:",
                options: [
                    { value: "project", label: "Project (.agents + .codex in current repository)" },
                    { value: "global", label: "Global (~/.codex)" },
                    { value: "both", label: "Project + global" },
                ],
                initialValue: state.targetScope,
            });

            if (p.isCancel(choice)) {
                currentStep -= 1;
                continue;
            }

            state.targetScope = choice as MigrationScope;
            currentStep += 1;
            continue;
        }

        if (step === "mode") {
            const choice = await p.select({
                message: "Choose transfer mode:",
                options: [
                    {
                        value: "symlink",
                        label: "Symlink (recommended for always-in-sync)",
                        hint: "No duplication, Codex reads the source files directly",
                    },
                    {
                        value: "copy",
                        label: "Copy (snapshot)",
                        hint: "Independent files, rerun migration for updates",
                    },
                ],
                initialValue: state.mode,
            });

            if (p.isCancel(choice)) {
                currentStep -= 1;
                continue;
            }

            state.mode = choice as MigrationMode;
            currentStep += 1;
            continue;
        }

        if (step === "name-style") {
            const choice = await p.select({
                message: "Choose target naming style:",
                options: [
                    {
                        value: "prefixed",
                        label: "Prefixed (recommended)",
                        hint: "Avoids collisions across project/global/plugin sources",
                    },
                    {
                        value: "preserve",
                        label: "Preserve original names",
                        hint: "Closest to original names, may collide",
                    },
                ],
                initialValue: state.nameStyle,
            });

            if (p.isCancel(choice)) {
                currentStep -= 1;
                continue;
            }

            state.nameStyle = choice as NameStyle;
            currentStep += 1;
            continue;
        }

        const plan = buildMigrationPlan(discovered, {
            projectRoot: process.cwd(),
            sourceScope: state.sourceScope,
            targetScope: state.targetScope,
            components: state.components,
            mode: state.mode,
            nameStyle: state.nameStyle,
        });

        const detailLines = [
            `Mode: ${state.mode}`,
            `Source scope: ${state.sourceScope}`,
            `Target scope: ${state.targetScope}`,
            `Components: ${state.components.join(", ")}`,
            `Force overwrite: ${options.force ? "yes" : "no"}`,
            `Dry run: ${options.dryRun ? "yes" : "no"}`,
            "",
            summarizePlan(plan),
        ];

        if (plan.warnings.length > 0) {
            detailLines.push("");
            detailLines.push(`Warnings: ${plan.warnings.length}`);
        }

        p.note(detailLines.join("\n"), "Migration plan");

        const confirmed = await p.confirm({
            message: options.dryRun ? "Run dry run with this plan?" : "Apply this migration plan?",
            initialValue: true,
        });

        if (p.isCancel(confirmed)) {
            currentStep -= 1;
            continue;
        }

        if (!confirmed) {
            currentStep -= 1;
            continue;
        }

        return state;
    }

    return null;
}

function formatDiscoveredItem(item: { path: string; origin: string; pluginName?: string }): string {
    const tag = item.origin === "plugin" && item.pluginName ? ` [plugin: ${item.pluginName}]` : "";
    return `- ${item.path}${tag}`;
}

function renderDiscoveryList(discovered: DiscoveredSources): void {
    const lines: string[] = [];
    lines.push(summarizeDiscovery(discovered));
    lines.push("");

    const projectSkills = discovered.skills.filter((entry) => entry.scope === "project");
    lines.push("Project skills:");
    if (projectSkills.length === 0) {
        lines.push("- (none)");
    } else {
        for (const item of projectSkills) {
            lines.push(formatDiscoveredItem(item));
        }
    }

    const globalSkills = discovered.skills.filter((entry) => entry.scope === "global");
    lines.push("");
    lines.push("Global skills:");
    if (globalSkills.length === 0) {
        lines.push("- (none)");
    } else {
        for (const item of globalSkills) {
            lines.push(formatDiscoveredItem(item));
        }
    }

    const projectCommands = discovered.commands.filter((entry) => entry.scope === "project");
    lines.push("");
    lines.push("Project commands:");
    if (projectCommands.length === 0) {
        lines.push("- (none)");
    } else {
        for (const item of projectCommands) {
            lines.push(formatDiscoveredItem(item));
        }
    }

    const globalCommands = discovered.commands.filter((entry) => entry.scope === "global");
    lines.push("");
    lines.push("Global commands:");
    if (globalCommands.length === 0) {
        lines.push("- (none)");
    } else {
        for (const item of globalCommands) {
            lines.push(formatDiscoveredItem(item));
        }
    }

    lines.push("");
    lines.push("Instruction files:");
    for (const item of discovered.instructions) {
        lines.push(`- [${item.scope}] ${item.path}`);
    }
    if (discovered.instructions.length === 0) {
        lines.push("- (none)");
    }

    if (discovered.warnings.length > 0) {
        lines.push("");
        lines.push("Warnings:");
        for (const warning of discovered.warnings) {
            lines.push(`- ${warning}`);
        }
    }

    p.note(lines.join("\n"), "Discovered Claude assets");
}

function countScope(discovered: DiscoveredSources, scope: "project" | "global"): number {
    const skills = discovered.skills.filter((item) => item.scope === scope).length;
    const commands = discovered.commands.filter((item) => item.scope === scope).length;
    const instructions = discovered.instructions.filter((item) => item.scope === scope).length;
    return skills + commands + instructions;
}

function parseScope(value: string | undefined, fallback: MigrationScope): MigrationScope {
    if (!value) {
        return fallback;
    }

    if (value !== "project" && value !== "global" && value !== "both") {
        throw new Error(`Invalid scope "${value}". Use: project | global | both`);
    }

    return value;
}

function parseMode(value: string | undefined): MigrationMode {
    if (!value || value === "symlink") {
        return "symlink";
    }

    if (value === "copy") {
        return "copy";
    }

    throw new Error(`Invalid mode "${value}". Use: symlink | copy`);
}

function parseNameStyle(value: string | undefined): NameStyle {
    if (!value || value === "prefixed") {
        return "prefixed";
    }

    if (value === "preserve") {
        return "preserve";
    }

    throw new Error(`Invalid name style "${value}". Use: prefixed | preserve`);
}

function parseComponents(value: string | undefined): MigrationComponent[] {
    if (!value) {
        return [...ALL_COMPONENTS];
    }

    const parsed = value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

    const invalid = parsed.filter((item) => !ALL_COMPONENTS.includes(item as MigrationComponent));
    if (invalid.length > 0) {
        throw new Error(`Invalid components: ${invalid.join(", ")}. Use any of: ${ALL_COMPONENTS.join(",")}`);
    }

    const unique = [...new Set(parsed)] as MigrationComponent[];
    if (unique.length === 0) {
        throw new Error("At least one component is required.");
    }

    return unique;
}

async function resolveConflictsInteractive(plan: ReturnType<typeof buildMigrationPlan>): Promise<{
    plan: ReturnType<typeof buildMigrationPlan>;
    overwriteTargets: Set<string>;
} | null> {
    const resolvedOperations = [...plan.operations];
    const overwriteTargets = new Set<string>();

    for (let index = 0; index < resolvedOperations.length; index++) {
        const operation = resolvedOperations[index];
        if (!existsSync(operation.targetPath)) {
            continue;
        }

        const choice = await promptConflictChoice(operation.targetPath, operation.sourcePath, operation.component);
        if (!choice) {
            return null;
        }

        if (choice === "skip") {
            resolvedOperations.splice(index, 1);
            index -= 1;
            continue;
        }

        if (choice === "rename") {
            const renamed = await promptRenamePath(operation.targetPath);
            if (!renamed) {
                return null;
            }

            operation.targetPath = renamed;
            operation.label = `${basename(operation.sourcePath)} -> ${basename(renamed)}`;
            continue;
        }

        overwriteTargets.add(operation.targetPath);
    }

    plan.operations = resolvedOperations;
    return { plan, overwriteTargets };
}

async function promptConflictChoice(
    targetPath: string,
    sourcePath: string,
    component: MigrationComponent
): Promise<ConflictChoice | null> {
    while (true) {
        const choice = await p.select({
            message: `Conflict for ${component}: ${targetPath}`,
            options: [
                { value: "overwrite", label: "Overwrite target" },
                { value: "skip", label: "Skip this item" },
                { value: "rename", label: "Use different target name/path" },
                { value: "diff", label: "Show diff and decide again" },
            ],
        });

        if (p.isCancel(choice)) {
            return null;
        }

        if (choice === "diff") {
            await showConflictDiff(targetPath, sourcePath);
            continue;
        }

        return choice as ConflictChoice;
    }
}

async function promptRenamePath(targetPath: string): Promise<string | null> {
    const defaultName = `${basename(targetPath)}-migrated`;
    const suggested = join(dirname(targetPath), defaultName);

    const renamed = await p.text({
        message: "New target path:",
        placeholder: suggested,
        defaultValue: suggested,
        validate: (value) => {
            if (!value || !value.trim()) {
                return "Path is required";
            }

            if (existsSync(resolve(value.trim()))) {
                return "Path already exists, choose a different name";
            }
        },
    });

    if (p.isCancel(renamed)) {
        return null;
    }

    return resolve((renamed as string).trim());
}

async function showConflictDiff(targetPath: string, sourcePath: string): Promise<void> {
    const oldPreview = renderPathPreview(targetPath, 2);
    const newPreview = renderPathPreview(sourcePath, 2);
    await DiffUtil.showDiff(oldPreview, newPreview, `existing:${targetPath}`, `incoming:${sourcePath}`);
}

function renderPathPreview(path: string, depth: number): string {
    try {
        if (!existsSync(path)) {
            return "(missing)";
        }

        const stat = lstatSync(path);
        if (stat.isSymbolicLink()) {
            return `symlink -> ${readlinkSync(path)}`;
        }

        if (stat.isFile()) {
            const content = readFileSync(path, "utf-8");
            if (content.length > 25_000) {
                return `${content.slice(0, 25_000)}\n\n... [truncated ${content.length - 25_000} chars]`;
            }

            return content;
        }

        if (stat.isDirectory()) {
            return renderDirectoryTree(path, depth);
        }

        return `(unsupported path type: ${path})`;
    } catch {
        return `(failed to read: ${path})`;
    }
}

function renderDirectoryTree(dirPath: string, maxDepth: number): string {
    const lines: string[] = [];
    const walk = (currentPath: string, level: number): void => {
        if (level > maxDepth) {
            lines.push(`${"  ".repeat(level)}...`);
            return;
        }

        let entries: Dirent[];
        try {
            entries = readdirSync(currentPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
        } catch {
            return;
        }

        for (const entry of entries) {
            const entryPath = join(currentPath, entry.name);
            const rel = relative(dirPath, entryPath) || ".";
            const prefix = "  ".repeat(level);

            if (entry.isDirectory()) {
                lines.push(`${prefix}${rel}/`);
                walk(entryPath, level + 1);
                continue;
            }

            if (entry.isSymbolicLink()) {
                lines.push(`${prefix}${rel} -> ${readlinkSync(entryPath)}`);
                continue;
            }

            lines.push(`${prefix}${rel}`);
        }
    };

    walk(dirPath, 0);
    return lines.join("\n");
}
