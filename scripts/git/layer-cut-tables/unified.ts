import type { CutBranch, CutTable, DerivedFile } from "./types";

const RECORDER_SCOPES = ["recorder", "recording-editor", "screen-recorder", "editor", "camera"] as const;
const CAPTURE_SCOPES = [...RECORDER_SCOPES, "ax-tool", "control", "meetings", "node-repl", "repl"] as const;
const MEETINGS_SCOPES = ["meetings", "transcribe", "dictionary", "wisprflow", "json2md", "transcripts"] as const;
const APP = "src/macos/GenesisTools";
const KIT = "src/macos/GenesisKit";

/**
 * The recorder part (branch 4) and the meetings part (branch 6) are registered in the same four files, and the two
 * branches share no ancestor that could hold both. Each branch gets unified's file without the other part's lines.
 */
function partRegistration(drop: "recorder" | "meetings"): DerivedFile[] {
    const keep = drop === "recorder" ? "meetings" : "recorder";
    // Package.swift: the part's entry with the comment lines right above it; an entry may wrap over lines.
    const packageEntry = new RegExp(`(\\n {4}//[^\\n]*)*\\n {4}AppPart\\(id: "${drop}",[\\s\\S]*?\\),(?=\\n)`);
    return [
        { file: `${APP}/Package.swift`, edits: [[packageEntry, ""]] },
        // Parts.swift keeps unified's text: a part's \`#if GENESIS_PART_<ID>\` blocks compile away when Package.swift
        // does not link it.
        { file: `${APP}/Sources/GenesisTools/Parts.swift`, edits: [] },
        // Unified's AppParts.swift reads the AppFaces table, a refactor of the leftovers branch: start from the base
        // and add this branch's face.
        {
            file: `${APP}/Sources/Host/AppParts.swift`,
            from: "base",
            edits: [[/\n( {8})"--markdown": "markdown",/, `\n$1"--markdown": "markdown",\n$1"--${keep}": "${keep}",`]],
        },
        {
            file: "src/macos/lib/permissions/parts.ts",
            edits: [[new RegExp(`\\n {4}\\{\\n {8}id: "${drop}",[\\s\\S]*?\\n {4}\\},`), ""]],
        },
    ];
}

/**
 * The layering (lead, 2026-11-05; retuned for #716's restacked base): 50 to 90 files where the import graph allows.
 *
 *   base ─ capture-core ─ screen-recorder ─┬─ recorder-service-and-editor ─ recorder-editor-swift ─ unified-leftovers
 *                                           └─ meetings-v3-and-window
 *
 * capture-core holds what nothing in the base breaks against (ax-tool, rpc, api-descriptor, process, video, json2md).
 * screen-recorder holds the capture session with everything its unified form forces in, measured on base dae7cfb3f2
 * and unified 79d01f2ea4: unified's control.ts drops the "stopped" state that the restacked base's start.ts and
 * node-repl toolsets.test.ts use (review fix e10e5b1d44, not on unified yet), and unified's start.ts changes the
 * startRecording options that the base's meetings recorder calls. Both chains land in this layer (137 files) until
 * unified carries #716's review round; then the toolsets.test.ts chain (about 40 files) stays in the next layer.
 */
