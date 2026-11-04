import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
    ENDPOINTS,
    type Endpoint,
    TIMEOUT_TIER_MS,
    type UploadReceipt,
} from "@app/dev-dashboard/contract/endpoint-table";
import { ACT_TOKEN_HEADER } from "@app/dev-dashboard/server/auth-guard";
import { bindEndpoint, IDEMPOTENCY_HEADER } from "@app/dev-dashboard/server/bind";
import { errorResult } from "@app/dev-dashboard/server/routes/error";
import type { RouteContext, RouteDef, RouteResult } from "@app/dev-dashboard/server/types";
import { type BoardStopDeps, stopAgentSession } from "@app/hub/lib/board/stop";
import { CapabilityRefusedError, type HubCapabilityName, runCapability } from "@app/hub/lib/capabilities/index";
import { type GateRaiseDeps, raiseGate } from "@app/hub/lib/gates/index";
import { type StartAgentDeps, startAgent } from "@app/hub/lib/launch/index";
import { type BoardSendDeps, interruptBoardSession, SEND_TIMINGS, sendToBoardSession } from "@app/hub/lib/send/index";
import { type ActDeps, act, realActDeps } from "@app/question/lib/act/act";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { z } from "zod";

/**
 * The gateway row of each hub capability. Typed by the capability names, so a capability without a row (or a row for
 * a capability that does not exist) is a compile error; adding one is one entry here and one in `ENDPOINTS`.
 */
export const GATEWAY_ROWS = {
    agents: ENDPOINTS.gatewayAgents,
    board: ENDPOINTS.gatewayBoard,
    gates: ENDPOINTS.gatewayGates,
    launch: ENDPOINTS.gatewayLaunch,
    transcript: ENDPOINTS.gatewayTranscript,
    procs: ENDPOINTS.gatewayProcs,
    stuck: ENDPOINTS.gatewayStuck,
    forecast: ENDPOINTS.gatewayForecast,
    prompts: ENDPOINTS.gatewayPrompts,
    promptPrepare: ENDPOINTS.gatewayPromptPrepare,
    widgetSnapshot: ENDPOINTS.gatewayWidgetSnapshot,
} as const satisfies Record<HubCapabilityName, Endpoint>;

/** What the upload route stores. Anything else is refused: the phone sends photos, screenshots and documents. */
const UPLOAD_TYPES: Readonly<Record<string, string>> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "image/heic": "heic",
    "application/pdf": "pdf",
    "text/plain": "txt",
};

function capabilityError(err: unknown): RouteResult {
    if (err instanceof CapabilityRefusedError) {
        return errorResult(err, err.code === "not-found" ? 404 : 400);
    }

    return errorResult(err);
}

export interface GatewayDeps {
    /** The act door's dependencies. Tests pass a memory token store and a fake answer. */
    act?: () => Promise<ActDeps>;
    /** Where uploads go; `~/.genesis-tools/dev-dashboard/uploads/<day>/` when omitted. */
    uploadDir?: () => string;
    /** Runs a capability; tests pass a fake so no hub reader runs. */
    run?: typeof runCapability;
    /** The stop route's fleet and signals; tests pass a fake process tree, so no real process is signalled. */
    stop?: BoardStopDeps;
    /** The send and interrupt routes' fleet and transports; tests pass fakes, so no session is reached. */
    send?: BoardSendDeps;
    /** The raise route's ledger and window openers; tests pass fakes, so no window opens. */
    gates?: GateRaiseDeps;
    /** The new-agent route's runner; tests pass a fake, so no workspace opens. */
    launch?: StartAgentDeps;
}

/**
 * The Mac mobile gateway: every hub capability the phone needs, each one row of the endpoint table bound to its
 * capability module (the same module the hub door mounts), the act route (`POST /api/act`, answered on a stored act
 * token) and one upload route with a size cap (`requestBodyLimit`).
 */
