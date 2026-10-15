import { DiffView, diffFields, FieldDiff } from "@artifact/kit";
import { Demo, type GalleryMeta, GalleryPage } from "./_frame";

export const meta: GalleryMeta = {
    family: "Diff",
    title: "Diffs",
    summary:
        "Line diffs from before and after text or a unified patch, unified or side by side, and field-level diffs of two records.",
    components: ["DiffView", "FieldDiff"],
};

const BEFORE = `export function retryDelay(attempt: number): number {
    const base = 200;
    return base * 2 ** attempt;
}
`;

const AFTER = `export function retryDelay(attempt: number): number {
    const base = 200;
    const cap = 30_000;
    return Math.min(cap, base * 2 ** attempt);
}
`;

const PATCH = `diff --git a/config/limits.yaml b/config/limits.yaml
--- a/config/limits.yaml
+++ b/config/limits.yaml
@@ -1,4 +1,4 @@
 queue:
-  max_jobs: 500
+  max_jobs: 2000
   timeout: 30s
   retries: 3
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -3,2 +3,3 @@
 Run the worker with make run.
+Set QUEUE_URL first.
 Logs go to stdout.
`;

const CHANGES = diffFields(
    { title: "Checkout retry fix", owner: "payments", estimate: 3, due: "2026-11-02", updatedAt: "10:00" },
    { title: "Checkout retry cap", owner: "payments", estimate: 5, labels: "reliability", updatedAt: "11:00" },
    { ignore: ["updatedAt"], labels: { estimate: "Estimate (d)" } }
);

export default function DiffPage() {
    return (
        <GalleryPage
            title={meta.title}
            summary={meta.summary}
            keyboard="Not interactive. Long lines scroll horizontally inside the diff frame; pass wrap to soft-wrap them."
        >
            <Demo title="Before and after, unified" note="labels name the two sides">
                <DiffView before={BEFORE} after={AFTER} labels={["retry.ts (old)", "retry.ts (new)"]} />
            </Demo>
            <Demo title="Before and after, split" note="side by side">
                <DiffView before={BEFORE} after={AFTER} mode="split" title="retry.ts" />
            </Demo>
            <Demo title="A unified patch with two files" note="git diff output">
                <DiffView patch={PATCH} />
            </Demo>
            <Demo title="FieldDiff" note="diffFields builds the changes from two flat records">
                <FieldDiff changes={CHANGES} />
            </Demo>
            <Demo title="Edge case: no change" note="identical text">
                <DiffView before={BEFORE} after={BEFORE} title="Nothing changed" />
                <FieldDiff changes={[]} />
            </Demo>
        </GalleryPage>
    );
}
