import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { AgentVoiceReceiptDto } from "@app/dev-dashboard/contract/agents";
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
import { type ApprovalSources, answerPendingApproval } from "@app/hub/lib/approvals/index";
import { type BoardStopDeps, stopAgentSession } from "@app/hub/lib/board/stop";
import { CapabilityRefusedError, type HubCapabilityName, runCapability } from "@app/hub/lib/capabilities/index";
import { type GateRaiseDeps, raiseGate } from "@app/hub/lib/gates/index";
import { type StartAgentDeps, startAgent } from "@app/hub/lib/launch/index";
import { addPing, removePing } from "@app/hub/lib/ping/index";
import { type BoardSendDeps, interruptBoardSession, SEND_TIMINGS, sendToBoardSession } from "@app/hub/lib/send/index";
import { fillTimesheetWeek, type TimesheetDeps } from "@app/hub/lib/timesheet/index";
import { fixPr, type MergeRunner, mergePr } from "@app/hub/lib/triage/index";
import { appendToVault, clipToVault } from "@app/hub/lib/vault/index";
import { transcribeVoiceClip, VoiceClipError, type VoiceDeps } from "@app/hub/lib/voice/index";
import { muteWatch, WATCH_SOURCE_IDS, WATCH_SOURCES } from "@app/hub/lib/watching/index";
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
    glance: ENDPOINTS.gatewayGlance,
    pings: ENDPOINTS.gatewayPings,
    approvals: ENDPOINTS.gatewayApprovals,
    launch: ENDPOINTS.gatewayLaunch,
    watching: ENDPOINTS.gatewayWatching,
    brief: ENDPOINTS.gatewayBrief,
    wake: ENDPOINTS.gatewayWake,
    timesheet: ENDPOINTS.gatewayTimesheet,
    transcript: ENDPOINTS.gatewayTranscript,
    procs: ENDPOINTS.gatewayProcs,
    stuck: ENDPOINTS.gatewayStuck,
    forecast: ENDPOINTS.gatewayForecast,
    prompts: ENDPOINTS.gatewayPrompts,
    promptPrepare: ENDPOINTS.gatewayPromptPrepare,
    prs: ENDPOINTS.gatewayPrs,
    prChecks: ENDPOINTS.gatewayPrChecks,
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

