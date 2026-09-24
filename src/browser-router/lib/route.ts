import { GENESIS_APP_BUNDLE_ID } from "@genesiscz/utils/macos/genesis-app";
import { cleanUrl } from "./clean";
import { takeToken } from "./tokens";

/** The retired standalone "Genesis Router.app"; a config may still name it. */
export const BROWSER_ROUTER_BUNDLE_ID = "com.genesiscz.genesistools.browser-router";
/** GenesisTools.app is the http(s) handler that routes links now: forwarding to either would loop. */
const LINK_ROUTER_BUNDLE_IDS = [BROWSER_ROUTER_BUNDLE_ID, GENESIS_APP_BUNDLE_ID];

export type AppType = "appName" | "bundleId" | "path" | "none";
export type ApprovalMode = "ask" | "allow";

export interface BrowserTarget {
    name: string;
    appType?: AppType;
    openInBackground?: boolean;
}

/**
 * `open` hands the rewritten URL to Launch Services.
 * `forward` names a browser.
 * `unwrap` decodes $1 and routes that URL. Used by `links --convert`.
 * `run` is an argv list, not a shell. `{qty}` is a query parameter, `{ids*}` splits on commas.
 * `tool` is recorded and not executed.
 */
export type RouteAction =
    | { type: "open"; to: string }
    | { type: "forward"; to?: string; browser: BrowserTarget | string }
    | { type: "unwrap" }
    | { type: "token" }
    | {
          type: "run";
          argv: string[];
          approval: ApprovalMode;
          /** Same grant for every value of the template's parameters. Touch ID is optional. */
          touchId?: boolean;
          open?: string;
          notify?: string;
          /** A redeemed one-use link may skip the prompt. A raw URL that carries a prompt never does. */
          trustMinted?: boolean;
      }
    | { type: "tool"; tool: string; args: string[]; approval: ApprovalMode };

export const UNWRAP_PATTERN = "https?://(?:localhost|127\\.0\\.0\\.1):6666/link/(.+)";
export const TOKEN_PATTERN = "https?://(?:localhost|127\\.0\\.0\\.1):6666/t/([A-Za-z0-9_-]+)";
/** `https://genesis.tools/tabs/<name>`, the link `tabs save` prints. */
export const TABS_PATTERN = "https?://(?:localhost|127\\.0\\.0\\.1):6666/tabs/([A-Za-z0-9_-]+)";
/** The untagged catch-all an older default config carried; the genesis-md preset replaces it. */
export const LEGACY_LOCAL_CATCH_ALL = "https?://(?:localhost|127\\.0\\.0\\.1):6666/(.*)";

/** Built-in routes every config starts with, in this order, ahead of the user's routes. */
export function builtinRoutes(): RouteRule[] {
    return [
        { pattern: TOKEN_PATTERN, action: { type: "token" } },
        { pattern: UNWRAP_PATTERN, action: { type: "unwrap" } },
        {
            pattern: TABS_PATTERN,
            name: "Open tabs",
            action: { type: "run", argv: ["tools", "browser-router", "tabs", "open", "$1"], approval: "allow" },
        },
    ];
}

export const ROUTER_ALIAS_HOST = "genesis.tools";
export const ROUTER_ALIAS_BASE = "https://127.0.0.1:6666";

export interface RouterAlias {
    host: string;
    base: string;
}

/** `false` turns the card off. Omitted fields inherit the level above. */
export type ToastSettings = { enabled?: boolean; seconds?: number; title?: string } | false;

export interface RouteRule {
    pattern: string;
    /** Human headline for the card ("Open mail"); without it the card names the command. */
    name?: string;
    action: RouteAction;
    toast?: ToastSettings;
    /** Set on a built-in route so it can be removed when its app is not installed. */
    preset?: string;
}

export interface RouterConfig {
    defaultBrowser: BrowserTarget | string;
    /** When true, hosts in `aliases` are rewritten onto the local router before a second match. */
    allowAliases?: boolean;
    aliases?: RouterAlias[];
    /** Center-screen card shown when a click opens or runs something. */
    toast?: ToastSettings;
    /** Registered local servers. A click on one starts it before the page opens. */
    services?: { port: number; name: string }[];
    /** Unwrap safelinks and strip tracking parameters. Default on. */
    clean?: boolean;
    routes: RouteRule[];
}

export interface NormalizedBrowser {
    name: string;
    appType: AppType;
    openInBackground: boolean;
}

