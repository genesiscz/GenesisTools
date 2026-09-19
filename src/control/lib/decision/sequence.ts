import { evaluationProviderSchema } from "@genesiscz/utils/ai/evaluation/types";
import { logger } from "@genesiscz/utils/logger";
import { Stopwatch } from "@genesiscz/utils/Stopwatch";
import { z } from "zod";
import { NativeControlSession } from "./native-session";

export const nativeSequenceSchema = z
    .object({
        app: z.string().trim().min(1).max(300),
        intent: z.string().trim().min(1).max(4000),
        role: z
            .string()
            .regex(/^AX[A-Za-z]+$/)
            .max(100),
        rootRole: z
            .string()
            .regex(/^AX[A-Za-z]+$/)
            .max(100),
        rootIndex: z.number().int().nonnegative().optional(),
        windowIds: z.array(z.number().int().positive()).min(1).max(10).optional(),
        scope: z.enum(["window", "chrome"]).default("chrome"),
        verifyAttribute: z.enum(["AXSelected", "AXExpanded", "AXValue"]).optional(),
        intervalMs: z.number().int().min(0).max(5000).default(0),
        focus: z.boolean().default(false),
        restoreSelected: z.boolean().default(false),
        cursor: z.boolean().default(true),
        timeoutMs: z.number().int().min(1).max(120000).default(120000),
        provider: evaluationProviderSchema.default("vercel"),
        jev: z.literal(true),
    })
    .strict();
export async function runNativeSequence(options: {
    input: unknown;
    signal?: AbortSignal;
    createSession?: (input: z.output<typeof nativeSequenceSchema>) => NativeControlSession;
}) {
    const input = nativeSequenceSchema.parse(options.input);
    options.signal?.throwIfAborted();
    const clock = new Stopwatch();
    const session =
        options.createSession?.(input) ??
        new NativeControlSession({ app: input.app, provider: input.provider, cursor: input.cursor });
    const stop = () => session.close();
    const timer = setTimeout(stop, input.timeoutMs);
    options.signal?.addEventListener("abort", stop, { once: true });
    const windowIds = input.windowIds ?? [undefined];
    const windows = [];
    let failure: string | undefined;
    let plannedActions = 0;
    try {
        for (const windowId of windowIds) {
            options.signal?.throwIfAborted();
            const observation = await session.observe({
                role: input.role,
                rootRole: input.rootRole,
                rootIndex: input.rootIndex,
                scope: input.scope,
                windowId,
                focus: input.focus,
            });
            const chosen = await session.chooseAll(input.intent);
            const original = observation.targets.find((target) => target.selected);
            const restore = input.restoreSelected && original;
            if (plannedActions + chosen.targets.length + (restore ? 1 : 0) > 200) {
                throw new Error("The shared 200-action session budget would be exceeded; no more actions dispatched.");
            }
            plannedActions += chosen.targets.length + (restore ? 1 : 0);
            const result = await session.batch({
                steps: chosen.targets.map((target) => ({
                    target,
                    verifyAttribute: input.verifyAttribute,
                    verifyValue: input.verifyAttribute ? true : undefined,
                })),
                intervalMs: input.intervalMs,
            });
            const restored =
                result.ok && restore
                    ? await session.act({ target: original.id, verifyAttribute: "AXSelected", verifyValue: true })
                    : null;
            windows.push({
                windowId: observation.windowId,
                targets: chosen.targets.length,
                decision: chosen.decision,
                result,
                restored,
            });
            if (!result.ok || restored?.ok === false) {
                break;
            }
        }
    } catch (error) {
        logger.debug({ error }, "Native sequence stopped without retry");
        failure = options.signal?.aborted
            ? "Sequence cancelled; in-flight delivery may be uncertain."
            : error instanceof Error
              ? error.message
              : "Sequence stopped.";
    } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", stop);
        session.close();
    }
    const ok =
        !failure &&
        windows.length === windowIds.length &&
        windows.every((window) => window.result.ok && window.restored?.ok !== false);
    return { ok, elapsedMs: clock.elapsedMs, backend: "native-AXPress" as const, windows, error: failure };
}
