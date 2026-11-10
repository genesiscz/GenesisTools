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

let annotateModuleServed = false;

function serveAnnotateModule(): void {
    if (annotateModuleServed) {
        return;
    }

    annotateModuleServed = true;
    Bun.plugin({
        name: "genesis-tools-annotate",
        setup(build) {
            build.module(ANNOTATE_MODULE, () => ({ exports: { defineAnnotations }, loader: "object" }));
        },
    });
}

const SCRIPT_PLAN = /\.m?ts$/i;

async function readPlanFile(path: string): Promise<unknown> {
    const file = Bun.file(path);
    if (!(await file.exists())) {
        throw new Error(`annotation plan not found: ${path} (pass inline JSON or a .json, .jsonc or .ts plan path)`);
    }

    if (SCRIPT_PLAN.test(path)) {
        serveAnnotateModule();
        const loaded: { default?: unknown } = await import(resolve(path));
        if (loaded.default === undefined) {
            throw new Error(`annotation plan ${path} has no default export (export default defineAnnotations({...}))`);
        }

        return loaded.default;
    }

    return SafeJSON.parse(await file.text());
}

export async function loadAnnotationPlanValue(value: string): Promise<AnnotationPlanFile> {
    const trimmed = value.trim();
    const parsed: unknown =
        trimmed.startsWith("{") || trimmed.startsWith("[") ? SafeJSON.parse(trimmed) : await readPlanFile(trimmed);

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
