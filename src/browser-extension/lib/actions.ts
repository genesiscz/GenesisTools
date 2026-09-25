import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { expandTilde } from "@genesiscz/utils/paths";
import { startSession } from "./agent";
import type { ActionSpec, BrowserExtensionConfig } from "./config";
import type { Deps } from "./deps";
import { FeatureError } from "./errors";
import { checkPageValue, fillArgv, fillText, isRecord } from "./values";

const log = logger.child({ component: "browser-extension/actions" });

const URL_CAP = 2000;

export interface ActionRequest {
    actionId: unknown;
    url: unknown;
    /** Values the popup read from the page with the action's selectors. */
    fields?: unknown;
    dryRun?: boolean;
}

export interface ActionOutcome {
    actionId: string;
    cwd: string;
    argv: string[] | null;
    stdoutLastLine: string | null;
    sessionCwd: string | null;
    session: string | null;
    dryRun: boolean;
}

function checkUrl(value: unknown): string {
    if (typeof value !== "string" || value.length > URL_CAP || !URL.canParse(value)) {
        throw new FeatureError("invalid", "the page URL is missing or not a URL");
    }

    const protocol = new URL(value).protocol;

    if (protocol !== "https:" && protocol !== "http:") {
        throw new FeatureError("invalid", "only http(s) pages can run actions");
    }

    return value;
}

/** Actions whose `match` fits `url`, in config order. */
export function matchingActions(config: BrowserExtensionConfig, url: string): ActionSpec[] {
    return config.actions.filter((action) => new RegExp(action.match, "u").test(url));
}

function existingDir(path: string, label: string): string {
    const expanded = expandTilde(path);

    if (!isAbsolute(expanded) || !existsSync(expanded) || !statSync(expanded).isDirectory()) {
        throw new FeatureError("invalid", `${label} ${expanded} is not an existing folder`);
    }

    return expanded;
}

/**
 * The action's values: named groups of its URL pattern (matched here, not in the page) and the
 * fields the page supplied, each checked against its pattern. Unknown fields are ignored.
 */
export function actionValues(action: ActionSpec, url: string, fields: unknown): Record<string, string> {
    const match = new RegExp(action.match, "u").exec(url);

    if (!match) {
        throw new FeatureError("invalid", `action ${action.id} does not apply to this page`);
    }

    const values: Record<string, string> = { url };

    for (const [name, value] of Object.entries(match.groups ?? {})) {
        values[name] = checkPageValue(name, value);
    }

    const given: Record<string, unknown> = isRecord(fields) ? fields : {};

    for (const [name, spec] of Object.entries(action.fields ?? {})) {
        values[name] = checkPageValue(name, given[name], spec.pattern);
    }

    return values;
}

export async function runAction(deps: Deps, request: ActionRequest): Promise<ActionOutcome> {
    const config = await deps.config();
    const action = config.actions.find((candidate) => candidate.id === request.actionId);

    if (!action) {
        throw new FeatureError("invalid", `no configured action ${String(request.actionId)}`);
    }

    const url = checkUrl(request.url);
    const cwd = existingDir(action.cwd, `action ${action.id} cwd`);
    const values = { ...actionValues(action, url, request.fields), cwd };
    const argv = action.command ? fillArgv(action.command, { ...values, stdoutLastLine: "" }) : null;
    const dryRun = request.dryRun === true;
    const outcome: ActionOutcome = {
        actionId: action.id,
        cwd,
        argv,
        stdoutLastLine: null,
        sessionCwd: null,
        session: null,
        dryRun,
    };
    log.info({ action: action.id, argv0: argv?.[0] ?? null, dryRun }, "run action");

    if (dryRun) {
        return outcome;
    }

    if (argv) {
        const res = await deps.run(argv, { cwd, timeoutMs: action.timeoutMs ?? 120_000 });

        if (res.code !== 0) {
            throw new FeatureError("failed", `${argv[0]} exited ${res.code}: ${res.stderr.trim().slice(-500)}`);
        }

        outcome.stdoutLastLine =
            res.stdout
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean)
                .at(-1) ?? "";
    }

    if (action.session === false) {
        return outcome;
    }

    const sessionValues = { ...values, stdoutLastLine: outcome.stdoutLastLine ?? "" };
    outcome.sessionCwd = existingDir(fillText(action.sessionCwd ?? "{cwd}", sessionValues), "session folder");
    const session = await startSession({
        deps,
        config,
        cwd: outcome.sessionCwd,
        title: fillText(action.label, sessionValues),
        kind: action.id,
        prompt: fillText(action.prompt ?? "Page: {url}", sessionValues),
    });
    outcome.session = session.detail;
    return outcome;
}
