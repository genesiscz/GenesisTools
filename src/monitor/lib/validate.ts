import { parseHostPort } from "./checks/tcp";
import {
    DEFAULT_INTERVAL_SEC,
    DEFAULT_TIMEOUT_MS,
    isNotifyChannel,
    isWatcherKind,
    MAX_INTERVAL_SEC,
    MAX_TIMEOUT_MS,
    MIN_INTERVAL_SEC,
    MIN_TIMEOUT_MS,
    type NotifyChannel,
    type NotifyTargetInput,
    type NotifyTargetPatch,
    type WatcherConfig,
    type WatcherInput,
    type WatcherKind,
    type WatcherPatch,
} from "./types";

export class WatcherValidationError extends Error {
    readonly code = "WATCHER_INVALID";

    constructor(message: string) {
        super(message);
        this.name = "WatcherValidationError";
    }
}

const ACCOUNT_ID = /^acc_[a-z0-9][a-z0-9_-]*$/;
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const HTTP_METHODS = new Set(["GET", "HEAD", "POST"]);

function asRecord(value: unknown): Record<string, unknown> {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }

    throw new WatcherValidationError("body must be a JSON object");
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
    const value = record[key];

    if (value === undefined || value === null) {
        return undefined;
    }

    if (typeof value !== "string") {
        throw new WatcherValidationError(`${key} must be a string`);
    }

    return value;
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
    const value = record[key];

    if (value === undefined || value === null) {
        return undefined;
    }

    if (typeof value !== "boolean") {
        throw new WatcherValidationError(`${key} must be a boolean`);
    }

    return value;
}

function optionalInt(
    record: Record<string, unknown>,
    key: string,
    range: { min: number; max: number }
): number | undefined {
    const value = record[key];

    if (value === undefined || value === null || value === "") {
        return undefined;
    }

    const parsed = typeof value === "string" ? Number(value) : value;

    if (typeof parsed !== "number" || !Number.isFinite(parsed)) {
        throw new WatcherValidationError(`${key} must be a number`);
    }

    const rounded = Math.round(parsed);

    if (rounded < range.min || rounded > range.max) {
        throw new WatcherValidationError(`${key} must be between ${range.min} and ${range.max}`);
    }

    return rounded;
}

