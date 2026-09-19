import { z } from "zod";
import { type Observation, observationSchema } from "./observation";

export const replayCaseSchema = z
    .object({
        id: z.string().min(1).max(80),
        title: z.string().min(1).max(200),
        intent: z.string().min(1).max(4000),
        expect: z.string().min(1).max(4000),
        observation: observationSchema,
        expectedElement: z.number().int().nonnegative().nullable(),
        expectedOutcome: z.enum(["verified", "refuted", "unknown"]),
        mockWitness: z.number().int().nonnegative().nullable(),
    })
    .strict();
export type ReplayCase = z.infer<typeof replayCaseSchema>;

const observed = (elements: Observation["elements"]): Observation => ({
    ok: true,
    app: "SyntheticFixture",
    pid: 1,
    snapshot: "fixture-never-executable",
    window: { id: 1, title: "Preferences and export" },
    scope: "window",
    elements,
});
const button = (index: number, title: string, extra: Partial<Observation["elements"][number]> = {}) => ({
    index,
    depth: 1,
    role: "AXButton",
    AXTitle: title,
    AXEnabled: "1",
    visible: true,
    actions: ["AXPress"],
    ...extra,
});
export const replayCases: ReplayCase[] = [
    {
        id: "context",
        title: "Duplicate Settings buttons",
        intent: "Open settings for the account, not the project.",
        expect: "Account preferences are open",
        expectedElement: 1,
        expectedOutcome: "unknown",
        mockWitness: null,
        observation: observed([
            { index: 0, depth: 0, role: "AXGroup", AXTitle: "Account" },
            button(1, "Settings"),
            { index: 2, depth: 0, role: "AXGroup", AXTitle: "Project" },
            button(3, "Settings"),
        ]),
    },
    {
        id: "disabled",
        title: "Disabled export",
        intent: "Export the document.",
        expect: "The export finished.",
        expectedElement: null,
        expectedOutcome: "unknown",
        mockWitness: null,
        observation: observed([button(0, "Export", { AXEnabled: "0" }), button(1, "Cancel")]),
    },
    {
        id: "missing",
        title: "Missing target",
        intent: "Open account settings.",
        expect: "Account settings are open.",
        expectedElement: null,
        expectedOutcome: "unknown",
        mockWitness: null,
        observation: observed([
            button(0, "Export"),
            { index: 1, depth: 0, role: "AXStaticText", AXValue: "Ready to export" },
        ]),
    },
    {
        id: "completed",
        title: "Observed completion",
        intent: "Close the completed export panel.",
        expect: "The document export finished successfully.",
        expectedElement: 1,
        expectedOutcome: "verified",
        mockWitness: 0,
        observation: observed([
            { index: 0, depth: 0, role: "AXStaticText", AXValue: "Document exported successfully to report.pdf" },
            button(1, "Close"),
        ]),
    },
    {
        id: "contradiction",
        title: "Success toast with a failed write",
        intent: "Retry the export.",
        expect: "The document export finished successfully.",
        expectedElement: 2,
        expectedOutcome: "refuted",
        mockWitness: 1,
        observation: observed([
            { index: 0, depth: 0, role: "AXStaticText", AXValue: "Export started successfully" },
            {
                index: 1,
                depth: 0,
                role: "AXStaticText",
                AXValue: "Export failed: unable to write destination. No file saved.",
            },
            button(2, "Retry"),
        ]),
    },
];
