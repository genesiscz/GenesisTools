import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { compareChoosers } from "@app/control/lib/decision/chooser-replay";
import { replayCases } from "@app/control/lib/decision/fixtures";
import type { ControlDriver } from "@app/control/lib/decision/native";
import { type ObserveFanout, observeFanout } from "@app/control/lib/decision/observe";
import { replayControl } from "@app/control/lib/decision/replay";
import { replayResilience, resilienceCases } from "@app/control/lib/decision/resilience-replay";
import { VisualCaptureStore } from "@app/control/lib/decision/visual-store";
import { replayWait, waitCases } from "@app/control/lib/decision/wait-replay";
import { parseCustomTemplates } from "@app/jev/lib/screen/custom";
import { COMPACT_SOURCES, type CompactResult, compactSession, formatDecisionTable } from "@genesiscz/utils/ai/compact";
import { type EvaluationProviderId, evaluationProviderSchema } from "@genesiscz/utils/ai/evaluation/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import type { Plugin } from "vite";
import { ZodError, z } from "zod";
import { circuitCache } from "../arena/cache";
import { decideArena } from "../arena/policy";
import { compileExperiment } from "../compiler";
import { demoInput } from "../evaluate";
import { stepExperiment } from "../experiment";
import { experimentRequestSchema } from "../experiment-contract";
import { generationMode } from "../generation";
import { languages } from "../languages";
import {
    LISTEN_LAB_FIXTURES,
    ListenLab,
    ListenSessionConflictError,
    listenLabObservation,
    listenLabStartSchema,
} from "../listen/lab";
import { loadCatalogue } from "../route/cache";
import type { ToolCatalogue } from "../route/catalogue";
import { type RouteDecision, routeUtterance } from "../route/router";
import { DEFAULT_VERIFY_PURPOSES, parsePurposes } from "../screen/templates";
import { parseClaims, type VerifyResult, verifyClaims } from "../screen/verify";
import { type Evaluator, evaluateRequest, gatewayStatus } from "../service";
import { typescriptPresets } from "../typescript-grammar";
import { runWatch, type WatchResult } from "../watch/loop";

const { log } = logger.scoped("jev-api");
const listenProf = profiler.scope("jev-listen");
const routeProf = profiler.scope("jev-route");
const compactProf = profiler.scope("jev-compact");
const verifyProf = profiler.scope("jev-verify");
const observeProf = profiler.scope("jev-observe");
const watchProf = profiler.scope("jev-watch");

/** `src/`, the directory the route catalogue is built from (this file is `src/jev/lib/server/`). */
const SRC_DIR = join(import.meta.dir, "..", "..", "..");

export function validLocalRequest(req: IncomingMessage): boolean {
    const host = req.headers.host;
    const port = req.socket.localPort;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
        return false;
    }

    if (req.headers.origin && req.headers.origin !== `http://${host}`) {
        return false;
    }

    return (
        req.method === "GET" ||
        (req.headers["x-jev-request"] === "1" && req.headers["content-type"]?.startsWith("application/json") === true)
    );
}

/** A native `see` is offered to a request that arrived over the loopback interface only. */
export function loopbackRequest(req: IncomingMessage): boolean {
    const address = req.socket.remoteAddress;
    return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

async function readBody(req: IncomingMessage): Promise<{ value: unknown; bytes: number }> {
    let text = "";
    let bytes = 0;
    const decoder = new StringDecoder("utf8");
    req.setTimeout(10000, () => req.destroy(new Error("Request body timed out.")));
    for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 65536) {
            throw new Error("Request exceeds 64 KB.");
        }

        text += decoder.write(chunk);
    }

    req.setTimeout(0);
    return { value: SafeJSON.parse(text + decoder.end(), { strict: true }), bytes };
}

function reply(res: ServerResponse, status: number, value: unknown): number {
    const payload = SafeJSON.stringify(value, { strict: true });
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    });
    res.end(payload);
    return Buffer.byteLength(payload, "utf8");
}

const evaluateBody = z.object({ input: z.unknown(), zeroDataRetention: z.boolean().optional() }).strict();

function providerEvaluator(provider: EvaluationProviderId): Evaluator {
    return (call) => evaluateRequest({ ...call, provider });
}

export const routeRequestSchema = z.object({ utterance: z.string().min(1).max(400) }).strict();

