import { discoverTools, type ToolInfo } from "@app/tools/lib/discovery";
import { introspectSubcommand, introspectTool, type ToolHelp } from "@app/tools/lib/introspect";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { aliasNote } from "./aliases";

const { log } = logger.scoped("jev-route");
const prof = profiler.scope("jev-route");

/** Bumped whenever a row field changes, so an old cache file is rebuilt instead of misread. */
export const CATALOGUE_VERSION = 2;

/**
 * Paths that are destructive no matter what the verb list says.
 */
export const DESTRUCTIVE_PATHS = new Set([
    "control act",
    "control osascript",
    "git push",
    "jenkins",
    "chrome-devtools rm-cookie",
    "jev wake enable",
]);

/**
 * Verbs that mutate something a human cannot get back by re-running the command.
 * A path segment equal to one of these marks the row destructive.
 */
export const DESTRUCTIVE_VERBS = new Set([
    "delete",
    "force",
    "kill",
    "prune",
    "push",
    "remove",
    "reset",
    "revoke",
    "rm",
    "rotate",
    "uninstall",
    "wipe",
]);

/** Flags whose presence in the final argv makes the run destructive regardless of the path. */
export const DESTRUCTIVE_FLAGS = new Set(["--force", "--delete", "--rm", "--push", "--reset", "--yes"]);

/** Subcommand names that never help a router. */
const SKIPPED_COMMANDS = new Set(["help", "readme"]);

/**
 * `src/` entries that `discoverTools` sees as tools because they carry an `index.ts`, but that no
 * human can run. `src/utils/index.ts` is the `@genesiscz/utils` barrel; running it prints nothing,
 * and leaving it in puts a dead option in the family question.
 */
const NON_TOOL_DIRS = new Set(["utils", "Internal", "components", "lib"]);

const COMMAND_NAME_RE = /^[a-z][a-z0-9-]*$/;

export interface RouteFlag {
    /** Long name without dashes, e.g. `unresolved-only`. */
    name: string;
    /** Short form with its dash, e.g. `-u`, when the option declares one. */
    short?: string;
    takesValue: boolean;
    optionalValue: boolean;
    description: string;
}

export interface CatalogueCommand {
    /** Space separated path as a human types it after `tools`, e.g. `github review`. */
    path: string;
    /** One-line summary from the tool's own `--help`. */
    description: string;
    /** Positional part of the usage line, e.g. `<pr>` or `[path]`. */
    argHint: string;
    destructive: boolean;
    /** Filled by `enrichCommand` at bind time; absent while only the depth-1 build has run. */
    flags?: RouteFlag[];
    flagsLoaded?: boolean;
    hasSubcommands?: boolean;
    aliases?: string[];
}

export interface CatalogueTool {
    name: string;
    oneLine: string;
    commands: CatalogueCommand[];
    /** Absolute path of the tool entry script, needed to introspect a subcommand later. */
    entry?: string;
}

export interface ToolCatalogue {
    commit: string;
    tools: CatalogueTool[];
    version?: number;
    builtAtMs?: number;
    /** Source stamp the cache compares against; see `cache.ts`. */
    stamp?: string;
}

export interface CatalogueRow {
    id: string;
    path: string;
    tool: string;
    oneLine: string;
    argHint: string;
    destructive: boolean;
    flags: RouteFlag[];
    flagsLoaded: boolean;
    hasSubcommands: boolean;
    entry?: string;
}

export function isDestructive(path: string): boolean {
    if (DESTRUCTIVE_PATHS.has(path)) {
        return true;
    }

    for (const item of DESTRUCTIVE_PATHS) {
        if (path === item || path.startsWith(`${item} `) || item.startsWith(`${path} `)) {
            return true;
        }
    }

    return path.split(" ").some((segment) => DESTRUCTIVE_VERBS.has(segment));
}

/** True when the assembled argv carries a flag that mutates state on its own. */
export function hasDestructiveFlag(argv: string[]): boolean {
    return argv.some((token) => DESTRUCTIVE_FLAGS.has(token));
}

/**
 * Split a Commander command entry such as `pr [options] <input>` or `experiment|typescript`
 * into its canonical name, its aliases and the positional hint.
 *
 * Returns null for anything that is not a command name. The shared help parser is line based,
 * so a "Subcommand Options:" block under `Commands:` reaches this function as
 * `-s, --session <id>`; rejecting it here keeps option rows out of the catalogue.
 */
export function parseCommandEntry(entry: string): { name: string; aliases: string[]; argHint: string } | null {
    const parts = entry.trim().split(/\s+/);
    const head = parts.shift();
    if (!head) {
        return null;
    }

    const [name, ...aliases] = head.split("|");
    if (!COMMAND_NAME_RE.test(name) || aliases.some((alias) => !COMMAND_NAME_RE.test(alias))) {
        return null;
    }

    const argHint = parts.filter((part) => part !== "[options]" && part !== "[command]").join(" ");
    return { name, aliases, argHint };
}

/**
 * Parse one Commander option line into a flag row.
 *
 * `-u, --unresolved-only` is a boolean, `--repo <owner/repo>` takes a value, and
 * `-w, --worktree [path]` takes an optional one.
 */
export function parseFlag(flags: string, description: string): RouteFlag | null {
    const long = flags.match(/--([a-z0-9][a-z0-9-]*)/i);
    if (!long) {
        return null;
    }

    const name = long[1];
    if (name === "help" || name === "version") {
        return null;
    }

    const short = flags.match(/(?:^|[\s,])(-[a-zA-Z0-9])(?![a-zA-Z0-9-])/)?.[1];
    return {
        name,
        ...(short ? { short } : {}),
        takesValue: /[<[]\S*[>\]]/.test(flags),
        optionalValue: /\[[^\]]+\]/.test(flags),
        description: description.replace(/\s+/g, " ").trim(),
    };
}

