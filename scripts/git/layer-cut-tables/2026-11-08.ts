import type { CutBranch, CutTable } from "./types";

const APP = "src/macos/GenesisTools";
const KIT = "src/macos/GenesisKit";

/**
 * The 2026-11-08 cut of unified's work since master (the deep manual test rounds, the editor features, the meetings
 * window and the REPL), as one stack on origin/master:
 *
 *   master ─ recorder ─ repl-control ─ meetings ─ decisions-and-tools
 *
 * A diff table: every path that differs between master and unified goes to the branch of its most specific glob, and
 * the last branch's `**` takes the rest. The typecheck tracer moves a file down when an earlier tree needs it.
 */
const groups: readonly (readonly [string, string, readonly string[], boolean])[] = [
    // The recorder's TypeScript and its app part share one layer: the TypeScript tests read the Swift side's tools
    // commands and protocol fixtures, and the editor's Swift reads the TypeScript edit model's output.
    [
        "recorder",
        "feat(recorder, recording-editor, GenesisKit): the editor's fx, overlays, transitions and redaction tracking in the edit library, tools recorder, and the recorder part's renderer, editor window and timeline",
        [
            "src/recorder/**",
            "src/utils/recording-editor/**",
            "src/utils/screen-recorder/**",
            "src/utils/macos/ocr*",
            "src/utils/storage/file-lock.ts",
            "plugins/genesis-tools/skills/recorder/**",
            `${APP}/Sources/Parts/Recorder/**`,
            `${APP}/Tests/Recorder*`,
            `${APP}/Tests/CapturePickerTests.swift`,
            `${APP}/Tests/FakeServiceLink.swift`,
            `${KIT}/Sources/GenesisKit/Recording/**`,
            `${KIT}/Tests/GenesisKitTests/Recording*`,
            // The editor's find and comment fields are AgentTextFields.
            `${KIT}/Sources/GenesisKit/Controls/AgentTextField.swift`,
        ],
        true,
    ],
    [
        "repl-control",
        "feat(node-repl, control): the REPL's toolsets, presets and MCP server, tools control and the shared CLI, process and descriptor helpers they use",
        [
            "src/node-repl/**",
            "src/utils/repl/**",
            "src/control/**",
            "src/utils/api-descriptor/**",
            "src/utils/cli/**",
            "src/utils/process/**",
            "src/utils/bun/**",
            "src/utils/rpc/**",
            "src/utils/video/**",
            "native/ax-tool/**",
            "src/chrome-devtools/**",
            "src/genesis-tools-mcp/**",
            "plugins/genesis-tools/skills/node-repl/**",
            "plugins/genesis-tools/skills/macos-control/**",
        ],
        false,
    ],
    [
        "meetings",
        "feat(meetings, GenesisHub): the meetings CLI, its transcript and speaker fixes and the meetings window",
        [
            "src/meetings/**",
            "src/utils/meetings/**",
            "src/utils/transcribe/**",
            "src/wisprflow/**",
            "src/transcribe/**",
            `${APP}/Sources/Parts/Meetings/**`,
            `${APP}/Tests/Meetings*`,
            "src/hub/server/doors/meetings.ts",
        ],
        true,
    ],
    [
        "decisions-and-tools",
        "feat(question, GenesisHub, tools): decisions answered from the widget, the hub inbox, the phone and Telegram, the app build and its reap, the dashboard lifecycle and the day's tooling fixes",
        ["**"],
        true,
    ],
];

const branches: CutBranch[] = groups.map(([id, subject, globs, swift], index) => ({
    name: `feat/2026-11-08-${id}`,
    parent: index === 0 ? null : `feat/2026-11-08-${groups[index - 1][0]}`,
    subject,
    scopes: [],
    globs: [],
    sweep: globs,
    swift,
}));

export default {
    branches,
    keepAtBase: {},
    defaults: {
        unified: "feat/2026-10-13-enhancements-unified",
        unifiedBranch: "feat/2026-10-13-enhancements-unified",
        base: "origin/master",
    },
    selection: "diff",
    refPrefix: "refs/heads/cut/2026-11-08/",
} satisfies CutTable;
