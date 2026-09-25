import { logger } from "@genesiscz/utils/logger";
import { runAction } from "../actions";
import { ConfigError, configPath, saveConfig } from "../config";
import type { Deps } from "../deps";
import { FeatureError } from "../errors";
import { explainHunk } from "../explain";
import { describeCheckouts, openFile, openTerminal } from "../open";
import { startReview } from "../review";
import { explainLink, routeLink } from "../router";
import { isRecord, PageValueError } from "../values";
import { HOST_COMMANDS, type HostCommand, type HostErrorCode, type HostResponse, type PingData } from "./messages";

export const HOST_VERSION = "0.1.0";

const log = logger.child({ component: "browser-extension/host" });

type Handler = (deps: Deps, params: Record<string, unknown>) => Promise<unknown>;

/**
 * The allowlist. Each handler takes named params and hands them to a validating lib function;
 * there is no command that runs a caller-supplied argv.
 */
const HANDLERS: Record<HostCommand, Handler> = {
    ping: async (): Promise<PingData> => ({
        host: "genesis-tools",
        version: HOST_VERSION,
        pid: process.pid,
        configPath: configPath(),
    }),
    "config.get": async (deps) => ({ path: configPath(), config: await deps.config() }),
    "config.set": async (_deps, params) => ({ path: configPath(), config: await saveConfig(params.config) }),
    "checkout.resolve": (deps, params) => describeCheckouts(deps, { url: params.url, branch: params.branch }),
    "open.file": (deps, params) =>
        openFile(deps, { url: params.url, branch: params.branch, path: params.path, line: params.line }),
    "open.terminal": (deps, params) => openTerminal(deps, { url: params.url, branch: params.branch }),
    "hunk.explain": (deps, params) =>
        explainHunk(deps, {
            url: params.url,
            branch: params.branch,
            path: params.path,
            line: params.line,
            hunk: params.hunk,
        }),
    "review.start": (deps, params) => startReview(deps, { url: params.url, branch: params.branch }),
    "action.run": (deps, params) =>
        runAction(deps, { actionId: params.actionId, url: params.url, fields: params.fields }),
    "router.explain": (deps, params) => explainLink(deps, params.url),
    "router.route": (deps, params) => routeLink(deps, params.url),
};

function isHostCommand(value: unknown): value is HostCommand {
    return typeof value === "string" && (HOST_COMMANDS as readonly string[]).includes(value);
}

function errorCode(error: unknown): HostErrorCode {
    if (error instanceof FeatureError) {
        return error.code;
    }

    return error instanceof PageValueError || error instanceof ConfigError ? "invalid" : "failed";
}

export async function dispatch(deps: Deps, request: unknown): Promise<HostResponse> {
    const command = isRecord(request) ? request.command : undefined;

    if (!isHostCommand(command)) {
        log.warn({ command: typeof command === "string" ? command : typeof command }, "refused unknown command");
        return { ok: false, code: "unknown-command", error: `unknown command ${String(command)}` };
    }

    const params = isRecord(request) && isRecord(request.params) ? request.params : {};
    const started = performance.now();

    try {
        const data = await HANDLERS[command](deps, params);
        log.info({ command, ms: Math.round(performance.now() - started) }, "host command ok");
        return { ok: true, data };
    } catch (error) {
        const code = errorCode(error);
        const message = error instanceof Error ? error.message : String(error);
        log.warn({ command, code, error }, "host command failed");
        return { ok: false, code, error: message };
    }
}
