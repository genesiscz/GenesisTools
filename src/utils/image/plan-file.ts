/**
 * The one loader of annotation plans, for every surface that takes `--annotate <plan>`: `tools control draw`,
 * `tools control capture --annotate`, and the annotated web shots.
 *
 * A plan is inline JSON (a value that starts with `{` or `[`), or a file: `.json`, `.jsonc` (comments and trailing
 * commas), or `.ts` / `.mts` whose default export is the plan. A `.ts` plan may import `defineAnnotations` from
 * `@genesis-tools/annotate`; the loader serves that module itself, so the plan's folder needs no `node_modules`. A bare
 * array is shorthand for `{ annotations: [...] }`.
 */
import { resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { ANNOTATION_PRESETS, type Annotation, type AnnotationPlanFile } from "./annotation-plan";
import { validateAnnotations } from "./render-plan";

/** The module a `.ts` plan imports `defineAnnotations` from. */
export const ANNOTATE_MODULE = "@genesis-tools/annotate";

/** Types a `.ts` plan's default export and returns it unchanged. */
export function defineAnnotations(plan: AnnotationPlanFile | Annotation[]): AnnotationPlanFile | Annotation[] {
    return plan;
}

/** Modules a `.ts` plan may import, by name: their exports, served by the loader. */
export type PlanModules = Record<string, Record<string, unknown>>;

const servedModules = new Set<string>();

function serveModules(modules: PlanModules): void {
    const fresh = Object.entries(modules).filter(([name]) => !servedModules.has(name));
    if (fresh.length === 0) {
        return;
    }

    for (const [name] of fresh) {
        servedModules.add(name);
    }

    Bun.plugin({
        name: `genesis-tools-plan-modules-${servedModules.size}`,
        setup(build) {
            for (const [name, exports] of fresh) {
                build.module(name, () => ({ exports, loader: "object" }));
            }
        },
    });
}

const SCRIPT_PLAN = /\.m?ts$/i;

async function readPlanFile(path: string, modules: PlanModules): Promise<unknown> {
    const file = Bun.file(path);
    if (!(await file.exists())) {
        throw new Error(`annotation plan not found: ${path} (pass inline JSON or a .json, .jsonc or .ts plan path)`);
    }

    if (SCRIPT_PLAN.test(path)) {
        serveModules({ [ANNOTATE_MODULE]: { defineAnnotations }, ...modules });
        const loaded: { default?: unknown } = await import(resolve(path));
        if (loaded.default === undefined) {
            throw new Error(`annotation plan ${path} has no default export (export default defineAnnotations({...}))`);
        }

        return loaded.default;
    }

    return SafeJSON.parse(await file.text());
}

/**
 * A plan value as data, before any validation: inline JSON, or a `.json`, `.jsonc` or `.ts` file. `modules` adds
 * modules a `.ts` file may import (the page-shot locator helpers).
 */
export async function readPlanValue(value: string, options: { modules?: PlanModules } = {}): Promise<unknown> {
    const trimmed = value.trim();
    return trimmed.startsWith("{") || trimmed.startsWith("[")
        ? SafeJSON.parse(trimmed)
        : await readPlanFile(trimmed, options.modules ?? {});
}

export async function loadAnnotationPlanValue(value: string): Promise<AnnotationPlanFile> {
    const parsed = await readPlanValue(value);

    if (!parsed || typeof parsed !== "object") {
        throw new Error("invalid annotation plan: expected an object or an array of annotations");
    }

    const plan: AnnotationPlanFile = Array.isArray(parsed)
        ? { annotations: parsed as Annotation[] }
        : (parsed as AnnotationPlanFile);
    validateAnnotations(plan.annotations);

    if (plan.preset !== undefined && !(plan.preset in ANNOTATION_PRESETS)) {
        throw new Error(
            `unknown preset "${plan.preset}" — valid presets: ${Object.keys(ANNOTATION_PRESETS).join(", ")}`
        );
    }

    return plan;
}
