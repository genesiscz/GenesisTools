import { DataTable, Md, MdInline, MdViewer } from "@artifact/kit";
import { Demo, type GalleryMeta, GalleryPage } from "./_frame";

export const meta: GalleryMeta = {
    family: "Markdown",
    title: "Markdown",
    summary:
        "Block markdown, inline markdown for cells and lists, and a document viewer with a table of contents and a filter.",
    components: ["Md", "MdInline", "MdViewer"],
};

const BLOCK = `### Release notes

The **checkout** service now caps its retry delay at \`30 s\`.

- Fewer stuck jobs
- A shorter queue at night

\`\`\`ts
const delay = Math.min(30_000, 200 * 2 ** attempt);
\`\`\`

| Metric | Before | After |
| --- | --- | --- |
| p95 | 260 ms | 212 ms |
`;

const DOCUMENT = `# Runbook

## Restart a worker

Drain the node first, then restart the service. Wait for the health check to pass.

## Replace a disk

1. Mark the node as down.
2. Swap the disk.
3. Rejoin the cluster and watch the sync finish.

## Rotate a key

Create the new key, deploy it beside the old one, then remove the old key a day later.

## Contacts

The on-call rotation lives in the team calendar.
`;

export default function MarkdownPage() {
    return (
        <GalleryPage
            title={meta.title}
            summary={meta.summary}
            keyboard="MdViewer's filter is a text input and its table of contents is a list of links: Tab reaches both, Enter follows a link. Md and MdInline render static text."
        >
            <Demo title="Md" note="headings, lists, code, a table">
                <Md>{BLOCK}</Md>
            </Demo>
            <Demo title="MdInline" note="inside table cells, no block wrapper">
                <DataTable
                    columns={[
                        { key: "change", label: "Change" },
                        { key: "owner", label: "Owner" },
                    ]}
                    rows={[
                        {
                            change: <MdInline>Cap the delay at **30 s**</MdInline>,
                            owner: <MdInline>`payments`</MdInline>,
                        },
                        {
                            change: <MdInline>Log the attempt number</MdInline>,
                            owner: <MdInline>_unassigned_</MdInline>,
                        },
                    ]}
                />
            </Demo>
            <Demo title="MdViewer" note="from a string; src fetches a sibling .md instead">
                <MdViewer title="Runbook" source={DOCUMENT} filterPlaceholder="Filter sections" />
            </Demo>
            <Demo title="Edge case: no chrome, empty input" note="chrome off hides the filter and the contents">
                <MdViewer source={"## Only one section\n\nNo table of contents is drawn."} chrome={false} />
                <Md>{""}</Md>
            </Demo>
        </GalleryPage>
    );
}