interface OpenDecision {
    kind: "open" | "forward";
    original: string;
    url: string;
    browser: NormalizedBrowser | null;
    openArguments: string[];
    via: "route" | "default" | "loop-guard";
    routeIndex: number | null;
}

interface ToolDecision {
    kind: "tool";
    original: string;
    url: string;
    tool: string;
    args: string[];
    approval: ApprovalMode;
    needsApproval: true;
    via: "route";
    routeIndex: number;
}

/** Named fields the approval card reads. The prompt is the full text, never a truncated argv cell. */
export interface LaunchFields {
    agent: string | null;
    account: string | null;
    prompt: string | null;
    cwd: string | null;
    resume: string | null;
    name: string | null;
    model: string | null;
    surface: string | null;
    extra: string[];
    runArgs: string[];
}

interface RunDecision {
    kind: "run";
    original: string;
    url: string;
    argv: string[];
    approval: ApprovalMode;
    needsApproval: boolean;
    touchId: boolean;
    open: string | null;
    notify: string | null;
    browserArguments: string[];
    via: "route";
    routeIndex: number | null;
    launch?: LaunchFields;
}

export type RouteDecision = OpenDecision | ToolDecision | RunDecision;

export class RouteError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "RouteError";
    }
}

const TOOL_NAME = /^[a-z0-9][a-z0-9-]*$/;

export function defaultRouterConfig(
    browser: BrowserTarget | string = { name: "com.brave.Browser", appType: "bundleId" }
): RouterConfig {
    return {
        defaultBrowser: browser,
        allowAliases: true,
        aliases: [{ host: ROUTER_ALIAS_HOST, base: ROUTER_ALIAS_BASE }],
        toast: { enabled: true, seconds: 5 },
        routes: [
            ...builtinRoutes(),
            { pattern: LEGACY_LOCAL_CATCH_ALL, action: { type: "open", to: "genesis-md://$1" } },
        ],
    };
}

export function parseConfig(value: unknown): RouterConfig {
    if (!isRecord(value)) {
        throw new RouteError("config must be an object");
    }

    if (value.defaultBrowser === undefined) {
        throw new RouteError("config.defaultBrowser is required");
    }

    const routes = value.routes === undefined ? [] : value.routes;

    if (!Array.isArray(routes)) {
        throw new RouteError("config.routes must be an array");
    }

    return {
        defaultBrowser: parseBrowser(value.defaultBrowser, "defaultBrowser"),
        allowAliases: value.allowAliases !== false,
        aliases: value.aliases === undefined ? defaultAliases() : parseAliases(value.aliases),
        ...(value.toast === undefined ? {} : { toast: parseToast(value.toast, "toast") }),
        ...(value.services === undefined ? {} : { services: parseServices(value.services) }),
        clean: value.clean !== false,
        routes: routes.map((route, index) => parseRoute(route, index)),
    };
}

export function compileRoutePattern(pattern: string): RegExp {
    let source = pattern;

    if (!source.startsWith("^")) {
        source = `^(?:${source})`;
    }

    if (!source.endsWith("$")) {
        source = `${source}(?:\\?[^#]*)?(?:#.*)?$`;
    }

    try {
        return new RegExp(source);
    } catch (error) {
        throw new RouteError(`pattern /${pattern}/ is not a regular expression (${errorText(error)})`);
    }
}

export function route(
    raw: string,
    config: RouterConfig,
    allowUnwrap = true,
    consumeToken = false,
    trusted = false
): RouteDecision {
    const original = parseHttpUrl(config.clean === false ? raw : cleanUrl(raw), "url");
    const direct = firstMatch(original, raw, config, allowUnwrap, consumeToken, trusted);

    if (direct) {
        return direct;
    }

    const aliased = applyAlias(original, config);

    if (aliased.href !== original.href) {
        const second = firstMatch(aliased, raw, config, allowUnwrap, consumeToken, trusted);

        if (second) {
            return second;
        }
    }

    const service = registeredService(original, config);

    if (service) {
        const opened = forward(config.defaultBrowser, original.href, raw, "route", null);
        return {
            kind: "run",
            original: raw,
            url: original.href,
            argv: ["tools", "browser-router", "ensure", String(service.port)],
            approval: "allow",
            needsApproval: false,
            touchId: false,
            open: original.href,
            notify: `Starting ${service.name}`,
            browserArguments: opened.openArguments,
            via: "route",
            routeIndex: null,
        };
    }

    return forward(config.defaultBrowser, original.href, raw, "default", null);
}