export function normalizeTarget(kind: WatcherKind, raw: string): string {
    const target = raw.trim();

    if (!target) {
        throw new WatcherValidationError("target is required");
    }

    if (kind === "ai-provider") {
        if (!ACCOUNT_ID.test(target)) {
            throw new WatcherValidationError("ai-provider target must be an account id (acc_…)");
        }

        return target;
    }

    if (kind === "command") {
        return target;
    }

    if (kind === "tcp" || kind === "tls") {
        try {
            const { host, port } = parseHostPort(target, kind === "tls" ? 443 : undefined);

            return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
        } catch (error) {
            throw new WatcherValidationError(`${kind} target must be host:port (${(error as Error).message})`);
        }
    }

    if (kind === "dns") {
        const host = target
            .replace(/^[a-z]+:\/\//i, "")
            .replace(/[/:].*$/, "")
            .toLowerCase();

        if (!HOSTNAME.test(host)) {
            throw new WatcherValidationError(`dns target must be a hostname, got "${raw}"`);
        }

        return host;
    }

    const withScheme = /^https?:\/\//i.test(target) ? target : `https://${target}`;
    let url: URL;

    try {
        url = new URL(withScheme);
    } catch {
        throw new WatcherValidationError(`target is not a valid URL: ${raw}`);
    }

    if (kind === "statuspage") {
        // Callers paste the human page; the check appends /api/v2/… itself.
        return `${url.protocol}//${url.host}`;
    }

    return url.toString();
}

export function parseWatcherConfig(value: unknown): WatcherConfig {
    if (value === undefined || value === null) {
        return {};
    }

    const record = asRecord(value);
    const config: WatcherConfig = {};
    const method = optionalString(record, "method")?.toUpperCase();

    if (method) {
        if (!HTTP_METHODS.has(method)) {
            throw new WatcherValidationError("config.method must be GET, HEAD or POST");
        }

        config.method = method as WatcherConfig["method"];
    }

    const expectStatus = optionalInt(record, "expectStatus", { min: 100, max: 599 });

    if (expectStatus !== undefined) {
        config.expectStatus = expectStatus;
    }

    const expectBody = optionalString(record, "expectBody")?.trim();

    if (expectBody) {
        config.expectBody = expectBody;
    }

    const degradedAboveMs = optionalInt(record, "degradedAboveMs", { min: 1, max: MAX_TIMEOUT_MS });

    if (degradedAboveMs !== undefined) {
        config.degradedAboveMs = degradedAboveMs;
    }

    if (record.headers !== undefined && record.headers !== null) {
        const headers = asRecord(record.headers);
        const clean: Record<string, string> = {};

        for (const [key, headerValue] of Object.entries(headers)) {
            if (typeof headerValue !== "string") {
                throw new WatcherValidationError(`config.headers.${key} must be a string`);
            }

            clean[key] = headerValue;
        }

        if (Object.keys(clean).length > 0) {
            config.headers = clean;
        }
    }

    const components = optionalStringList(record, "components");

    if (components) {
        config.components = components;
    }

    const itemFilter = optionalStringList(record, "itemFilter");

    if (itemFilter) {
        config.itemFilter = itemFilter;
    }

    const deliverItems = optionalBoolean(record, "deliverItems");

    if (deliverItems !== undefined) {
        config.deliverItems = deliverItems;
    }

    const expectIp = optionalString(record, "expectIp")?.trim();

    if (expectIp) {
        config.expectIp = expectIp;
    }

    const jsonPath = optionalString(record, "jsonPath")?.trim();

    if (jsonPath) {
        config.jsonPath = jsonPath;
    }

    const expect = optionalString(record, "expect");

    if (expect !== undefined && expect !== "") {
        config.expect = expect;
    }

    const warnDays = optionalInt(record, "warnDays", { min: 1, max: 3650 });

    if (warnDays !== undefined) {
        config.warnDays = warnDays;
    }

    const minDays = optionalInt(record, "minDays", { min: 0, max: 3650 });

    if (minDays !== undefined) {
        config.minDays = minDays;
    }

    return config;
}

/** ISO date/time, or null to clear. */
export function parseMutedUntil(value: unknown): string | null | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (value === null || value === "") {
        return null;
    }

    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
        throw new WatcherValidationError("mutedUntil must be an ISO date/time or null");
    }

    return new Date(value).toISOString();
}

/** Comma string or array of strings; `undefined` when absent or empty after trimming. */
function optionalStringList(record: Record<string, unknown>, key: string): string[] | undefined {
    const raw = record[key];

    if (raw === undefined || raw === null) {
        return undefined;
    }

    const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",").map((part) => part.trim()) : null;

    if (!list || list.some((item) => typeof item !== "string")) {
        throw new WatcherValidationError(`config.${key} must be a list of strings`);
    }

    const clean = (list as string[]).map((item) => item.trim()).filter(Boolean);

    return clean.length > 0 ? clean : undefined;
}

function optionalIdList(record: Record<string, unknown>, key: string): number[] | undefined {
    const raw = record[key];

    if (raw === undefined || raw === null) {
        return undefined;
    }

    const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",").map((part) => part.trim()) : null;

    if (!list) {
        throw new WatcherValidationError(`${key} must be a list of ids`);
    }

    const ids = list
        .filter((item) => item !== "")
        .map((item) => {
            const id = typeof item === "number" ? item : Number(item);

            if (!Number.isInteger(id) || id <= 0) {
                throw new WatcherValidationError(`${key} contains "${String(item)}", which is not an id`);
            }

            return id;
        });

    return [...new Set(ids)];
}

