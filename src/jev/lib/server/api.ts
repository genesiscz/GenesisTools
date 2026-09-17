import type { IncomingMessage, ServerResponse } from "node:http";
import { StringDecoder } from "node:string_decoder";
import { evaluationProviderSchema } from "@genesiscz/utils/ai/evaluation/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
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
import { evaluateRequest, gatewayStatus } from "../service";
import { typescriptPresets } from "../typescript-grammar";

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

async function readBody(req: IncomingMessage): Promise<unknown> {
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
    return SafeJSON.parse(text + decoder.end());
}

function reply(res: ServerResponse, status: number, value: unknown) {
    res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    });
    res.end(SafeJSON.stringify(value));
}

const evaluateBody = z.object({ input: z.unknown(), zeroDataRetention: z.boolean().optional() }).strict();

export function jevApiPlugin(): Plugin {
    let activeRequests = 0;
    return {
        name: "jev:api",
        configureServer(server) {
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
                const handle = async () => {
                    const route = req.url?.split("?")[0];
                    const provider = evaluationProviderSchema.parse(req.headers["x-jev-provider"] ?? "vercel");
                    logger.debug({ route, method: req.method }, "Jev dashboard API request");
                    if (req.method === "GET" && route === "/status") {
                        return gatewayStatus(provider);
                    }

                    if (req.method === "GET" && route === "/arena/circuits") {
                        return circuitCache.status();
                    }

                    if (req.method === "GET" && route === "/presets") {
                        return { evaluation: demoInput, typescript: typescriptPresets };
                    }

                    if (req.method !== "POST") {
                        throw new Error("Unknown Jev API route.");
                    }

                    const body = await readBody(req);
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

                    throw new Error("Unknown Jev API route.");
                };
                void handle()
                    .then((result) => {
                        if (!res.destroyed) {
                            reply(res, 200, result);
                        }
                    })
                    .catch((error: unknown) => {
                        const message =
                            error instanceof ZodError
                                ? error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n")
                                : error instanceof Error
                                  ? error.message
                                  : "Request failed.";
                        logger.debug({ message }, "Jev dashboard request ended with an error");
                        if (!res.destroyed) {
                            reply(res, error instanceof ZodError ? 400 : 502, { error: message });
                        }
                    })
                    .finally(() => {
                        activeRequests--;
                        clearTimeout(timer);
                        res.removeListener("close", disconnect);
                    });
            });
        },
    };
}
