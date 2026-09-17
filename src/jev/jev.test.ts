import { describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import type { Experimental_EvaluationModel } from "ai";
import { CircuitCache, circuitBlobHash } from "./lib/arena/cache";
import type { CircuitGraph, CircuitTier } from "./lib/arena/circuit";
import { FlyArena } from "./lib/arena/engine";
import { MaleCnsCircuit } from "./lib/arena/neural";
import { decideArena } from "./lib/arena/policy";
import { simulateArena } from "./lib/arena/simulate";
import { needsCircuit, needsJev } from "./lib/arena/types";
import { resolveApiKey, saveApiKey } from "./lib/auth";
import { compileExperiment } from "./lib/compiler";
import { CompilerRegistry } from "./lib/compilers/registry";
import type { LanguageCompiler } from "./lib/compilers/types";
import { describeGatewayFailure } from "./lib/errors";
import {
    createJevModel,
    demoInput,
    type EvaluationInput,
    evaluateState,
    evaluationSchema,
    JEV_MODEL,
} from "./lib/evaluate";
import { stepExperiment } from "./lib/experiment";
import { experimentRequestSchema } from "./lib/experiment-contract";
import { CharacterMode } from "./lib/generation";
import { LanguageRegistry, languages, TypeScriptLanguage } from "./lib/languages";
import { validLocalRequest } from "./lib/server/api";
import type { evaluateRequest } from "./lib/service";
import { typescriptRequestSchema, typescriptState } from "./lib/typescript-grammar";

type TestModel = Exclude<Experimental_EvaluationModel, string>;

function fakeModel() {
    const doEvaluate = mock<TestModel["doEvaluate"]>(async () => ({
        answers: {
            refundRequested: { type: "boolean", probability: 0.99 },
            route: { type: "choice", choice: "billing", probabilities: { billing: 1, shipping: 0, technical: 0 } },
            urgency: { type: "score", score: 1, probabilities: { "0": 0, "1": 1, "2": 0 } },
        },
        usage: { inputTokens: 42, outputTokens: 0 },
        warnings: [],
        providerMetadata: { typesafe: { confidence: { route: 0.98 } } },
    }));
    const model: TestModel = {
        specificationVersion: "v4",
        provider: "test",
        modelId: JEV_MODEL,
        supportedQuestionTypes: ["boolean", "choice", "score"],
        doEvaluate,
    };
    return { model, doEvaluate };
}

describe("Jev evaluation", () => {
    test("preserves all answer types, usage and provider confidence through the SDK", async () => {
        const { model, doEvaluate } = fakeModel();
        const result = await evaluateState({ input: demoInput, model });
        expect(result.answers.refundRequested).toEqual({ type: "boolean", probability: 0.99 });
        expect(result.answers.route).toMatchObject({ choice: "billing" });
        expect(result.answers.urgency).toMatchObject({ score: 1 });
        expect(result.usage.inputTokens).toBe(42);
        expect(result.providerMetadata?.typesafe?.confidence).toEqual({ route: 0.98 });
        expect(doEvaluate).toHaveBeenCalledTimes(1);
        const call = doEvaluate.mock.calls[0]?.[0];
        expect(call?.state).toBe(demoInput.state);
        expect(call?.providerOptions?.gateway).toBeUndefined();
        expect(call?.abortSignal).toBeInstanceOf(AbortSignal);
    });

    test("requires ZDR only when requested and never retries without it", async () => {
        const { model, doEvaluate } = fakeModel();
        doEvaluate.mockImplementation(async () => {
            throw new Error("ZdrUnauthorizedError");
        });
        await expect(evaluateState({ input: demoInput, model, zeroDataRetention: true })).rejects.toThrow(
            "ZdrUnauthorizedError"
        );
        expect(doEvaluate).toHaveBeenCalledTimes(1);
        expect(doEvaluate.mock.calls[0]?.[0].providerOptions?.gateway).toEqual({ zeroDataRetention: true });
    });

    test("rejects invalid criteria before invoking the model", async () => {
        const { model, doEvaluate } = fakeModel();
        await expect(
            evaluateState({
                input: {
                    state: "ticket",
                    questions: { urgency: { type: "score", instructions: "Rate", criteria: ["low"] } },
                },
                model,
            })
        ).rejects.toThrow();
        expect(doEvaluate).not.toHaveBeenCalled();
    });

    test("rejects empty questions, unknown fields, invalid state and empty choices", () => {
        expect(evaluationSchema.safeParse({ state: "ticket", questions: {} }).success).toBe(false);
        expect(evaluationSchema.safeParse({ ...demoInput, model: "wrong" }).success).toBe(false);
        expect(evaluationSchema.safeParse({ ...demoInput, state: null }).success).toBe(false);
        expect(
            evaluationSchema.safeParse({
                state: "ticket",
                questions: {
                    route: { type: "choice", instructions: "Route", criteria: {} },
                },
            }).success
        ).toBe(false);
    });

    test("accepts structured state, instructions and null criteria", () => {
        const input: EvaluationInput = {
            state: [{ role: "user", text: "refund" }],
            questions: {
                route: { type: "choice", instructions: { task: "Route" }, criteria: { billing: null } },
                safe: { type: "boolean", instructions: "Safe?", criteria: { true: { rule: "ok" } } },
            },
        };
        expect(evaluationSchema.parse(input)).toEqual(input);
    });

    test("validates the deadline before any model call", async () => {
        const { model, doEvaluate } = fakeModel();
        await expect(evaluateState({ input: demoInput, model, timeoutMs: 0 })).rejects.toThrow("Timeout");
        expect(doEvaluate).not.toHaveBeenCalled();
    });

    test("uses the gateway evaluation model, not the chat model", () => {
        const model = createJevModel("fixture-key");
        expect(model.modelId).toBe(JEV_MODEL);
        expect(model.supportedQuestionTypes).toContain("boolean");
        expect(model.doEvaluate).toBeFunction();
    });

    test("does not retry a provider failure", async () => {
        const { model, doEvaluate } = fakeModel();
        doEvaluate.mockImplementation(async () => {
            throw new Error("fixture failure");
        });
        await expect(evaluateState({ input: demoInput, model })).rejects.toThrow("fixture failure");
        expect(doEvaluate).toHaveBeenCalledTimes(1);
    });
});

describe("Jev authentication", () => {
    test("has read-only missing-credential handling and saves owner-only keys with explicit precedence", async () => {
        const root = await mkdtemp(join(tmpdir(), "jev-auth-"));
        const snapshot = env.testing.snapshot();
        try {
            env.testing.set("GENESIS_TOOLS_HOME", root);
            env.testing.unset("AI_GATEWAY_API_KEY");
            env.testing.unset("VERCEL_OIDC_TOKEN");
            await expect(resolveApiKey()).rejects.toThrow("tools jev login");
            expect(await Bun.file(join(root, ".genesis-tools/jev/config.json")).exists()).toBe(false);
            env.testing.set("VERCEL_OIDC_TOKEN", "fixture-oidc");
            expect(await resolveApiKey()).toBe("fixture-oidc");
            const file = await saveApiKey("fixture-saved");
            expect((await stat(file)).mode & 0o777).toBe(0o600);
            expect(await resolveApiKey()).toBe("fixture-saved");
            env.testing.set("AI_GATEWAY_API_KEY", "fixture-env");
            expect(await resolveApiKey()).toBe("fixture-env");
        } finally {
            env.testing.restore(snapshot);
            await rm(root, { recursive: true, force: true });
        }
    });
});

describe("Jev gateway failures", () => {
    test("explains account verification without asking for a new API key", () => {
        const error = {
            statusCode: 403,
            cause: {
                message: '{"error":{"type":"customer_verification_required","message":"verification needed"}}',
            },
        };
        const message = describeGatewayFailure({ error, timeoutMs: 30000 });
        expect(message).toContain("credit card");
        expect(message).toContain("You do not need to replace your API key");
        expect(message).not.toContain("tools jev login");
    });

    test("identifies the plan restriction for ZDR", () => {
        const error = {
            statusCode: 403,
            message: "Zero Data Retention (ZDR) is only available for Pro and Enterprise plans. Current plan: hobby.",
        };
        const message = describeGatewayFailure({ error, timeoutMs: 30000 });
        expect(message).toContain("--zdr");
        expect(message).toContain("Pro or Enterprise");
        expect(message).not.toContain("tools jev login");
    });

    test("preserves new gateway rejection reasons while redacting the credential", () => {
        const error = {
            name: "GatewayInternalServerError",
            statusCode: 403,
            message: "Free tier users do not have access to this model. Upgrade to paid credits. Key: fixture-key",
        };
        const message = describeGatewayFailure({ error, timeoutMs: 30000, apiKey: "fixture-key" });
        expect(message).toContain("Upgrade to paid credits");
        expect(message).not.toContain("fixture-key");
        expect(message).toContain("[REDACTED]");
    });

    test("distinguishes invalid credentials, forbidden access, credits and timeout without exposing raw errors", () => {
        expect(describeGatewayFailure({ error: { statusCode: 401 }, timeoutMs: 30000 })).toContain("tools jev login");
        expect(describeGatewayFailure({ error: { statusCode: 403 }, timeoutMs: 30000 })).toContain("denied access");
        expect(describeGatewayFailure({ error: { statusCode: 402 }, timeoutMs: 30000 })).toContain("credits");
        expect(describeGatewayFailure({ error: { cause: { name: "TimeoutError" } }, timeoutMs: 30 })).toContain(
            "30 ms"
        );
        expect(describeGatewayFailure({ error: new Error("fixture-secret"), timeoutMs: 30000 })).not.toContain(
            "fixture-secret"
        );
    });
});

const HELLO_TOKENS = ["export", "{", "}", ";", "console", ".", "log", "(", '"Hello, World!"', ")", ";", "<done>"];
const helloRequest = () =>
    typescriptRequestSchema.parse({ goal: "Print Hello, World!", literals: ["Hello, World!"], tokens: HELLO_TOKENS });

describe("TypeScript experiment", () => {
    test("only offers grammar-valid tokens and requires an explicit finish decision", () => {
        const request = helloRequest();
        for (let index = 0; index < request.tokens.length; index++) {
            const state = typescriptState({ ...request, tokens: request.tokens.slice(0, index) });
            expect(state.candidates).toContain(request.tokens[index]);
            expect(state.complete).toBe(false);
        }

        const result = typescriptState(request);
        expect(result.complete).toBe(true);
        expect(result.candidates).toEqual([]);
        expect(result.source).toBe('export {};\nconsole.log("Hello, World!");');
    });

    test("rejects arbitrary code, undeclared variables and const reassignment", () => {
        const base = ["export", "{", "}", ";"];
        expect(() => typescriptState({ literals: [], tokens: [...base, "fetch"] })).toThrow("Illegal TypeScript");
        expect(() =>
            typescriptState({ literals: [], tokens: [...base, "console", ".", "log", "(", "missing"] })
        ).toThrow();
        const state = typescriptState({ literals: [], tokens: [...base, "const", "a", ":", "number", "=", "1", ";"] });
        expect(state.candidates).not.toContain("a");
        expect(state.candidates).toContain("<done>");
        expect(typescriptRequestSchema.safeParse({ ...helloRequest(), source: "process.exit()" }).success).toBe(false);
    });

    test("maps model option IDs to legal tokens and preserves probability evidence", async () => {
        const evaluate = mock<typeof evaluateRequest>(async () => ({
            model: JEV_MODEL,
            answers: {
                next: { type: "choice", choice: "t0", probabilities: { t0: 1 } },
                done: { type: "boolean", probability: 0.01 },
            },
            usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
            warnings: [],
            rounding: undefined,
            providerMetadata: { typesafe: { confidence: { next: 0.9 } } },
        }));
        const step = await stepExperiment({ input: { goal: "Say hello" }, evaluate });
        expect(step.tokens).toEqual(["export"]);
        expect(step.decision.probability).toBe(1);
        expect(step.decision.confidence).toBe(0.9);
        expect(step.decision.doneProbability).toBe(0.01);
        expect(evaluate).toHaveBeenCalledTimes(1);
        await expect(
            stepExperiment({ input: { goal: "Say hello", tokens: ["export"], maxSteps: 1 }, evaluate })
        ).rejects.toThrow("step limit");
        const controller = new AbortController();
        controller.abort();
        await expect(
            stepExperiment({ input: { goal: "Say hello" }, evaluate, signal: controller.signal })
        ).rejects.toThrow();
        expect(evaluate).toHaveBeenCalledTimes(1);
    });

    test("type-checks and runs actual TypeScript with Bun", async () => {
        const result = await compileExperiment({ input: helloRequest() });
        expect(result.build.exitCode).toBe(0);
        expect(result.run?.exitCode).toBe(0);
        expect(result.run?.stdout).toBe("Hello, World!\n");
        expect(result.run?.timedOut).toBe(false);
        await expect(compileExperiment({ input: { ...helloRequest(), tokens: ["export"] } })).rejects.toThrow("Finish");
    }, 30000);

    test("reads stdin as numbers and computes a typed result", async () => {
        const inputDeclaration = [
            "export",
            "{",
            "}",
            ";",
            "const",
            "input",
            ":",
            "number",
            "[",
            "]",
            "=",
            "(",
            "await",
            "Bun",
            ".",
            "stdin",
            ".",
            "text",
            "(",
            ")",
            ")",
            ".",
            "trim",
            "(",
            ")",
            ".",
            "split",
            "(",
            "/\\s+/",
            ")",
            ".",
            "map",
            "(",
            "Number",
            ")",
            ";",
        ];
        const tokens = [
            ...inputDeclaration,
            "const",
            "sum",
            ":",
            "number",
            "=",
            "input",
            "[",
            "0",
            "]",
            "+",
            "input",
            "[",
            "1",
            "]",
            ";",
            "console",
            ".",
            "log",
            "(",
            "sum",
            ")",
            ";",
            "<done>",
        ];
        const result = await compileExperiment({
            input: { goal: "Add two numbers", literals: [], stdin: "12 30\n", tokens },
        });
        expect(result.build.exitCode).toBe(0);
        expect(result.run?.stdout).toBe("42\n");
    }, 30000);
});

describe("Jev local API boundary", () => {
    test("accepts same-origin requests but rejects other origins, hosts and form posts", async () => {
        const server = createServer((req: IncomingMessage, res: ServerResponse) => {
            res.writeHead(validLocalRequest(req) ? 200 : 403);
            res.end();
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") {
            throw new Error("Missing test port");
        }

        const base = `http://127.0.0.1:${address.port}`;
        try {
            expect((await fetch(base)).status).toBe(200);
            expect(
                (
                    await fetch(base, {
                        method: "POST",
                        headers: { "Content-Type": "application/json", "X-Jev-Request": "1", Origin: base },
                        body: "{}",
                    })
                ).status
            ).toBe(200);
            expect((await fetch(base, { headers: { Origin: "https://example.com" } })).status).toBe(403);
            expect((await fetch(base, { headers: { Host: "example.com" } })).status).toBe(403);
            expect((await fetch(base, { method: "POST", body: "input=hello" })).status).toBe(403);
        } finally {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });
});

describe("Language and compiler interfaces", () => {
    test("dispatches independent compiler implementations and rejects unknown or duplicate registrations", async () => {
        const driver: LanguageCompiler = {
            languageId: "fixture",
            async prepare(sourceFile) {
                return {
                    label: "fixture",
                    check: ["checker", sourceFile],
                    execute: ["runtime", sourceFile],
                    readPaths: [],
                };
            },
        };
        const registry = new CompilerRegistry().register(driver);
        expect((await registry.get("fixture").prepare("main.fixture")).execute).toEqual(["runtime", "main.fixture"]);
        expect(() => registry.register(driver)).toThrow("already registered");
        expect(() => registry.get("missing")).toThrow("No compiler");
        const grammarRegistry = new LanguageRegistry().register(new TypeScriptLanguage());
        expect(grammarRegistry.get("typescript").fileExtension).toBe("ts");
        expect(() => grammarRegistry.get("missing")).toThrow("Unsupported");
    });

    test("character mode accepts arbitrary source characters without a supplied string vocabulary", () => {
        const source = 'console.log("A new string");';
        const request = experimentRequestSchema.parse({
            mode: "characters",
            goal: "Print something",
            literals: [],
            tokens: [...source, "<done>"],
        });
        const mode = new CharacterMode();
        const state = mode.state(languages.get("typescript"), request);
        expect(state.source).toBe(source);
        expect(state.complete).toBe(true);
        const start = mode.state(languages.get("typescript"), { ...request, tokens: [] });
        expect(start.candidates).toContain("A");
        expect(start.candidates).toContain('"');
        expect(start.candidates).not.toContain("<done>");
        expect(() => mode.state(languages.get("typescript"), { ...request, tokens: ["not-one-character"] })).toThrow(
            "one printable"
        );
    });

    test.skipIf(process.platform !== "darwin")(
        "character mode runs inside the sandbox and cannot read an unrelated temp file",
        async () => {
            const source = 'console.log("Characters work");';
            const success = await compileExperiment({
                input: { mode: "characters", goal: "Print", tokens: [...source, "<done>"] },
            });
            expect(success.build.exitCode).toBe(0);
            expect(success.run?.stdout).toBe("Characters work\n");
            const root = await mkdtemp(join(tmpdir(), "jev-private-fixture-"));
            try {
                const file = join(root, "private.txt");
                await Bun.write(file, "fixture-private-marker");
                const read = `console.log(await Bun.file(${SafeJSON.stringify(file)}).text()); export {};`;
                const denied = await compileExperiment({
                    input: { mode: "characters", goal: "Fixture", tokens: [...read, "<done>"] },
                });
                expect(denied.build.exitCode).toBe(0);
                expect(denied.run?.exitCode).not.toBe(0);
                expect(denied.run?.stdout).not.toContain("fixture-private-marker");
            } finally {
                await rm(root, { recursive: true, force: true });
            }
        },
        30000
    );
});

function circuitFixture(): CircuitGraph {
    const names = ["LC16", "LC16", "relay", "relay", "MDN", "MDN"];
    const neurons = names.map((type, index) => ({
        id: `cell-${index}`,
        type,
        side: index % 2 ? "R" : "L",
        nt: "acetylcholine",
        role: index < 2 ? "sensory" : "interneuron",
        x: index,
        y: index,
        z: index,
    }));
    return {
        version: "fixture",
        neurons,
        edges: [
            [0, 2, 100, 1],
            [1, 3, 100, 1],
            [2, 4, 100, 1],
            [3, 5, 100, 1],
        ],
        manifest: {
            dataset: "male-cns:v1.0",
            neuronCount: 6,
            edgeCount: 4,
            contactCount: 400,
            sensoryIds: ["cell-0", "cell-1"],
            outputIds: ["cell-4", "cell-5"],
            assumptions: ["Synthetic test fixture"],
            attribution: "Fixture",
            license: "CC BY 4.0",
            licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
            sources: [],
            modelParameters: { synapseMvPerContact: 0.275, sensoryCurrentMv: 36, decoderHz: 40, turnHz: 35 },
        },
    };
}

describe("Fly arena and lazy circuit cache", () => {
    test("cache status and non-connectome modes do not download or create a cache", async () => {
        const root = await mkdtemp(join(tmpdir(), "jev-circuit-"));
        const directory = join(root, "not-created");
        const download = mock(async () => {
            throw new Error("Unexpected download");
        });
        const cache = new CircuitCache({ directory, download });
        try {
            expect((await cache.status()).every((tier) => !tier.cached)).toBe(true);
            await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
            expect(needsCircuit("human")).toBe(false);
            expect(needsCircuit("jev")).toBe(false);
            expect(needsJev("human")).toBe(false);
            const load = mock(async () => {
                throw new Error("Unexpected model load");
            });
            const decide = mock(async () => {
                throw new Error("Unexpected paid request");
            });
            const human = await simulateArena({ input: { mode: "human", seconds: 0.1 }, load, decide });
            expect(human.state.elapsed).toBeCloseTo(0.1);
            expect(load).not.toHaveBeenCalled();
            expect(decide).not.toHaveBeenCalled();
            expect(download).not.toHaveBeenCalled();
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("concurrent first loads download once; subsequent loads verify and reuse the cached bytes", async () => {
        const root = await mkdtemp(join(tmpdir(), "jev-circuit-"));
        const bytes = new TextEncoder().encode(SafeJSON.stringify(circuitFixture()));
        const tier: CircuitTier = {
            id: "fixture",
            label: "Fixture",
            file: "fixture.json",
            neurons: 6,
            edges: 4,
            bytes: bytes.length,
            blob: circuitBlobHash(bytes),
        };
        const download = mock(async () => bytes);
        const cache = new CircuitCache({ directory: root, tiers: [tier], download });
        try {
            const [first, second] = await Promise.all([
                cache.load({ tierId: "fixture" }),
                cache.load({ tierId: "fixture" }),
            ]);
            expect(first.cacheHit).toBe(false);
            expect(second.graph.neurons).toHaveLength(6);
            expect(download).toHaveBeenCalledTimes(1);
            expect((await cache.load({ tierId: "fixture" })).cacheHit).toBe(true);
            expect(download).toHaveBeenCalledTimes(1);
            expect((await cache.status())[0].cached).toBe(true);
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("bad checksums never become a cached model and cancelled requests never download", async () => {
        const root = await mkdtemp(join(tmpdir(), "jev-circuit-"));
        const bytes = new TextEncoder().encode(SafeJSON.stringify(circuitFixture()));
        const tier: CircuitTier = {
            id: "fixture",
            label: "Fixture",
            file: "fixture.json",
            neurons: 6,
            edges: 4,
            bytes: bytes.length,
            blob: "wrong",
        };
        const download = mock(async () => bytes);
        const cache = new CircuitCache({ directory: root, tiers: [tier], download });
        try {
            await expect(cache.load({ tierId: "fixture" })).rejects.toThrow("checksum");
            expect((await cache.status())[0].cached).toBe(false);
            const abort = new AbortController();
            abort.abort();
            await expect(cache.load({ tierId: "fixture", signal: abort.signal })).rejects.toThrow();
            expect(download).toHaveBeenCalledTimes(1);
            await expect(cache.load({ tierId: "../secret" })).rejects.toThrow("Unknown");
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });

    test("Jev-only simulation makes decisions without loading any circuit", async () => {
        const load = mock(async () => {
            throw new Error("Unexpected circuit download");
        });
        const decide = mock<typeof decideArena>(async () => ({
            action: "forage",
            confidence: 0.9,
            threatProbability: 0,
            survivalScore: 4,
            probabilities: { forage: 0.9 },
            fallback: false,
            latencyMs: 1,
            usage: {},
        }));
        const result = await simulateArena({ input: { mode: "jev", seconds: 0.1 }, load, decide });
        expect(load).not.toHaveBeenCalled();
        expect(decide).toHaveBeenCalledTimes(1);
        expect(result.state.actionSource).toBe("Jev");
        expect(result.state.neural).toBeNull();
        decide.mockImplementation(async () => {
            throw new Error("Fixture gateway failure");
        });
        const failed = await simulateArena({ input: { mode: "jev", seconds: 0.1 }, load, decide });
        expect(failed.state.actionSource).toBe("fallback");
        expect(failed.failures).toHaveLength(1);
        expect(failed.attempts).toBe(1);
        expect(load).not.toHaveBeenCalled();
    });

    test("render-frame batching preserves fixed-step physics and neural outputs", () => {
        const options = { mode: "malecns" as const, seed: 42, wiring: "original" as const, graph: circuitFixture() };
        const fine = new FlyArena(options);
        const batched = new FlyArena(options);
        fine.start();
        batched.start();
        for (let index = 0; index < 250; index++) {
            fine.advance({ milliseconds: 20 });
        }

        for (let index = 0; index < 50; index++) {
            batched.advance({ milliseconds: 100 });
        }

        expect(batched.state).toEqual(fine.state);
    });

    test("seeded manual control moves the fly, collects sugar, and respects pause", () => {
        const options = { mode: "human" as const, seed: 42, wiring: "original" as const };
        const arena = new FlyArena(options);
        expect(arena.state.food).toEqual(new FlyArena(options).state.food);
        arena.state.food[0] = { x: 460, y: 260 };
        arena.start();
        arena.advance({ milliseconds: 100, input: { x: 1, y: 0 } });
        expect(arena.state.fly.x).toBeGreaterThan(450);
        expect(arena.state.sugar).toBe(1);
        arena.pause();
        const elapsed = arena.state.elapsed;
        arena.advance({ milliseconds: 100 });
        expect(arena.state.elapsed).toBe(elapsed);
        expect(() => new FlyArena({ ...options, mode: "malecns" })).toThrow("Load");
    });

    test("a swat damages a stationary fly and finished rounds stop advancing", () => {
        const arena = new FlyArena({ mode: "human", seed: 42, wiring: "original" });
        arena.start();
        for (let i = 0; i < 600; i++) {
            arena.advance({ milliseconds: 20 });
        }
        expect(arena.state.status).toBe("lost");
        expect(arena.state.health).toBe(0);
        const elapsed = arena.state.elapsed;
        arena.advance({ milliseconds: 100 });
        expect(arena.state.elapsed).toBe(elapsed);
    });

    test("sensory spikes reach motor cells through wiring; disconnected control keeps motor output silent", () => {
        const graph = circuitFixture();
        const normal = new MaleCnsCircuit(graph, { seed: 42, wiring: "original" });
        const disconnected = new MaleCnsCircuit(graph, { seed: 42, wiring: "disconnected" });
        expect(normal.snapshot().leftHz).toBe(0);
        for (let i = 0; i < 5; i++) {
            normal.advance({ milliseconds: 100, left: 1, right: 0 });
            disconnected.advance({ milliseconds: 100, left: 1, right: 0 });
        }
        expect(normal.snapshot().sensoryLeftHz).toBeGreaterThan(0);
        expect(normal.snapshot().leftHz).toBeGreaterThan(0);
        expect(normal.snapshot().rightHz).toBe(0);
        expect(disconnected.snapshot().leftHz).toBe(0);
        expect(disconnected.snapshot().retreat).toBe(0);
        expect(graph.edges).toEqual(circuitFixture().edges);
    });

    test("shuffled wiring and game replay are reproducible for a fixed seed", () => {
        const options = { mode: "malecns" as const, seed: 19, wiring: "shuffled" as const, graph: circuitFixture() };
        const first = new FlyArena(options);
        const second = new FlyArena(options);
        first.start();
        second.start();
        for (let i = 0; i < 200; i++) {
            first.advance({ milliseconds: 20 });
            second.advance({ milliseconds: 20 });
        }
        expect(first.state).toEqual(second.state);
    });

    test("Jev gets reduced state, validates choices, and uses an explicit low-confidence fallback", async () => {
        const evaluate = mock<typeof evaluateRequest>(async ({ input }) => {
            evaluationSchema.parse(input);
            return {
                model: JEV_MODEL,
                answers: {
                    action: { type: "choice", choice: "dash", probabilities: { dash: 0.9 } },
                    threat: { type: "boolean", probability: 0.95 },
                    survival: { type: "score", score: 2 },
                },
                usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
                warnings: [],
                rounding: undefined,
                providerMetadata: undefined,
            };
        });
        const observation = new FlyArena({ mode: "human", seed: 42, wiring: "original" }).observe();
        const result = await decideArena({ observation, evaluate });
        expect(result.action).toBe("dash");
        expect(result.fallback).toBe(false);
        expect(result.threatProbability).toBe(0.95);
        evaluate.mockImplementation(async () => ({
            model: JEV_MODEL,
            answers: {
                action: { type: "choice", choice: "left", probabilities: { left: 0.2 } },
                threat: { type: "boolean", probability: 0.1 },
                survival: { type: "score", score: 3 },
            },
            usage: { inputTokens: 10, outputTokens: 3, totalTokens: 13 },
            warnings: [],
            rounding: undefined,
            providerMetadata: undefined,
        }));
        expect(await decideArena({ observation, evaluate })).toMatchObject({ action: "forage", fallback: true });
        await expect(decideArena({ observation: { ...observation, health: -2 }, evaluate })).rejects.toThrow();
        expect(evaluate).toHaveBeenCalledTimes(2);
    });
});

describe("Unconstrained mode regressions", () => {
    test("whitespace choices validate without losing the original character", async () => {
        const evaluate = mock<typeof evaluateRequest>(async (options) => {
            evaluationSchema.parse(options.input);
            return {
                model: JEV_MODEL,
                answers: { next: { type: "choice", choice: "t0" }, done: { type: "boolean", probability: 0 } },
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                warnings: [],
                providerMetadata: undefined,
                rounding: undefined,
            };
        });
        const result = await stepExperiment({ input: { mode: "characters", goal: "Print 1" }, evaluate });
        expect(result.tokens).toEqual(["\n"]);
        expect(result.source).toBe("\n");
    });

    test.skipIf(process.platform !== "darwin")(
        "reports real checker/runtime failures and blocks network requests",
        async () => {
            const invalid = 'const n: number = "wrong";';
            const checked = await compileExperiment({
                input: { mode: "characters", goal: "Fixture", tokens: [...invalid, "<done>"] },
            });
            expect(checked.build.exitCode).not.toBe(0);
            expect(checked.run).toBeUndefined();
            let calls = 0;
            const endpoint = Bun.serve({
                port: 0,
                hostname: "127.0.0.1",
                fetch: () => {
                    calls++;
                    return new Response("fixture-network-marker");
                },
            });
            try {
                expect((await fetch(endpoint.url)).status).toBe(200);
                calls = 0;
                const source = `console.log(await (await fetch(${SafeJSON.stringify(endpoint.url.toString())})).text()); export {};`;
                const denied = await compileExperiment({
                    input: { mode: "characters", goal: "Fixture", tokens: [...source, "<done>"] },
                });
                expect(denied.build.exitCode).toBe(0);
                expect(denied.run?.exitCode).not.toBe(0);
                expect(denied.run?.stdout).not.toContain("fixture-network-marker");
                expect(calls).toBe(0);
            } finally {
                await endpoint.stop(true);
            }
        },
        30000
    );
});