const TARGET_FIELDS: Record<NotifyChannel, { strings: readonly string[]; booleans: readonly string[] }> = {
    system: { strings: ["sound", "title"], booleans: ["ignoreDnD"] },
    say: { strings: ["voice", "provider"], booleans: [] },
    telegram: { strings: ["botToken", "chatId"], booleans: [] },
    webhook: { strings: ["url"], booleans: [] },
};

export function parseNotifyTargetConfig(channel: NotifyChannel, value: unknown): Record<string, string | boolean> {
    if (value === undefined || value === null) {
        return {};
    }

    const record = asRecord(value);
    const spec = TARGET_FIELDS[channel];
    const config: Record<string, string | boolean> = {};

    for (const [key, raw] of Object.entries(record)) {
        if (raw === undefined || raw === null) {
            continue;
        }

        if (spec.strings.includes(key)) {
            if (typeof raw !== "string") {
                throw new WatcherValidationError(`config.${key} must be a string`);
            }

            if (raw.trim()) {
                config[key] = raw.trim();
            }

            continue;
        }

        if (spec.booleans.includes(key)) {
            if (typeof raw !== "boolean") {
                throw new WatcherValidationError(`config.${key} must be a boolean`);
            }

            config[key] = raw;
            continue;
        }

        throw new WatcherValidationError(`config.${key} is not a ${channel} field`);
    }

    if (channel === "webhook" && typeof config.url === "string") {
        let parsed: URL;

        try {
            parsed = new URL(config.url);
        } catch {
            throw new WatcherValidationError("config.url must be a valid URL");
        }

        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            throw new WatcherValidationError("config.url must be an http(s) URL");
        }
    }

    return config;
}

const REQUIRED_TARGET_FIELDS: Record<NotifyChannel, readonly string[]> = {
    system: [],
    say: [],
    telegram: ["botToken", "chatId"],
    webhook: ["url"],
};

/** A target that cannot deliver (webhook without url, telegram without token or chat) is refused, not stored. */
export function assertTargetConfigComplete(channel: NotifyChannel, config: Record<string, string | boolean>): void {
    for (const key of REQUIRED_TARGET_FIELDS[channel]) {
        if (typeof config[key] !== "string" || !config[key]) {
            throw new WatcherValidationError(`${channel} target needs config.${key}`);
        }
    }
}

export function parseNotifyTargetInput(value: unknown): NotifyTargetInput {
    const record = asRecord(value);
    const channel = record.channel;

    if (!isNotifyChannel(channel)) {
        throw new WatcherValidationError("channel must be system, say, telegram or webhook");
    }

    const name = optionalString(record, "name")?.trim();

    if (!name) {
        throw new WatcherValidationError("name is required");
    }

    const config = parseNotifyTargetConfig(channel, record.config);
    assertTargetConfigComplete(channel, config);

    return {
        name,
        channel,
        config,
        enabled: optionalBoolean(record, "enabled") ?? true,
    };
}

export function parseNotifyTargetPatch(value: unknown, currentChannel: NotifyChannel): NotifyTargetPatch {
    const record = asRecord(value);
    const patch: NotifyTargetPatch = {};

    if (record.channel !== undefined) {
        if (!isNotifyChannel(record.channel)) {
            throw new WatcherValidationError("channel must be system, say, telegram or webhook");
        }

        patch.channel = record.channel;
    }

    const name = optionalString(record, "name")?.trim();

    if (name !== undefined) {
        if (!name) {
            throw new WatcherValidationError("name cannot be empty");
        }

        patch.name = name;
    }

    if (record.config !== undefined) {
        patch.config = parseNotifyTargetConfig(patch.channel ?? currentChannel, record.config);
    } else if (patch.channel !== undefined && patch.channel !== currentChannel) {
        // Without this the row keeps the OLD channel's fields: a webhook turned
        // telegram reports as telegram while still holding only `url`, and every
        // notification through it dies silently.
        throw new WatcherValidationError(`changing the channel to ${patch.channel} needs a config for it`);
    }

    if (patch.channel !== undefined && patch.channel !== currentChannel && patch.config) {
        // No stored secret carries over across a channel switch, so the new
        // config has to be complete on its own.
        assertTargetConfigComplete(patch.channel, patch.config);
    }

    const enabled = optionalBoolean(record, "enabled");

    if (enabled !== undefined) {
        patch.enabled = enabled;
    }

    return patch;
}