/** When this server process started, for the health route. */
const SERVER_STARTED_AT = new Date().toISOString();

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
    /** The voice route's clip folder and transcriber; tests pass fakes, so no model is called. */
    voice?: VoiceDeps;
    /** The merge route's runner; tests pass a fake, so no PR is merged. */
    merge?: MergeRunner;
    /** The raise route's ledger and window openers; tests pass fakes, so no window opens. */
    gates?: GateRaiseDeps;
    /** The approval answer route's sources; tests pass fakes, so no key is pressed and no worker is answered. */
    approvals?: ApprovalSources;
    /** The new-agent route's runner; tests pass a fake, so no workspace opens. */
    launch?: StartAgentDeps;
    /** The mute route's sources; tests pass fakes, so no Monitor database is written. */
    watchSources?: typeof WATCH_SOURCES;
    /** The timesheet fill's preview and writer; tests pass fakes, so nothing reaches Clarity. */
    timesheet?: TimesheetDeps;
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
            input: z.object({ text: z.string().max(4000).optional() }),
            invalid: "expected an empty JSON body, or { text } for a reply token",
            run: async (input, ctx: RouteContext) => {
                const token = ctx.headers[ACT_TOKEN_HEADER];
                const key = ctx.headers[IDEMPOTENCY_HEADER];

                if (!token) {
                    return { kind: "json", status: 401, body: { error: `${ACT_TOKEN_HEADER} required` } };
                }

                if (!key) {
                    return { kind: "json", status: 400, body: { error: `${IDEMPOTENCY_HEADER} required` } };
                }

                return act({
                    token,
                    key: `http:${key}`,
                    deps: await (deps.act ?? realActDeps)(),
                    ...(input.text ? { text: input.text } : {}),
                });
            },
        }),
        // The phone's "is the Mac awake" probe after a wake (F26); any answer proves the server runs.
        bindEndpoint(ENDPOINTS.health, {
            input: z.object({}),
            invalid: "expected no query",
            run: async () => ({ ok: true as const, host: hostname(), pid: process.pid, startedAt: SERVER_STARTED_AT }),
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
        // A keyed write: the clip is named by its content, so a replay keeps one file and answers the first text.
        bindEndpoint(ENDPOINTS.agentsVoice, {
            input: z.object({}),
            invalid: "expected a raw body",
            body: "raw",
            run: async (_input, ctx): Promise<AgentVoiceReceiptDto | RouteResult> => {
                try {
                    return await transcribeVoiceClip(
                        { bytes: await ctx.readRawBody(), contentType: ctx.headers["content-type"] ?? "" },
                        deps.voice
                    );
                } catch (err) {
                    if (err instanceof VoiceClipError) {
                        return { kind: "json", status: err.status, body: { error: err.message } };
                    }

                    throw err;
                }
            },
        }),
        // Keyed writes: a replayed fix types one pointer line, a replayed merge merges once.
        bindEndpoint(ENDPOINTS.prsFix, {
            input: z.object({
                url: z.string().min(1),
                checkout: z.string().min(1),
                kind: z.enum(["threads", "check"]),
                checkUrl: z.string().min(1).optional(),
                checkName: z.string().min(1).optional(),
            }),
            invalid: "expected { url, checkout, kind, checkUrl?, checkName? }",
            run: (input) => fixPr(input),
        }),
        bindEndpoint(ENDPOINTS.prsMerge, {
            input: z.object({ url: z.string().min(1), method: z.enum(["rebase", "squash"]) }),
            invalid: "expected { url, method }",
            run: (input) => mergePr(input, deps.merge),
        }),
        bindEndpoint(ENDPOINTS.agentsInterrupt, {
            input: z.object({ key: z.string().min(1) }),
            invalid: "expected { key }",
            run: (input) => interruptBoardSession(input, deps.send),
        }),
        // A keyed write: a replayed allow must not press the keys of the next dialog.
        // Keyed writes: a replayed watch keeps one watch, a replayed unwatch removes nothing more.
        bindEndpoint(ENDPOINTS.pingWatch, {
            input: z.object({ key: z.string().min(1), label: z.string().max(200).optional() }),
            invalid: "expected { key, label? }",
            run: (input) => addPing(input),
        }),
        bindEndpoint(ENDPOINTS.pingUnwatch, {
            input: z.object({ key: z.string().min(1) }),
            invalid: "expected { key }",
            run: (input) => removePing(input.key),
        }),
        bindEndpoint(ENDPOINTS.approvalsAnswer, {
            input: z.object({
                id: z.string().min(1),
                verdict: z.enum(["allow", "allow-always", "deny"]),
                reason: z.string().max(2000).optional(),
            }),
            invalid: "expected { id, verdict, reason? }",
            run: (input) => answerPendingApproval(input, deps.approvals),
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
        // Writes real hours: a keyed write behind the full login that names the revision the phone showed (F27).
        bindEndpoint(ENDPOINTS.timesheetFill, {
            input: z.object({
                date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
                timesheetId: z.number().int().positive(),
                revision: z.string().min(1),
            }),
            invalid: "expected { date, timesheetId, revision }",
            run: (input) => fillTimesheetWeek(input, deps.timesheet),
        }),
        // Vault writes (F25): keyed, so a replayed clip or append writes once.
        bindEndpoint(ENDPOINTS.vaultClip, {
            input: z.object({ url: z.string().min(1).max(4096), note: z.string().max(4000).optional() }),
            invalid: "expected { url, note? }",
            run: (input) => clipToVault(input),
        }),
        bindEndpoint(ENDPOINTS.vaultAppend, {
            input: z.object({
                text: z
                    .string()
                    .min(1)
                    .max(256 * 1024),
                folder: z.string().max(400).optional(),
                name: z.string().max(200).optional(),
            }),
            invalid: "expected { text, folder?, name? }",
            run: (input) => appendToVault(input),
        }),
        bindEndpoint(ENDPOINTS.watchingMute, {
            input: z.object({
                source: z.enum(WATCH_SOURCE_IDS),
                id: z.string().min(1),
                minutes: z
                    .number()
                    .int()
                    .min(0)
                    .max(7 * 24 * 60),
            }),
            invalid: "expected { source, id, minutes }",
            run: (input) => muteWatch(input, deps.watchSources ?? WATCH_SOURCES),
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
