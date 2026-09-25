import { dirname } from "node:path";
import { getMainRepoRootSync } from "@genesiscz/utils/git/worktree";
import { logger } from "@genesiscz/utils/logger";
import {
    EDITOR_DRIVER_IDS,
    type EditorDriverId,
    isEditorDriverId,
    isTerminalDriverId,
    TERMINAL_DRIVER_IDS,
    type TerminalDriverId,
} from "@genesiscz/utils/open-in";
import { Storage } from "@genesiscz/utils/storage";
import { isRecord, placeholders } from "./values";

/** How a configured action reads one value from the page. */
export interface FieldSpec {
    /** CSS selector, run in the page by the popup. */
    selector: string;
    /** `textContent` (default), `value`, or `attr:<name>`. */
    property?: string;
    /** Anchored regular expression the value must match; the default refuses control characters. */
    pattern?: string;
}

/** A button for pages whose URL matches `match`; see the plan's feature D. */
export interface ActionSpec {
    id: string;
    label: string;
    /** Regular expression over the page URL. Named groups become values: `(?<id>\d+)`. */
    match: string;
    fields?: Record<string, FieldSpec>;
    /** Local folder the command runs in; `~` is expanded. */
    cwd: string;
    /** argv template; `{name}` fills one element from a value and never splits it. */
    command?: string[];
    /** Folder for the agent session: a template, `{stdoutLastLine}` is the command's last output line. */
    sessionCwd?: string;
    /** First prompt of the agent session; written to a file, never onto a command line. */
    prompt?: string;
    /** Open an agent session afterwards. Default true. */
    session?: boolean;
    timeoutMs?: number;
}

export interface AgentSpec {
    /** argv of an interactive agent; the prompt sentence is appended as the last element. */
    interactive: string[];
    /** argv of a headless agent; the prompt goes to its stdin. */
    headless: string[];
    headlessTimeoutMs: number;
}

export interface BrowserExtensionConfig {
    version: 1;
    /** Folders scanned (3 levels deep) for checkouts. */
    repoRoots: string[];
    /** Project web URL -> local checkout, for checkouts outside `repoRoots`. */
    repos: Record<string, string>;
    /** Self-hosted GitLab hosts, e.g. `gitlab.internal.example`. Hosts containing "gitlab" need no entry. */
    gitlabHosts: string[];
    editor: EditorDriverId;
    terminal: TerminalDriverId;
    agent: AgentSpec;
    actions: ActionSpec[];
}

export class ConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ConfigError";
    }
}

const ACTION_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VALUE_NAME = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A host name of dot-separated labels (letters, digits, inner hyphens) and an optional port
 * 1-65535. The extension builds Chrome match patterns and script ids from it, and one entry Chrome
 * refuses fails the whole GitLab sync, so `.example.com`, `a..b` and `:70000` are refused here.
 */
function isHost(host: string): boolean {
    const match = /^([^:]+)(?::(\d{1,5}))?$/.exec(host);

    if (!match) {
        return false;
    }

    const [, name, port] = match;

    if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) {
        return false;
    }

    return name.length <= 253 && name.split(".").every((label) => HOST_LABEL.test(label));
}
/** Values every action template may use besides its URL groups and fields. */
export const BUILTIN_VALUES = ["url", "cwd", "stdoutLastLine"] as const;

const log = logger.child({ component: "browser-extension/config" });

export function browserExtensionStorage(): Storage {
    return new Storage("browser-extension");
}

export function configPath(): string {
    return browserExtensionStorage().getConfigPath();
}

/** Defaults: scan the folder that holds this checkout, open files in Cursor and terminals in cmux. */
export function defaultConfig(): BrowserExtensionConfig {
    let roots: string[] = [];

    try {
        roots = [dirname(getMainRepoRootSync(import.meta.dirname))];
    } catch (err) {
        log.debug({ err }, "no repo root for the default repoRoots");
    }

    return {
        version: 1,
        repoRoots: roots,
        repos: {},
        gitlabHosts: [],
        editor: "cursor",
        terminal: "cmux",
        // `tools claude run --autopick` uses the saved account with the most headroom; a plain
        // `claude` works too when that CLI is logged in by itself.
        agent: {
            interactive: ["tools", "claude", "run", "--autopick", "--"],
            headless: ["tools", "claude", "run", "--autopick", "--", "-p", "--allowedTools", "Read,Grep,Glob"],
            headlessTimeoutMs: 180_000,
        },
        actions: [],
    };
}