/**
 * `POST /route`. The same decision `tools jev route` prints, and nothing more: the HTTP door can
 * never execute a routed command, so `--run` has no browser equivalent by construction.
 */
export async function routeRequest(options: {
    input: unknown;
    provider: EvaluationProviderId;
    signal?: AbortSignal;
    evaluate?: Evaluator;
    catalogue?: ToolCatalogue;
}): Promise<RouteDecision> {
    const { utterance } = routeRequestSchema.parse(options.input);
    const catalogue = options.catalogue ?? (await loadCatalogue({ srcDir: SRC_DIR })).catalogue;
    return routeUtterance({
        utterance,
        catalogue,
        evaluate: options.evaluate ?? providerEvaluator(options.provider),
        ...(options.signal ? { signal: options.signal } : {}),
        bind: true,
    });
}

export const compactRequestSchema = z
    .object({
        text: z.string().min(1).max(60000),
        source: z.enum(COMPACT_SOURCES).optional(),
        keep: z.number().min(0).max(1).optional(),
        maxResult: z.number().int().min(1).max(20000).optional(),
    })
    .strict();

/** `POST /compact`. Structural compaction only; the paid `--llm` layer stays a CLI decision. */
export async function compactRequest(options: {
    input: unknown;
    signal?: AbortSignal;
}): Promise<CompactResult & { table: string[] }> {
    const body = compactRequestSchema.parse(options.input);
    const result = await compactSession({
        text: body.text,
        ...(body.source ? { source: body.source } : {}),
        ...(body.keep === undefined ? {} : { keep: body.keep }),
        ...(body.maxResult === undefined ? {} : { maxResult: body.maxResult }),
        ...(options.signal ? { signal: options.signal } : {}),
    });
    return { ...result, table: formatDecisionTable(result) };
}

export const verifyRequestSchema = z
    .object({
        claims: z.string().min(1).max(20000),
        against: z.string().min(1).max(40000),
        purposes: z.array(z.string().max(60)).max(12).optional(),
        task: z.string().max(400).optional(),
        // The CLI (--custom) and the MCP tool both accept extra templates. Leaving it out here
        // made the same verification answerable only through two of its three doors.
        custom: z.string().max(20000).optional(),
    })
    .strict();

/** `POST /verify`. One Jev request scoring the claims and the selected document templates. */
export async function verifyRequest(options: {
    input: unknown;
    provider: EvaluationProviderId;
    signal?: AbortSignal;
    evaluate?: Evaluator;
}): Promise<VerifyResult> {
    const body = verifyRequestSchema.parse(options.input);
    return verifyClaims({
        claims: parseClaims(body.claims),
        against: body.against,
        purposes: parsePurposes(body.purposes, DEFAULT_VERIFY_PURPOSES),
        ...(body.task ? { task: body.task } : {}),
        ...(body.custom ? { custom: parseCustomTemplates(body.custom) } : {}),
        evaluate: options.evaluate ?? providerEvaluator(options.provider),
        ...(options.signal ? { signal: options.signal } : {}),
    });
}

export const observeRequestSchema = z
    .object({
        caseId: z.string().min(1).max(80).optional(),
        goal: z.string().min(1).max(400),
    })
    .strict();

function fixtureObservation(caseId?: string) {
    if (!caseId) {
        return listenLabObservation();
    }

    const found = replayCases.find((item) => item.id === caseId);
    if (!found) {
        throw new Error(`Unknown control fixture ${caseId}.`);
    }

    return found.observation;
}

/**
 * `POST /observe`. One fan-out over a RETAINED fixture observation. The browser never triggers a
 * `see` of this Mac, so the card shows the CLI's own decision shape without touching the desktop.
 */
export async function observeRequest(options: {
    input: unknown;
    provider: EvaluationProviderId;
    signal?: AbortSignal;
    evaluate?: Evaluator;
}): Promise<ObserveFanout> {
    const body = observeRequestSchema.parse(options.input);
    return observeFanout({
        observation: fixtureObservation(body.caseId),
        goal: body.goal,
        evaluate: options.evaluate ?? providerEvaluator(options.provider),
        ...(options.signal ? { signal: options.signal } : {}),
    });
}

