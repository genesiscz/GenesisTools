import { z } from "zod";
import type { ActionParameters, ControlAction } from "./action";

const rowSchema = z
    .object({
        index: z.number().int().nonnegative(),
        depth: z.number().int().nonnegative(),
        role: z.string(),
        AXIdentifier: z.string().optional(),
        AXURL: z.string().optional(),
        targetKey: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
        AXTitle: z.string().optional(),
        AXDescription: z.string().optional(),
        AXValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
        AXSubrole: z.string().optional(),
        AXRoleDescription: z.string().optional(),
        AXEnabled: z.union([z.string(), z.number(), z.boolean()]).optional(),
        actions: z.array(z.string()).optional(),
        valueSettable: z.boolean().optional(),
        visible: z.boolean().optional(),
    })
    .passthrough();
export const observedElementSchema = rowSchema;
export const observationSchema = z
    .object({
        ok: z.literal(true),
        app: z.string(),
        pid: z.number().int().positive(),
        processLaunch: z.number().positive().optional(),
        snapshot: z.string().min(1),
        observationRecovery: z.object({ retries: z.number().int().min(1).max(2) }).optional(),
        window: z.object({ id: z.number().int().positive(), title: z.string() }).passthrough(),
        scope: z.enum(["window", "chrome"]).default("window"),
        elements: z.array(rowSchema).max(2000),
    })
    .refine(
        (value) => new Set(value.elements.map((row) => row.index)).size === value.elements.length,
        "Duplicate element indexes"
    );
export type Observation = z.infer<typeof observationSchema>;
export type ObservedElement = Observation["elements"][number];
export const evidenceScopeSchema = z
    .object({
        identifier: z.string().min(1).max(300).optional(),
        label: z.string().min(1).max(300).optional(),
        role: z.string().min(1).max(100).optional(),
    })
    .strict()
    .refine(
        (value) => value.identifier !== undefined || value.label !== undefined,
        "Evidence scope requires an exact identifier or label."
    );
export type EvidenceScope = z.infer<typeof evidenceScopeSchema>;

export function scopedObservation(observation: Observation, scope?: EvidenceScope): Observation {
    if (!scope) {
        return observation;
    }
    const parsed = evidenceScopeSchema.parse(scope);
    const matches = observation.elements.filter(
        (row) =>
            (parsed.identifier === undefined || row.AXIdentifier === parsed.identifier) &&
            (parsed.label === undefined || elementLabel(row) === parsed.label) &&
            (parsed.role === undefined || row.role === parsed.role)
    );
    if (matches.length !== 1) {
        throw new Error("Evidence scope is missing or ambiguous; select one observed container.");
    }
    const root = matches[0];
    const start = observation.elements.indexOf(root);
    let end = start + 1;
    while (end < observation.elements.length && observation.elements[end].depth > root.depth) {
        end++;
    }
    return { ...observation, elements: observation.elements.slice(start, end) };
}
export function primaryWebArea(elements: ObservedElement[]): ObservedElement | undefined {
    const documents = elements.filter(
        (element) => element.role === "AXWebArea" && typeof element.AXURL === "string" && element.AXURL.length > 0
    );
    const minimumDepth = Math.min(...documents.map((element) => element.depth));
    const shallowest = documents.filter((element) => element.depth === minimumDepth);
    return shallowest.length === 1 ? shallowest[0] : undefined;
}
export function hasAncestorRole(elements: ObservedElement[], target: ObservedElement, role: string): boolean {
    let depth = target.depth;
    const position = elements.findIndex((row) => row.index === target.index);
    for (let index = position - 1; index >= 0 && depth > 0; index--) {
        const candidate = elements[index];
        if (candidate.depth >= depth) {
            continue;
        }
        depth = candidate.depth;
        if (candidate.role === role) {
            return true;
        }
    }
    return false;
}
export interface Candidate {
    id: string;
    element: number;
    action: ControlAction;
    label: string;
    role: string;
    kind?: string;
    identifier?: string;
    ancestors: string[];
    checked?: boolean;
    nearbyText?: string[];
}

function siblingText(rows: ObservedElement[]): Map<number, string[]> {
    const ancestors: ObservedElement[] = [];
    const parents = new Map<number, number>();
    const texts = new Map<number, string[]>();
    for (const row of rows) {
        while (ancestors.length && ancestors[ancestors.length - 1].depth >= row.depth) {
            ancestors.pop();
        }
        const parent = ancestors.at(-1);
        if (parent) {
            parents.set(row.index, parent.index);
        }
        if (row.role === "AXStaticText" && typeof row.AXValue === "string" && row.AXValue) {
            for (const ancestor of ancestors) {
                if (!["AXGroup", "AXRow", "AXCell", "AXListItem"].includes(ancestor.role)) {
                    continue;
                }
                const values = texts.get(ancestor.index) ?? [];
                if (values.length <= 8) {
                    values.push(row.AXValue);
                }
                texts.set(ancestor.index, values);
            }
        }
        ancestors.push(row);
    }
    const result = new Map<number, string[]>();
    for (const [index, parent] of parents) {
        const values = texts.get(parent);
        if (values?.length && values.length <= 8 && values.join("").length <= 2048) {
            result.set(index, values);
        }
    }
    return result;
}