function registeredService(url: URL, config: RouterConfig): { port: number; name: string } | null {
    if (url.protocol !== "http:" && url.protocol !== "https:") {
        return null;
    }

    if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
        return null;
    }

    const port = Number(url.port);

    if (!port || port === 6666) {
        return null;
    }

    return (config.services ?? []).find((service) => service.port === port) ?? null;
}

function firstMatch(
    url: URL,
    raw: string,
    config: RouterConfig,
    allowUnwrap: boolean,
    consumeToken: boolean,
    trusted: boolean
): RouteDecision | null {
    for (const [index, rule] of config.routes.entries()) {
        if (!allowUnwrap && rule.action.type === "unwrap") {
            continue;
        }

        const found = compileRoutePattern(rule.pattern).exec(url.href);

        if (!found) {
            continue;
        }

        if (rule.action.type === "token") {
            return redeemToken(found[1] ?? "", raw, config, consumeToken);
        }

        return applyAction(rule.action, found, raw, url, config, index, trusted);
    }

    return null;
}

export function applyAlias(url: URL, config: RouterConfig): URL {
    if (config.allowAliases === false) {
        return url;
    }

    const aliases = config.aliases ?? defaultAliases();
    const alias = aliases.find((item) => item.host.toLowerCase() === url.hostname.toLowerCase());

    if (!alias) {
        return url;
    }

    const base = new URL(alias.base.endsWith("/") ? alias.base : `${alias.base}/`);
    return new URL(`${url.pathname}${url.search}${url.hash}`, base);
}

export function defaultAliases(): RouterAlias[] {
    return [{ host: ROUTER_ALIAS_HOST, base: ROUTER_ALIAS_BASE }];
}

/** A URL with `:name` placeholders. Returns null when the string is already a regular expression. */
export function compileUrlTemplate(input: string): { pattern: string; names: string[] } | null {
    if (!/^https?:\/\//i.test(input) || /[()\\]/.test(input) || !/:[A-Za-z]/.test(input)) {
        return null;
    }

    const names: string[] = [];
    const pattern = input
        .replace(/[.*+?^${}()|[\]\\]/g, (character) => `\\${character}`)
        .replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_token, name: string) => {
            names.push(name);
            return "([^/?#&]+)";
        });

    return { pattern, names };
}

export function bindTemplateNames(template: string, names: string[]): string {
    return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (whole, name: string) => {
        const index = names.indexOf(name);

        return index === -1 ? whole : `$${index + 1}`;
    });
}

export function inferAppType(name: string): AppType {
    if (name.startsWith("/") || name.endsWith(".app")) {
        return "path";
    }

    if (name.includes(".") && !name.includes("/")) {
        return "bundleId";
    }

    return "appName";
}

const SPLIT_ARG = /^\{([A-Za-z][A-Za-z0-9]*)\*\}$/;

export function substitute(template: string, match: RegExpExecArray, url?: URL): string {
    return template.replace(
        /\$\$|\$(\d+)|\{([A-Za-z][A-Za-z0-9]*)\}/g,
        (token, index: string | undefined, name: string | undefined) => {
            if (token === "$$") {
                return "$";
            }

            if (index !== undefined) {
                return match[Number(index)] ?? "";
            }

            return placeholder(name ?? "", url);
        }
    );
}

export function fillArgs(templates: string[], match: RegExpExecArray, url: URL): string[] {
    const args: string[] = [];

    for (const template of templates) {
        const split = SPLIT_ARG.exec(template);

        if (split) {
            const value = url.searchParams.get(split[1]) ?? "";

            for (const part of value.split(",")) {
                const trimmed = part.trim();

                if (trimmed.length > 0) {
                    args.push(trimmed);
                }
            }

            continue;
        }

        args.push(substitute(template, match, url));
    }

    return args;
}

function placeholder(name: string, url: URL | undefined): string {
    if (!url) {
        return "";
    }

    if (name === "host") {
        return url.hostname;
    }

    if (name === "path") {
        return url.pathname.startsWith("/") ? url.pathname.slice(1) : url.pathname;
    }

    if (name === "pathname") {
        return url.pathname;
    }

    if (name === "port") {
        return url.port;
    }

    return url.searchParams.get(name) ?? "";
}

function redeemToken(id: string, raw: string, config: RouterConfig, consume: boolean): RouteDecision {
    const token = takeToken(id, consume);

    if (!token) {
        throw new RouteError("link used up");
    }

    const inner = route(token.url, config, false, false, true);
    return { ...inner, original: raw };
}

