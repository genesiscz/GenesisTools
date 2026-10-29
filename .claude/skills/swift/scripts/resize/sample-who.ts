// Inclusive main-thread sample counts per frame family of a `sample` file, each family counted at its topmost
// occurrence only, so "who owns the busy time" reads as one short list. SwiftUI hides view names behind
// `<deduplicated_symbol>`, so the families are the machinery: flushTransactions is body updates, updateOutputs is
// layout, `AccessibilityNode.updateFocusResponder` is the responder walk an accessibility client causes.
// Usage: bun sample-who.ts <sample file> [extra pattern...]
const file = process.argv[2];
const extra = process.argv.slice(3);
const patterns: [string, RegExp][] = [
    ["flushTransactions (SwiftUI body updates)", /GraphHost\.flushTransactions/],
    ["updateOutputs (layout + display list)", /ViewGraph\.updateOutputs/],
    ["DisplayList / render", /DisplayList|RenderBox|updateDisplayList/],
    ["LazyVStack placements", /LazySubviewPlacements|LazyStack<>/],
    ["List / NSTableView", /NSTableView|noteHeightOfRows|ListCore|UICollection|NSOutlineView/],
    ["TextLayout / CoreText", /TextLayout|CTTypesetter|CTFramesetter|NSAttributedString.*boundingRect|CoreText/],
    ["Accessibility", /AccessibilityNode|NSAccessibility|AXUIElement/],
    ["WebKit (UI process)", /WKWebView|WebKit::|WebPageProxy/],
    ["GenResize*", /GenResize/],
    ["PRThreads*", /PRThreads/],
    ["SessionList*", /SessionList|SessionRow/],
    ["Transcript*", /Transcript/],
    ["HubLiveResize / PaneHold", /HubLiveResize|PaneHold|ResizableSidePanel/],
    ["AttributeGraph update", /AG::Graph::UpdateStack::update/],
    ["ToolsCLIRunner (a process wait)", /ToolsCLIRunner|runCapturing/],
    ...extra.map((p): [string, RegExp] => [p, new RegExp(p)]),
];
const lines = (await Bun.file(file).text()).split("\n");
let i = lines.findIndex((l) => /^\s+\d+ Thread_\d+.*Main Thread|com\.apple\.main-thread/.test(l));
if (i < 0) {
    console.log("no main thread");
    process.exit(1);
}
const total = Number(lines[i].match(/(\d+) Thread_/)![1]);
const totals = new Map<string, number>();
const stack: { depth: number; hit: Set<string> }[] = [];
for (i++; i < lines.length; i++) {
    const line = lines[i];
    if (/^ {4}\d+ Thread_/.test(line) || line.trim() === "") {
        break;
    }
    const m = line.match(/^([ +!:|]*)(\d+) (.*)$/);
    if (!m) {
        continue;
    }
    const depth = m[1].length,
        count = Number(m[2]),
        sym = m[3];
    while (stack.length && stack[stack.length - 1].depth >= depth) {
        stack.pop();
    }
    const inherited = new Set<string>(stack.length ? stack[stack.length - 1].hit : []);
    for (const [name, re] of patterns) {
        if (inherited.has(name) || !re.test(sym)) {
            continue;
        }
        inherited.add(name);
        totals.set(name, (totals.get(name) ?? 0) + count);
    }
    stack.push({ depth, hit: inherited });
}
console.log(`main thread: ${total} samples`);
for (const [name] of patterns) {
    const n = totals.get(name);
    if (n) {
        console.log(`${String(n).padStart(5)}  ${name}`);
    }
}
