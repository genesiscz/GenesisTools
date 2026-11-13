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

const RECORD_BEFORE = `{
  "kind": "article",
  "id": "72d986bc-7cc4-4ac2-8507-f64b3fc91987",
  "slug": "release-notes",
  "live": {
    "version": 7,
    "active": true,
    "publishedAt": "2026-01-03T09:15:00+01:00",
    "release": {
      "number": 12,
      "name": "January",
      "comment": "Updated notes",
      "publishedBy": "editor"
    },
    "data": { "text": "A sentence with spaces and punctuation, followed by another sentence for wrapping." }
  },
  "draft": {
    "version": 8,
    "active": true,
    "revision": 3,
    "release": {
      "id": "f19a5d9d-2815-48ed-b590-ff119001763c",
      "number": 13,
      "name": "February"
    },
    "updatedAt": "2026-01-10T14:02:00+01:00",
    "updatedBy": "editor",
    "data": { "text": "Draft release notes" }
  }
}`;

const RECORD_AFTER = `{
  "kind": "article",
  "id": "72d986bc-7cc4-4ac2-8507-f64b3fc91987",
  "slug": "release-notes",
  "data": { "text": "A sentence with spaces and punctuation, followed by another sentence for wrapping." },
  "meta": {
    "version": 7,
    "publishedAt": "2026-01-03T09:15:00+01:00",
    "preview": false
  }
}`;

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
            <Demo title="JSON values" note="object keys sort recursively; array order stays significant">
                <DiffView
                    beforeValue={{ enabled: true, limits: { burst: 20, daily: 400 } }}
                    afterValue={{ limits: { daily: 600, burst: 20 }, enabled: true }}
                    mode="split"
                    wrap
                />
            </Demo>
            <Demo title="A compact read record" note="30 lines become 11; each pane keeps its own context line numbers">
                <DiffView
                    before={RECORD_BEFORE}
                    after={RECORD_AFTER}
                    labels={["editor record", "published record"]}
                    mode="split"
                    wrap
                    context={30}
                />
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