function unwrap(match: RegExpExecArray, raw: string, config: RouterConfig, routeIndex: number): RouteDecision {
    let decoded: string;

    try {
        decoded = decodeURIComponent(match[1] ?? "");
    } catch (error) {
        throw new RouteError(`wrapped link is not encoded (${errorText(error)})`);
    }

    const inner = route(decoded, config, false);

    if (inner.via !== "default") {
        return { ...inner, original: raw };
    }

    const parsed = parseHttpUrl(decoded, "wrapped link");

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        const browser = schemeHandler(parsed.protocol);

        // A /link/ URL arrives from any app with no prompt, so it may only open http(s) and genesis-md.
        // Anything else (file:, x-apple.systempreferences:, an editor scheme) would reach its handler unasked.
        if (!browser) {
            throw new RouteError(
                `wrapped link uses ${parsed.protocol}, and only http(s) and genesis-md links are unwrapped`
            );
        }

        return {
            kind: "open",
            original: raw,
            url: parsed.href,
            browser,
            openArguments: openArguments(browser, parsed.href),
            via: "route",
            routeIndex,
        };
    }

    return { ...inner, original: raw };
}

const PROMPT_CAP = 8_192;

function launchFields(url: URL, argv: string[]): LaunchFields | undefined {
    const isLaunch =
        url.pathname.includes("/cmux/") || (argv[0] === "tools" && argv[1] === "cmux" && argv[2] === "launch");

    if (!isLaunch) {
        return undefined;
    }

    const prompt = url.searchParams.get("prompt");

    if (prompt && Buffer.byteLength(prompt) > PROMPT_CAP) {
        throw new RouteError("prompt is over the 8 KB cap; use a minted link with --prompt-file");
    }

    return {
        agent: url.searchParams.get("agent") || "claude",
        account: url.searchParams.get("account"),
        prompt,
        cwd: url.searchParams.get("cwd"),
        resume: url.searchParams.get("resume"),
        name: url.searchParams.get("name"),
        model: url.searchParams.get("model"),
        surface: url.searchParams.get("surface"),
        extra: [...url.searchParams.getAll("arg"), ...url.searchParams.getAll("claude-arg")].filter(
            (arg) => arg.length > 0
        ),
        runArgs: url.searchParams.getAll("run").filter((arg) => arg.length > 0),
    };
}

function applyAction(
    action: RouteAction,
    match: RegExpExecArray,
    raw: string,
    url: URL,
    config: RouterConfig,
    routeIndex: number,
    trusted: boolean
): RouteDecision {
    if (action.type === "unwrap") {
        return unwrap(match, raw, config, routeIndex);
    }

    if (action.type === "token") {
        return redeemToken(match[1] ?? "", raw, config, false);
    }

    if (action.type === "run") {
        const argv = fillArgs(action.argv, match, url);
        const launch = launchFields(url, argv);

        for (const arg of launch?.runArgs ?? []) {
            argv.push("--run-arg", arg);
        }

        for (const arg of launch?.extra ?? []) {
            argv.push("--claude-arg", arg);
        }

        const open = action.open === undefined ? null : substitute(action.open, match, url);
        const notify = action.notify === undefined ? null : substitute(action.notify, match, url);
        const browserArguments =
            open === null
                ? []
                : forward(config.defaultBrowser, parseOpenTarget(open).href, raw, "route", routeIndex).openArguments;
        const asks = launch?.prompt ? !(trusted && action.trustMinted === true) : action.approval === "ask";

        return {
            kind: "run",
            original: raw,
            url: raw,
            argv,
            approval: asks ? "ask" : action.approval,
            needsApproval: asks,
            touchId: action.touchId === true,
            open,
            notify,
            browserArguments,
            via: "route",
            routeIndex,
            ...(launch ? { launch } : {}),
        };
    }

    if (action.type === "tool") {
        return {
            kind: "tool",
            original: raw,
            url: raw,
            tool: action.tool,
            args: action.args.map((arg) => substitute(arg, match, url)),
            approval: action.approval,
            needsApproval: true,
            via: "route",
            routeIndex,
        };
    }

    if (action.type === "forward") {
        const target = action.to === undefined ? raw : substitute(action.to, match, url);
        const parsed = parseHttpUrl(target, "forward target");
        return forward(action.browser, parsed.href, raw, "route", routeIndex);
    }

    const rewritten = parseHttpUrl(substitute(action.to, match, url), "open target");

    if (rewritten.protocol === "http:" || rewritten.protocol === "https:") {
        return forward(config.defaultBrowser, rewritten.href, raw, "loop-guard", routeIndex);
    }

    const browser = schemeHandler(rewritten.protocol);

    return {
        kind: "open",
        original: raw,
        url: rewritten.href,
        browser,
        openArguments: browser ? openArguments(browser, rewritten.href) : [rewritten.href],
        via: "route",
        routeIndex,
    };
}