const CUT: readonly CutBranch[] = [
    {
        name: "feat/2026-11-05-capture-core",
        parent: null,
        subject:
            "feat(ax-tool, control, screen-recorder): the RPC socket, the api-descriptor table, the ax-tool capture and the shared pid claim under the screen recorder",
        scopes: [...CAPTURE_SCOPES, "json2md", "transcribe"],
        globs: [
            "native/ax-tool/**",
            "src/daemon/**",
            "src/utils/process/**",
            "src/utils/video/**",
            "src/utils/rpc/**",
            "src/utils/api-descriptor/**",
            "src/utils/macos/ocr*",
            "src/utils/transcribe/render.ts",
            "src/utils/json2md/**",
            "src/json2md/**",
            "src/chrome-devtools/lib/recorder*",
            "plugins/genesis-tools/skills/macos-control/**",
        ],
    },
    {
        name: "feat/2026-11-05-screen-recorder",
        parent: "feat/2026-11-05-capture-core",
        subject:
            "feat(screen-recorder, control, meetings): the shared capture session and its run loop, the start path, tools control's recordings and the meetings recorder on them",
        scopes: [...CAPTURE_SCOPES, ...MEETINGS_SCOPES, "GenesisKit", "GenesisHub"],
        globs: [
            "src/utils/screen-recorder/**",
            "src/control/**",
            "src/utils/meetings/**",
            "src/meetings/lib/recorder*",
            "src/meetings/lib/meeting-run.ts",
            "src/meetings/lib/recording-manifest*",
            "src/meetings/commands/record.ts",
            // Both app parts lay chips out with it (the editor's transcript cuts, the meeting detail).
            `${KIT}/Sources/GenesisKit/Controls/WrapLayout.swift`,
        ],
    },
    {
        name: "feat/2026-11-05-recorder-service-and-editor",
        parent: "feat/2026-11-05-screen-recorder",
        subject:
            "feat(recorder, recording-editor, node-repl): tools recorder serve and its edit session, the recording editor library and the movies REPL toolset",
        scopes: [...RECORDER_SCOPES, "node-repl", "repl", "GenesisKit", "GenesisHub"],
        globs: [
            "src/recorder/**",
            "src/utils/recording-editor/**",
            "src/node-repl/**",
            "src/utils/repl/**",
            "src/utils/ai/providers/xai/AIXAITranscription*",
            `${KIT}/Sources/GenesisKit/Recording/**`,
            `${KIT}/Tests/GenesisKitTests/LiveRecording*`,
            "plugins/genesis-tools/skills/recorder/**",
            "plugins/genesis-tools/skills/node-repl/**",
            "plugins/genesis-tools/.claude-plugin/plugin.json",
            ".claude-plugin/marketplace.json",
            "scripts/benchmarks/recorder-denoise/**",
            "scripts/recorder/**",
        ],
        // GLOSSARY.md's new entries are the recorder's words.
        stays: ["GLOSSARY.md"],
    },
    {
        name: "feat/2026-11-05-recorder-editor-swift",
        parent: "feat/2026-11-05-recorder-service-and-editor",
        subject:
            "feat(GenesisHub, recorder): the recorder app part: the service host, the editor and library windows, the lanes, the capture picker and the camera bubble",
        scopes: [...RECORDER_SCOPES, "GenesisKit", "GenesisHub"],
        globs: [
            `${APP}/Sources/Parts/Recorder/**`,
            `${APP}/Tests/Recorder*`,
            `${APP}/Tests/CapturePickerTests.swift`,
            `${APP}/Tests/CameraBubbleTests.swift`,
            // The service fake the recorder tests above use; in a later layer this layer's test target did not compile.
            `${APP}/Tests/FakeServiceLink.swift`,
            // The schema checker RecorderProtocolTests calls; without it the test target fails to compile here too.
            `${APP}/Tests/JSONSchemaCheck.swift`,
            `${APP}/Info.plist`,
            // The camera library the bubble links (a8c6527dad split it out of GenesisKitPosture, which the app must
            // never compile): its new folder, the old one's deletions, the Posture re-export, the kit's Package.swift
            // and the kit tests that import it, so this layer's swift build has all of it.
            `${KIT}/Sources/GenesisKitCamera/**`,
            `${KIT}/Sources/GenesisKitPosture/Camera/**`,
            `${KIT}/Sources/GenesisKitPosture/Posture/CameraExport.swift`,
            `${KIT}/Sources/GenesisKitPosture/Posture/PostureStateMachine.swift`,
            `${KIT}/Package.swift`,
            `${KIT}/Tests/GenesisKitTests/Camera*Tests.swift`,
            `${KIT}/Tests/GenesisKitTests/Posture*Tests.swift`,
            `${KIT}/Tests/GenesisKitTests/VisionPoseBenchTests.swift`,
            `${KIT}/Sources/GenesisKit/Controls/GenSegmentedTabs.swift`,
        ],
        // service.test.ts reads the Swift editor's tab list.
        stays: ["src/recorder/lib/service.test.ts"],
        derived: partRegistration("meetings"),
        swift: true,
    },
    {
        name: "feat/2026-11-05-meetings-v3-and-window",
        parent: "feat/2026-11-05-screen-recorder",
        subject:
            "feat(meetings, GenesisHub): meetings v3 (dictionary, json2md markdown, OCR boxes, a meeting as an editor project) and the Meetings window with Settings → Meetings",
        scopes: [...MEETINGS_SCOPES, "GenesisKit", "GenesisHub"],
        globs: [
            "src/meetings/**",
            "src/utils/transcribe/**",
            "src/transcribe/**",
            "src/wisprflow/**",
            "src/ms-teams/lib/attendance.ts",
            "scripts/benchmarks/meetings-ocr/**",
            "scripts/benchmarks/baselines/meetings-ocr.json",
            "plugins/genesis-tools/skills/meetings/**",
            `${APP}/Sources/Parts/Meetings/**`,
            `${APP}/Tests/MeetingsWindowTests.swift`,
        ],
        // The meetings sandbox fixture, the meetings rows of the CPU benchmark doc and the transcribe hint serve it.
        stays: ["scripts/fixtures/meetings-sandbox.ts", "docs/benchmarks-cpu.md", "src/transcribe/index.ts"],
        derived: partRegistration("recorder"),
        swift: true,
    },
    {
        name: "feat/2026-11-05-unified-leftovers",
        parent: "feat/2026-11-05-recorder-editor-swift",
        subject:
            "feat(GenesisHub, GenesisKit, macos): unified's hub, widget, markdown viewer and app lifecycle changes that the recorder and meetings commits carried",
        // The catch-all: `**` has no literal prefix, so any other branch's glob wins, and this takes exactly the
        // changed files of the selected commits that no branch above serves (the hub, the widget, the markdown viewer,
        // the face lifecycle and quit flow, the app faces table, the permissions relaunch, mobile, toolCommand hints).
        scopes: [...new Set([...CAPTURE_SCOPES, ...MEETINGS_SCOPES, "GenesisKit", "GenesisHub"])],
        globs: ["**"],
        // The app lifecycle and the approval windows: their `(GenesisHub, app)` and `(GenesisKit, permissions)` commits
        // are outside the selection, so the branch takes their folders whole.
        sweep: [
            `${APP}/Sources/Host/**`,
            `${APP}/Tests/PartQuitTests.swift`,
            `${KIT}/Sources/GenesisKitBase/Permissions/**`,
            `${KIT}/Tests/GenesisKitTests/GateAuditTests.swift`,
            "src/macos/lib/permissions/**",
            "scripts/native/**",
        ],
        // This branch merges after both app parts, so its registration is unified's, meetings part included
        // (relaunch.test.ts knows the meetings face). Package.swift stays the recorder branch's: an unlinked part's face
        // answers with the command that adds it.
        derived: [
            { file: `${APP}/Sources/Host/AppParts.swift`, edits: [] },
            { file: `${APP}/Sources/Host/AppFaces+Declared.swift`, edits: [] },
            { file: "src/macos/lib/permissions/parts.ts", edits: [] },
        ],
        swift: true,
    },
];

/**
 * Files the cut leaves at their base form on purpose, with the reason. For a dependency the import tracer cannot see
 * (Swift) on code another open PR holds. A TypeScript file never needs an entry: the tracer keeps it at base itself.
 */
const KEEP_AT_BASE: Record<string, string> = {
    [`${APP}/Sources/Parts/Widget/WidgetWindow.swift`]:
        "its unified form passes openUsage to WidgetCoordinator, the AI usage widget of PRs #711 and #712",
};

export default {
    branches: CUT,
    keepAtBase: KEEP_AT_BASE,
    defaults: {
        unified: "feat/2026-10-13-enhancements-unified",
        unifiedBranch: "feat/2026-10-13-enhancements-unified",
        base: "origin/feat/2026-11-03-repl-followups",
    },
    selection: "commits",
    refPrefix: "refs/heads/cut/",
} satisfies CutTable;
