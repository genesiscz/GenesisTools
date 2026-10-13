import type { Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { OperationLimits } from "@genesiscz/utils/operation-budget";
import { z } from "zod";
import { resolveIntent } from "./decisions";
import type { ControlDriver } from "./native";
import { type Candidate, candidatesFor, type Observation } from "./observation";
import { ControlSession } from "./session";

export const fillDataSchema = z
    .record(z.string().trim().min(1).max(200), z.string().max(10000))
    .refine(
        (data) => Object.keys(data).length > 0 && Object.keys(data).length <= 20,
        "Supply 1–20 named string values."
    );
function identity(candidate: Candidate): string {
    return candidate.identifier
        ? `id:${candidate.identifier}`
        : SafeJSON.stringify([candidate.role, candidate.label, candidate.ancestors]);
}
function observedField(observation: Observation, binding: string) {
    const matches = candidatesFor({ observation, action: "set" }).filter(
        (candidate) => identity(candidate) === binding
    );
    return matches.length === 1 ? observation.elements.find((row) => row.index === matches[0].element) : undefined;
}
function validationError(field: Observation["elements"][number] | undefined): boolean {
    return field !== undefined && ![undefined, false, 0, "", "0", "false"].some((value) => value === field.AXInvalid);
}
function readback(observation: Observation, binding: string, value: string): boolean {
    const field = observedField(observation, binding);
    if (field === undefined) {
        return false;
    }

    // An empty rich-text editor (Lexical) reads back as one newline; native set counts that as empty too.
    const read = String(field.AXValue ?? "");
    return read === value || (value === "" && read === "\n");
}

export async function fillForm(options: {
    data: unknown;
    driver: ControlDriver;
    evaluate: Evaluator;
    signal?: AbortSignal;
    limits?: OperationLimits;
    /**
     * The app stays in the background. A native dropdown is then refused: selecting from it opens
     * its menu, which no plain AXValue write can avoid.
     */
    background?: boolean;
}) {
    const data = fillDataSchema.parse(options.data);
    const session = new ControlSession(options);
    const filled: Array<{ key: string; binding: string; element: number }> = [];
    const decisions: Array<{ key: string; resolution: Awaited<ReturnType<typeof resolveIntent>> }> = [];
    let status: "filled" | "stopped" | "unknown" = "stopped";
    let reason = "";
    let observation: Observation | undefined;
    try {
        observation = await session.observe();
        for (const [key, value] of Object.entries(data)) {
            const used = new Set(filled.map((item) => item.binding));
            const available = candidatesFor({ observation, action: "set" }).filter(
                (candidate) => !used.has(identity(candidate))
            );
            const filtered: Observation = {
                ...observation,
                elements: observation.elements.map((row) =>
                    available.some((item) => item.element === row.index)
                        ? row
                        : { ...row, valueSettable: false, actions: [] }
                ),
            };
            const resolution = await resolveIntent({
                observation: filtered,
                action: "set",
                intent: `Find the editable form field for this supplied data key: ${key}. Match field meaning; do not submit the form.`,
                evaluate: session.evaluate,
                signal: session.budget.signal,
            });
            decisions.push({ key, resolution });
            if (!resolution.selected) {
                reason = `No unambiguous writable field for ${key}.`;
                break;
            }
            const binding = identity(resolution.selected);
            if (available.filter((item) => identity(item) === binding).length !== 1) {
                reason = `Field identity for ${key} is ambiguous.`;
                break;
            }
            const candidate = candidatesFor({ observation, action: "set" }).find(
                (item) => item.element === resolution.selected?.element
            );
            if (!candidate) {
                throw new Error("Selected field disappeared.");
            }
            if (options.background && candidate.role === "AXPopUpButton") {
                reason = `The field for ${key} is a native dropdown, which opens its menu to select; fill it with activate:true. No further fields were written.`;
                break;
            }
            const dispatched = await session.dispatch({ observation, candidate, value });
            observation = dispatched.after;
            if (!dispatched.result.ok || !observation) {
                status = "unknown";
                reason = dispatched.result.error ?? dispatched.observationError ?? "Could not verify the field write.";
                break;
            }
            if (!readback(observation, binding, value)) {
                reason = `Exact readback failed for ${key}; no further fields were written.`;
                break;
            }
            if (validationError(observedField(observation, binding))) {
                reason = `The field for ${key} reports a validation error; no further fields were written.`;
                break;
            }
            filled.push({ key, binding, element: candidate.element });
            if (filled.length === Object.keys(data).length) {
                const allMatch = filled.every(
                    (item) =>
                        observation &&
                        readback(observation, item.binding, data[item.key]) &&
                        !validationError(observedField(observation, item.binding))
                );
                status = allMatch ? "filled" : "stopped";
                reason = allMatch
                    ? "All supplied values read back exactly. Form was not submitted."
                    : "A previously filled field changed or reports a validation error.";
            }
        }
    } catch (error) {
        logger.debug({ error }, "Structured fill stopped");
        reason = session.budget.signal.aborted
            ? "Cancelled or deadline reached."
            : error instanceof Error
              ? error.message
              : "Fill stopped.";
    }
    return { status, reason, filled, decisions, metrics: session.report() };
}
