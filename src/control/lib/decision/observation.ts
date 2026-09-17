import { z } from "zod";

const rowSchema = z
    .object({
        index: z.number().int().nonnegative(),
        depth: z.number().int().nonnegative(),
        role: z.string(),
        AXIdentifier: z.string().optional(),
        AXTitle: z.string().optional(),
        AXDescription: z.string().optional(),
        AXValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
        AXSubrole: z.string().optional(),
        AXEnabled: z.union([z.string(), z.number(), z.boolean()]).optional(),
        actions: z.array(z.string()).optional(),
        valueSettable: z.boolean().optional(),
        visible: z.boolean().optional(),
    })
    .passthrough();
export const observationSchema = z
    .object({
        ok: z.literal(true),
        app: z.string(),
        pid: z.number().int().positive(),
        snapshot: z.string().min(1),
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
export interface Candidate {
    id: string;
    element: number;
    action: "press" | "set";
    label: string;
    role: string;
    identifier?: string;
    ancestors: string[];
}

export function elementLabel(row: ObservedElement): string {
    return row.AXTitle || row.AXDescription || row.AXIdentifier || row.role;
}
function disabled(row: ObservedElement): boolean {
    return [false, 0, "0", "false"].includes(row.AXEnabled ?? "");
}
export function candidatesFor({
    observation,
    action = "press",
}: {
    observation: Observation;
    action?: Candidate["action"];
}): Candidate[] {
    const ancestors: ObservedElement[] = [];
    const candidates: Candidate[] = [];
    for (const row of observation.elements) {
        while (ancestors.length && ancestors[ancestors.length - 1].depth >= row.depth) {
            ancestors.pop();
        }
        const permitted = action === "press" ? row.actions?.includes("AXPress") : row.valueSettable === true;
        if (
            permitted &&
            row.visible !== false &&
            !disabled(row) &&
            !ancestors.some(disabled) &&
            row.AXSubrole !== "AXSecureTextField" &&
            (action !== "set" || ["AXTextField", "AXTextArea", "AXComboBox"].includes(row.role))
        ) {
            candidates.push({
                id: `c${candidates.length}`,
                element: row.index,
                action,
                label: elementLabel(row).slice(0, 300),
                role: row.role,
                identifier: row.AXIdentifier,
                ancestors: ancestors
                    .map(elementLabel)
                    .slice(-4)
                    .map((label) => label.slice(0, 200)),
            });
        }
        ancestors.push(row);
    }
    if (candidates.length > 80) {
        throw new Error("More than 80 actionable targets. Narrow the window or scope before using semantic control.");
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
            label: elementLabel(row).slice(0, 300),
            value:
                row.valueSettable || row.AXSubrole === "AXSecureTextField"
                    ? "[private input]"
                    : String(row.AXValue ?? "").slice(0, 500),
            enabled: !disabled(row),
        }));
}
export function sameScope(first: Observation, next: Observation): boolean {
    return first.pid === next.pid && first.window.id === next.window.id && first.scope === next.scope;
}
