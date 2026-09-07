import { coalesceWorkerEvents, type WorkerEvent } from "@genesiscz/utils/worker/events";
import { clipResult, type TranscriptTool, type TranscriptTurn } from "./types";

/**
 * The shared worker-event stream of one turn as transcript turns. A backend
 * whose worker log already maps onto `WorkerEvent` (claude `-p` stream-json)
 * gets its transcript adapter for free through this function; grok has its own
 * because its log carries model-call boundaries and usage that the event
 * vocabulary does not.
 *
 * Grouping: a new assistant turn starts at the first text or reasoning after a
 * tool result, so "think, call tools, read results, answer" reads as two steps.
 */
export function workerEventsToTurns(
    events: readonly WorkerEvent[],
    sessionId: string,
    turnIndex = 1
): TranscriptTurn[] {
    const turns: TranscriptTurn[] = [];
    const toolsById = new Map<string, TranscriptTool>();
    const prefix = `${sessionId}-turn-${turnIndex}`;
    let open: TranscriptTurn | null = null;
    let afterResult = false;

    const flush = () => {
        if (open && (open.text || open.reasoning || open.tools.length > 0)) {
            turns.push(open);
        }

        open = null;
        afterResult = false;
    };

    const ensureOpen = (): TranscriptTurn => {
        if (open === null) {
            const step = turns.filter((turn) => turn.role === "assistant").length + 1;
            open = { id: `${prefix}-step-${step}`, role: "assistant", at: null, text: "", tools: [], step };
        }

        return open;
    };

    for (const event of coalesceWorkerEvents(events)) {
        switch (event.kind) {
            case "text":
            case "reasoning": {
                if (afterResult) {
                    flush();
                }

                const turn = ensureOpen();
                if (event.kind === "text") {
                    turn.text += event.text;
                } else {
                    turn.reasoning = (turn.reasoning ?? "") + event.text;
                }

                break;
            }
            case "tool_call": {
                const turn = ensureOpen();
                const tool: TranscriptTool = {
                    id: event.callId ?? `${prefix}-tool-${toolsById.size}`,
                    name: event.tool,
                    inputPreview: event.target ?? "",
                    result: null,
                    isError: false,
                };
                turn.tools.push(tool);
                toolsById.set(tool.id, tool);
                break;
            }
            case "tool_result": {
                afterResult = true;
                const tool = event.callId ? toolsById.get(event.callId) : undefined;
                if (!tool) {
                    break;
                }

                const output = event.output ?? "";
                tool.result = output ? clipResult(output) : "";
                tool.resultChars = output.length;
                tool.isError = event.ok === false;
                break;
            }
            case "turn.completed": {
                flush();
                turns.push({
                    id: `${prefix}-end`,
                    role: "system",
                    at: null,
                    text: "end (completed)",
                    tools: [],
                    event: { kind: "end", stopReason: "completed", costUsd: event.usage?.totalCostUsd },
                    usage: event.usage
                        ? {
                              inputTokens: event.usage.inputTokens,
                              cacheReadTokens: event.usage.cacheReadTokens,
                              outputTokens: event.usage.outputTokens,
                              reasoningTokens: event.usage.reasoningTokens,
                          }
                        : undefined,
                });
                break;
            }
            case "turn.failed":
            case "error": {
                flush();
                const message = event.kind === "error" ? event.message : (event.reason ?? "turn failed");
                turns.push({
                    id: `${prefix}-error`,
                    role: "system",
                    at: null,
                    text: message,
                    tools: [],
                    event: { kind: "error", message },
                });
                break;
            }
            case "turn.started": {
                flush();
                turns.push({
                    id: `${prefix}-start-${event.turn ?? turnIndex}`,
                    role: "system",
                    at: null,
                    text: `turn ${event.turn ?? turnIndex} started`,
                    tools: [],
                    event: { kind: "turn.started", turn: event.turn ?? turnIndex },
                });
                break;
            }
            default:
                break;
        }
    }

    flush();
    return turns;
}