export function parseWatcherInput(value: unknown): WatcherInput {
    const record = asRecord(value);
    const kind = record.kind;

    if (!isWatcherKind(kind)) {
        throw new WatcherValidationError("kind must be website, statuspage or ai-provider");
    }

    const name = optionalString(record, "name")?.trim();

    if (!name) {
        throw new WatcherValidationError("name is required");
    }

    const target = optionalString(record, "target");

    if (target === undefined) {
        throw new WatcherValidationError("target is required");
    }

    return {
        name,
        kind,
        target: normalizeTarget(kind, target),
        config: parseWatcherConfig(record.config),
        intervalSec:
            optionalInt(record, "intervalSec", { min: MIN_INTERVAL_SEC, max: MAX_INTERVAL_SEC }) ??
            DEFAULT_INTERVAL_SEC,
        timeoutMs: optionalInt(record, "timeoutMs", { min: MIN_TIMEOUT_MS, max: MAX_TIMEOUT_MS }) ?? DEFAULT_TIMEOUT_MS,
        enabled: optionalBoolean(record, "enabled") ?? true,
        notify: optionalBoolean(record, "notify") ?? true,
        targetIds: optionalIdList(record, "targetIds") ?? [],
        mutedUntil: parseMutedUntil(record.mutedUntil) ?? null,
    };
}

/** Like `parseWatcherInput` but every field is optional; `kind` is needed to normalize `target`. */
export function parseWatcherPatch(value: unknown, currentKind: WatcherKind): WatcherPatch {
    const record = asRecord(value);
    const patch: WatcherPatch = {};
    const kindValue = record.kind;

    if (kindValue !== undefined) {
        if (!isWatcherKind(kindValue)) {
            throw new WatcherValidationError("kind must be website, statuspage or ai-provider");
        }

        patch.kind = kindValue;
    }

    const name = optionalString(record, "name")?.trim();

    if (name !== undefined) {
        if (!name) {
            throw new WatcherValidationError("name cannot be empty");
        }

        patch.name = name;
    }

    const target = optionalString(record, "target");

    if (target !== undefined) {
        patch.target = normalizeTarget(patch.kind ?? currentKind, target);
    } else if (patch.kind !== undefined && patch.kind !== currentKind) {
        // Same hazard as a notify target that changes channel without a config:
        // the row would keep the OLD kind's target. A website turned ai-provider
        // reports "no AI account with id https://example.com/" on every tick,
        // and a website turned statuspage has `/api/v2/summary.json` appended to
        // a URL that still carries a path.
        throw new WatcherValidationError(`changing the kind to ${patch.kind} needs a target for it`);
    }

    if (record.config !== undefined) {
        patch.config = parseWatcherConfig(record.config);
    }

    const intervalSec = optionalInt(record, "intervalSec", { min: MIN_INTERVAL_SEC, max: MAX_INTERVAL_SEC });

    if (intervalSec !== undefined) {
        patch.intervalSec = intervalSec;
    }

    const timeoutMs = optionalInt(record, "timeoutMs", { min: MIN_TIMEOUT_MS, max: MAX_TIMEOUT_MS });

    if (timeoutMs !== undefined) {
        patch.timeoutMs = timeoutMs;
    }

    const enabled = optionalBoolean(record, "enabled");

    if (enabled !== undefined) {
        patch.enabled = enabled;
    }

    const notify = optionalBoolean(record, "notify");

    if (notify !== undefined) {
        patch.notify = notify;
    }

    const targetIds = optionalIdList(record, "targetIds");

    if (targetIds !== undefined) {
        patch.targetIds = targetIds;
    }

    const mutedUntil = parseMutedUntil(record.mutedUntil);

    if (mutedUntil !== undefined) {
        patch.mutedUntil = mutedUntil;
    }

    return patch;
}