export const watchRequestSchema = z
    .object({
        caseId: z.string().min(1).max(80).optional(),
        goal: z.string().min(1).max(400),
        hz: z.number().int().min(1).max(10).optional(),
        seconds: z.number().min(0.25).max(10).optional(),
        maxRequests: z.number().int().min(1).max(8).optional(),
    })
    .strict();

/**
 * `POST /watch`. `runWatch` over a fixture driver, so the card reports real ticks, observes, hz and
 * the last refusal instead of describing them. The driver observes and refuses to act.
 */
export async function watchRequest(options: {
    input: unknown;
    provider: EvaluationProviderId;
    signal?: AbortSignal;
    evaluate?: Evaluator;
}): Promise<WatchResult> {
    const body = watchRequestSchema.parse(options.input);
    const observation = fixtureObservation(body.caseId);
    const driver: ControlDriver = {
        observe: async () => observation,
        act: async () => {
            throw new Error("The watch lab observes only; it never acts.");
        },
    };
    return runWatch({
        goal: body.goal,
        driver,
        evaluate: options.evaluate ?? providerEvaluator(options.provider),
        hz: body.hz ?? 4,
        maxSeconds: body.seconds ?? 2,
        maxRequests: body.maxRequests ?? 2,
        ...(options.signal ? { signal: options.signal } : {}),
    });
}

