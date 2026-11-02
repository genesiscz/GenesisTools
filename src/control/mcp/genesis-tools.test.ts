/**
 * The control MCP twin (handoff h_00ddcbx1 t22). Every case here is refused or answered before any
 * native call: under the test runner the real ax-tool throws, so a handler that reached it fails.
 */
import { describe, expect, test } from "bun:test";
import { answerText } from "@app/genesis-tools-mcp/lib/tool-entry";
import { SafeJSON } from "@genesiscz/utils/json";
import { controlToolEntries } from "./genesis-tools";

const entries = controlToolEntries();

async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const entry = entries[name];
    if (!entry) {
        throw new Error(`no tool ${name}`);
    }

    return SafeJSON.parse(answerText(await entry.handler(args)), { strict: true }) as Record<string, unknown>;
}

describe("controlToolEntries", () => {
    test("exposes the plan runner, the validated workflow runner and two read-only queries", () => {
        expect(Object.keys(entries).sort()).toEqual([
            "control_find",
            "control_get",
            "control_run",
            "control_workflow_run",
        ]);
        expect(entries.control_workflow_run?.description).toContain("PREFERRED");

        for (const entry of Object.values(entries)) {
            expect(entry.inputSchema.type).toBe("object");
        }
    });

    test("control_run takes the plan object inline and dry-runs it without touching the UI", async () => {
        const result = await call("control_run", {
            plan: {
                app: "Fixture",
                steps: [
                    { do: "press", q: "Save" },
                    { do: "wait", q: "Done" },
                ],
            },
            dry_run: true,
        });

        expect(result.kind).toBe("dry-run");
        expect((result.steps as unknown[]).length).toBe(2);
    });

    test("a cancelled control_run request skips UI dispatch", async () => {
        const controller = new AbortController();
        controller.abort();
        const response = await entries.control_run.handler(
            { plan: { app: "Fixture", restore: true, steps: [{ do: "type", text: "test" }] } },
            { signal: controller.signal }
        );
        const result = SafeJSON.parse(answerText(response), { strict: true });
        expect(result.kind).toBe("ran");
        expect(result.report.ok).toBe(false);
        expect(result.report.skippedSteps).toBe(1);
    });

    test("control_run reports every plan problem before the first step", async () => {
        const result = await call("control_run", { plan: { steps: [{ do: "frobnicate" }, { do: "press" }] } });

        expect(result.kind).toBe("invalid");
        expect((result.problems as string[]).join("\n")).toContain("frobnicate");
    });

    test("control_workflow_run refuses a semantic postcondition before observing: the twin makes no model call", async () => {
        const plan = {
            version: 1,
            app: "Fixture",
            steps: [
                {
                    id: "save",
                    action: "press",
                    selector: { identifier: "save" },
                    intent: "Save the document",
                    postcondition: { expect: "The document is saved" },
                },
            ],
        };

        await expect(entries.control_workflow_run?.handler({ plan })).rejects.toThrow("Jev");
    });

    test("unknown arguments are refused by the schema", async () => {
        await expect(entries.control_find?.handler({ app: "Fixture", frobnicate: true })).rejects.toThrow();
    });
});