export function elementLabel(row: ObservedElement): string {
    const visibleText = row.role === "AXStaticText" ? String(row.AXValue ?? "") : "";
    return row.AXTitle || row.AXDescription || row.AXIdentifier || visibleText || row.role;
}
export function elementKind(row: ObservedElement): string {
    if (row.AXRoleDescription) {
        return row.AXRoleDescription;
    }
    const kinds: Record<string, string> = {
        AXStaticText: "visible text",
        AXButton: "button",
        AXCheckBox: "checkbox",
        AXRadioButton: "radio button",
        AXProgressIndicator: "progress indicator",
        AXTextField: "text input",
        AXTextArea: "text area",
        AXGroup: "group",
        AXWindow: "window",
        AXRow: "row",
        AXTabGroup: "tab group",
    };
    return kinds[row.role] ?? row.role;
}
function checkedState(row: ObservedElement): boolean | undefined {
    if (!["AXCheckBox", "AXRadioButton", "AXSwitch"].includes(row.role)) {
        return undefined;
    }
    return ["1", 1, true].includes(row.AXValue ?? "")
        ? true
        : ["0", 0, false].includes(row.AXValue ?? "")
          ? false
          : undefined;
}
function disabled(row: ObservedElement): boolean {
    return [false, 0, "0", "false"].includes(row.AXEnabled ?? "");
}
export function candidatesFor({
    observation,
    action = "press",
    parameters,
}: {
    observation: Observation;
    action?: Candidate["action"];
    parameters?: ActionParameters;
}): Candidate[] {
    const ancestors: ObservedElement[] = [];
    const candidates: Candidate[] = [];
    const context = siblingText(observation.elements);
    const modals = observation.elements.filter(
        (row) => row.visible !== false && (row.role === "AXSheet" || ["1", "true"].includes(String(row.AXModal)))
    );
    for (const row of observation.elements) {
        while (ancestors.length && ancestors[ancestors.length - 1].depth >= row.depth) {
            ancestors.pop();
        }
        const editable = ["AXTextField", "AXTextArea", "AXComboBox"].includes(row.role);
        const geometry =
            [row.x, row.y, row.width, row.height].every((value) => typeof value === "number") &&
            Number(row.width) > 0 &&
            Number(row.height) > 0;
        const permitted =
            action === "press"
                ? row.actions?.includes("AXPress")
                : action === "set"
                  ? (editable && row.valueSettable === true) ||
                    (row.role === "AXPopUpButton" && row.actions?.includes("AXPress"))
                  : action === "perform"
                    ? parameters?.axAction && row.actions?.includes(parameters.axAction)
                    : ["type", "paste", "select"].includes(action)
                      ? editable
                      : action === "key"
                        ? row.role === "AXWindow" || editable
                        : action === "focus"
                          ? row.role === "AXWindow" || editable || row.AXFocused !== undefined
                          : geometry;
        if (
            permitted &&
            row.visible !== false &&
            modals.every(
                (modal) => row.index === modal.index || ancestors.some((ancestor) => ancestor.index === modal.index)
            ) &&
            !disabled(row) &&
            !ancestors.some(disabled) &&
            row.AXSubrole !== "AXSecureTextField"
        ) {
            candidates.push({
                id: `c${candidates.length}`,
                element: row.index,
                action,
                label: elementLabel(row).slice(0, 300),
                role: row.role,
                kind: elementKind(row),
                identifier: row.AXIdentifier,
                checked: checkedState(row),
                ...(context.has(row.index) ? { nearbyText: context.get(row.index) } : {}),
                ancestors: ancestors
                    .map(elementLabel)
                    .slice(-4)
                    .map((label) => label.slice(0, 200)),
            });
        }
        ancestors.push(row);
    }
    return candidates;
}
export function observedEvidence(observation: Observation) {
    if (observation.elements.length > 300) {
        throw new Error(
            "More than 300 observation rows. Narrow the window/scope; evidence will not be silently truncated."
        );
    }
    return observation.elements
        .filter((row) => row.visible !== false)
        .map((row) => ({
            id: `e${row.index}`,
            role: row.role,
            kind: elementKind(row),
            label: elementLabel(row).slice(0, 300),
            value:
                ["AXTextField", "AXTextArea", "AXComboBox", "AXPopUpButton"].includes(row.role) ||
                row.AXSubrole === "AXSecureTextField"
                    ? "[private input]"
                    : String(row.AXValue ?? "").slice(0, 500),
            enabled: !disabled(row),
            ...(checkedState(row) === undefined ? {} : { checked: checkedState(row) }),
        }));
}
export function evidenceChoices(evidence: ReturnType<typeof observedEvidence>): Record<string, string> {
    return Object.fromEntries(
        evidence.map((item) => [item.id, `${item.kind}: ${item.label}${item.value ? ` — ${item.value}` : ""}`])
    );
}
export function sameScope(first: Observation, next: Observation): boolean {
    return (
        first.pid === next.pid &&
        first.processLaunch === next.processLaunch &&
        first.window.id === next.window.id &&
        first.scope === next.scope
    );
}