function schemeHandler(protocol: string): NormalizedBrowser | null {
    if (protocol === "genesis-md:") {
        return { name: "dev.foltyn.genesis.markdown", appType: "bundleId", openInBackground: false };
    }

    return null;
}

function forward(
    browser: BrowserTarget | string,
    url: string,
    original: string,
    via: OpenDecision["via"],
    routeIndex: number | null
): OpenDecision {
    const normalized = normalizeBrowser(browser);

    if (normalized.appType === "none") {
        return {
            kind: "forward",
            original,
            url,
            browser: normalized,
            openArguments: [],
            via,
            routeIndex,
        };
    }

    if (normalized.appType === "bundleId" && LINK_ROUTER_BUNDLE_IDS.includes(normalized.name)) {
        throw new RouteError("a route cannot forward back into the browser router");
    }

    return {
        kind: "forward",
        original,
        url,
        browser: normalized,
        openArguments: openArguments(normalized, url),
        via,
        routeIndex,
    };
}

function openArguments(browser: NormalizedBrowser, url: string): string[] {
    const args: string[] = [];

    if (browser.openInBackground) {
        args.push("-g");
    }

    if (browser.appType === "bundleId") {
        args.push("-b", browser.name);
    } else {
        args.push("-a", browser.name);
    }

    args.push(url);
    return args;
}

function parseHttpUrl(raw: string, label: string): URL {
    try {
        return new URL(raw);
    } catch (error) {
        throw new RouteError(`${label} is not a URL: ${raw} (${errorText(error)})`);
    }
}

/**
 * A run route's `open` goes to the default browser after the command, so it must be an absolute
 * http(s) URL. Router.swift applies the same rule, so both routers refuse `report.html` or `file:`.
 */
function parseOpenTarget(raw: string): URL {
    const url = parseHttpUrl(raw, "open target");

    if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new RouteError(`open target is not an http(s) URL: ${raw}`);
    }

    return url;
}

function parseRoute(value: unknown, index: number): RouteRule {
    if (!isRecord(value) || typeof value.pattern !== "string" || value.pattern.length === 0) {
        throw new RouteError(`routes[${index}] needs a pattern`);
    }

    compileRoutePattern(value.pattern);

    if (!isRecord(value.action) || typeof value.action.type !== "string") {
        throw new RouteError(`routes[${index}].action needs a type`);
    }

    return {
        pattern: value.pattern,
        ...(typeof value.name === "string" && value.name.trim().length > 0 ? { name: value.name.trim() } : {}),
        action: parseAction(value.action, index),
        ...(value.toast === undefined ? {} : { toast: parseToast(value.toast, `routes[${index}].toast`) }),
        ...(typeof value.preset === "string" && value.preset.length > 0 ? { preset: value.preset } : {}),
    };
}

function parseToast(value: unknown, label: string): ToastSettings {
    if (value === false) {
        return false;
    }

    if (!isRecord(value)) {
        throw new RouteError(`${label} must be an object or false`);
    }

    const toast: { enabled?: boolean; seconds?: number; title?: string } = {};

    if (value.enabled !== undefined) {
        if (typeof value.enabled !== "boolean") {
            throw new RouteError(`${label}.enabled must be a boolean`);
        }

        toast.enabled = value.enabled;
    }

    if (value.seconds !== undefined) {
        if (typeof value.seconds !== "number" || value.seconds < 0) {
            throw new RouteError(`${label}.seconds must be a number of seconds`);
        }

        toast.seconds = value.seconds;
    }

    if (value.title !== undefined) {
        if (typeof value.title !== "string") {
            throw new RouteError(`${label}.title must be a string`);
        }

        toast.title = value.title;
    }

    return toast;
}