function usageArgHint(usage: string): string {
    return usage
        .split(/\s+/)
        .slice(1)
        .filter((part) => part !== "[options]" && part !== "[command]")
        .join(" ");
}

function commandsOf(help: ToolHelp, toolName: string): CatalogueCommand[] {
    const commands: CatalogueCommand[] = [];
    const seen = new Set<string>();
    for (const entry of help.commands) {
        const parsed = parseCommandEntry(entry.name);
        if (!parsed || SKIPPED_COMMANDS.has(parsed.name) || seen.has(parsed.name)) {
            continue;
        }

        seen.add(parsed.name);
        const path = `${toolName} ${parsed.name}`;
        commands.push({
            path,
            description: entry.description || parsed.name,
            argHint: parsed.argHint,
            destructive: isDestructive(path),
            ...(parsed.aliases.length ? { aliases: parsed.aliases } : {}),
        });
    }
    return commands;
}

/**
 * Build the catalogue by running every tool's real `--help` through `introspectTool`.
 *
 * Depth 1 only: one `bun run <tool> --help` per tool, about 110 spawns and 40 s on this Mac,
 * which is why `cache.ts` keeps the result. Deeper levels are reached at bind time, when the
 * chosen row is introspected anyway for its flags, so a nested tree never costs a spawn until
 * a human actually routes into it.
 */
export function buildCatalogue(options: { srcDir: string; only?: string[]; commit?: string }): ToolCatalogue {
    const started = performance.now();
    const discovered = discoverTools(options.srcDir).filter(
        (tool: ToolInfo) => !NON_TOOL_DIRS.has(tool.name) && (!options.only || options.only.includes(tool.name))
    );
    log.info({ toolCount: discovered.length, srcDir: options.srcDir }, "Building the Jev route catalogue");

    const tools: CatalogueTool[] = [];
    let rowCount = 0;
    let failed = 0;
    for (const tool of discovered) {
        const help = prof.measure(`introspect:${tool.name}`, () => introspectTool(tool.path));
        if (!help) {
            failed += 1;
            log.debug({ tool: tool.name, entry: tool.path }, "Tool --help produced no output; using the tool row only");
        }

        const commands = help ? commandsOf(help, tool.name) : [];
        const oneLine = help?.description || tool.description || tool.name;
        if (!commands.length) {
            commands.push({
                path: tool.name,
                description: oneLine,
                argHint: help ? usageArgHint(help.usage) : "",
                destructive: isDestructive(tool.name),
            });
        }

        rowCount += commands.length;
        tools.push({ name: tool.name, oneLine, commands, entry: tool.path });
    }

    const ms = Math.round(performance.now() - started);
    log.info({ toolCount: tools.length, rowCount, failed, ms }, "Jev route catalogue built");
    return { commit: options.commit ?? "worktree", version: CATALOGUE_VERSION, builtAtMs: Date.now(), tools };
}

export function flattenCatalogue(catalogue: ToolCatalogue): CatalogueRow[] {
    const rows: CatalogueRow[] = [];
    for (const tool of catalogue.tools) {
        const commands = tool.commands.length
            ? tool.commands
            : [
                  {
                      path: tool.name,
                      description: tool.oneLine,
                      argHint: "",
                      destructive: isDestructive(tool.name),
                  },
              ];
        for (const command of commands) {
            rows.push({
                id: command.path.replaceAll(" ", "."),
                path: command.path,
                tool: tool.name,
                oneLine: `${command.description || tool.oneLine}${aliasNote(command.path)}`.trim(),
                argHint: command.argHint ?? "",
                destructive: command.destructive || isDestructive(command.path),
                flags: command.flags ?? [],
                flagsLoaded: command.flagsLoaded ?? false,
                hasSubcommands: command.hasSubcommands ?? false,
                ...(tool.entry ? { entry: tool.entry } : {}),
            });
        }
    }
    return rows.sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Read the chosen row's own `--help` so binding sees real flags, a real positional hint and the
 * row's children. One spawn, only for the row Jev already picked, which is what keeps a nested
 * tree out of the catalogue build.
 */
export function enrichCommand(row: CatalogueRow): { row: CatalogueRow; children: CatalogueRow[] } {
    if (row.flagsLoaded || !row.entry) {
        return { row, children: [] };
    }

    const entry = row.entry;
    const segments = row.path.split(" ").slice(1);
    const help = prof.measure(`introspect:${row.path}`, () =>
        segments.length ? introspectSubcommand(entry, segments.join(" ")) : introspectTool(entry)
    );
    if (!help) {
        log.debug({ path: row.path, entry }, "Subcommand --help produced no output; binding without flags");
        return { row: { ...row, flagsLoaded: true }, children: [] };
    }

    const flags = help.options
        .map((option) => parseFlag(option.flags, option.description))
        .filter((flag): flag is RouteFlag => flag !== null);
    const children = commandsOf(help, row.path).map((command) => ({
        id: command.path.replaceAll(" ", "."),
        path: command.path,
        tool: row.tool,
        oneLine: command.description,
        argHint: command.argHint,
        destructive: command.destructive || isDestructive(command.path),
        flags: [],
        flagsLoaded: false,
        hasSubcommands: false,
        entry,
    }));
    const argHint = usageArgHint(help.usage) || row.argHint;
    log.debug(
        { path: row.path, flagCount: flags.length, childCount: children.length, argHint },
        "Enriched the chosen catalogue row"
    );
    return {
        row: { ...row, flags, flagsLoaded: true, hasSubcommands: children.length > 0, argHint },
        children,
    };
}