export function jevApiPlugin(): Plugin {
    let activeRequests = 0;
    const visuals = new VisualCaptureStore();
    // Per-process state, beside the retained-capture store: a module-level singleton would leak
    // one dashboard's live session into another server in the same process.
    const listen = new ListenLab();
    return {
        name: "jev:api",
        configureServer(server) {
            server.httpServer?.once("close", () => {
                visuals.dispose();
                listen.dispose();
            });
            server.middlewares.use("/api/jev", (req, res) => {
                if (!validLocalRequest(req)) {
                    reply(res, 403, { error: "This API accepts same-origin local requests only." });
                    return;
                }

                if (activeRequests >= 2) {
                    reply(res, 429, { error: "Two requests are already running. Stop or wait for one to finish." });
                    return;
                }

                activeRequests++;
                const controller = new AbortController();
                const timer = setTimeout(
                    () => controller.abort(),
                    req.url?.split("?")[0] === "/arena/circuit" ? 120000 : 45000
                );
                const disconnect = () => {
                    if (!res.writableEnded) {
                        controller.abort();
                    }
                };
                res.once("close", disconnect);
                const route = req.url?.split("?")[0] ?? "";
                const started = performance.now();
                let requestBytes = 0;
                let responseBytes = 0;
                const handle = async () => {
                    const provider = evaluationProviderSchema.parse(req.headers["x-jev-provider"] ?? "vercel");
                    log.debug({ route, method: req.method }, "Jev dashboard API request");
                    if (req.method === "GET" && route === "/control/visual/image") {
                        const id = new URL(req.url ?? "", "http://localhost").searchParams.get("id") ?? "";
                        const data = await visuals.image(id);
                        res.writeHead(200, {
                            "Content-Type": "image/png",
                            "Cache-Control": "no-store",
                            "X-Content-Type-Options": "nosniff",
                        });
                        res.end(data);
                        responseBytes = data.byteLength;
                        return;
                    }
                    if (req.method === "GET" && route === "/control/resilience-cases") {
                        return resilienceCases;
                    }
                    if (req.method === "GET" && route === "/status") {
                        return gatewayStatus(provider);
                    }

                    if (req.method === "GET" && route === "/arena/circuits") {
                        return circuitCache.status();
                    }

                    if (req.method === "GET" && route === "/control/wait-cases") {
                        return waitCases.map(({ id, title }) => ({ id, title }));
                    }
                    if (req.method === "GET" && route === "/control/cases") {
                        return replayCases;
                    }
                    if (req.method === "GET" && route === "/presets") {
                        return { evaluation: demoInput, typescript: typescriptPresets };
                    }

                    if (req.method === "GET" && route === "/listen/fixtures") {
                        return {
                            fixtures: LISTEN_LAB_FIXTURES.map(({ id, title, events }) => ({
                                id,
                                title,
                                events: events.length,
                            })),
                            cases: replayCases.map(({ id, title }) => ({ id, title })),
                        };
                    }

                    if (req.method === "GET" && route === "/listen/status") {
                        return listen.status();
                    }

                    if (req.method === "GET" && route === "/listen/tail") {
                        return { tail: listen.tail(), running: listen.status().running };
                    }

                    if (req.method !== "POST") {
                        throw new Error("Unknown Jev API route.");
                    }

                    const read = await readBody(req);
                    const body = read.value;
                    requestBytes = read.bytes;
                    if (route === "/control/resilience-replay") {
                        return replayResilience({ input: body, provider, signal: controller.signal });
                    }
                    if (route === "/control/visual/capture") {
                        return visuals.capture(body, controller.signal);
                    }
                    if (route === "/control/visual/choose") {
                        return visuals.choose(body, { provider, signal: controller.signal });
                    }
                    if (route === "/control/visual/click") {
                        return visuals.click(body, controller.signal);
                    }
                    if (route === "/control/compare-choosers") {
                        return compareChoosers({ input: body, provider, signal: controller.signal });
                    }
                    if (route === "/control/wait-replay") {
                        return replayWait({ input: body, provider, signal: controller.signal });
                    }
                    if (route === "/control/replay") {
                        return replayControl({ input: body, provider, signal: controller.signal });
                    }
                    if (route === "/arena/circuit") {
                        const { tierId } = z
                            .object({ tierId: z.string().max(32) })
                            .strict()
                            .parse(body);
                        return circuitCache.load({ tierId, signal: controller.signal });
                    }

                    if (route === "/arena/decide") {
                        return decideArena({ observation: body, signal: controller.signal, provider });
                    }

                    if (route === "/evaluate") {
                        const options = evaluateBody.parse(body);
                        return evaluateRequest({ ...options, signal: controller.signal, provider });
                    }

                    if (route === "/experiment/state") {
                        const request = experimentRequestSchema.parse(body);
                        return generationMode(request.mode).state(languages.get(request.language), request);
                    }

                    if (route === "/experiment/step") {
                        return stepExperiment({ input: body, signal: controller.signal, provider });
                    }

                    if (route === "/experiment/compile") {
                        return compileExperiment({ input: body, signal: controller.signal });
                    }

                    if (route === "/route") {
                        return routeProf.measureAsync("http-route", () =>
                            routeRequest({ input: body, provider, signal: controller.signal })
                        );
                    }

                    if (route === "/compact") {
                        return compactProf.measureAsync("http-compact", () =>
                            compactRequest({ input: body, signal: controller.signal })
                        );
                    }

                    if (route === "/verify") {
                        return verifyProf.measureAsync("http-verify", () =>
                            verifyRequest({ input: body, provider, signal: controller.signal })
                        );
                    }

                    if (route === "/observe") {
                        return observeProf.measureAsync("http-observe", () =>
                            observeRequest({ input: body, provider, signal: controller.signal })
                        );
                    }

                    if (route === "/watch") {
                        return watchProf.measureAsync("http-watch", () =>
                            watchRequest({ input: body, provider, signal: controller.signal })
                        );
                    }

                    if (route === "/listen/start") {
                        const parsed = listenLabStartSchema.parse(body);
                        return listenProf.measure("http-listen-start", () =>
                            listen.start({ ...parsed, provider, allowNative: loopbackRequest(req) })
                        );
                    }

                    if (route === "/listen/stop") {
                        return listen.stop();
                    }

                    throw new Error("Unknown Jev API route.");
                };
                void handle()
                    .then((result) => {
                        if (!res.destroyed && !res.writableEnded) {
                            responseBytes = reply(res, 200, result);
                        }
                    })
                    .catch((error: unknown) => {
                        const message =
                            error instanceof ZodError
                                ? error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n")
                                : error instanceof Error
                                  ? error.message
                                  : "Request failed.";
                        log.debug({ message }, "Jev dashboard request ended with an error");
                        if (!res.destroyed && !res.writableEnded) {
                            const status =
                                error instanceof ListenSessionConflictError
                                    ? 409
                                    : error instanceof ZodError
                                      ? 400
                                      : 502;
                            responseBytes = reply(res, status, { error: message });
                        }
                    })
                    .finally(() => {
                        activeRequests--;
                        clearTimeout(timer);
                        res.removeListener("close", disconnect);
                        log.info(
                            {
                                route,
                                method: req.method,
                                requestBytes,
                                responseBytes,
                                ms: Math.round(performance.now() - started),
                            },
                            "Jev dashboard API request finished"
                        );
                    });
            });
        },
    };
}
