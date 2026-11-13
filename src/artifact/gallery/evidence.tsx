import {
    Badge,
    Callout,
    Card,
    Chips,
    Claim,
    ClaimList,
    CodeBlock,
    FileMark,
    Note,
    Quote,
    Superseded,
} from "@artifact/kit";
import { Demo, type GalleryMeta, GalleryPage } from "./_frame";

export const meta: GalleryMeta = {
    family: "Evidence",
    title: "Claims, code and callouts",
    summary:
        "The pieces of a findings report: code with marked lines, file references, claims with confidence, quotes, callouts, badges, chips, notes and retracted text.",
    components: [
        "CodeBlock",
        "FileMark",
        "Claim",
        "ClaimList",
        "Quote",
        "Callout",
        "Badge",
        "Chips",
        "Note",
        "Superseded",
    ],
};

const SNIPPET = `export function retryDelay(attempt: number): number {
    const base = 200;
    // The bug: no upper bound, so attempt 12 waits 13 minutes.
    return base * 2 ** attempt;
}`;

export default function EvidencePage() {
    return (
        <GalleryPage
            title={meta.title}
            summary={meta.summary}
            keyboard="CodeBlock's copy button is a normal button: Tab reaches it, Enter copies. Everything else is static text."
        >
            <Demo title="CodeBlock" note="label, highlighting, a good line and a bad line">
                <CodeBlock label="src/retry.ts" lang="ts" highlightLines={[2]} badLines={[4]}>
                    {SNIPPET}
                </CodeBlock>
            </Demo>
            <Demo
                title="JSON strings"
                note="maxString shortens values; hover shows the full value, copy keeps the original"
            >
                <Card kicker="Generated output" title="Published record">
                    <CodeBlock lang="json" wrap maxString={42} label="Auto surface inside Card">
                        {`{\n  "title": "Release notes",\n  "body": "A long sentence retained in full for copying, while the visible value stays short enough to scan."\n}`}
                    </CodeBlock>
                </Card>
                <CodeBlock lang="json" wrap maxString={42} surface="framed" label="Framed surface">
                    {`{\n  "body": "The framed option keeps the original border and canvas fill even when placed inside a Card."\n}`}
                </CodeBlock>
            </Demo>
            <Demo title="FileMark" note="file and line chips">
                <div className="flex flex-wrap gap-2">
                    <FileMark path="src/retry.ts" lines="1-5" />
                    <FileMark path="src/queue/worker.ts" lines="88" badge="cause" tone="err" />
                    <FileMark path="docs/runbook.md" />
                </div>
            </Demo>
            <Demo title="Claim" note="confidence badge and proof line">
                <Claim
                    confidence={90}
                    tone="ok"
                    proof="The delay is **unbounded**: `200 * 2 ** attempt`."
                    marks={[{ path: "src/retry.ts", lines: "4" }]}
                >
                    The long waits come from the retry delay, not from the network.
                </Claim>
                <Claim confidence={40} tone="warn">
                    The second spike on Friday has the same cause.
                </Claim>
            </Demo>
            <Demo title="ClaimList" note="facts with inline markdown proof and source chips">
                <ClaimList
                    facts={[
                        {
                            text: "The queue drained after the cap was applied.",
                            confidence: 95,
                            proof: "Depth fell from **400** to **0**.",
                            marks: [{ path: "logs/queue.log", lines: "22-30" }],
                        },
                        {
                            text: "Another worker still uses the old helper.",
                            confidence: 75,
                            tone: "warn",
                            marks: [{ path: "src/worker.ts", lines: "18" }],
                        },
                    ]}
                />
            </Demo>
            <Demo title="Quote">
                <Quote cite="On-call engineer, incident channel">
                    The queue drained the moment we capped the delay at thirty seconds.
                </Quote>
            </Demo>
            <Demo title="Callout" note="every tone">
                <div className="flex flex-col gap-3">
                    <Callout tone="ok" title="Verdict">
                        Fixed in the next release.
                    </Callout>
                    <Callout tone="warn" title="Watch">
                        Two other services copy the same helper.
                    </Callout>
                    <Callout tone="err" title="Do not">
                        Do not raise the timeout instead; it hides the bug.
                    </Callout>
                    <Callout tone="info">A callout without a title.</Callout>
                </div>
            </Demo>
            <Demo title="Badge and Chips">
                <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="ok">merged</Badge>
                    <Badge tone="warn">needs review</Badge>
                    <Badge tone="err">blocked</Badge>
                    <Badge tone="info" pill>
                        draft
                    </Badge>
                    <Badge>neutral</Badge>
                </div>
                <Chips
                    className="mt-3"
                    items={[
                        { k: "service", v: "checkout" },
                        { k: "severity", v: "high", tone: "err" },
                        { k: "owner", v: "payments team" },
                    ]}
                />
            </Demo>
            <Demo title="Note and Superseded">
                <Note>A muted aside: the numbers are from the staging cluster.</Note>
                <Superseded reason="the Friday spike had a different cause">
                    <p>Both spikes come from the retry delay.</p>
                </Superseded>
            </Demo>
            <Demo title="Edge case: a 300-character line" note="wrap on and off">
                <CodeBlock label="wrap off (scrolls)" copy={false}>
                    {`log: ${"request id=abc123 status=200 duration=12ms ".repeat(7)}`}
                </CodeBlock>
                <div className="mt-3">
                    <CodeBlock label="wrap on" wrap copy={false}>
                        {`log: ${"request id=abc123 status=200 duration=12ms ".repeat(7)}`}
                    </CodeBlock>
                </div>
            </Demo>
        </GalleryPage>
    );
}