function stringArray(value: unknown, label: string, { nonEmpty = false } = {}): string[] {
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0)) {
        throw new ConfigError(`${label} must be an array of non-empty strings`);
    }

    if (nonEmpty && value.length === 0) {
        throw new ConfigError(`${label} must not be empty`);
    }

    return value;
}

function text(value: unknown, label: string): string {
    if (typeof value !== "string" || value.trim() === "") {
        throw new ConfigError(`${label} must be a non-empty string`);
    }

    return value;
}

function regex(value: unknown, label: string): string {
    const source = text(value, label);

    try {
        new RegExp(source, "u");
    } catch (err) {
        throw new ConfigError(`${label} is not a regular expression: ${err instanceof Error ? err.message : err}`);
    }

    return source;
}

function isBuiltinValue(name: string): boolean {
    return (BUILTIN_VALUES as readonly string[]).includes(name);
}

/** Named groups of a URL pattern: the values a URL match yields. */
export function groupNames(pattern: string): string[] {
    return [...pattern.matchAll(/\(\?<([A-Za-z][A-Za-z0-9]*)>/g)].map((match) => match[1]);
}

function parseField(value: unknown, label: string): FieldSpec {
    if (!isRecord(value)) {
        throw new ConfigError(`${label} must be an object`);
    }

    const field: FieldSpec = { selector: text(value.selector, `${label}.selector`) };

    if (value.property !== undefined) {
        const property = text(value.property, `${label}.property`);

        if (property !== "textContent" && property !== "value" && !/^attr:[A-Za-z_:][-A-Za-z0-9_:.]*$/.test(property)) {
            throw new ConfigError(`${label}.property must be textContent, value or attr:<name>`);
        }

        field.property = property;
    }

    if (value.pattern !== undefined) {
        field.pattern = regex(value.pattern, `${label}.pattern`);
    }

    return field;
}

function assertKnownPlaceholders(templates: string[], known: Set<string>, label: string): void {
    for (const name of templates.flatMap(placeholders)) {
        if (!known.has(name)) {
            throw new ConfigError(
                `${label} uses {${name}}, which is not a URL group, a field or ${BUILTIN_VALUES.join("/")}`
            );
        }
    }
}

function parseAction(value: unknown, index: number, seen: Set<string>): ActionSpec {
    const label = `actions[${index}]`;

    if (!isRecord(value)) {
        throw new ConfigError(`${label} must be an object`);
    }

    const id = text(value.id, `${label}.id`);

    if (!ACTION_ID.test(id) || seen.has(id)) {
        throw new ConfigError(`${label}.id must be unique, lowercase letters, digits and dashes`);
    }

    seen.add(id);
    const action: ActionSpec = {
        id,
        label: text(value.label, `${label}.label`),
        match: regex(value.match, `${label}.match`),
        cwd: text(value.cwd, `${label}.cwd`),
    };
    const groups = groupNames(action.match);
    // actionValues sets url first and the groups and fields after it, so one named url would replace
    // the checked page URL with page text, and cwd or stdoutLastLine would be dropped without a word.
    const reserved = groups.find(isBuiltinValue);

    if (reserved) {
        throw new ConfigError(`${label}.match: group "${reserved}" is a built-in value (${BUILTIN_VALUES.join(", ")})`);
    }

    const known = new Set<string>([...BUILTIN_VALUES, ...groups]);

    if (value.fields !== undefined) {
        if (!isRecord(value.fields)) {
            throw new ConfigError(`${label}.fields must be an object`);
        }

        action.fields = {};

        for (const [name, spec] of Object.entries(value.fields)) {
            if (!VALUE_NAME.test(name)) {
                throw new ConfigError(`${label}.fields: "${name}" must be letters and digits`);
            }

            if (isBuiltinValue(name)) {
                throw new ConfigError(`${label}.fields: "${name}" is a built-in value (${BUILTIN_VALUES.join(", ")})`);
            }

            action.fields[name] = parseField(spec, `${label}.fields.${name}`);
            known.add(name);
        }
    }

    // The label becomes the session title after the command ran, so an unknown name must fail
    // here, before any command has side effects.
    assertKnownPlaceholders([action.label], known, `${label}.label`);

    if (value.command !== undefined) {
        action.command = stringArray(value.command, `${label}.command`, { nonEmpty: true });
        assertKnownPlaceholders(action.command, known, `${label}.command`);
    }

    for (const key of ["sessionCwd", "prompt"] as const) {
        if (value[key] !== undefined) {
            action[key] = text(value[key], `${label}.${key}`);
            assertKnownPlaceholders([action[key] ?? ""], known, `${label}.${key}`);
        }
    }

    if (value.session !== undefined) {
        if (typeof value.session !== "boolean") {
            throw new ConfigError(`${label}.session must be true or false`);
        }

        action.session = value.session;
    }

    if (value.timeoutMs !== undefined) {
        if (!Number.isInteger(value.timeoutMs) || Number(value.timeoutMs) < 1000) {
            throw new ConfigError(`${label}.timeoutMs must be an integer of at least 1000`);
        }

        action.timeoutMs = Number(value.timeoutMs);
    }

    return action;
}

/** Validates a config object from disk or from the options page; missing keys take the defaults. */
export function parseConfig(
    value: unknown,
    defaults: BrowserExtensionConfig = defaultConfig()
): BrowserExtensionConfig {
    if (!isRecord(value)) {
        throw new ConfigError("config must be a JSON object");
    }

    if (value.version !== undefined && value.version !== 1) {
        throw new ConfigError("version must be 1");
    }

    const config: BrowserExtensionConfig = { ...defaults, agent: { ...defaults.agent } };

    if (value.repoRoots !== undefined) {
        config.repoRoots = stringArray(value.repoRoots, "repoRoots");
    }

    if (value.repos !== undefined) {
        if (!isRecord(value.repos) || !Object.values(value.repos).every((path) => typeof path === "string")) {
            throw new ConfigError("repos must map project URLs to folder paths");
        }

        config.repos = Object.fromEntries(Object.entries(value.repos).map(([url, path]) => [url, String(path)]));
    }

    if (value.gitlabHosts !== undefined) {
        const hosts = stringArray(value.gitlabHosts, "gitlabHosts").map((host) => host.toLowerCase());

        if (!hosts.every(isHost)) {
            throw new ConfigError("gitlabHosts must be bare host names, e.g. gitlab.internal.example");
        }

        // Each host is one content script id, and registering an id twice fails the whole sync.
        config.gitlabHosts = [...new Set(hosts)];
    }

    if (value.editor !== undefined) {
        if (!isEditorDriverId(value.editor)) {
            throw new ConfigError(`editor must be one of ${EDITOR_DRIVER_IDS.join(", ")}`);
        }

        config.editor = value.editor;
    }

    if (value.terminal !== undefined) {
        if (!isTerminalDriverId(value.terminal)) {
            throw new ConfigError(`terminal must be one of ${TERMINAL_DRIVER_IDS.join(", ")}`);
        }

        config.terminal = value.terminal;
    }

    if (value.agent !== undefined) {
        if (!isRecord(value.agent)) {
            throw new ConfigError("agent must be an object");
        }

        if (value.agent.interactive !== undefined) {
            config.agent.interactive = stringArray(value.agent.interactive, "agent.interactive", { nonEmpty: true });
        }

        if (value.agent.headless !== undefined) {
            config.agent.headless = stringArray(value.agent.headless, "agent.headless", { nonEmpty: true });
        }

        if (value.agent.headlessTimeoutMs !== undefined) {
            const ms = value.agent.headlessTimeoutMs;

            if (typeof ms !== "number" || !Number.isInteger(ms) || ms < 5000) {
                throw new ConfigError("agent.headlessTimeoutMs must be an integer of at least 5000");
            }

            config.agent.headlessTimeoutMs = ms;
        }
    }

    if (value.actions !== undefined) {
        if (!Array.isArray(value.actions)) {
            throw new ConfigError("actions must be an array");
        }

        const seen = new Set<string>();
        config.actions = value.actions.map((action, index) => parseAction(action, index, seen));
    }

    return config;
}

export async function loadConfig(): Promise<BrowserExtensionConfig> {
    const raw = await browserExtensionStorage().getConfig<Record<string, unknown>>();
    log.debug({ path: configPath(), exists: raw !== null }, "load config");
    return raw === null ? defaultConfig() : parseConfig(raw);
}

export async function saveConfig(value: unknown): Promise<BrowserExtensionConfig> {
    const config = parseConfig(value);
    await browserExtensionStorage().setConfig(config);
    log.info({ path: configPath(), actions: config.actions.length }, "config saved");
    return config;
}
