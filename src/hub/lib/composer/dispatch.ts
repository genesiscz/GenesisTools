import { resolve } from "node:path";
import { readPaneReceipt } from "@app/claude/lib/cmux/pane-send";
import { doorAnswerRefusal, type HeldAnswer, planDoorAnswer } from "@app/question/lib/decisions/answers";
import { type DeliverDeps, DeliveryUnknownError, deliverToSession } from "@app/question/lib/decisions/deliver";
import { decisionFiles } from "@app/question/lib/decisions/read";
import { sendAnsweredDecisions } from "@app/question/lib/decisions/send";
import { readDecisions } from "@app/question/lib/decisions/store";
import { answerInboxDecision } from "@app/question/lib/inbox/answer";
import { waitingBlock } from "@app/question/lib/inbox/load";
import { type AskDeps, answerAskForm, checkAskAnswer, getAskForm } from "@app/question/lib/pending/ask";
import { attachImageFiles, MAX_ANSWER_IMAGE_BYTES } from "@app/question/lib/pending/form";
import type { AskAnswer, AskForm } from "@app/question/lib/pending/types";
import { isAccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import { harnessDriver } from "@genesiscz/utils/ai/providers/harness-index";
import { logger } from "@genesiscz/utils/logger";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
import type { WorkerCapabilities } from "@genesiscz/utils/worker/capabilities";
import type { WidgetAsset, WidgetOutgoing } from "../widget/types";
import type { OutboxDispatcher } from "./engine";

/** The transport the widget delivers through: the `tools` runner of the widget's own checkout. */
export function widgetDeliverDeps(signal?: AbortSignal): DeliverDeps {
    return { runTool: (args, { timeoutMs }) => runWidgetDelivery({ args, signal, timeoutMs }) };
}

/** The `tools` verb path of the cmux transport (`tools claude cmux send`): a command path, not a harness branch. */
const CMUX_TRANSPORT = ["claude", "cmux"] as const;

/**
 * The worker capabilities of the harness whose worker a transport run drives (`tools claude worker steer`,
 * `tools codex steer`, `tools grok steer`): `args[0]` names the harness's tool, and `args[1]` opens one of the
 * worker verbs its driver's `worker` part lists. Undefined for any other run.
 */
function workerRun(args: readonly string[]): WorkerCapabilities | undefined {
    const tool = args[0] ?? "";
    if (!isAccountProviderAlias(tool)) {
        return undefined;
    }

    const worker = harnessDriver(tool).parts.worker;
    return worker.verbs.some((verb) => verb.split(" ")[0] === args[1]) ? worker : undefined;
}

/** One transport run, bounded by the deadline the delivery route gives it (a worker turn may take minutes). */
async function runWidgetDelivery({
    args,
    signal,
    timeoutMs,
}: {
    args: string[];
    signal?: AbortSignal;
    timeoutMs: number;
}) {
    const result = await boundedCommand({
        command: [process.execPath, resolve(import.meta.dir, "../../../../widget-tools"), ...args],
        timeoutMs,
        signal,
    });
    return widgetDeliveryReceipt({ args, result });
}

/**
 * Turns one transport run into a receipt, or throws DeliveryUnknownError when nobody can tell whether text
 * reached the agent. `claude cmux send --json` exits 1 with `{"sent":false}` when no pane matched: nothing was
 * typed, so that is a certain "not sent" (the message waits for a route) rather than an unknown outcome. A worker
 * run of any harness (`claude worker steer`, `codex steer`, `grok steer`) reports a refusal through a nonzero exit
 * with a readable answer, so its exit status is the receipt.
 */
export function widgetDeliveryReceipt({
    args,
    result,
}: {
    args: readonly string[];
    result: { error?: Error; status: number | null; stdout: string; stderr: string };
}): { success: boolean; stdout: string; stderr: string } {
    const unknown = new DeliveryUnknownError(
        "The transport was attempted but returned no successful receipt. Check the conversation before retrying."
    );
    if (result.error) {
        throw unknown;
    }

    if (!CMUX_TRANSPORT.every((word, index) => args[index] === word)) {
        if (result.status !== 0 && !workerRun(args)) {
            throw unknown;
        }

        return { success: result.status === 0, stdout: result.stdout, stderr: result.stderr };
    }

    const receipt = readPaneReceipt(result.stdout);

    if (receipt.kind === "unreadable") {
        logger.warn({ status: result.status }, "Widget transport receipt could not be decoded");
        throw new DeliveryUnknownError(
            "The transport returned no readable receipt. Check the conversation before retrying."
        );
    }

    const typed = receipt.kind === "typed";
    if (result.status !== 0 && typed) {
        throw unknown;
    }

    return { success: result.status === 0 && typed, stdout: result.stdout, stderr: result.stderr };
}

type DecisionPayload = Extract<WidgetOutgoing["payload"], { kind: "decision" }>;

/** The answer a widget message holds for its decision. */
function heldAnswer(payload: DecisionPayload): HeldAnswer {
    return { expectedRevision: payload.expectedRevision, option: payload.option, text: payload.text };
}

/** Widget images too large for a form answer. They still reach the form, as media context. */
function oversizedAnswerImages(assets: WidgetAsset[]): WidgetAsset[] {
    return assets.filter((asset) => asset.type === "image" && asset.bytes > MAX_ANSWER_IMAGE_BYTES);
}

/**
 * The widget's image attachments become images of the form's first item that accepts pasted images, before the
 * answer is checked and recorded. Otherwise an image-only answer to such an item fails as incomplete, because the
 * images reach the form only as media context, which never answers an item. A widget image may be far larger than
 * an answer image may be; such an image stays media context only, so it never fails an otherwise complete answer.
 */
function formAnswersWithImages(form: AskForm, answers: AskAnswer[], assets: WidgetAsset[]): AskAnswer[] {
    const item = form.items.find((entry) => entry.allowImagePaste);
    if (!item) {
        return answers;
    }

    const oversized = new Set(oversizedAnswerImages(assets));
    return attachImageFiles(
        answers,
        assets.flatMap((asset) => (asset.type === "image" && !oversized.has(asset) ? [`${item.id}=${asset.path}`] : []))
    );
}

type FormPayload = Extract<WidgetOutgoing["payload"], { kind: "form" }>;

/**
 * The answers exactly as the form records them: the widget's images attached, and the whole serialized message
 * (note plus media) as the first answer's media context. Validation and dispatch both build them here, so a
 * combined text over the limit is refused before anything is attempted.
 */
function formAnswersToRecord(form: AskForm, payload: FormPayload, assets: WidgetAsset[], text: string): AskAnswer[] {
    return formAnswersWithImages(form, payload.answers, assets).map((answer, index) => ({
        ...answer,
        ...(index === 0 && text ? { mediaContext: text } : {}),
    }));
}

export function widgetDispatcher({
    deliver: supplied,
    signal,
    files = decisionFiles(),
    ask = {},
}: {
    deliver?: DeliverDeps;
    signal?: AbortSignal;
    files?: { file: string; events: string };
    ask?: AskDeps;
} = {}): OutboxDispatcher {
    const deliver = supplied ?? widgetDeliverDeps(signal);
    return {
        async validate(message, assets, text = message.payload.text) {
            const payload = message.payload;
            if (payload.kind === "decision") {
                const row = readDecisions(files.file).find((entry) => entry.id === payload.id);
                const refusal = doorAnswerRefusal(row, {
                    session: message.target.sessionId,
                    number: payload.number,
                    provider: message.target.provider,
                    ...heldAnswer(payload),
                });
                if (refusal) {
                    throw refusal;
                }
            } else if (payload.kind === "form") {
                const form = getAskForm(payload.id, ask);
                if (form?.status !== "pending") {
                    throw new Error("This question was already resolved. Refresh the inbox before answering.");
                }
                if ((form.sessionHint || form.id) !== message.target.sessionId) {
                    throw new Error("This question belongs to another session.");
                }
                const checked = checkAskAnswer(payload.id, formAnswersToRecord(form, payload, assets, text), ask);
                if (!checked.ok) {
                    const oversized = oversizedAnswerImages(assets).map((asset) => asset.name);
                    const limit = `${(MAX_ANSWER_IMAGE_BYTES / 1_000_000).toFixed(1)} MB`;
                    throw new Error(
                        oversized.length
                            ? `${checked.error}. Over ${limit}, ${oversized.join(", ")} goes along as context but cannot answer a question: attach a smaller image or answer in text.`
                            : checked.error
                    );
                }
            } else if (message.target.provider === "unknown") {
                throw new Error("Choose a specific destination session before sending this follow-up.");
            }
        },
        async dispatch(message: WidgetOutgoing, text: string, assets: WidgetAsset[]) {
            const payload = message.payload;
            if (payload.kind === "form") {
                const existing = getAskForm(payload.id, ask);
                if (existing?.status !== "pending") {
                    return {
                        delivered: false,
                        certainty: "not-sent",
                        channel: "form",
                        detail: "Question was resolved elsewhere; your submitted answer was not recorded.",
                    };
                }
                const result = await answerAskForm(
                    payload.id,
                    formAnswersToRecord(existing, payload, assets, text),
                    ask
                );
                if (!result.ok) {
                    return { delivered: false, certainty: "not-sent", channel: "form", detail: result.error };
                }
                return {
                    delivered: true,
                    channel: "form",
                    entryId: result.entryId,
                    detail: "Answer recorded for the waiting agent",
                };
            }
            if (payload.kind === "decision") {
                const row = readDecisions(files.file).find((entry) => entry.id === payload.id);
                const plan = planDoorAnswer(row, heldAnswer(payload));
                if (plan.kind === "unresolved") {
                    throw new DeliveryUnknownError(
                        "An earlier delivery of this decision is unresolved. Inspect the conversation in Hub."
                    );
                }

                if (plan.kind === "delivered") {
                    return { delivered: true, channel: "decisions", detail: "Delivered from Decisions" };
                }

                if (plan.kind === "refused") {
                    return {
                        delivered: false,
                        certainty: "not-sent",
                        channel: "decisions",
                        detail: plan.refusal.message,
                    };
                }

                // An earlier attempt stored the answer and the transport refused it: send that same answer again.
                // Without a live route both paths save it for this exact session (sourceHome, deliveryKey).
                const sent =
                    plan.kind === "resend"
                        ? await sendAnsweredDecisions({
                              ids: [plan.row.id],
                              session: message.target.sessionId,
                              provider: message.target.provider,
                              sourceHome: message.target.sourceHome,
                              deliveryKey: message.id,
                              files,
                              deps: deliver,
                          })
                        : await answerInboxDecision(
                              {
                                  session: message.target.sessionId,
                                  provider: message.target.provider,
                                  cwd: message.target.cwd,
                                  sourceHome: message.target.sourceHome,
                                  deliveryKey: message.id,
                                  number: payload.number,
                                  expectedRevision: payload.expectedRevision,
                                  option: payload.option,
                                  text,
                              },
                              { ...files, block: waitingBlock, deliver }
                          );
                return {
                    delivered: sent.delivered === true,
                    channel: sent.queueId ? "session-queue" : (sent.channel ?? "queued"),
                    entryId: sent.queueId,
                    payloadHash: sent.queueTextHash,
                    certainty: sent.delivered ? undefined : "not-sent",
                    detail: sent.target ?? sent.error ?? "Queued in Decisions for this session",
                };
            }

            const sent = await deliverToSession(
                {
                    session: message.target.sessionId,
                    provider: message.target.provider,
                    sourceHome: message.target.sourceHome,
                    text,
                    deliveryKey: message.id,
                },
                deliver
            );
            return {
                delivered: sent.delivered,
                channel: sent.queueId ? "session-queue" : sent.channel,
                entryId: sent.queueId,
                payloadHash: sent.queueTextHash,
                certainty: sent.delivered ? undefined : "not-sent",
                detail: sent.target ?? sent.error,
            };
        },
    };
}