export function gatewayRoutes(deps: GatewayDeps = {}): RouteDef[] {
    const run = deps.run ?? runCapability;
    const capabilityRoutes = (Object.keys(GATEWAY_ROWS) as HubCapabilityName[]).map((name) => {
        const row = GATEWAY_ROWS[name];
        return bindEndpoint(row, {
            input: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional()),
            invalid: "expected query parameters",
            error: capabilityError,
            run: (input) => run(name, input, { signal: AbortSignal.timeout(TIMEOUT_TIER_MS[row.timeout] ?? 60_000) }),
        });
    });

    return [
        ...capabilityRoutes,
        bindEndpoint(ENDPOINTS.act, {
            input: z.object({}),
            invalid: "expected an empty JSON body",
            run: async (_input, ctx: RouteContext) => {
                const token = ctx.headers[ACT_TOKEN_HEADER];
                const key = ctx.headers[IDEMPOTENCY_HEADER];

                if (!token) {
                    return { kind: "json", status: 401, body: { error: `${ACT_TOKEN_HEADER} required` } };
                }

                if (!key) {
                    return { kind: "json", status: 400, body: { error: `${IDEMPOTENCY_HEADER} required` } };
                }

                return act({ token, key: `http:${key}`, deps: await (deps.act ?? realActDeps)() });
            },
        }),
        // Behind the full login and an idempotency key (a keyed-write row), so a replayed stop answers once.
        bindEndpoint(ENDPOINTS.agentsStop, {
            input: z.object({ key: z.string().min(1), pid: z.number().int().positive() }),
            invalid: "expected { key, pid }",
            run: (input) => stopAgentSession(input, deps.stop),
        }),
        // The idempotency key is the durable queue's key too, so a replayed send is the same delivery.
        bindEndpoint(ENDPOINTS.agentsSend, {
            input: z.object({
                key: z.string().min(1),
                text: z
                    .string()
                    .min(1)
                    .max(64 * 1024),
                timing: z.enum(SEND_TIMINGS),
            }),
            invalid: "expected { key, text, timing }",
            run: (input, ctx: RouteContext) =>
                sendToBoardSession({ ...input, idempotencyKey: ctx.headers[IDEMPOTENCY_HEADER] }, deps.send),
        }),
        bindEndpoint(ENDPOINTS.agentsInterrupt, {
            input: z.object({ key: z.string().min(1) }),
            invalid: "expected { key }",
            run: (input) => interruptBoardSession(input, deps.send),
        }),
        // A keyed write: a raise opens a window on the Mac, so a replay must not open a second one.
        bindEndpoint(ENDPOINTS.gatesRaise, {
            input: z.object({ id: z.string().min(1) }),
            invalid: "expected { id }",
            run: (input) => raiseGate(input.id, deps.gates),
        }),
        // A keyed write: a replayed start (a dropped answer) must not open a second workspace.
        bindEndpoint(ENDPOINTS.agentsNew, {
            input: z.object({
                agent: z.string().min(1),
                repo: z.string().min(1),
                account: z.string().min(1),
                prompt: z
                    .string()
                    .max(64 * 1024)
                    .optional(),
                name: z.string().max(80).optional(),
                model: z.string().max(80).optional(),
            }),
            invalid: "expected { agent, repo, account, prompt?, name?, model? }",
            run: (input) => startAgent(input, deps.launch),
        }),
        bindEndpoint(ENDPOINTS.gatewayUpload, {
            input: z.object({}),
            invalid: "expected a raw body",
            body: "raw",
            run: async (_input, ctx): Promise<UploadReceipt | RouteResult> => {
                const contentType = (ctx.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
                const extension = UPLOAD_TYPES[contentType];

                if (!extension) {
                    return {
                        kind: "json",
                        status: 415,
                        body: { error: `expected one of ${Object.keys(UPLOAD_TYPES).join(", ")}` },
                    };
                }

                const bytes = await ctx.readRawBody();

                if (bytes.byteLength === 0) {
                    return { kind: "json", status: 400, body: { error: "empty upload" } };
                }

                // Named by content, so a replayed upload writes the same file again: the write is idempotent.
                const sha256 = createHash("sha256").update(bytes).digest("hex");
                const dir =
                    deps.uploadDir?.() ??
                    toolDataDir("dev-dashboard", "uploads", new Date().toISOString().slice(0, 10));
                mkdirSync(dir, { recursive: true });
                const path = join(dir, `${sha256.slice(0, 16)}.${extension}`);
                writeFileSync(path, bytes, { mode: 0o600 });
                return { path, bytes: bytes.byteLength, sha256, contentType };
            },
        }),
    ];
}
