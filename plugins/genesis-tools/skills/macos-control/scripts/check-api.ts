#!/usr/bin/env bun
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = Bun.argv.slice(2);
if (args.includes("--help")) {
    console.log(
        "Usage: bun check-api.ts --repo PATH\nChecks API schemas, native capture policy, Markdown links and TS example syntax. No UI actions or model calls."
    );
    process.exit(0);
}
if (args.length !== 2 || args[0] !== "--repo") {
    throw new Error("Supply --repo PATH for the checkout whose implementation the skill describes.");
}
const repo = resolve(args[1]);
const skill = resolve(import.meta.dir, "..");
const source = (relative: string) => pathToFileURL(resolve(repo, relative)).href;
interface Validator {
    safeParse(value: unknown): { success: boolean };
}
const { computerSchemas }: { computerSchemas: Record<string, Validator> } = await import(
    source("src/control/lib/computer-use/schemas.ts")
);
const { validateNativeCapturePlan } = await import(source("src/control/lib/capture-native.ts"));
const { validatePlan } = await import(source("src/control/lib/capture-plan.ts"));
const { SafeJSON } = await import(source("src/utils/json.ts"));
const checks: Array<{ method: string; input: unknown; valid: boolean }> = [
    { method: "paste", input: { app: "Fixture", text: "draft", replace: true, prepare: true }, valid: true },
    { method: "paste", input: { app: "Fixture", text: "draft", replace: true }, valid: false },
    { method: "paste", input: { app: "Fixture", text: "insert" }, valid: true },
    {
        method: "get_app_state",
        input: { app: "Fixture", window_id: 1, scope: "chrome", image: false, element_limit: 1000 },
        valid: true,
    },
    { method: "get_app_state", input: { app: "Fixture", text_limit: 100 }, valid: false },
    {
        method: "resolve_target",
        input: {
            app: "Fixture",
            action: "set",
            intent: "Find the address field",
            query: "Address",
            role: "AXTextField",
            chooser: "jev",
            provider: "typesafe",
        },
        valid: true,
    },
    {
        method: "await_condition",
        input: {
            app: "Fixture",
            condition: "Saved",
            exact: { identifier: "status", value: "Saved" },
            max_requests: 0,
            timeout_ms: 5000,
        },
        valid: true,
    },
    {
        method: "await_condition",
        input: { app: "Fixture", condition: "Ready", jev: true, evidence_scope: { identifier: "export-panel" } },
        valid: true,
    },
    {
        method: "await_condition",
        input: { app: "Fixture", condition: "Ready", jev: true, evidence_scope: { role: "AXGroup" } },
        valid: false,
    },
    {
        method: "fill_form",
        input: {
            app: "Fixture",
            window_id: 1,
            data: { Name: "Example Person", Priority: "High" },
            jev: true,
            provider: "typesafe",
            timeout_ms: 15000,
            max_fields: 2,
            max_requests: 2,
        },
        valid: true,
    },
];
for (const check of checks) {
    assert.equal(
        computerSchemas[check.method].safeParse(check.input).success,
        check.valid,
        `${check.method}: wrong schema contract`
    );
}
const files = [
    resolve(skill, "SKILL.md"),
    ...readdirSync(resolve(skill, "references"))
        .filter((name) => name.endsWith(".md"))
        .map((name) => resolve(skill, "references", name)),
];
const transpiler = new Bun.Transpiler({ loader: "ts" });
let examples = 0;
let links = 0;
for (const file of files) {
    const markdown = readFileSync(file, "utf8");
    for (const match of markdown.matchAll(/```(?:ts|typescript|js|javascript)\n([\s\S]*?)```/g)) {
        transpiler.transformSync(match[1]);
        examples++;
    }
    for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const target = match[1].split("#")[0];
        if (!target || /^(?:https?:|mailto:)/.test(target)) {
            continue;
        }
        assert.ok(existsSync(resolve(dirname(file), target)), `${file}: broken link ${target}`);
        links++;
    }
}
const capture = readFileSync(resolve(skill, "references/capture.md"), "utf8").match(/```json\n([\s\S]*?)```/);
assert.ok(capture, "Missing native capture example");
const plan = SafeJSON.parse(capture[1], { strict: true });
assert.deepEqual(validatePlan(plan), [], "Capture example must validate");
validateNativeCapturePlan(plan);
assert.throws(
    () => validateNativeCapturePlan({ ...plan, actions: [{ do: "url", url: "https://example.com" }] }),
    /unavailable in native capture/
);
console.log(
    `${checks.length} schema contracts, ${examples} TS examples, ${links} local links and native capture policy checked. No UI actions or model calls.`
);