function parseAction(value: Record<string, unknown>, index: number): RouteAction {
    if (value.type === "open") {
        if (typeof value.to !== "string" || value.to.length === 0) {
            throw new RouteError(`routes[${index}].action.to is required`);
        }

        return { type: "open", to: value.to };
    }

    if (value.type === "forward") {
        if (value.browser === undefined) {
            throw new RouteError(`routes[${index}].action.browser is required`);
        }

        const to = value.to === undefined ? undefined : value.to;

        if (to !== undefined && typeof to !== "string") {
            throw new RouteError(`routes[${index}].action.to must be a string`);
        }

        return {
            type: "forward",
            ...(to === undefined ? {} : { to }),
            browser: parseBrowser(value.browser, `routes[${index}].browser`),
        };
    }

    if (value.type === "tool") {
        if (typeof value.tool !== "string" || !TOOL_NAME.test(value.tool)) {
            throw new RouteError(`routes[${index}].action.tool must be a tool name`);
        }

        if (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== "string")) {
            throw new RouteError(`routes[${index}].action.args must be a list of strings`);
        }

        return { type: "tool", tool: value.tool, args: value.args, approval: readApproval(value.approval, index) };
    }

    if (value.type === "unwrap") {
        return { type: "unwrap" };
    }

    if (value.type === "token") {
        return { type: "token" };
    }

    if (value.type === "run") {
        if (
            !Array.isArray(value.argv) ||
            value.argv.length === 0 ||
            value.argv.some((arg) => typeof arg !== "string")
        ) {
            throw new RouteError(`routes[${index}].action.argv must be a non-empty list of strings`);
        }

        const approval = readApproval(value.approval, index);
        const open = readOptionalString(value.open, `routes[${index}].action.open`);
        const notify = readOptionalString(value.notify, `routes[${index}].action.notify`);

        const touchId = value.touchId === true;
        const trustMinted = value.trustMinted === true;

        return {
            type: "run",
            argv: value.argv,
            approval,
            ...(touchId ? { touchId } : {}),
            ...(trustMinted ? { trustMinted } : {}),
            ...(open === undefined ? {} : { open }),
            ...(notify === undefined ? {} : { notify }),
        };
    }

    throw new RouteError(`routes[${index}].action.type must be open, forward, unwrap, token, run, or tool`);
}

function parseServices(value: unknown): { port: number; name: string }[] {
    if (!Array.isArray(value)) {
        throw new RouteError("config.services must be an array");
    }

    return value.map((item, index) => {
        if (!isRecord(item) || typeof item.port !== "number" || typeof item.name !== "string") {
            throw new RouteError(`services[${index}] needs a port and a name`);
        }

        return { port: item.port, name: item.name };
    });
}

function parseAliases(value: unknown): RouterAlias[] {
    if (!Array.isArray(value)) {
        throw new RouteError("config.aliases must be an array");
    }

    return value.map((item, index) => {
        if (!isRecord(item) || typeof item.host !== "string" || typeof item.base !== "string") {
            throw new RouteError(`aliases[${index}] needs host and base`);
        }

        return { host: item.host, base: item.base };
    });
}

function readApproval(value: unknown, index: number): ApprovalMode {
    const approval = value === undefined ? "ask" : value;

    if (approval !== "ask" && approval !== "allow") {
        throw new RouteError(`routes[${index}].action.approval must be ask or allow`);
    }

    return approval;
}

function readOptionalString(value: unknown, label: string): string | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (typeof value !== "string") {
        throw new RouteError(`${label} must be a string`);
    }

    return value;
}

function parseBrowser(value: unknown, label: string): BrowserTarget | string {
    if (typeof value === "string") {
        if (value.length === 0) {
            throw new RouteError(`${label} is empty`);
        }

        return value;
    }

    if (!isRecord(value) || typeof value.name !== "string" || value.name.length === 0) {
        throw new RouteError(`${label} needs a name`);
    }

    const browser: BrowserTarget = { name: value.name };

    if (value.appType !== undefined) {
        if (!isAppType(value.appType)) {
            throw new RouteError(`${label}.appType is not appName, bundleId, path, or none`);
        }

        browser.appType = value.appType;
    }

    if (value.openInBackground !== undefined) {
        if (typeof value.openInBackground !== "boolean") {
            throw new RouteError(`${label}.openInBackground must be a boolean`);
        }

        browser.openInBackground = value.openInBackground;
    }

    return browser;
}

function normalizeBrowser(value: BrowserTarget | string): NormalizedBrowser {
    if (typeof value === "string") {
        return { name: value, appType: inferAppType(value), openInBackground: false };
    }

    return {
        name: value.name,
        appType: value.appType ?? inferAppType(value.name),
        openInBackground: value.openInBackground === true,
    };
}

function isAppType(value: unknown): value is AppType {
    return value === "appName" || value === "bundleId" || value === "path" || value === "none";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
