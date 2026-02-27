import {
    cpSync,
    type Dirent,
    existsSync,
    lstatSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    rmSync,
    statSync,
    symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";

export type MigrationScope = "project" | "global" | "both";
export type SingleScope = "project" | "global";
export type MigrationComponent = "skills" | "commands" | "instructions";
export type MigrationMode = "symlink" | "copy";
export type NameStyle = "prefixed" | "preserve";

type SourceOrigin = "claude" | "plugin";

export interface SkillSource {
    path: string;
    scope: SingleScope;
    origin: SourceOrigin;
    pluginName?: string;
}

export interface CommandSource {
    path: string;
    scope: SingleScope;
    origin: SourceOrigin;
    namespace: string;
    pluginName?: string;
}

export interface InstructionSource {
    path: string;
    scope: SingleScope;
    origin: "claude";
}

export interface DiscoveredSources {
    skills: SkillSource[];
    commands: CommandSource[];
    instructions: InstructionSource[];
    warnings: string[];
}

export interface MigrationPlanInput {
    projectRoot: string;
    sourceScope: MigrationScope;
    targetScope: MigrationScope;
    components: MigrationComponent[];
    mode: MigrationMode;
    nameStyle: NameStyle;
}

export interface PlannedOperation {
    component: MigrationComponent;
    mode: MigrationMode;
    sourceScope: SingleScope;
    targetScope: SingleScope;
    sourcePath: string;
    targetPath: string;
    label: string;
}

export interface MigrationPlan {
    operations: PlannedOperation[];
    warnings: string[];
}

export interface ExecutePlanOptions {
    dryRun: boolean;
    force: boolean;
}

export interface OperationResult {
    operation: PlannedOperation;
    status: "created" | "updated" | "skipped" | "failed";
    message: string;
}

interface PluginDeclaration {
    name: string;
    rootDir: string;
    skills: string[];
    commands: string[];
    scope: SingleScope;
}

const PROJECT_CLAUDE_DIRNAME = ".claude";
const PROJECT_CLAUDE_PLUGIN_DIRNAME = ".claude-plugin";
const GLOBAL_CLAUDE_DIR = join(homedir(), ".claude");
const GLOBAL_CODEX_DIR = join(homedir(), ".codex");

export function discoverMigrationSources(projectRoot: string): DiscoveredSources {
    const warnings: string[] = [];
    const skills: SkillSource[] = [];
    const commands: CommandSource[] = [];
    const instructions: InstructionSource[] = [];

    const seenSkills = new Set<string>();
    const seenCommands = new Set<string>();
    const seenInstructions = new Set<string>();

    const projectClaudeDir = join(projectRoot, PROJECT_CLAUDE_DIRNAME);
    const projectClaudeSkillsDir = join(projectClaudeDir, "skills");
    const projectClaudeCommandsDir = join(projectClaudeDir, "commands");
    const projectClaudeMd = join(projectRoot, "CLAUDE.md");

    addSkillDirs(skills, seenSkills, collectSkillDirs(projectClaudeSkillsDir), "project", "claude");
    addCommandFiles(
        commands,
        seenCommands,
        collectMarkdownFiles(projectClaudeCommandsDir),
        "project",
        "claude",
        "claude"
    );
    addInstruction(instructions, seenInstructions, projectClaudeMd, "project");

    const plugins = discoverProjectPlugins(projectRoot, warnings);
    for (const plugin of plugins) {
        const skillDirs = collectSkillDirsFromPaths(plugin.rootDir, plugin.skills, warnings);
        addSkillDirs(skills, seenSkills, skillDirs, plugin.scope, "plugin", plugin.name);

        const commandFiles = collectCommandFilesFromPaths(plugin.rootDir, plugin.commands, warnings);
        addCommandFiles(
            commands,
            seenCommands,
            commandFiles,
            plugin.scope,
            "plugin",
            normalizeSegment(plugin.name),
            plugin.name
        );
    }

    const globalSkillsDir = join(GLOBAL_CLAUDE_DIR, "skills");
    const globalCommandsDir = join(GLOBAL_CLAUDE_DIR, "commands");
    const globalClaudeMd = join(GLOBAL_CLAUDE_DIR, "CLAUDE.md");

    addSkillDirs(skills, seenSkills, collectSkillDirs(globalSkillsDir), "global", "claude");
    addCommandFiles(commands, seenCommands, collectMarkdownFiles(globalCommandsDir), "global", "claude", "claude");
    addInstruction(instructions, seenInstructions, globalClaudeMd, "global");

    return {
        skills: sortByPath(skills),
        commands: sortByPath(commands),
        instructions: sortByPath(instructions),
        warnings,
    };
}

export function buildMigrationPlan(discovered: DiscoveredSources, input: MigrationPlanInput): MigrationPlan {
    const warnings = [...discovered.warnings];
    const operations: PlannedOperation[] = [];
    const sourceScopes = expandScope(input.sourceScope);
    const targetScopes = expandScope(input.targetScope);
    const selected = new Set(input.components);
    const seenTargets = new Set<string>();

    if (selected.has("skills")) {
        const skillSources = discovered.skills.filter((item) => sourceScopes.includes(item.scope));

        for (const targetScope of targetScopes) {
            const nameUsedByTarget = new Set<string>();
            for (const source of skillSources) {
                const targetBase =
                    targetScope === "project"
                        ? join(input.projectRoot, ".agents", "skills")
                        : join(GLOBAL_CODEX_DIR, "skills");

                if (targetScope === "project" && !isInsideDir(source.path, input.projectRoot)) {
                    warnings.push(
                        `Skipping project-scope target for out-of-repo skill: ${basename(source.path)} (source: ${source.path})`
                    );
                    continue;
                }

                if (targetScope === "global" && source.scope === "project" && source.origin !== "plugin") {
                    warnings.push(
                        `Skipping global target for project-scoped skill: ${basename(source.path)} (source: ${source.path})`
                    );
                    continue;
                }

                const skillName = buildSkillTargetName(source, input.nameStyle, nameUsedByTarget);
                const targetPath = join(targetBase, skillName);

                if (seenTargets.has(targetPath)) {
                    warnings.push(`Skipping duplicate skill target: ${targetPath}`);
                    continue;
                }

                seenTargets.add(targetPath);
                operations.push({
                    component: "skills",
                    mode: input.mode,
                    sourceScope: source.scope,
                    targetScope,
                    sourcePath: source.path,
                    targetPath,
                    label: `${basename(source.path)} -> ${skillName}`,
                });
            }
        }
    }

    if (selected.has("commands")) {
        const commandSources = discovered.commands.filter((item) => sourceScopes.includes(item.scope));

        for (const targetScope of targetScopes) {
            const namespaceClaimed = new Map<string, string>();
            for (const source of commandSources) {
                const targetBase =
                    targetScope === "project"
                        ? join(input.projectRoot, ".codex", "prompts")
                        : join(GLOBAL_CODEX_DIR, "prompts");

                if (targetScope === "project" && !isInsideDir(source.path, input.projectRoot)) {
                    warnings.push(
                        `Skipping project-scope target for out-of-repo command: ${basename(source.path)} (source: ${source.path})`
                    );
                    continue;
                }

                if (targetScope === "global" && source.scope === "project" && source.origin !== "plugin") {
                    warnings.push(
                        `Skipping global target for project-scoped command: ${basename(source.path)} (source: ${source.path})`
                    );
                    continue;
                }

                const namespace = buildCommandNamespace(source, input.nameStyle, namespaceClaimed);
                const targetPath = join(targetBase, namespace, basename(source.path));

                if (seenTargets.has(targetPath)) {
                    warnings.push(`Skipping duplicate command target: ${targetPath}`);
                    continue;
                }

                seenTargets.add(targetPath);
                operations.push({
                    component: "commands",
                    mode: input.mode,
                    sourceScope: source.scope,
                    targetScope,
                    sourcePath: source.path,
                    targetPath,
                    label: `${basename(source.path, extname(source.path))} -> /${namespace}:${basename(source.path, extname(source.path))}`,
                });
            }
        }
    }

    if (selected.has("instructions")) {
        const instructionSources = discovered.instructions.filter((item) => sourceScopes.includes(item.scope));

        for (const source of instructionSources) {
            for (const targetScope of targetScopes) {
                const targetPath =
                    targetScope === "project"
                        ? join(input.projectRoot, "AGENTS.md")
                        : join(GLOBAL_CODEX_DIR, "AGENTS.md");

                if (seenTargets.has(targetPath)) {
                    warnings.push(`Skipping duplicate instruction target: ${targetPath}`);
                    continue;
                }

                seenTargets.add(targetPath);
                operations.push({
                    component: "instructions",
                    mode: input.mode,
                    sourceScope: source.scope,
                    targetScope,
                    sourcePath: source.path,
                    targetPath,
                    label: `${source.path} -> ${targetPath}`,
                });
            }
        }
    }

    return { operations, warnings };
}

export function executeMigrationPlan(plan: MigrationPlan, options: ExecutePlanOptions): OperationResult[] {
    const results: OperationResult[] = [];

    for (const operation of plan.operations) {
        try {
            if (!existsSync(operation.sourcePath)) {
                results.push({
                    operation,
                    status: "skipped",
                    message: `Source not found: ${operation.sourcePath}`,
                });
                continue;
            }

            const targetExists = existsSync(operation.targetPath);
            if (targetExists && !options.force) {
                if (operation.mode === "symlink" && isSameSymlink(operation.targetPath, operation.sourcePath)) {
                    results.push({
                        operation,
                        status: "skipped",
                        message: "Already linked",
                    });
                    continue;
                }

                results.push({
                    operation,
                    status: "skipped",
                    message: "Target exists (use --force to overwrite)",
                });
                continue;
            }

            if (targetExists && options.force) {
                if (!options.dryRun) {
                    rmSync(operation.targetPath, { recursive: true, force: true });
                }
            }

            if (!options.dryRun) {
                mkdirSync(dirname(operation.targetPath), { recursive: true });

                if (operation.mode === "copy") {
                    copyPath(operation.sourcePath, operation.targetPath);
                } else {
                    createSymlink(operation.sourcePath, operation.targetPath, operation.targetScope === "project");
                }
            }

            results.push({
                operation,
                status: targetExists ? "updated" : "created",
                message: options.dryRun ? "Dry run" : operation.mode === "copy" ? "Copied" : "Linked",
            });
        } catch (error) {
            results.push({
                operation,
                status: "failed",
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }

    return results;
}

export function summarizePlan(plan: MigrationPlan): string {
    const componentCounts = countByComponent(plan.operations);
    const lines: string[] = [];
    lines.push(`Operations: ${plan.operations.length}`);
    lines.push(`- skills: ${componentCounts.skills}`);
    lines.push(`- commands: ${componentCounts.commands}`);
    lines.push(`- instructions: ${componentCounts.instructions}`);

    if (plan.operations.length > 0) {
        lines.push("");
        lines.push("Preview:");
        for (const item of plan.operations) {
            lines.push(`- [${item.component}] ${item.label}`);
        }
    }

    return lines.join("\n");
}

export function summarizeDiscovery(discovered: DiscoveredSources): string {
    const lines: string[] = [];
    lines.push(`Skills: ${discovered.skills.length}`);
    lines.push(`Commands: ${discovered.commands.length}`);
    lines.push(`Instruction files: ${discovered.instructions.length}`);

    const projectSkills = discovered.skills.filter((item) => item.scope === "project").length;
    const globalSkills = discovered.skills.filter((item) => item.scope === "global").length;
    const projectCommands = discovered.commands.filter((item) => item.scope === "project").length;
    const globalCommands = discovered.commands.filter((item) => item.scope === "global").length;

    lines.push("");
    lines.push(`Project scope: ${projectSkills} skills, ${projectCommands} commands`);
    lines.push(`Global scope: ${globalSkills} skills, ${globalCommands} commands`);

    return lines.join("\n");
}

export function summarizeExecution(results: OperationResult[]): string {
    const created = results.filter((item) => item.status === "created").length;
    const updated = results.filter((item) => item.status === "updated").length;
    const skipped = results.filter((item) => item.status === "skipped").length;
    const failed = results.filter((item) => item.status === "failed").length;

    return [`Created: ${created}`, `Updated: ${updated}`, `Skipped: ${skipped}`, `Failed: ${failed}`].join("\n");
}

function addSkillDirs(
    skills: SkillSource[],
    seen: Set<string>,
    paths: string[],
    scope: SingleScope,
    origin: SourceOrigin,
    pluginName?: string
): void {
    for (const sourcePath of paths) {
        const normalized = resolve(sourcePath);
        const key = `${scope}:${normalized}`;
        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        skills.push({
            path: normalized,
            scope,
            origin,
            pluginName,
        });
    }
}

function addCommandFiles(
    commands: CommandSource[],
    seen: Set<string>,
    paths: string[],
    scope: SingleScope,
    origin: SourceOrigin,
    namespace: string,
    pluginName?: string
): void {
    for (const sourcePath of paths) {
        const normalized = resolve(sourcePath);
        const key = `${scope}:${namespace}:${normalized}`;
        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        commands.push({
            path: normalized,
            scope,
            origin,
            namespace: normalizeSegment(namespace),
            pluginName,
        });
    }
}

function addInstruction(
    instructions: InstructionSource[],
    seen: Set<string>,
    sourcePath: string,
    scope: SingleScope
): void {
    if (!existsSync(sourcePath)) {
        return;
    }

    const normalized = resolve(sourcePath);
    const key = `${scope}:${normalized}`;
    if (seen.has(key)) {
        return;
    }

    seen.add(key);
    instructions.push({
        path: normalized,
        scope,
        origin: "claude",
    });
}

function discoverProjectPlugins(projectRoot: string, warnings: string[]): PluginDeclaration[] {
    const plugins: PluginDeclaration[] = [];
    const seen = new Set<string>();

    const marketplacePath = join(projectRoot, PROJECT_CLAUDE_PLUGIN_DIRNAME, "marketplace.json");
    if (existsSync(marketplacePath)) {
        const marketplace = parseJsonFile(marketplacePath, warnings);
        const pluginEntries = marketplace?.plugins;
        if (Array.isArray(pluginEntries)) {
            for (const pluginEntry of pluginEntries) {
                const plugin = asObject(pluginEntry);
                if (!plugin) {
                    continue;
                }

                const pluginName = normalizeSegment(typeof plugin.name === "string" ? plugin.name : "plugin");
                const sourceValue = typeof plugin.source === "string" ? plugin.source : "";
                const pluginRoot = sourceValue ? resolve(projectRoot, sourceValue) : "";
                if (!pluginRoot || !existsSync(pluginRoot)) {
                    warnings.push(
                        `Marketplace plugin root not found for ${pluginName}: ${pluginRoot || "(missing source)"}`
                    );
                    continue;
                }

                const key = `${pluginName}:${pluginRoot}`;
                if (seen.has(key)) {
                    continue;
                }

                seen.add(key);
                plugins.push({
                    name: pluginName,
                    rootDir: pluginRoot,
                    skills: toPathList(plugin.skills),
                    commands: toPathList(plugin.commands),
                    scope: "project",
                });
            }
        }
    }

    const pluginsDir = join(projectRoot, "plugins");
    if (existsSync(pluginsDir)) {
        const pluginDirs = readdirSync(pluginsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
        for (const entry of pluginDirs) {
            const pluginRoot = join(pluginsDir, entry.name);
            const manifestPath = join(pluginRoot, ".claude-plugin", "plugin.json");
            if (!existsSync(manifestPath)) {
                continue;
            }

            const manifest = parseJsonFile(manifestPath, warnings);
            if (!manifest) {
                continue;
            }

            const pluginName = normalizeSegment(typeof manifest.name === "string" ? manifest.name : entry.name);
            const key = `${pluginName}:${pluginRoot}`;
            if (seen.has(key)) {
                continue;
            }

            seen.add(key);
            plugins.push({
                name: pluginName,
                rootDir: pluginRoot,
                skills: toPathList(manifest.skills),
                commands: toPathList(manifest.commands),
                scope: "project",
            });
        }
    }

    return plugins;
}

function collectSkillDirsFromPaths(baseDir: string, paths: string[], warnings: string[]): string[] {
    const results: string[] = [];
    for (const pathValue of paths) {
        const resolvedPath = resolve(baseDir, pathValue);
        if (!existsSync(resolvedPath)) {
            warnings.push(`Plugin skills path not found: ${resolvedPath}`);
            continue;
        }

        if (existsSync(join(resolvedPath, "SKILL.md"))) {
            results.push(resolvedPath);
            continue;
        }

        const stat = lstatSync(resolvedPath);
        if (!stat.isDirectory()) {
            warnings.push(`Plugin skills path is not a directory: ${resolvedPath}`);
            continue;
        }

        results.push(...collectSkillDirs(resolvedPath));
    }

    return uniqueStringPaths(results);
}

function collectCommandFilesFromPaths(baseDir: string, paths: string[], warnings: string[]): string[] {
    const results: string[] = [];
    for (const pathValue of paths) {
        const resolvedPath = resolve(baseDir, pathValue);
        if (!existsSync(resolvedPath)) {
            warnings.push(`Plugin commands path not found: ${resolvedPath}`);
            continue;
        }

        const stat = lstatSync(resolvedPath);
        if (stat.isDirectory()) {
            results.push(...collectMarkdownFiles(resolvedPath));
            continue;
        }

        if (stat.isFile() && extname(resolvedPath).toLowerCase() === ".md") {
            results.push(resolvedPath);
        }
    }

    return uniqueStringPaths(results);
}

function isDirEntry(entry: Dirent, fullPath: string): boolean {
    if (entry.isDirectory()) {
        return true;
    }

    if (!entry.isSymbolicLink()) {
        return false;
    }

    try {
        return statSync(fullPath).isDirectory();
    } catch {
        return false;
    }
}

function collectSkillDirs(baseDir: string): string[] {
    if (!existsSync(baseDir)) {
        return [];
    }

    const entries = readdirSync(baseDir, { withFileTypes: true });
    const skillDirs: string[] = [];
    for (const entry of entries) {
        const candidate = join(baseDir, entry.name);
        if (!isDirEntry(entry, candidate)) {
            continue;
        }

        if (existsSync(join(candidate, "SKILL.md"))) {
            skillDirs.push(candidate);
        }
    }

    return uniqueStringPaths(skillDirs);
}

function collectMarkdownFiles(baseDir: string): string[] {
    if (!existsSync(baseDir)) {
        return [];
    }

    const files: string[] = [];
    const walk = (currentDir: string): void => {
        const entries = readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = join(currentDir, entry.name);
            if (isDirEntry(entry, fullPath)) {
                walk(fullPath);
                continue;
            }

            if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
                files.push(fullPath);
            }
        }
    };

    walk(baseDir);
    return uniqueStringPaths(files);
}

function expandScope(scope: MigrationScope): SingleScope[] {
    if (scope === "both") {
        return ["project", "global"];
    }

    return [scope];
}

function buildSkillTargetName(source: SkillSource, style: NameStyle, used: Set<string>): string {
    const baseName = basename(source.path);
    let candidate = baseName;

    if (source.origin === "plugin" && source.pluginName) {
        candidate = `${normalizeSegment(source.pluginName)}-${baseName}`;
    } else if (style === "prefixed") {
        candidate = `${source.scope}-${baseName}`;
    }

    return ensureUniqueName(candidate, used);
}

function buildCommandNamespace(
    source: CommandSource,
    style: NameStyle,
    claimed: Map<string, string>
): string {
    let namespace = source.namespace;

    if (style === "prefixed") {
        if (source.origin === "plugin" && source.pluginName) {
            namespace = normalizeSegment(source.pluginName);
        } else {
            namespace = `${source.scope}-${normalizeSegment(namespace)}`;
        }
    }

    const sourceKey =
        source.origin === "plugin" && source.pluginName
            ? `plugin:${source.pluginName}`
            : `${source.origin}:${source.scope}:${source.namespace}`;

    const normalized = normalizeSegment(namespace);
    const existingOwner = claimed.get(normalized);

    if (existingOwner === sourceKey) {
        return normalized;
    }

    if (!existingOwner) {
        claimed.set(normalized, sourceKey);
        return normalized;
    }

    let candidate = normalized;
    let counter = 2;

    while (claimed.has(candidate) && claimed.get(candidate) !== sourceKey) {
        candidate = `${normalized}-${counter}`;
        counter++;
    }

    claimed.set(candidate, sourceKey);
    return candidate;
}

function ensureUniqueName(name: string, used: Set<string>): string {
    const normalized = normalizeSegment(name);
    let candidate = normalized;
    let counter = 2;

    while (used.has(candidate)) {
        candidate = `${normalized}-${counter}`;
        counter++;
    }

    used.add(candidate);
    return candidate;
}

function countByComponent(operations: PlannedOperation[]): Record<MigrationComponent, number> {
    return operations.reduce<Record<MigrationComponent, number>>(
        (acc, item) => {
            acc[item.component] += 1;
            return acc;
        },
        {
            skills: 0,
            commands: 0,
            instructions: 0,
        }
    );
}

function copyPath(sourcePath: string, targetPath: string): void {
    const sourceStat = lstatSync(sourcePath);
    if (sourceStat.isDirectory()) {
        cpSync(sourcePath, targetPath, { recursive: true });
        return;
    }

    cpSync(sourcePath, targetPath);
}

function createSymlink(sourcePath: string, targetPath: string, preferRelative: boolean): void {
    const sourceStat = lstatSync(sourcePath);
    const linkTarget = preferRelative ? relative(dirname(targetPath), sourcePath) : sourcePath;

    if (sourceStat.isDirectory()) {
        const type = process.platform === "win32" ? "junction" : "dir";
        symlinkSync(linkTarget, targetPath, type);
        return;
    }

    symlinkSync(linkTarget, targetPath);
}

function isSameSymlink(targetPath: string, sourcePath: string): boolean {
    if (!existsSync(targetPath)) {
        return false;
    }

    const stat = lstatSync(targetPath);
    if (!stat.isSymbolicLink()) {
        return false;
    }

    const current = readlinkSync(targetPath);
    const resolvedCurrent = resolve(dirname(targetPath), current);
    return resolvedCurrent === resolve(sourcePath);
}

function parseJsonFile(filePath: string, warnings: string[]): Record<string, unknown> | null {
    try {
        const content = readFileSync(filePath, "utf-8");
        return JSON.parse(content) as Record<string, unknown>;
    } catch (error) {
        warnings.push(
            `Failed to parse JSON file ${filePath}: ${error instanceof Error ? error.message : String(error)}`
        );
        return null;
    }
}

function toPathList(value: unknown): string[] {
    if (typeof value === "string") {
        return [value];
    }

    if (Array.isArray(value)) {
        return value.filter((item): item is string => typeof item === "string");
    }

    return [];
}

function normalizeSegment(value: string): string {
    const normalized = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+/, "")
        .replace(/-+$/, "");

    if (!normalized) {
        return "item";
    }

    return normalized;
}

function uniqueStringPaths(items: string[]): string[] {
    const set = new Set<string>();
    const result: string[] = [];

    for (const item of items) {
        const value = resolve(item);
        if (set.has(value)) {
            continue;
        }

        set.add(value);
        result.push(item);
    }

    return result;
}

function asObject(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object") {
        return null;
    }

    return value as Record<string, unknown>;
}

function isInsideDir(filePath: string, dirPath: string): boolean {
    const resolved = resolve(filePath);
    const resolvedDir = resolve(dirPath) + "/";
    return resolved.startsWith(resolvedDir);
}

function sortByPath<T extends { path: string }>(items: T[]): T[] {
    return [...items].sort((a, b) => a.path.localeCompare(b.path));
}
