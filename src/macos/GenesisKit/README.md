# GenesisKit

The Swift code GenesisTools.app and Genesis.app share: the session screen, the `tools` clients under it, perf
logging, the title bar zone and the small controls. One copy, two consumers:

- GenesisTools.app: `.package(path: "../GenesisKit")`; `Sources/Hub/GenesisKitHost.swift` re-exports it
  (`@_exported import GenesisKit`) and implements `GenesisKitHost`.
- Genesis: the app target and `Genesis/lib/GenesisAIMonitorKit` depend on
  `../../../../GenesisTools/src/macos/GenesisKit`; the kit re-exports it. Genesis therefore builds only next to a
  GenesisTools checkout at `~/Tresors/Projects/GenesisTools`. The app lists it directly as well: through the
  re-export alone, a changed initializer here left a stale caller in the app and the link failed.

## Layout

Six libraries, folders by job. A file goes where its job is, not where its first caller was. An app compiles only
the libraries it imports, so an optional part costs an app nothing until it uses it (Martin, 2026-10-14 and 15).

- `GenesisKitBase` (`Sources/GenesisKitBase/`): what GenesisTools.app's permissions host needs and nothing more:
  `Permissions/`, `Perf/` (PerfLog, PerfSpans, HangWatch, …), `Paths/` (`PathOpener`, `Clipboard`, `CopyToast`,
  `PathKind`, `PathDisplay`), `Tools/` (`ToolsBridge`, the server client), `Style/` (motion, `RowButton`, `Plural`,
  `KitPalette`, and `KitHost`: the `GenesisKitBaseHost` protocol and the class-name lookup), `Window/`
  (`WindowTitlebar`, `SingleInstance`). No external package. `GenesisKit` re-exports it, so an app that imports
  `GenesisKit` never names it. A host-only GenesisTools build (no optional part, src/macos/lib/permissions/parts.ts) links only
  this (12 s cold instead of 83 s, 2026-10-18), with `GENESIS_KIT_BASE_ONLY=1` so this package declares nothing else
  (Package.swift); a build with any part links `GenesisKit`. A file moves here only when
  the host needs it and it needs nothing outside this library; `GenesisKit`'s files reach its helpers through `package`.
- `GenesisKit` (`Sources/GenesisKit/`): what both apps use, including `Alerts/` (`AlertPolicy`, the channels and the
  channel matrix row), `System/` (`ActivityGate`, `ScreenCaptureDetector`) and `ChartColor`. Every GenesisTools part
  compiles it. Its `GenesisKitHost` protocol refines `GenesisKitBaseHost` with the markdown, transcript and git hooks.
- `GenesisKitCharts` (`Sources/GenesisKitCharts/`): sunburst, treemap, donut, ring gauge, health bar and their
  layouts. Any app may import it. `Sparkline`, the native charts and `ChartColor` stay in the core.
- `GenesisKitOverlay` (`Sources/GenesisKitOverlay/`): screen effects (`ScreenEffectsController`: tints, edge glow,
  a draggable message pill per display). Any app may import it; it needs only the core.
- `GenesisKitPosture` (`Sources/GenesisKitPosture/`): PostureWatcher's `Camera/`, `Pose/` and `Posture/`. Genesis's.
- `GenesisKitDisk` (`Sources/GenesisKitDisk/`): the Disk Manager's `Disk/`. Genesis's.

A part goes into the core only when GenesisTools.app uses it; otherwise into a library of its own. The libraries reach
core helpers through `package` access, not `public`. `KitModuleBoundaryTests` in GenesisTools fails when the app names
or imports `GenesisKitPosture` or `GenesisKitDisk`, or when a type of any optional library is declared in the core
again. Genesis lists each library it uses and imports it where it is used.

The fixtures product, `GenesisKitFixtures` (`Sources/GenesisKitFixtures/`), is for test targets only: the one copy
of the `tools` disk fixtures, read with `KitFixture.url(_:)`, `data(_:)` and `string(_:)` by file name
(`contract-doctor-act.ndjson`).
A fixture an app test needs goes there under its own name, never into a test target.

| Folder | What |
|---|---|
| `Style/` | hover styles (`.genHover*`, `.genHoverEffect`), `.instantTooltip` + `TooltipGuard`, `.rowButton` / `RowButtonStyle`, `KitPalette` / `KitTheme`, `GenesisKitHost`, `.hoverHighlight()` / `.axMarker(_:)`, `SWR` (stale-while-revalidate: `changed`, `fade`, `rowTransition`, `animation`) + `.swrFlash` |
| `Controls/` | `IconButton`, `GhostButton`, `MenuButton`, `CopyChip`, `NoticePill`, `NewItemsPill` ("3 new ↓" over a live list while the reader is scrolled up) and `RowArrival` (a new row fades in and rises 8 pt, fade only under Reduce Motion), `InfoStrip`, `EmptyState`, `Badge` / `CountBadge`, `ProviderBadge`, `ForgeBadge` ("GitLab !7528" with the forge's mark, opens the PR/MR), `UserAvatar` (a person's picture on a host, one fetch per URL, initial or person-glyph fallback), `.kicker`, `RefreshingMark` (the spinner over last known data) |
| `Keymap/` | keyboard shortcuts as data: `KeyChord` (a key by position or by character, plus modifiers; labels in the user's layout), `KeymapLibrary` (an app's commands and default keys), `KeymapConfiguration` + `KeymapStore` (the user's keys, JSON), `Keymap` (both together: keys in force, hints, conflicts, menu items), `KeymapDispatcher` + `.keymapAction` (runs a command from its key), `KeyChordRecorder`, `KeymapHelpView` / `KeymapListView` / `KeymapHelpWindow` (the list, with an editor) |
| `Media/` | `MediaThumbnailView` (the picture of any image, video or document: off-main decode, file-identity cache, Retina pixel buckets, poster frame and length for a video, a named placeholder with Retry on failure, a click previews it) on `MediaThumbnailCache`; `.mediaPreviewHost()` + `MediaPreviewState` (an in-place Quick Look style preview over a surface, ← / → through the set) and `MediaPreviewKeyboard` (Esc / Space / arrows, for a window's key handler); `ImageViewer.present` (a window that grows from the picture's place: pinch / ⌘± / ⌘0 zoom anchored at the pointer, pan, ← / → through the source's pictures, "Compare with…" as a slider or side by side, same table row first; `ImageViewer.prefetch` on the first click; `ImageViewerSnapshot` renders any state off screen) and `MediaDataURL` (an embedded `data:image/` picture as a private temporary file) |
| `Paths/` | `PathOpener` (folder in Finder by bundle id, file in Cursor at a line), `PathLabel`, `PathActionsMenu`, `Clipboard` + `CopyToast`, `DefaultApp` (a file's default app by name, opened at a line through `cursor://` / `vscode://`) |
| `Diff/` | git and diffs for any host: `GenesisKitGTProvider` (the data source, swappable), `GitWorkingTreeSource` + `DiffScope`, `GitDiffView` + `GitScopePicker` + `GitCommitPicker` (popover choosers built when opened, `GitPickerChip`), `GitFileDiffModel`, `GitRepos` (one status per repository, refreshed by git's own folder events), the file state badge and marks, the gutter (`GitGutterModel`, `GitHunks`, `GitHunkPopover`), history and commits (`GitHistoryModel`, `GitCommitList`, `GitRepoPanel`, `GitCommitView`), tree marks, agent blame |
| `Time/` | `LiveTime`, `LiveAgo`, `LiveTimeFormat` |
| `Navigation/` | `NavigationHistory` (a log of every place a window showed, who took it there: user, agent or link, and why; Back / Forward / hop to any entry; visits never replace), `NavigationHistoryStore` (the host persists it: the hub through `tools hub nav`), `NavigationHistoryList` (the list, newest first, a click hops) |
| `Cmux/` | `CmuxTree`, `CmuxTarget`, `CmuxTargetPicker` (Tree / Layout), `CmuxSessionPanel` |
| `Settings/` | the settings window (`FeatureSettingsWindowController`, `NativeSettingsStore`, pages and controls, `NativeSettingsTilePicker`), the plug-in contract for a window that several parts of an app add pages to (`FeatureSettingsPlugin`, `FeatureSettingsPluginHost`, `FeatureSettingsMode`) with the two pages every such window has (`FeatureSettingsPages.general`, `.about(additionalInfo:)`), its look (`NativeSettingsAppearance`, `NativeSettingsBackdrop`, `NativePaneFill` / `NativePaneBackground` for a host that draws its panes in that look), and the hub's preferences with their Hub pages (`HubPreferences`, `HubSettingsPages`) |
| `Alerts/` | Turning measured values into alert events (`AlertPolicy`: tiers, hysteresis, snooze, quiet hours), and the channels that show them (`AlertDispatcher`, `AlertChannelMatrix`) |
| `GenesisKitPosture/Camera/` | One webcam at low energy (`CameraFrameSource`: VGA, device frame rate, interval bursts with the light off in between), its preview, the camera grant and the device list |
| `GenesisKitDisk/Disk/` | Free-space sampling (`VolumeSpaceMonitor`), forecasts, history, a resumable FSEvents stream, the big-file radar, the du index reader and the decoders for the tools disk commands (`ToolsDiskProvider`); unrelated to `DiskCache` in `Tools/` |
| `GenesisKitOverlay/` | Screen effects: click-through panels over every display (vignette, sepia, blur, dim, edge glow), a message pill and a camera bubble (`ScreenEffectsController`) |
| `GenesisKitPosture/Pose/` | Pose samples, the Vision body and face engines and the AirPods engine, and the skeleton overlay |
| `GenesisKitPosture/Posture/` | PostureWatcher's logic: metrics, scorer, state machine, health, calibration slots, history, the activity gate and `PostureMonitor` |
| `Window/` | `WindowTitlebar`: `.titlebarZone()`, `.titlebarBackground`, `.titlebarRow()`, the snapshot audit; `HostWindow` + `HostWindowReader` (the window a view is in, without SwiftUI state); `WindowSnapshot` (a `--snapshot` PNG as the window server composes it, Liquid Glass included); `WindowRaise` (one window forward, not the whole app); `SingleInstance` (one process of a kind per login session: a later launch hands its arguments over and exits) |
| `Permissions/` | `PermissionKind` (every privacy grant: title, reason, exact System Settings pane, request style), `PermissionAccess` (status and in-place request through TCC, with the `GenesisToolsSimulateDeniedPermissions` denial simulation on top), `PermissionCenter` + `PermissionNeed` (the one permission dialog: one per kind at a time, grants in place where macOS allows it, otherwise explains and opens the pane, offers Relaunch for a grant only a new process sees, closes itself when the grant arrives), `PermissionDialogView` / `PermissionPanelPresenter` |
| `Perf/` | `PerfLog`, `HangWatch`, `MainStackSampler`, `MonitorPerf`, `RenderProbe`, `PerfConfiguration`, `MainBusy` (main-thread busy time after an event, `measureUntilSettled`, and a `Meter` for benches), `SessionOpenBench` (times one open of a session screen for the bench tests of both apps) |
| `Tools/` | `ToolsBridge` (runs `tools`), `ToolsLineStream` (one long-running `tools` child, stdout as whole lines on the main queue, stdin held open so the child ends with the app), `MonitorJSON`, `TitleFormatter`, `SessionTranscriptClient` (the `tools ai sessions tail` envelope), `TranscriptPromptPart`, `DiskCache` (last answers on disk; `load` / `loadData` read off the main thread), `DirectoryWatcher` (one FSEvents stream over several folders, a path filter, main-queue callback) |
| `Providers/` | `AIProviderMeta`, `AIProviders`, `AIProviderGlyph` |
| `Recording/` | screen recording for any host: `ScreenRecorder` (picker, grant, session, floating controls) with `ScreenRecordingHost`, `RecordingTargetPicker`, `RecordingControlsView`, `RecordingSessionController` (one `tools control capture session`), `RecordingTarget(s)`, `RecordingSettings` + `RecordingSettingsView` |
| `Sessions/` | `SessionPalette`, `SessionFormat` |
| `Sessions/Transcript/` | `SessionTranscriptList`, `TranscriptDocument`, prompt parts, `TranscriptScrollAnchor`, `TranscriptBus` / `TranscriptFilters`, `TranscriptMarkdownStyle`, `TranscriptLiveTail` (one `tools ai sessions tail --live` child, or a server subscription, per open screen; its `TranscriptLiveActivity` says what the agent does now, the list's last row through a `TranscriptActivityFeed` only that row observes) |
| `Sessions/ToolCalls/` | `SessionToolCallView` + `TranscriptServices`, `SessionNativeLog` + `SessionNativeLogStore`, `SessionToolChanges`, `BatchedToolChangeSource` + `ToolChangeBatcher` (rows that ask within 100 ms share one `tools agents changes` run) |
| `Sessions/Code/` | `CodeBlock`, `CodeBlockText`, `SessionSyntaxHighlighter` |
| `Sessions/Detail/` | `SessionDetailScreen`, its header and sidebar, `SessionSidebarSplit`, `TranscriptPaging` (first page 12, pages of 150, refresh to the end), `TranscriptBuildQueue` (one document build at a time, newest pending wins) |
| `Markdown/` | the Genesis Markdown viewer. `Window/`: `MarkdownViewerApp.run(_:)` (a process whose only window is the viewer, its menu and URL queue), `MarkdownDocumentWindowController.shared.show(paths:focus:range:)`, `MarkdownDocumentsModel` + `MarkdownDocumentsView` (tabs, split, sidebar). `Views/`: `MarkdownWebView` (markdown-it, highlight.js, mermaid, offline; `MarkdownWebPage` for a host's own pane), the source editor, `MarkdownPreviewView` / `MarkdownContentView` + `MarkdownStyle` (native), toolbar, status bar, find bar, outline, go to, file tree and its search, conflict view, media and image viewer. `Document/`: links and line ranges, file ops, drop, export, properties, completion, merge, default app, dashboard share. `Resources/webview` is the renderer; an installed app copies it to `Contents/Resources/webview`, read first |

## Components

Every public component a host uses, one section per folder. An entry says what the component is for, lists its
options as `name: Type = default`, and shows a short usage example. Internal helpers and small payload types
that only serve another entry are described inside that entry, not listed on their own. The number is the entry
count of the section.

- [Alerts](#alerts) (4)
- [Audio](#audio) (4)
- [Camera](#camera) (8)
- [Charts](#charts) (15)
- [Clicky](#clicky) (13)
- [Cmux](#cmux) (6)
- [Controls](#controls) (42)
- [Diff](#diff) (11)
- [Disk](#disk) (10)
- [Files](#files) (11)
- [Flow](#flow) (39)
- [Focus](#focus) (31)
- [Markdown](#markdown) (28)
- [Media](#media) (25)
- [Overlay](#overlay) (6)
- [Paths](#paths) (16)
- [Perf](#perf) (11)
- [Permissions](#permissions) (16)
- [Pose](#pose) (8)
- [Posture](#posture) (9)
- [Providers](#providers) (3)
- [Recording](#recording) (7)
- [Sessions](#sessions) (65)
- [Settings](#settings) (49)
- [Style](#style) (32)
- [Time](#time) (5)
- [Tools](#tools) (21)
- [Widgets](#widgets) (40)
- [Window](#window) (18)

### Alerts

Alerts turn a stream of measured values (free bytes, a health score) into a few events a person should see. `AlertPolicy` is pure: it keeps no clock and no timer, and the caller passes each value with its time and keeps the `AlertState`. The events it returns go to the app's channels through `AlertDispatcher` and an `AlertChannelMatrix` (tiers by channels), and the app implements each `AlertChannel` (a banner, a sound, speech, a screen glow, the menu tint).

#### `AlertPolicy`

The rules, as a `Codable` value a settings page can edit. A value is in the worst tier whose threshold it crossed (`.below`: under the threshold). A tier, once on, ends only when the value recovers past `threshold ± margin`, so a value that hovers at a threshold raises once and does not flap. A worse tier notifies at once; recovery into a milder tier reports `.improved`, and past every tier `.cleared` (neither interrupts). While a tier lasts it notifies again every `repeatInterval`. Quiet hours and a snooze hold interrupting events back; an event at or above `emergencyOverride` breaks through both, and a snooze ends early when the value reaches a worse severity than the snoozed one. A held-back alert notifies as a `.reminder` once the quiet hours or the snooze end. A policy stored by an older build decodes with defaults for the newer fields.

- `direction: Direction = .below`: `.below` (lower is worse) or `.above`.
- `tiers: [AlertTier]`: each has `id: String`, `threshold: Double`, `severity: AlertSeverity` (`info < warning < critical < emergency`), `clearMargin: Double? = nil` (overrides the fraction) and `repeatInterval: TimeInterval? = nil` (overrides the policy's).
- `hysteresisFraction: Double = 0.1`: the default clear margin as a fraction of the threshold (0.5: a 10 GB tier ends above 15 GB).
- `repeatInterval: TimeInterval? = 3600`: nil never repeats.
- `quietHours: AlertQuietHours? = nil`: `startMinute` and `endMinute` since local midnight; a start after the end wraps past midnight.
- `emergencyOverride: AlertSeverity? = .emergency`: nil lets nothing through quiet hours or a snooze.
- `confirmSamples: Int = 1`, `confirmDuration: TimeInterval = 0`: a worse tier is entered only after that many consecutive samples past its threshold and after that long, so one dip does not alert.
- `evaluate(_ value: Double, at: Date, state: inout AlertState, calendar: Calendar = .current) -> [AlertEvent]`: feeds one value; usually returns nothing.
- `snoozed(_ state: AlertState, until: Date, severity: AlertSeverity? = nil) -> AlertState`: snoozes the tier on now (or `severity`).
- `orderedTiers`, `crosses(_:_:)`, `clearPoint(of:)`, `tier(for:current:)`, `suppression(for:at:state:calendar:)`: the pieces `evaluate` uses, for a settings preview.
- `AlertPolicy.freeSpace(watch:low:critical:repeatInterval:quietHours:)` (in `Disk/`): the free-space default, Watch under 10 GB, Low under 3 GB, Critical (`.emergency`) under 1 GB, two samples to arm, re-armed only above 1.5 times the floor.

`AlertState` is `Codable` too, so a snooze survives a restart: `tierID`, `lastNotified` (nil while the tier was held back), `snooze` (`until`, `severity`) and the pending confirmation.

```swift
let policy = AlertPolicy.freeSpace()
var state = AlertState()
let events = policy.evaluate(Double(sample.available), at: sample.date, state: &state)
dispatcher.dispatch(events)
state = policy.snoozed(state, until: .now.addingTimeInterval(3600))   // "Snooze 1 h"
```

#### `AlertEvent`

One change the policy reports: `kind` (`.raised`, `.escalated`, `.reminder`, `.improved`, `.cleared`), `tier` (nil for `.cleared`), `previousTier`, `value`, `date`, `notifies` (the policy's verdict for interrupting channels) and `suppression` (`.snoozed` or `.quietHours` when it was held back). `severity` is the tier's, or the ended tier's for `.cleared`. A `.reminder` always notifies.

#### `AlertChannel`

A `@MainActor` protocol the app implements once per way of reaching the user.

- `id: String`: the column of the matrix (`banner`, `sound`, `speech`, `glow`, `menu`).
- `interrupts: Bool`: true for a channel that interrupts (it gets a `.raised`, `.escalated` or `.reminder` only when `notifies` is true); false for a status channel such as the menu tint, which gets every event, held back or not.
- `receivesRecovery: Bool` (default false): true for an interrupting channel that shows a state and must take it back (an edge glow, a persistent banner). It also gets `.improved` and `.cleared`, with `notifies == false`. A channel that only posts (a sound) keeps the default and is never called on a recovery.
- `deliver(_ event: AlertEvent)`.

#### `AlertDispatcher`

Sends events to the channels by an `AlertChannelMatrix`. An `.improved` or `.cleared` event goes to the channels of the tier that ended (and, for `.improved`, of the milder tier now on): every status channel, and each interrupting channel with `receivesRecovery`, so a status channel drops its tint and a glow fades when the disk recovers. `AlertChannelMatrix(routes: [String: Set<String>] = [:], fallback: Set<String> = [])` maps a tier id to channel ids; a tier missing from `routes` uses `fallback`. `set(_:tierID:channelID:)` and `contains(tierID:channelID:)` back a tiers-by-channels settings grid; `materialized(tierIDs:)` gives every tier an explicit route (the fallback for a missing one), for a grid that binds `routes` directly.

- `channels: [AlertChannel]`, `matrix: AlertChannelMatrix`.
- `add(_ channel:)`: adds a channel, replacing one with the same id.
- `targets(for event:) -> [AlertChannel]`, `dispatch(_ events:)`.

```swift
let dispatcher = AlertDispatcher(channels: [bannerChannel, soundChannel, menuTint],
                                 matrix: AlertChannelMatrix(routes: ["critical": ["banner", "sound", "menu"]],
                                                            fallback: ["menu"]))
```

### Audio

Voice Notes recording support. `VoiceCommandTransport` runs one `tools` voice-notes command at a time, streams its JSON events and returns the final result. A recording can start only after a `VoiceRecordingLease` admits the recorder process. `VoiceMicrophonePermission` reads the macOS microphone grant and explains it, and `VoiceCommandFailure` is the error a command throws. The Voice Notes widget store in the Widgets folder is the main caller.

#### `VoiceCommandTransport`

Runs `tools hub widget [--state-root <path>] voice-notes <args>` as a child process on the main actor. It decodes each stdout line as a `VoiceCommandEvent`, hands the events to the caller, and returns the data of the last `recorded` or `transcribed` event when the process exits cleanly. Only one operation can run at a time: a second `run` throws `ToolsBridgeError.refused`.

- `binaryPath: String`: the path of the `tools` executable.
- `stateRoot: String? = nil`: adds `--state-root <path>` to the command, so a test or preview can use an isolated state folder.
- `deadline: Duration = .seconds(90)`: the time limit for the whole command, setup included. On expiry the child gets SIGTERM, then SIGKILL after `killGrace`, and the call throws `VoiceCommandFailure.timedOut`.
- `killGrace: Duration = .seconds(3)`: the wait between SIGTERM and SIGKILL. The caller is answered after a second `killGrace` even if the child's exit never arrives.

Methods:

- `func run(args: [String], lease: (any VoiceRecordingLease)? = nil, onEvent: @escaping (VoiceCommandEvent) -> Void = { _ in }) async throws -> Data`: runs the command and returns the final event line. With a `lease`, the transport waits for the child's `ready` event (which carries its `pid`), calls `lease.attachRecorder(pid:)`, and only then writes `start` to the child's stdin. The lease is released when the child exits. Canceling the surrounding Swift task cancels the command.
- `func finishRecording()`: asks the recorder to stop and save, by closing the child's stdin. If the `start` line has not been sent yet, the request is applied right after it.
- `func cancel()`: stops the command (SIGTERM, then SIGKILL) and makes `run` throw `CancellationError`.

`VoiceCommandEvent` is the value passed to `onEvent`. All its fields are read-only:

- `kind: String`: the event type. The code uses `ready`, `recording`, `recorded`, `transcribed` and `error`.
- `pid: Int32?`: the recorder process id, sent with `ready`.
- `rms: Double?`: an input level reading.
- `durationMs: Double?`: a duration in milliseconds.
- `text: String?`: text, such as a transcript.
- `code: String?`: the error code of an `error` event. It maps to a `VoiceCommandFailure` case, and an unknown code becomes `operationFailed`.

If the child exits with status 143 the call throws `VoiceCommandFailure.interrupted`. Any other non-zero status, or a clean exit without a final event, throws `VoiceCommandFailure.operationFailed`.

```swift
let transport = VoiceCommandTransport(binaryPath: toolsPath, deadline: .seconds(120))
Task {
    let data = try await transport.run(args: ["record", "--input", "mic", "--json"], lease: lease) { event in
        if event.kind == "recording" { level = event.rms ?? 0 }
    }
    handleSavedNote(data)
}
// From a Stop button while the recording runs:
transport.finishRecording()
```

#### `VoiceRecordingLease`

A main-actor protocol for the object that owns the microphone while a recording runs. The transport calls it so that the recorder process is admitted before it opens the input, and released after it has closed the input and exited. `FlowFocusAudioLease` from the Flow folder already conforms. There are no default implementations.

- `func attachRecorder(pid: Int32) async throws`: admit the recorder process with this pid. Throw to stop the recording before it starts.
- `func release() async throws`: give the microphone back after the recorder has exited.

```swift
@MainActor
final class SingleOwnerLease: VoiceRecordingLease {
    func attachRecorder(pid: Int32) async throws { /* record the pid as the microphone owner */ }
    func release() async throws { /* clear the owner */ }
}
```

#### `VoiceMicrophonePermission`

The state of the macOS microphone permission, read through GenesisKit's permission module, so a simulated denial applies to Voice Notes as well. Use it before a recording to show a hint in the UI.

- `notDetermined`: the user has not been asked yet.
- `authorized`: recording is allowed.
- `denied`: the user turned microphone access off.
- `restricted`: the Mac's settings or an administrator block access.
- `unknown`: the permission could not be read (a partial or unreadable state).
- `static var current: VoiceMicrophonePermission`: reads the permission now.
- `var guidance: String?`: a sentence that tells the user what to do, or `nil` when the state is `authorized`.

```swift
let permission = VoiceMicrophonePermission.current
switch permission {
case .authorized, .notDetermined:
    startRecording()
default:
    statusText = permission.guidance ?? ""
}
```

#### `VoiceCommandFailure`

The error that `VoiceCommandTransport.run` throws for a failed voice command. The raw value is the `code` string that the `tools` command sends in an `error` event. It conforms to `LocalizedError`, and `errorDescription` returns a sentence that is safe to show to the user.

- `microphonePermission` (`microphone_permission`): microphone access is not available.
- `microphonePromptOpen` (`microphone_prompt_open`): the macOS microphone prompt still waits for an answer.
- `noAudio` (`no_audio`): no audio was recorded.
- `interrupted` (`capture_interrupted`): the recording was interrupted before it was saved.
- `captureFailed` (`capture_failed`): audio capture failed.
- `cancelled` (`cancelled`): the recording was canceled.
- `operationFailed` (`operation_failed`): the voice operation failed. The transport also uses this for an unknown error code or a failed exit.
- `timedOut` (`timed_out`): the command passed its `deadline` and was stopped.

```swift
do {
    _ = try await transport.run(args: ["transcribe", noteID])
} catch let failure as VoiceCommandFailure {
    message = failure.errorDescription ?? "The voice operation failed."
}
```

### Camera

Camera runs one webcam as cheaply as a posture check allows and shows it. `CameraFrameSource` owns the `AVCaptureSession`: the 640x480 preset, 32BGRA pixels, late frames dropped, the device's own frame rate where the format allows it, and an interval mode that turns the camera off between short bursts. `CameraPreviewView` shows the same session. `CameraAuthorization` reads and requests the camera grant directly through `AVCaptureDevice`; the camera is deliberately not a `PermissionKind` case. `CameraDevice` and `CameraSelection` list and pick cameras. `CameraCaptureMode`, `CameraFrame`, `CameraWarmup` and `FrameThrottle` are the small value types the source runs on.

A host that uses the camera needs `NSCameraUsageDescription` and, to see an iPhone as a Continuity camera, `NSCameraUseContinuityCameraDeviceType` in its Info.plist. macOS ends a process that asks for the camera without a usage description, and it judges the responsible process: a tool started from a terminal (`swift test`, `swift run`) is ended even when its own Info.plist has the key. No test in this package reads the real grant or opens a camera.

#### `CameraFrameSource`

One camera, run as cheaply as the mode allows. A `final class`, thread-safe: every method may be called from any thread.

- A continuous mode sets `activeVideoMinFrameDuration` to the slowest rate the active format supports at or above the asked rate, so the sensor does less work, and drops the remaining extra frames in software (`FrameThrottle`). A rate no format supports is never set, because AVFoundation raises an exception for it.
- Interval mode starts the session every `every` seconds, discards frames until the exposure settles (`CameraWarmup`: at least 0.5 s and 5 frames, then `isAdjustingExposure` false and two frames within 0.02 brightness, at most 1.5 s), delivers `frames` frames 0.2 s apart and stops the session. The camera light is off between bursts. A `DispatchSourceTimer` with 10% leeway schedules the bursts. Each burst has a number, so a burst that ends after a newer mode began (a slouch seen on its last frame switches to continuous) changes nothing.
- A rate of zero or less is the same as `.off` (`FrameThrottle(fps: 0)` admits nothing).
- Frames go to `onFrame` on `deliveryQueue`. Run the pose work there: while it runs, late frames are dropped.
- It recovers by itself: a runtime error and a session that macOS stopped are retried, a wake restarts a continuous session, an unplugged camera reports `.noDevice` and starts again when it comes back, and a watchdog restarts a continuous session that delivered no frame for 10 s. Every restart counts, the watchdog's too: after `maximumRestarts` (3) in a row without a delivered frame it stops with `.failed` and the light off, until the next `setMode` or `refresh()`.
- It never asks for the grant. After `CameraAuthorization.request()` returns true, call `refresh()`.

Initializer:

- `selection: CameraSelection = .systemDefault`: which camera.
- `preset: AVCaptureSession.Preset = .vga640x480`: the session preset; `.vga640x480`, `.medium` and `.low` are tried next when the device refuses it. A new session starts at High, and Dorso found CIF broke capture cards, so VGA is the floor.
- `deliveryQueue: DispatchQueue? = nil`: the serial queue for frames; nil makes a utility-QoS queue.
- `warmup: CameraWarmup = CameraWarmup()`: the burst warm-up rule.

Properties:

- `session: AVCaptureSession`: for `CameraPreviewView`. Do not reconfigure it.
- `onFrame: (@Sendable (CameraFrame) -> Void)?`: each delivered frame, on `deliveryQueue`.
- `onStateChange: ((CameraSourceState) -> Void)?`: each state change, on the main queue.
- `state: CameraSourceState`: `.stopped`, `.starting`, `.running`, `.waiting` (between bursts), `.interrupted`, `.failed(String)`, `.unauthorized`, `.noDevice`. `state.issue` gives the `PostureCameraIssue` it means, nil when the camera is fine or off.
- `mode: CameraCaptureMode` and `activeDeviceID: String?`: what it was asked for and which camera it opened.

Methods:

- `setMode(_ mode: CameraCaptureMode)`: `.off`, `.continuous(fps:)` or `.interval(every:frames:)`. The same mode twice does nothing.
- `select(_ selection: CameraSelection)`: switch cameras; applies at once when running.
- `refresh()`: read the grant and the devices again.
- `stop()`: the same as `setMode(.off)`.
- `static frameDuration(for fps: Double, ranges: [(min: Double, max: Double)]) -> Double?`: the frame duration it asks the device for. Pure.

```swift
// Alone. A PostureMonitor given this camera sets onFrame and the mode itself.
let camera = CameraFrameSource(selection: .systemDefault)
let engine = VisionBodyPoseEngine()
camera.onFrame = { frame in
    if let sample = engine.analyze(frame) { record(sample) }
}
if await CameraAuthorization.request() { camera.refresh() }
camera.setMode(.interval(every: 30, frames: 3))
```

#### `CameraPreviewView`

The live image of a running `CameraFrameSource`, through an `AVCaptureVideoPreviewLayer` on the source's own session, so no second session opens the camera. Aspect fill, continuous rounded corners and a white 10% hairline on the inside edge. Between interval bursts the layer keeps the last frame. Take the view off screen when its window hides, so the layer stops taking frames. Accessibility identifier `camera.preview`.

- `session: AVCaptureSession` or `source: CameraFrameSource` (unlabeled first argument names which).
- `mirrored: Bool = true`: show it like a mirror. Pass the same value to `PoseSkeletonOverlay`.
- `cornerRadius: CGFloat = 16`.

```swift
ZStack {
    CameraPreviewView(source: camera)
    PoseSkeletonLiveOverlay(feed: monitor.feed, target: .lastGood)
}
.aspectRatio(4.0 / 3.0, contentMode: .fit)
```

#### `CameraAuthorization`

The camera grant, read and asked for straight through `AVCaptureDevice`. An `enum` with static members.

- `status: CameraAuthorizationStatus`: `.notDetermined`, `.restricted`, `.denied` or `.authorized`. Reading it never prompts.
- `hasUsageDescription: Bool`: whether the running bundle declares `NSCameraUsageDescription`.
- `request() async -> Bool`: shows the macOS prompt while the user has not answered; `true` when allowed. Returns `false` without asking when the bundle has no usage description, and after a denial until the user changes it in System Settings.
- `settingsURL: URL`: Privacy & Security, Camera.

```swift
switch CameraAuthorization.status {
case .authorized: camera.refresh()
case .notDetermined: if await CameraAuthorization.request() { camera.refresh() }
case .denied, .restricted: NSWorkspace.shared.open(CameraAuthorization.settingsURL)
}
```

#### `CameraDevice`

A camera the user can pick: `id` (`AVCaptureDevice.uniqueID`, stable across launches), `name` and `kind` (`.builtIn`, `.external`, `.continuity`, `.other`). A struct with a public init.

- `static available() -> [CameraDevice]`: the built-in, external and Continuity cameras (`AVCaptureDevice.DiscoverySession`). Desk View is left out. A Continuity camera reports its own kind only with `NSCameraUseContinuityCameraDeviceType` in the Info.plist; otherwise macOS calls it built in.

#### `CameraSelection`

`.systemDefault` or `.device(id:)`. The system default is the built-in camera when there is one, else the default video device; it never follows `systemPreferredCamera`, which switches by itself when an iPhone comes near.

- `storageValue: String` and `init(storageValue: String?)`: `"default"` or the unique id, for settings.
- `resolve() -> AVCaptureDevice?`: the device it names now; nil when that camera is not connected.

#### `CameraCaptureMode`

`.off`, `.continuous(fps:)` or `.interval(every:frames:)`. `usesCamera` is false only for `.off`. `PostureStateMachine.captureMode(...)` picks one from a posture state.

#### `CameraFrame`

One frame on its way to a pose engine: `pixelBuffer`, `time` (uptime seconds), `meanLuma` (0...1 from a sparse 16 by 12 grid, about 20 µs a frame), `isBurst`, `imageAspect`, and `isLowLight` (below `lowLightLuma`, 0.08). A dark frame makes a posture reading "unknown", never "away" (Dorso #67).

#### `CameraWarmup` and `FrameThrottle`

The pure rules behind the source. `CameraWarmup(minimumWait: 0.5, minimumFrames: 5, maximumWait: 1.5, lumaTolerance: 0.02)` answers `settled(at:luma:adjustingExposure:) -> Bool` per frame. `FrameThrottle(fps:)` answers `admit(_ time:) -> Bool`; it keeps the long-run rate exact and lets a frame in up to 10% of an interval early, so timestamp jitter never costs a whole frame.

### Charts

Native chart views. Three are built on SwiftUI Charts and drawn in mint: `NativeTimeSeriesChart` (a pannable, zoomable timeline), `NativeMatrixHeatmap` (a grid of intensities) and `NativeCategoryChart` (ranked bars); Clicky's Stats and Performance pages use them. The rest are drawn by hand for the dark kit look and share one palette (`ChartPalette`): `RingGauge`, `SegmentedDonut`, `HealthBar` and `Sparkline` for single values and trends, and `SunburstChart` and `TreemapView` for a hierarchy (`ChartNode`), with their pure layouts (`SunburstLayout`, `SquarifiedLayout`, `TreemapLayout`) public and tested. None of them animates at rest: a value change glides once, and a drill moves the arcs once.

#### `NativeTimeSeriesChart`

A timeline of counts or amounts over time, with a Line, Area or Bars style picker, zoom buttons and a slider, a Latest button, drag to pan and hover to inspect a value. Points that fall in the same bin are added together. A wide view combines nearby bins so that scrolling stays smooth (about 1200 bins at most).

- `points: [NativeTimePoint]`: the data. Sort it by date, oldest first. A `NativeTimePoint` has `date: Date` and `value: Double`, created with `NativeTimePoint(date:value:)`.
- `interval: TimeInterval`: the bin width in seconds. A value of 86400 gives calendar days.
- `initialWindow: TimeInterval`: the time span that is visible at zoom 1, in seconds. The zoom range is 0.25 to 8, and the visible span never gets shorter than five bins.
- `end: Date = Date()`: the right edge of the data, and where the Latest button goes.
- `valueLabel: String = "Events"`: the name of the measured value, used in the hover text and the accessibility label.

The nested `NativeTimeSeriesChart.Style` enum lists the three draw styles: `line` ("Line"), `area` ("Area", the starting style) and `bars` ("Bars").

```swift
NativeTimeSeriesChart(
    points: samples.map { NativeTimePoint(date: $0.time, value: Double($0.count)) },
    interval: 3600,
    initialWindow: 24 * 3600,
    valueLabel: "Presses"
)
```

#### `NativeMatrixHeatmap`

A grid of rounded cells whose brightness follows each value relative to the largest value. A missing cell counts as 0, and several cells at the same position are added together. The row labels are on the left, and only every third column label is shown. Each cell has a hover tooltip and an accessibility label such as "Mon, 09:00 · 120 presses", so the grid is written for hour-of-day columns and press counts.

- `rows: [String]`: the row labels, top to bottom.
- `columns: [String]`: the column labels, left to right.
- `cells: [NativeHeatmapCell]`: the values. A `NativeHeatmapCell` has `row: Int`, `column: Int` (zero-based indexes into `rows` and `columns`) and `value: Double`, created with `NativeHeatmapCell(row:column:value:)`.

```swift
NativeMatrixHeatmap(
    rows: ["Mon", "Tue"],
    columns: (0..<24).map { String(format: "%02d", $0) },
    cells: [
        NativeHeatmapCell(row: 0, column: 9, value: 120),
        NativeHeatmapCell(row: 1, column: 14, value: 80),
    ]
)
```

#### `NativeCategoryChart`

A horizontal bar chart with one bar per category and the value written at the end of each bar. The chart height follows the number of bars. Sort the values before you pass them if you want a ranking.

- `values: [NativeCategoryValue]`: the bars. A `NativeCategoryValue` has `label: String` (also its identity, so labels must be unique) and `value: Double`, created with `NativeCategoryValue(label:value:)`.

```swift
NativeCategoryChart(values: [
    NativeCategoryValue(label: "Space", value: 940),
    NativeCategoryValue(label: "E", value: 610),
])
```

#### `NativeChartSampling`

The static helpers that `NativeTimeSeriesChart` uses. Call them when you prepare data for the chart or build a similar view.

- `static func bins(points: [NativeTimePoint], start: Date, end: Date, step: TimeInterval, calendar: Calendar = .current) -> [NativeTimePoint]`: sums sorted `points` into bins of `step` seconds between `start` and `end`, with zero-value bins for gaps. A `step` of 86400 uses calendar days and stops after 1201 days. For any other `step`, a very long range widens the bins so that about 1200 remain. It returns an empty array for no points, `end <= start` or `step <= 0`.
- `static func valueText(_ value: Double, locale: Locale = .current) -> String`: formats a value with at most one decimal, so 0.8 stays 0.8 and a whole number prints without a decimal.
- `static func clampedPosition(_ position: Date, window: TimeInterval, domain: ClosedRange<Date>) -> Date`: the left edge of a `window`-wide view, moved so that the view stays inside `domain`.
- `static func pannedPosition(origin: Date, translation: Double, width: Double, window: TimeInterval, domain: ClosedRange<Date>) -> Date`: the new left edge after a horizontal drag of `translation` points across a plot `width` points wide, clamped to `domain`.
- `static func axisLabelFormat(interval: TimeInterval, window: TimeInterval) -> Date.FormatStyle`: the x-axis label format. It shows the date for daily bins, date and time for smaller bins in a window wider than one day, and the time otherwise.

```swift
let hourly = NativeChartSampling.bins(
    points: points,
    start: weekAgo,
    end: now,
    step: 3600
)
let total = hourly.reduce(0) { $0 + $1.value }
let summary = NativeChartSampling.valueText(total)
```

#### `ChartPalette`

The colours the hand-drawn charts use: ten hues of similar weight for the dark background (blue, teal, amber, rose, violet, green, orange, sky, pink, lime), a quiet grey for "other" and unaccounted space, and the health ramp.

- `static let categorical: [Color]`: the ten hues, in order.
- `static let muted: Color`: the grey.
- `static func color(_ index: Int) -> Color`: hue `index`, wrapping past the end.
- `static func ramp(_ value: Double) -> Color`: red at 0, amber through the middle third, green from about 0.85 (the `HealthBar` colour).

```swift
let slices = categories.enumerated().map { index, category in
    DonutSegment(id: category.id, value: category.bytes, color: ChartPalette.color(index), label: category.name)
}
```

#### `ChartNode`

One node of the hierarchy a `SunburstChart` or a `TreemapView` draws (a folder and its subfolders). A node is drawn at its `value` or at its children's sum, whichever is larger; space a node has beyond its children stays empty in the next ring (sunburst) or becomes a grey cell (treemap), so a gap means "here, but not in a child".

- `id: String`: unique in the tree; the focus binding and the callbacks use it.
- `name: String`: the label.
- `value: Double`: the node's own size. A node's drawn size is the larger of its value and its positive children's sum, so a folder of value 0 with files in it is kept; a node whose drawn size is zero or less is left out with its subtree.
- `children: [ChartNode] = []`
- `muted: Bool = false`: drawn grey whatever its branch (files, unaccounted space).
- `color: ChartColor? = nil`: replaces the branch's hue (colour by age or type). `ChartColor(red:green:blue:)` holds sRGB numbers, so a node stays `Sendable` and `Equatable`.

The tree is flattened once into a `ChartPartition` (each node's span of the root, depth, parent, children, top-level branch and rank among its siblings; children ordered by size, ties by id), in one pass over the tree. The charts cache it until the tree changes, so pass the same tree value on every render. `ChartPartition` is `Sendable` and `Equatable`: a host with a large tree can build it off the main thread once and pass it to both charts through their `partition:` initializers, so switching views never rebuilds it.

```swift
let root = ChartNode(id: "/", name: "Macintosh HD", value: 0, children: [
    ChartNode(id: "/Users", name: "Users", value: 322e9),
    ChartNode(id: "/private", name: "Unaccounted", value: 12e9, muted: true),
])
```

#### `SunburstChart`

A sunburst of a `ChartNode` tree, DaisyDisk's space map: the focused node is the centre disc, its children the first ring, their children the next, up to `maxDepth` rings. Each top-level branch has its own hue; siblings turn it a little, and each ring is lighter and calmer. Arcs too thin to see, and the children past the `maxArcs` largest, fold into one translucent "N smaller items" arc per parent. Arcs are separated by real one-point gaps, cut out of the drawing. Labels sit along an arc, or across a deep narrow one, only where they fit, turned so they never read upside down.

The pointer lights an arc and its ancestors (the rest dims) and shows its name, size, share of the centre and "Click to open" in a card beside it. A click on an arc calls `onSelect` and, when the node has children, makes it the centre; a click on the centre goes up one level. Every focus change moves all arcs to their new place in one 0.55 s transition on the `GenMotion` curve, at once under Reduce Motion; a drill or new data clears the hover card. The arcs redraw only when the data, the focus, the size or the hover change, not when the host's view updates for another reason. The first ring is exposed to VoiceOver as buttons with their size as value, and the centre's back button stays its own element.

- `root: ChartNode`: the tree. Or `partition: ChartPartition`: one the host built (same options).
- `focus: Binding<String?>`: the id of the centre node; nil is the root. The chart writes it on a drill or a back click.
- `maxDepth: Int = 4`: rings around the centre.
- `maxArcs: Int = 14`: the most children one parent shows as their own arcs.
- `identifier: String = "sunburst"`: the chart's accessibility identifier; the centre button is `<identifier>.center`.
- `valueText: (Double) -> String = { "%.0f" }`: a node's size as text.
- `onHover: ((String?) -> Void)? = nil`: the node under the pointer (nil off the chart or over a folded arc).
- `onSelect: ((String) -> Void)? = nil`: a clicked node.

```swift
SunburstChart(
    root: model.tree, focus: $model.focus, maxDepth: 3, identifier: "disk-explorer-chart",
    valueText: { ByteFormat.file(Int64($0)) },
    onHover: { model.hovered = $0 },
    onSelect: { model.select($0) })
    .frame(minWidth: 320, minHeight: 320)
```

#### `SunburstLayout`

The pure geometry behind `SunburstChart`, for a host that draws its own sunburst or tests one.

- `init(partition: ChartPartition, maxDepth: Int = 4, minAngle: Double = 0.012, centerFraction: Double = 0.26, maxChildren: Int = 14)`: `minAngle` is the narrowest arc in radians (on an inner ring the floor is higher, so an arc keeps about 2.5 points of its inner edge and is never all gap); `centerFraction` is the centre disc's radius over the outer radius. Folded children form runs of neighbours, so a fold never covers the arcs between two runs (ids `<parent>#smaller`, `<parent>#smaller-2`).
- `func arcs(_ viewport: SunburstViewport, radius: Double) -> [SunburstArc]`: the visible arcs. A `SunburstViewport(x0:x1:depth:)` is the focused node's span and depth (`SunburstViewport(item)` for a partition item); a viewport between two foci is a frame of the drill transition. A `SunburstArc` has the item, id, name, value, `ring` (1 next to the centre), start and end angle (radians clockwise from twelve o'clock), inner and outer radius, and `isAggregate` / `count` for a folded arc.
- `func hit(_ point: CGPoint, radius: Double, arcs: [SunburstArc]) -> Hit`: `.center`, `.arc(arc)` or `.none` for a point relative to the centre (y down).
- `static func angle(of:)`, `static func point(angle:radius:)`: the angle convention, both ways.
- `static func labelPlacement(_ arc: SunburstArc, size: CGSize, padding: Double = 4) -> SunburstLabelPlacement?`: where a label of `size` sits (centre, rotation, `.tangential` or `.radial`), or nil when it does not fit.

```swift
let layout = SunburstLayout(partition: ChartPartition(root: tree), maxDepth: 3)
let arcs = layout.arcs(SunburstViewport(layout.partition.items[0]), radius: 160)
if case .arc(let arc) = layout.hit(point, radius: 160, arcs: arcs) { print(arc.name) }
```

#### `TreemapView`

A squarified treemap of a `ChartNode` tree (GrandPerspective, WinDirStat): the focused node's children as rectangles sized by value and, with `levels` 2, each big child's own children inside it under a title strip. It shares the tree, the colours and the focus binding with `SunburstChart`, so a host can switch views of the same data. Children too small to see fold into one "N smaller items" cell; a parent's own space is a grey cell. Labels (name, then size) are drawn only where they fit and never outside their cell. The pointer outlines the cell under it and shows its name, size and share in a card; a click calls `onSelect` and drills into a node with children, with a short cross-fade (none under Reduce Motion). Cells are known by node id, so new data that shifts the tree keeps the hover on the same node and is not mistaken for a drill. The cells redraw only when the data, the focus, the size or the formatter's output change; a hover redraws only the outline.

- `root: ChartNode` (or `partition: ChartPartition`), `focus: Binding<String?>`: as for the sunburst.
- `levels: Int = 2`: 1 or 2 nesting levels.
- `shading: Shading = .cushion`: `.cushion` (a soft light-to-shade gradient with a lit top rim) or `.flat`.
- `identifier: String = "treemap"`, `valueText`, `onHover`, `onSelect`: as for the sunburst.

```swift
TreemapView(root: model.tree, focus: $model.focus, shading: model.flat ? .flat : .cushion,
            identifier: "disk-explorer-chart", valueText: { ByteFormat.file(Int64($0)) })
```

#### `SquarifiedLayout`

Squarified treemap layout (Bruls, Huizing and van Wijk, 2000): rectangles with areas proportional to the values and sides as close to square as the values allow. Values are placed largest first (ties by position), in rows along the shorter side; the same input always gives the same output, and the rectangles tile the space exactly.

- `static func layout(_ values: [Double], in rect: CGRect) -> [CGRect?]`: one rectangle per value, in input order; nil for a zero, negative or non-finite value. A value far too small next to the others (`[1e20, 1]`) can get an empty rectangle; `TreemapLayout` folds such values first.
- `static func worst(_ areas: [Double], sum: Double, side: Double) -> Double`: the row's worst aspect ratio (the paper's criterion).
- `static func aspect(_ rect: CGRect) -> Double`: a rectangle's aspect ratio, at least 1.

```swift
let rects = SquarifiedLayout.layout([6, 6, 4, 3, 2, 2, 1], in: CGRect(x: 0, y: 0, width: 600, height: 400))
```

#### `TreemapLayout`

The cells of a `TreemapView`, pure.

- `static func cells(_ partition: ChartPartition, focus: Int, in bounds: CGRect, levels: Int = 2) -> [TreemapCell]`: a `TreemapCell` has the item, its `rect`, `level`, `isGroup` (draws children under a title strip of `header` points), `isRemainder` (the parent's own space), and `folded` / `foldedValue` (small children folded together; `minimumArea` is the cut-off in square points). `isNode` is true for a cell that stands for a node.
- `static func hit(_ point: CGPoint, cells: [TreemapCell]) -> TreemapCell?`: the deepest cell under a point.

```swift
let cells = TreemapLayout.cells(ChartPartition(root: tree), focus: 0, in: CGRect(x: 0, y: 0, width: 640, height: 400))
```

#### `RingGauge`

A progress ring: a quiet track and an arc from twelve o'clock, clockwise, with round ends and a sweep from a lighter start to the full tint. Anything can sit in the middle. A change of `progress` glides on the `GenMotion` curve (at once under Reduce Motion); changes under half a percent apply without an animation, so raw values fed often cost nothing extra.

- `progress: Double`: 0...1, clamped.
- `tint: Color = .accentColor`
- `track: Color = .white.opacity(0.09)`
- `lineWidth: CGFloat = 8`
- `label: String? = nil`: what it measures, for accessibility; the value reads as a percentage.
- `identifier: String? = nil`: the gauge's accessibility identifier.
- `center: () -> Center`: the middle (`@ViewBuilder`; omit it for an empty ring).

```swift
RingGauge(progress: used / total, tint: ChartPalette.color(1), lineWidth: 10, label: "Disk used") {
    Text(verbatim: "\(Int(used / total * 100))%").font(.system(size: 20, weight: .semibold, design: .rounded))
}
.frame(width: 120, height: 120)
```

#### `SegmentedDonut`

A ring cut into slices (what fills a disk, a day's posture minutes), with thin gaps and a soft inner shade per slice. The slice under the pointer, and the selected one, lift out while the rest dim; the middle shows the focused slice. A click selects a slice, a second click clears it; a selection that names no slice (the data changed under it) selects nothing. Each slice is an accessibility child with its value and share.

- `segments: [DonutSegment]`: `DonutSegment(id:value:color:label:)`; zero or negative slices are left out.
- `lineWidth: CGFloat = 18`, `gapAngle: Angle = .degrees(1.6)`: a gap shrinks when slices are many.
- `identifier: String = "donut"`
- `selection: Binding<String?> = .constant(nil)`: the selected slice's id.
- `onHover: ((String?) -> Void)? = nil`
- `valueText: ((Double) -> String)? = nil`: a slice's value for accessibility (the convenience init passes its own).
- `center: (DonutSegment?) -> Center`: the middle for the focused slice (hovered, else selected, else nil). The convenience init takes `title: String` and `valueText: (Double) -> String` instead and shows `DonutCenterLabel` (the slice's label and value, or the title and the total).

`DonutLayout.arcs(_:gap:)` and `DonutLayout.hit(_:arcs:inner:outer:)` are the pure geometry.

```swift
SegmentedDonut(segments: slices, identifier: "disk-overview-donut", selection: $model.slice,
               title: "Used", valueText: { ByteFormat.file(Int64($0)) })
    .frame(width: 200, height: 200)
```

#### `HealthBar`

A health meter (SlouchSniper's "health 98%" row): the title in the bar's colour, a rounded bar that drains from green through amber to red (`ChartPalette.ramp`), an optional threshold marker, the percentage on the right and any accessory after it, as its own control (VoiceOver reaches a help button). A change of `value` glides (at once under Reduce Motion); changes under half a percent apply without an animation.

- `title: String = "Health"` (unlabeled)
- `value: Double`: 0...1, clamped. Or `value: Double?`: nil (nothing measured yet) draws a muted title, an empty track and "—", reads "Not measured", and still shows the accessory.
- `threshold: Double? = nil`: 0...1, marked on the track.
- `identifier: String? = nil`: the meter reads as its title with the percentage as value.
- `accessory: () -> Accessory`: optional trailing view (a help button).

```swift
HealthBar(value: model.health, threshold: 0.4, identifier: "posture-health") {
    IconButton(systemName: "questionmark.circle", tooltip: "What health measures") { model.explain() }
}
```

#### `Sparkline`

A small trend line over `[Double]`: a rounded stroke, optionally a fill fading down from it, optionally dots at the lowest (grey) and highest (tint) point. Draws nothing for no values; one value is a flat line.

- `values: [Double]`
- `tint: Color = .mint`, `lineWidth: CGFloat = 1.5`
- `fill: Bool = false`, `showsExtrema: Bool = false`
- `range: ClosedRange<Double>? = nil`: a fixed vertical scale (0...peak for counts); nil fits the values.
- `label: String? = nil`: for accessibility; the value reads the latest, lowest and highest.
- `identifier: String? = nil`
- `valueText: ((Double) -> String)? = nil`: how accessibility reads a value (bytes: `{ ByteFormat.file(Int64($0)) }`); without one, large numbers read compact ("1.2B"), never as "1.2e+09".

`SparklinePath(values:range:)` is the polyline as a `Shape`, for a host that strokes it itself (`FocusSparkline` draws through it).

```swift
Sparkline(values: card.growth, tint: ChartPalette.color(7), fill: true, showsExtrema: true, label: "Size, last 24 h")
    .frame(width: 120, height: 32)
```

### Clicky

Clicky plays a short keyboard sound for each key press, from seven built-in synthesized switches or from imported sound packs, and keeps local typing statistics. `ClickyModel` is the entry point: it holds the preferences and statistics, listens for key events through an input monitor, plays the sounds, and the host turns it on with `activate()`. `ClickyWindowController` shows the Settings window, `ClickySettingsView` embeds the same pages in a host view, and `ClickySettingsPages` gives the raw sections for a host that merges them into its own settings window. `ClickyPopoverView` is the small menu bar popover with the on/off switch, the volume and the switch list. The Stats and Performance pages are `ClickyAnalyticsView` and `ClickyPerformanceView`, and both read from the model's `ClickyAnalyticsStore`. `ClickyPreferences` and `ClickyStatistics` are the saved data types, and sound pack libraries (folders with a `registry.json`) are managed on the Sound page without a public API of their own.

#### `ClickyModel`

The main-actor observable model for the whole feature. It saves `preferences` and `statistics` into the given defaults, keeps the pause state (system sleep, quiet hours, a muted frontmost app, a snooze), and publishes the values the UI shows. Key events are read through a listen-only event tap, only key positions are used, and typed text is never read or stored. Starting a session needs the Input Monitoring permission. When it is missing, `activate()` sets `status` and `error` and shows the permission dialog.

- `defaults: UserDefaults = .standard`: where preferences, statistics and page settings are stored.
- `previewOnly: Bool = false`: for snapshots and previews. Live input stays off (`activate()` only sets an error), sound previews still work, and the model watches no system events and posts no notifications.
- `appearance: NativeSettingsAppearance? = nil`: the shared reduce-motion and reduce-transparency settings. Nil creates one on `defaults`. The model keeps `preferences.reduceMotion` and `preferences.reduceTransparency` in step with it.
- `inputMonitor: (any ClickyInputMonitoring)? = nil`: the source of key events. Nil uses the system event tap.
- `observeSystemEvents: Bool = true`: when false, the model does not watch app activation, sleep and wake, app termination or the notification permission.
- `notificationClient: NativeNotificationClient? = nil`: nil uses the system notification center.
- `presentPermission: (@MainActor (PermissionNeed) -> Void)? = nil`: how a permission request is shown. Nil uses `PermissionCenter.shared.require`.

Properties:

- `preferences: ClickyPreferences`: the settings. It is published and settable, and every change is saved and applied.
- `appearance: NativeSettingsAppearance`: the appearance object the model uses.
- `enabled: Bool`: whether Clicky is listening (read-only).
- `status: String`: a one-line state, such as "Clicky is off", "Listening for key presses", "Taking a break", "Quiet hours" or "Muted for this application" (read-only).
- `error: String?`: the last error message to show, or nil (read-only; clear it with `dismissError()`).
- `isPaused: Bool`: true during system sleep, quiet hours, a snooze, or while a muted app is in front.
- `sleepingUntil: Date?`: when a snooze ends, or nil.
- `hasInputPermission: Bool`: whether Input Monitoring is allowed.
- `statistics: ClickyStatistics`: the current statistics (read-only).
- `statisticsLoadError: String?`: set when the saved history could not be decoded. Collection is then paused until the history is restored or reset.
- `analytics: ClickyAnalyticsStore`: the store that the statistics views read.
- `selectedSoundName: String` and `selectedSoundDetail: String`: the name and a detail line (author and license for a pack, the character for a built-in switch) of the selected sound.
- `pulse: Int` and `lastPan: Float`: the keyboard visualizer inputs. `pulse` changes with each visualized sound, and `lastPan` is that sound's stereo position.
- `notificationAuthorization: UNAuthorizationStatus`, `notificationBusy: Bool`: the notification permission state and whether a request is running.
- `notificationStatus: String`, `notificationActionTitle: String`, `notificationHelp: String`: ready-made texts for a notification settings row.
- `applicationName: String` and `version: String`: the app's display name and short version, read from the main bundle.
- `stateDidChange: (() -> Void)?`: called when the status or the enabled state changes. A menu bar item uses it to refresh its tooltip.

Methods:

- `func activate()`: starts listening. It counts a session when statistics are on and readable, and posts an "enabled" notification when `preferences.notifications` is on.
- `func deactivate()`: stops listening, stops the audio and saves the statistics.
- `func shutdown()`: deactivates and removes the observers and timers. It also runs when the app terminates, unless `observeSystemEvents` is false or `previewOnly` is true.
- `func selectBuiltIn(_ profile: ClickySwitch)`: selects a built-in switch and clears any selected sound pack.
- `func preview(_ profile: ClickySwitch? = nil, release: Bool = false, position: Float = 0)`: plays one sound. Nil `profile` plays the selected sound. `position` is the stereo position.
- `func previewStroke(_ profile: ClickySwitch? = nil, position: Float = 0)`: plays a press, then about 85 ms later a release (when release sounds are on or `profile` is nil).
- `func snooze(minutes: Int)` and `func resume()`: pause Clicky for a time, or end the pause.
- `func dismissError()`: clears `error`.
- `func retryStatisticsLoad()`: tries to read the saved history again.
- `func resetStatistics()`: starts a new history. If the old history was unreadable, a numbered recovery copy of it stays in the defaults.
- `func setActivationNotifications(_ enabled: Bool)`: sets `preferences.notifications` and asks for permission if it was never requested.
- `func requestNotifications()`, `func performNotificationAction() async` and `func refreshNotificationPermission() async`: ask for notification permission or open its System Settings page, and read the current permission.
- `func openInputSettings()`: shows the permission dialog while Input Monitoring is missing, and opens its System Settings pane once it is allowed.
- `func excludeApplication()`: opens a panel to pick an app from `/Applications` and adds its bundle id to `preferences.excludedApplications`.

```swift
let clicky = ClickyModel()
clicky.stateDidChange = { statusItem.button?.toolTip = "Clicky: \(clicky.status)" }
clicky.activate()
clicky.previewStroke(.violet)
```

#### `ClickyWindowController`

Owns the Clicky Settings window, built from `ClickySettingsPages.sections(model:)` on a `FeatureSettingsWindowController`. Use it when the host opens Clicky settings in its own window.

- `model: ClickyModel`: the model the pages edit (passed to `init(model:)`).
- `settings: FeatureSettingsWindowController`: the underlying settings controller.
- `window: NSWindow?`: the window once it exists.

Methods:

- `func show(pageID: String? = nil)`: opens the window, on a page if given, and activates the app.
- `func prepare(page: ClickyPage = .sound) -> NSWindow`: builds the window on a page without showing it.
- `func prepare(pageID: String? = nil) -> NSWindow`: the same, by page id. A snapshot run uses it to order the window in invisibly.
- `func register(section: NativeSettingsSection) -> Bool`: adds a settings section to the window, or replaces the section with the same id. It returns false when the resulting catalog is invalid.
- `func close()`: closes the window.

```swift
let controller = ClickyWindowController(model: clicky)
controller.register(section: extraSection)
controller.show(pageID: ClickySettingsPages.pageID(.stats))
if controller.window?.isVisible == true { controller.close() }
```

#### `ClickyPopoverView`

The menu bar popover: the Clicky on/off toggle, the status line and any error, a volume slider, the seven built-in switches (a click selects one and plays a preview), the version, and the "Clicky settings…" and "Quit Clicky" buttons. It is 265 points wide and uses the dark color scheme.

- `model: ClickyModel`: the model to show and control.
- `showSettings: () -> Void`: called by "Clicky settings…".
- `quit: () -> Void`: called by "Quit Clicky".

```swift
NSHostingController(rootView: ClickyPopoverView(
    model: clicky,
    showSettings: { controller.show() },
    quit: { NSApp.terminate(nil) }
))
```

#### `ClickySettingsView`

The Clicky settings as a view you embed yourself: the full sidebar and page layout, without a window. It builds its own settings store from `ClickySettingsPages.sections(model:)`.

- `model: ClickyModel`: the model the pages edit.
- `page: ClickyPage = .sound`: the page that is selected first.

```swift
.sheet(isPresented: $showClicky) {
    ClickySettingsView(model: clicky, page: .stats)
        .frame(minWidth: 860, minHeight: 650)
}
```

#### `ClickySettingsPages`

Builds the settings sections for Clicky, and names the page ids. Use it to put the Clicky pages into a settings window that the host owns.

- `static func section(model: ClickyModel) -> NativeSettingsSection`: the "clicky" section alone, for a window other parts add pages to (a `FeatureSettingsPlugin` registers it). `aboutInfo` is the line Clicky adds to the About page.
- `static func sections(model: ClickyModel) -> [NativeSettingsSection]`: three sections, for a window of Clicky's own. "general" holds the shared General page (order 0). "clicky" holds Sound, Sleep, Notifications, Stats, Performance and Visualizer (order 10). "about" holds the About page (order 90).
- `static func pageID(_ page: ClickyPage) -> String`: the page id. `general` gives "general", `about` gives "about", and the others give "clicky." plus the lowercased name, such as "clicky.stats".

```swift
let sections = ClickySettingsPages.sections(model: clicky)
let window = FeatureSettingsWindowController(title: "Clicky", sections: sections)
let statsPageID = ClickySettingsPages.pageID(.stats)   // "clicky.stats"
window.show(pageID: statsPageID)
```

#### `ClickyPage`

The Clicky settings pages. It is the page argument of `ClickySettingsView` and `ClickyWindowController.prepare(page:)`, and the input of `ClickySettingsPages.pageID(_:)`. The raw value is the page title.

- `general`: "General". The shared GenesisTools appearance and accessibility page.
- `sound`: "Sound". The on/off switch, input permission note, volume, the switch list, sound libraries and sound behavior options.
- `sleep`: "Sleep". A snooze, quiet hours and muted applications.
- `visualizer`: "Visualizer". A keyboard light show for each sound.
- `notifications`: "Notifications". The activation notification and its permission.
- `stats`: "Stats". `ClickyAnalyticsView` and the privacy options.
- `performance`: "Performance". `ClickyPerformanceView`.
- `about`: "About".

```swift
let page = ClickyPage.sleep
let id = ClickySettingsPages.pageID(page)
controller.show(pageID: id)
let embedded = ClickySettingsView(model: clicky, page: page)
```

#### `ClickySwitch`

The seven built-in synthesized switch sounds. No recordings are bundled.

- `basalt`: deep, firm and resonant.
- `violet`: bright, crisp and tactile.
- `pebble`: rounded, hollow and playful.
- `paper`: dry, soft and textured.
- `honey`: warm, smooth and mellow.
- `ember`: sharp, light and quick.
- `cloud`: gentle, muted and airy.
- `var name: String`: the capitalized case name.
- `var detail: String`: the short description shown in the lists.

```swift
clicky.selectBuiltIn(.honey)
clicky.previewStroke(.honey)
let label = "\(ClickySwitch.honey.name): \(ClickySwitch.honey.detail)"
```

#### `ClickyPreferences`

The saved settings value, stored as JSON in the model's defaults. All members have defaults, and `init()` creates the default set.

- `selectedSwitch: ClickySwitch = .basalt`: the built-in switch.
- `selectedPack: ClickyPackReference?`: the selected sound pack, or nil for a built-in switch. A `ClickyPackReference` has `libraryID: String` and `packID: String`, created with `ClickyPackReference(libraryID:packID:)`.
- `volume: Double = 0.45`: 0 to 1.
- `releaseSounds = true`: play a sound when a key comes back up.
- `randomizedPitch = true`: vary the pitch a little between presses.
- `spatialAudio = true`: pan sounds left and right with the key position.
- `repeatSounds = false`: play sounds for held-key repeats.
- `quietHours = false`: pause on a daily schedule.
- `quietStart = 22 * 60` and `quietEnd = 8 * 60`: the schedule, in minutes after midnight (0 to 1439). Equal values turn the schedule off.
- `excludedApplications: [String] = []`: bundle ids of apps that mute Clicky while in front.
- `visualizer = true`: light the keyboard in the visualizer.
- `notifications = false`: post a notification when Clicky is enabled.
- `collectStats = true`: record local statistics.
- `reduceMotion = false` and `reduceTransparency = false`: mirrors of the shared appearance settings.

Methods:

- `mutating func normalize()`: clamps `volume` and the quiet times, and removes empty and duplicate entries from `excludedApplications`.
- `func isQuiet(at date: Date, calendar: Calendar = .current) -> Bool`: whether the quiet hours include `date`. It is false while `quietHours` is off. An overnight span such as 22:00 to 08:00 works.
- `func nextQuietBoundary(after date: Date, calendar: Calendar = .current) -> Date?`: the next start or end of the quiet hours, or nil when the schedule is off.
- `static func clockTime(minute: Int, on date: Date = Date(), calendar: Calendar = .current) -> Date`: a `Date` at that minute of the day, on the day of `date`.

```swift
clicky.preferences.volume = 0.6
clicky.preferences.quietHours = true
clicky.preferences.quietStart = 23 * 60
```

#### `ClickyStatistics`

The local typing counters, saved as JSON in the model's defaults. They hold counts by time and by physical key code, never text or key sequences. Decoding fills any missing field with its default. Old buckets are dropped when new ones are recorded: minutes after 30 days, hours after about a year and days after two years.

- `presses: Int = 0`, `releases: Int = 0`, `sessions: Int = 0`: lifetime totals. A session is one activation.
- `startedAt: Date = Date()`: when counting began.
- `historyStartedAt: Date?`: when detailed history began. Nil means no detailed history yet.
- `minutes: [Int: ClickyActivityBucket]`: buckets keyed by minutes since 1970.
- `hours: [Int: ClickyActivityBucket]`: buckets keyed by hours since 1970.
- `days: [Int: ClickyActivityBucket]`: buckets keyed by the Unix time of the start of the local day.
- `keys: [Int: Int]`: press counts keyed by macOS key code.
- `performanceMinutes: [Int: ClickyPerformanceBucket]`: typing-pace buckets keyed by minutes since 1970 (30 days kept).
- `performanceStartedAt: Date?`: when timing began.

A `ClickyActivityBucket` has `presses: Int` and `releases: Int`. A `ClickyPerformanceBucket` has `presses`, `characters`, `corrections`, `bursts` (all `Int`), `activeSeconds: Double` and `carriedBurst: Bool`.

Methods:

- `mutating func record(keyCode: UInt16, release: Bool, at date: Date = Date(), calendar: Calendar = .current, shortcut: Bool = false)`: adds one key event to the totals and the minute, hour and day buckets. A press also adds to `keys` and the typing-pace buckets. `shortcut: true` marks a Command or Control shortcut, which adds no words.
- `mutating func breakTypingBurst()`: ends the current typing burst, so a pause is not counted as typing time.

```swift
var stats = ClickyStatistics()
stats.record(keyCode: 0, release: false)
let aPresses = stats.keys[0, default: 0]   // key code 0 is the A key
```

#### `ClickyAnalyticsStore`

The published copy of the statistics that the Stats and Performance views read. The model owns one (`ClickyModel.analytics`), and a host does not create its own. A snapshot is published only while at least one viewer is attached, and then at most about once a second while typing. This avoids copying the whole history on every key event.

- `snapshot: ClickyStatistics`: the latest published statistics (read-only).
- `revision: UInt64`: a counter that changes with each published snapshot (read-only).
- `func attach()`: registers a viewer. The first viewer gets the current statistics at once.
- `func detach()`: removes a viewer.

```swift
let store = clicky.analytics
store.attach()
let presses = store.snapshot.presses
store.detach()
```

#### `ClickyAnalyticsView`

The Stats page content. It shows summary cards (presses today, active minutes today, peak presses in a minute), a segmented control for three tabs, and a line with the lifetime totals. It attaches to the store while it is on screen. A button switches to generated sample data that is never saved. Before any detailed history exists it shows a note instead of the tabs.

- Activity: a `NativeTimeSeriesChart` of presses or releases, by minute, hour or day.
- Keys: a physical keyboard heat map with a per-key count, and a chart of the most-used keys.
- Rhythm: a weekday-by-hour heat map, a day-by-day chart and the weekday distribution.

Parameters:

- `store: ClickyAnalyticsStore`: the store to read, usually `model.analytics`.

```swift
ScrollView {
    ClickyAnalyticsView(store: clicky.analytics)
        .padding(24)
}
```

#### `ClickyPerformanceView`

The Performance page content: typing-pace estimates from the timing buckets. Filters set a date range (Today, 7 days, 30 days or Custom), the timeline grouping, the weekdays and the hour range. The page shows presses, estimated words, active typing time, pace in words per minute, correction share and average burst length. It also has a timeline chart, a pace chart by time of day or weekday, a what-if comparison with dictation, and a few light "just for fun" cards. Words are estimated at 5 text-like presses each, and a pause longer than 5 seconds stops the clock. It has the same sample data button as `ClickyAnalyticsView`.

- `store: ClickyAnalyticsStore`: the store to read, usually `model.analytics`.
- `defaults: UserDefaults`: where the dictation what-if settings are kept: spoken words per minute (default 140, key `clicky.performance.spokenWPM`) and setup seconds per typing burst (default 3, key `clicky.performance.setupSeconds`).

```swift
ScrollView {
    ClickyPerformanceView(store: clicky.analytics, defaults: appDefaults)
        .padding(24)
}
```

#### `ClickyInputMonitoring`

The protocol for the source of key events. The model uses the system listen-only event tap by default. Pass another conformance to `ClickyModel(inputMonitor:)` in tests and previews. All requirements are main-actor, and none has a default implementation.

- `var hasPermission: Bool { get }`: whether Input Monitoring is allowed. Asking for it is the permission dialog's job, not this type's.
- `func start(handler: @escaping @MainActor (CGEventType, CGEvent) -> Void) -> ClickyInputStartResult`: starts delivering events to `handler`.
- `func reenable()`: turns a running tap back on after macOS disabled it for a slow callback.
- `func stop()`: stops delivering events.

`ClickyInputStartResult` is the result of `start`:

- `started`: events are flowing.
- `permissionRequired`: Input Monitoring is not allowed.
- `unavailable`: the event source could not be created.

```swift
@MainActor
final class FakeMonitor: ClickyInputMonitoring {
    var hasPermission = true
    func start(handler: @escaping @MainActor (CGEventType, CGEvent) -> Void) -> ClickyInputStartResult { .started }
    func reenable() {}
    func stop() {}
}
let model = ClickyModel(defaults: testDefaults, inputMonitor: FakeMonitor(), observeSystemEvents: false)
```

### Cmux

Views and models for choosing where to open something in cmux, the terminal multiplexer. The host loads the live layout with `tools ai cmux tree --json` and decodes it into a `CmuxTree`. `CmuxTargetPicker` shows that tree as a list or as the real pane layout and reports the choice as a `CmuxTarget`. `CmuxSessionPanel` is the ready-made "cmux" block for a session sidebar, with Focus, Open in last pane and Choose a pane. The host runs the actions itself and reports how they went.

#### `CmuxSessionPanel`

The "cmux" block of a session's sidebar. It shows where the session last ran (window, workspace, pane and tab as small labeled values), the actions Focus, Open in last pane and Choose a pane, and the target picker under them when the user is choosing. The whole panel is disabled while `busy` is true.

- `sessionId: String`: the session this panel is for.
- `window: String?`: the journalled window ref, for example "window:1".
- `workspace: String?`: the workspace ref.
- `pane: String?`: the pane ref.
- `surface: String?`: the tab (surface) ref. Empty and nil refs are left out of the display.
- `tree: CmuxTree?`: the loaded layout, or nil while it is not loaded.
- `loading: Bool`: shows a spinner in the picker.
- `busy: Bool`: disables the panel while the host runs an action.
- `lastPane: CmuxTarget?`: the target for "Open in last pane". The button is hidden when it is nil. `CmuxTarget.lastPane(workspace:pane:surface:)` builds it from the journalled refs.
- `choosing: Binding<Bool>`: whether the target picker is open.
- `notice: Binding<Notice?>`: a status line under the actions. Setting it to nil clears it.
- `modeKey: String = CmuxTargetPicker.defaultModeKey`: the defaults key that stores the picker's Tree or Layout choice.
- `modeStore: UserDefaults = .standard`: the defaults store for that key.
- `focus: (() -> Void)?`: runs Focus. Focus is hidden when this is nil, and also when the loaded tree has no tab for the session.
- `open: (CmuxTarget) -> Void`: runs when the user picks a target, or taps Open in last pane.
- `reload: () -> Void`: reloads the layout.

`CmuxSessionPanel.Notice` is the status value: `text: String` and `isError: Bool`, created with `Notice(text:isError:)`.

The static helper `CmuxSessionPanel.refs(window:workspace:pane:surface:) -> [(label: String, value: String)]` turns refs into the displayed pairs. The labels are fixed: "window", "workspace", "pane" and "tab" (for `surface`). The value is the text after the last colon, so "window:1" becomes ("window", "1"). A ref with no colon stays whole and empty refs are dropped.

```swift
CmuxSessionPanel(
    sessionId: session.id, window: "window:1", workspace: "workspace:3", pane: "pane:5", surface: "surface:9",
    tree: tree, loading: loading, busy: busy,
    lastPane: CmuxTarget.lastPane(workspace: "workspace:3", pane: "pane:5", surface: nil),
    choosing: $choosing, notice: $notice,
    focus: { raiseTab(for: session.id) }, open: { target in resume(session, at: target) }, reload: { loadTree() }
)
```

#### `CmuxTargetPicker`

A picker for where to open something in cmux. It has a Tree and a Layout mode (a segmented control, plus a button that opens the layout in a large popover) and a reload button. `selection` only marks the chosen target. A click always calls `onPick`, so the host decides whether to open the target at once or keep it as a choice that a launch sheet confirms. When the tree says cmux is unavailable it shows the error text instead.

- `tree: CmuxTree?`: the loaded layout. Nil shows "Loading the cmux layout…" or "No cmux layout yet".
- `loading: Bool`: shows a spinner.
- `selection: CmuxTarget? = nil`: the target to mark as chosen.
- `highlightSession: String? = nil`: a session id whose tab is highlighted as "this session".
- `modeKey: String = CmuxTargetPicker.defaultModeKey`: the defaults key for the Tree or Layout choice. The default key is `"cmux.picker.mode"` (static `defaultModeKey`), so every picker that uses it shares the choice.
- `modeStore: UserDefaults = .standard`: the defaults store for that key.
- `reload: () -> Void`: called by the reload button.
- `onPick: (CmuxTarget) -> Void`: called with the clicked target.

```swift
CmuxTargetPicker(tree: tree, loading: loading, selection: target, reload: { loadTree() }) { picked in
    target = picked
}
```

#### `CmuxTreeList`

The Tree mode of the picker on its own: windows, workspaces, panes and tabs as indented rows. Each row says what a click creates ("new workspace", "new pane", "new tab", "type here"). Use it when you want only the list, without the mode switch and toolbar.

- `tree: CmuxTree?`: the layout to list. Nil draws nothing.
- `selection: CmuxTarget? = nil`: the target to mark as chosen.
- `highlightSession: String? = nil`: a session id whose tab is marked "this session".
- `onPick: (CmuxTarget) -> Void`: called with the clicked target.

```swift
CmuxTreeList(
    tree: tree,
    selection: target,
    highlightSession: session.id
) { picked in
    target = picked
}
```

#### `CmuxLayoutView`

The Layout mode of the picker on its own. It draws each workspace as cmux lays it out: pane rectangles from their frames, with the tabs on top. Click a pane's plus button for a new tab, a tab to type into it, a workspace title for a new pane and a window title for a new workspace. The drawing uses the width it is given, so it fits a narrow sidebar and a large popover.

- `tree: CmuxTree?`: the layout to draw.
- `selection: CmuxTarget? = nil`: the target to mark as chosen.
- `highlightSession: String? = nil`: a session id whose tab is highlighted.
- `onPick: (CmuxTarget) -> Void`: called with the clicked target.

```swift
CmuxLayoutView(
    tree: tree,
    selection: target,
    highlightSession: session.id
) { picked in
    open(picked)
}
```

#### `CmuxTarget`

Where to open something in cmux. The level you pick decides what gets created.

- `newWorkspace(window: String?)`: a new workspace in that window, or in the current one when nil.
- `newPane(workspace: String)`: a new pane (a split) in a workspace.
- `newTab(workspace: String, pane: String)`: a new tab in a pane.
- `surface(workspace: String, surface: String)`: type into an existing tab.
- `var label: String`: a sentence for the target, such as "a new tab in pane:5 (workspace:3)".
- `var openSessionArgs: [String]?`: the flags that `tools claude cmux open-session` takes for this target. It is nil for a new workspace in the current window, which that command cannot name.
- `static func lastPane(workspace: String?, pane: String?, surface: String?) -> CmuxTarget?`: the target for "where a session last ran", from its journalled refs. It is nil without a workspace ref. Otherwise it gives a new tab in the pane when a pane ref exists, else the existing tab, else nil. Empty strings count as missing.

```swift
let target = CmuxTarget.newTab(workspace: "workspace:3", pane: "pane:5")
let flags = target.openSessionArgs   // ["--workspace", "workspace:3", "--pane", "pane:5"]
let sentence = "Resume in \(target.label)"
let last = CmuxTarget.lastPane(workspace: "workspace:3", pane: nil, surface: "surface:9")
```

#### `CmuxTree`

The live cmux layout as decoded from `tools ai cmux tree --json`: windows, their workspaces, each workspace's panes and each pane's tabs (surfaces). A tab carries the agent session it runs when the hook journal knows it. Every field except the ids decodes with a default, so output from an older `tools` still gives a tree.

- `fetchedAt: String = ""`: when the tree was read.
- `available: Bool = false`: false when cmux could not be read.
- `error: String? = nil`: why the tree is empty, when `available` is false.
- `windows: [Window] = []`: the windows.
- `totalMs: Double = 0`: how long the read took.

The nested value types, each with a public `init`. Every field except the id has a default, except in `Frame` and `Size`:

- `Window`: `id: String`, `ref: String?` (for example "window:1"), `index: Int`, `key: Bool` (the front window), `workspaces: [Workspace]`. Its `label` is `ref`, or "window N" with N equal to `index + 1`. Its `target` is `ref` or `id`.
- `Workspace`: `id: String`, `name: String`, `panes: [Pane]`.
- `Pane`: `id: String`, `title: String`, `active: Bool`, `cwd: String?`, `frame: Frame?` (where cmux draws the pane), `container: Size?`, `selectedSurfaceId: String?`, `surfaces: [Surface]`.
- `Surface` (a tab): `id: String`, `title: String`, `type: String` (default "terminal"), `index: Int`, `selected: Bool`, `active: Bool`, `sessionId: String?`, `provider: String?` ("claude", "codex" or "grok"), `sessionHint: String?` (the first 8 characters of a session id). `holds(_ sessionId: String) -> Bool` tells whether the tab runs that session.
- `Frame`: `x`, `y`, `width`, `height` (all `Double`). `Size`: `width`, `height`.

Methods and properties:

- `static func decode(_ data: Data) throws -> CmuxTree`: decodes the command's stdout. Text printed before the JSON (a profiler line, a warning) is skipped. The object starts at the first `{` at the beginning of a line.
- `func surface(of sessionId: String) -> (window: Window, workspace: Workspace, pane: Pane, surface: Surface)?`: the tab a session runs in, if the journal places it in one.
- `func hostsSession(_ sessionId: String) -> Bool`: true when the session, given as a full id, has a tab in the live tree.
- `var liveSessionKeys: Set<String>`: every session id and 8-character hint in the tree, lowercased.

```swift
let tree = try CmuxTree.decode(commandOutput)
if let found = tree.surface(of: sessionId) {
    print(found.workspace.name, found.pane.id, found.surface.title)
}
let isLive = tree.hostsSession(sessionId)
```

### Controls

The small reusable pieces of the interface: buttons, menus, chips and badges, avatars, status lines, loading placeholders, animated indicators and scroll helpers. They share one look (the `KitPalette` colors, instant tooltips and the hover button styles), so a host gets the same controls in every window. `IconButton`, `Badge`, `EmptyState` and `InfoStrip` cover most screens. The animated indicators (`PulsingDots`, `SpinningArc`, the skeleton shimmer) run as Core Animation layers, so the app does no per-frame work while they show.

#### `IconButton`

An icon-only button. It always carries an instant tooltip, and the tooltip is also the name VoiceOver and UI automation read. Use it for every button that has no text.

- `systemName: String`: the SF Symbol name.
- `tooltip: String`: the tooltip and the accessibility label.
- `size: CGFloat = 12`: the symbol's point size. The symbol sits in a 16 by 16 point frame, and the hover style adds 3 points of padding around it.
- `tint: Color? = nil`: colors the symbol.
- `accent: Color? = nil`: colors the hover disc. The default is the kit's amber (`KitTheme.accent`).
- `action: () -> Void`: runs on click.

```swift
IconButton(
    systemName: "gearshape",
    tooltip: "Settings",
    size: 13,
    tint: .secondary,
    accent: KitPalette.renamed
) { openSettings() }
```

#### `GhostButton`

A text action with an icon in a hairline outline and no fill, such as "Open in last pane". With `fullWidth` it stretches across its column, one action per row, for a narrow sidebar where side-by-side buttons squeezed each other's titles.

- `title: String`: the button text (the first, unlabeled parameter).
- `symbol: String`: the leading SF Symbol.
- `tooltip: String`: the instant tooltip.
- `trailingSymbol: String? = nil`: an optional symbol after the title.
- `fullWidth: Bool = false`: stretches the button across its column and left-aligns the content.
- `height: CGFloat = 26`: the button height.
- `identifier: String? = nil`: the accessibility identifier.
- `action: () -> Void`: runs on click.

```swift
GhostButton("Choose a pane...", symbol: "rectangle.split.2x1", tooltip: "Pick the pane to use", fullWidth: true) {
    choosePane()
}
```

#### `MenuButton`

A menu button that SwiftUI draws itself. The AppKit menu exists only while it is open, so a crowded row with many of them (or a `ViewThatFits` that measures them) does not build pop-up buttons again on every layout. The label is plain SwiftUI and truncates like any other view. `items` runs at the click, so the menu shows the state of that moment. The type is generic over the label view and a `ButtonStyle`.

- `style: Style`: the button style, always a drawn one (for example `.genHoverIcon()`).
- `items: () -> [MenuButtonItem]`: builds the menu entries at the click.
- `label: () -> Label`: the button content (a `@ViewBuilder`).

A second `init(items:label:)` exists for `Style == GenHoverButtonStyle` and uses `.genHoverPlain()`.

`MenuButtonItem` cases:

- `action(String, checked: Bool = false, enabled: Bool = true, run: () -> Void)`: a pickable entry; `checked` draws a check mark.
- `submenu(String, [MenuButtonItem])`: an entry that opens a nested menu.
- `note(String)`: a line of text that cannot be picked ("No commits ahead of the base").
- `divider`: a separator.

```swift
MenuButton(items: {
    [
        .action("Refresh", run: { model.refresh() }),
        .action("Show merged", checked: showMerged, run: { showMerged.toggle() }),
        .divider,
        .note("Updated a minute ago"),
    ]
}) {
    Label("Options", systemImage: "ellipsis.circle")
}
```

#### `MenuButtonPresenter`

The code behind `MenuButton`, for a host that wants to show the same kind of menu from its own button or gesture. It runs on the main actor.

- `menu(_ items: [MenuButtonItem]) -> NSMenu`: builds the `NSMenu`. Picks run the item's closure.
- `pop(_ items: [MenuButtonItem])`: opens the menu where the current click was; from the keyboard or VoiceOver it opens at the pointer. It does nothing without a window.

```swift
MenuButtonPresenter.pop([
    .action("Copy link", run: { Clipboard.copy(url.absoluteString, what: "link") }),
    .divider,
    .action("Delete", run: { delete() }),
])
```

#### `GenSegmentedTabs`

A segmented choice that looks the same in every window. The native segmented `Picker` draws its selected segment in the accent color only while its window is key, so panels that are not key showed it gray. Here the selected segment always has the accent fill. Each segment is a real button with a hover fill (in the window's ink, so a light window shows it too) and the pointing-hand cursor. One pill marks the selection: a new selection slides it to the new segment and gives it that segment's width on the `GenMotion` curve, and Reduce Motion moves it at once. The titles are white exactly where the pill covers them on the way. The content the selection switches is the caller's and changes at once. The type is generic over the selection id (`ID: Hashable`).

- `label: String`: the accessibility label of the whole control (the first, unlabeled parameter).
- `items: [Item]`: the segments. `Item` is built as `Item(id, title)` and has the public properties `id: ID` and `title: String`.
- `selection: Binding<ID>`: the selected segment id.
- `minSegmentWidth: CGFloat = 72`: the least width of one segment.
- `identifier: String? = nil`: the group's accessibility identifier; each segment is then `<identifier>.<id>` (`GenAccessibilityID.suffix`).

```swift
GenSegmentedTabs("Panel", items: [
    .init("top", "Top panel"),
    .init("side", "Side panel"),
], selection: $panel)
```

#### `HotkeyRecorder`

A control that records a global shortcut: click it, then press the keys. Escape cancels. A shortcut that cannot work is refused with the reason, and the recorder keeps listening. A reset button appears while the chord differs from `defaultChord`.

A shortcut registered with Carbon is swallowed system-wide, so `onListening` lets the owner of the shortcut being replaced let go of it while the recorder listens. Otherwise pressing it would run the shortcut instead of recording it.

- `chord: Binding<HotkeyChord>`: the shortcut to show and edit.
- `defaultChord: HotkeyChord? = nil`: the shortcut the reset button restores.
- `identifier: String = "hotkey-recorder"`: the accessibility identifier of the record button.
- `onListening: ((Bool) -> Void)? = nil`: told `true` when listening starts and `false` when it ends (saved, canceled, or the view went away).

```swift
HotkeyRecorder(
    chord: $chord,
    defaultChord: HotkeyChord(keyCode: 0x02, modifiers: HotkeyChord.control | HotkeyChord.option | HotkeyChord.command),
    onListening: { listening in hotkeys.isSuspended = listening }
)
```

#### `HotkeyChord`

A global shortcut as Carbon registers it: a virtual key code and a Carbon modifier mask. It is `Equatable` and `Sendable`. `HotkeyRecorder` edits a binding to one.

- `keyCode: UInt32`: the virtual key code.
- `modifiers: UInt32`: the Carbon modifier mask.
- `init(keyCode: UInt32, modifiers: UInt32)`: both values are required.

Static members:

- `command: UInt32` (`0x0100`), `shift: UInt32` (`0x0200`), `option: UInt32` (`0x0800`), `control: UInt32` (`0x1000`): the mask bits. Combine them with `|`.
- `carbonModifiers(_ flags: NSEvent.ModifierFlags) -> UInt32`: the mask for a key event's flags. Caps Lock, Fn and the keypad flag are not part of a chord.

Properties:

- `label: String`: the chord as symbols, such as `⌃⌥⌘D`.
- `problem: String?`: why the chord cannot be a global shortcut, or nil when it can. A chord needs ⌃, ⌥ or ⌘ (a function key may stand alone), and the shortcuts macOS uses are refused (⌘Q, ⌘W, ⌘H, ⌘M, ⌘Tab, ⌘Space, ⌃Space, ⌃⌘Space, ⇧⌘3, ⇧⌘4, ⇧⌘5).

```swift
let chord = HotkeyChord(
    keyCode: 0x02,
    modifiers: HotkeyChord.control | HotkeyChord.option | HotkeyChord.command
)
if let problem = chord.problem {
    print("Cannot use \(chord.label): \(problem)")
}
```

#### `Badge`

A short label in a capsule: a tag ("merged", a project name), a status ("stuck", "OPEN") or a count beside a sidebar entry. One shape for all three, so badges look alike in every app.

- `text: String`: the label (the first, unlabeled parameter).
- `color: Color = KitPalette.dim`: the text color, and the tint for `tone` and `filled`.
- `look: Look = .tag`: the style (below).
- `symbol: String? = nil`: an SF Symbol before the text.
- `monospaced: Bool = false`: sets the text in a monospaced font.
- `tooltip: String? = nil`: an instant tooltip. It also becomes part of the accessibility label.
- `findField: String? = nil`: the key a panel find lists the text under.

`Look` cases:

- `tag`: neutral. Dim text on a faint white capsule, no outline (project chips, reasons).
- `tone`: status. Colored text on a tint of the color, with a thin outline of it.
- `filled`: status without the outline (inbox kinds).

```swift
HStack(spacing: 4) {
    Badge("merged", color: KitPalette.added, look: .tone, symbol: "checkmark")
    Badge("demo-app", tooltip: "Project")
    Badge("a1b2c3d", color: KitPalette.renamed, look: .filled, monospaced: true)
}
```

#### `CountBadge`

A number in a small capsule beside a sidebar entry, such as sessions in a worktree.

- `count: Int`: the number to show (the first, unlabeled parameter).
- `tooltip: String`: the instant tooltip. It is read together with the number by VoiceOver.
- `color: Color = .primary`: the number's color.

```swift
HStack {
    Text(worktree.name)
    Spacer()
    CountBadge(sessions.count, tooltip: "Sessions in this worktree", color: KitPalette.modified)
}
```

#### `CopyChip`

A short monospaced value (the first 8 characters of a session id) that copies the full value on click. The copy toast confirms it. The chip only turns its icon into a check mark for about 1.4 s, in a fixed slot, so the text beside it never moves.

- `label: String`: the text shown.
- `value: String`: the full value that is copied.
- `tooltip: String`: the instant tooltip and accessibility label.
- `what: String? = nil`: names the value in the toast ("Copied session id").

```swift
CopyChip(
    label: String(session.id.prefix(8)),
    value: session.id,
    tooltip: "Copy the session id",
    what: "session id"
)
```

#### `ProviderBadge`

An agent's initial in its color, in a rounded square: C for Claude, X for Codex, G for Grok, otherwise the first letter of the name in the dim color. The provider name is matched case-insensitively. It works on harness names (`"claude"`, `"codex"`, `"grok"`), not on plugin ids; for those, see `AIProviderGlyph`.

- `provider: String`: the harness name.
- `size: CGFloat = 18`: the side of the square.
- `tooltip: String? = nil`: the tooltip and accessibility label. The default is the provider name.

Static member:

- `style(for provider: String) -> (letter: String, color: Color)`: the letter and color used for a provider.

```swift
HStack(spacing: 6) {
    ProviderBadge(provider: "codex", size: 20, tooltip: "Codex")
    Text(agent.title)
}
```

#### `Forge`

The forge a pull request or project lives on, with its words ("PR #436" on GitHub, "MR !7412" on GitLab). `ForgeBadge` and `ForgeMark` take one. The raw values are `github` and `gitlab`.

- `init?(kind: String?)`: reads `github` or `gitlab` as `tools` names them (`origin.kind`), ignoring case. Anything else gives nil.
- `name: String`: `GitHub` or `GitLab`.
- `label(_ number: Int) -> String`: `#436` on GitHub, `!7412` on GitLab.
- `noun: String`: `PR` or `MR`.
- `tint: Color`: the mark's own color. GitHub's is near white, GitLab's is orange.

```swift
if let forge = Forge(kind: origin.kind) {
    Text("\(forge.noun) \(forge.label(pr.number))")
}
```

#### `ForgeMark`

The forge's logo as a SwiftUI `Shape`, drawn from its 16 by 16 outline and scaled and centered in the frame it is given. Fill it with `Forge.tint` or any color.

- `forge: Forge`: the logo to draw. The initializer takes it without a label: `ForgeMark(.github)`.

```swift
ForgeMark(.gitlab)
    .fill(Forge.gitlab.tint)
    .frame(width: 14, height: 14)
```

#### `ForgeBadge`

A pill that names where a PR or MR lives: the forge mark and "GitHub #436". A click opens the page, the tooltip shows the URL, and the context menu offers Copy link and Open in the browser. Without a URL it is a plain pill.

- `forge: Forge`: the forge.
- `number: Int`: the PR or MR number.
- `url: URL?`: the page to open; nil makes the pill non-interactive.
- `open: (URL) -> Void`: how the app opens a web page (its browser router), so a click follows the same rules as every other link.

```swift
ForgeBadge(forge: .github, number: 436, url: URL(string: "https://github.com/example/demo/pull/436")) { link in
    NSWorkspace.shared.open(link)
}
```

#### `UserAvatar`

A round picture of a person on a host (a PR author, a note's author, a pusher). A fallback shows behind it until the picture loads, and stays when the picture never does. Pictures come through `UserAvatarCache`. The view is hidden from accessibility, so show the person's name beside it.

- `url: String?`: the picture's URL; nil or empty shows only the fallback.
- `name: String = ""`: the person's name; its first letter is the initial.
- `username: String = ""`: the user name. It gives the initial when `name` is empty, and it picks the tint.
- `size: CGFloat = 22`: the diameter.
- `fallback: Fallback = .initial`: what shows when there is no picture (below).
- `tint: Color? = nil`: overrides the fallback color.

`Fallback` cases:

- `initial`: the initial of `name` (or `username`) on a tint taken from `username`, unless `tint` is set.
- `person`: the `person.crop.circle.fill` glyph, for a place that shows the name beside it.

Static member:

- `tint(for username: String) -> Color`: the tint for a user name, one of six colors. It is the same on every run, so two people's avatars differ in a stable way.

```swift
HStack(spacing: 6) {
    UserAvatar(url: author.avatarUrl, name: author.name, username: author.username, size: 18)
    Text(author.name)
}
UserAvatar(url: author.avatarUrl, username: author.username, size: 16, fallback: .person)
```

#### `UserAvatarCache`

The shared image cache behind `UserAvatar`. It fetches one image per URL for the whole process, off the main thread, and keeps the decoded image in memory. A URL that failed once is not asked again in this process. Only `http` and `https` URLs are fetched. Use it to preload a picture or to read one in your own view.

- `shared: UserAvatarCache` (static): the one instance.
- `cached(_ url: String) -> NSImage?`: the image already in memory. It never fetches.
- `image(_ url: String) async -> NSImage?`: the image, fetched once. nil when the URL is not an image or the host refused it. Several callers for one URL share one fetch.

```swift
if let hit = UserAvatarCache.shared.cached(url) {
    picture = hit
} else {
    picture = await UserAvatarCache.shared.image(url)
}
```

#### `View.kicker(size:weight:color:kerning:)`

A tiny uppercase monospaced label over a section or beside a value ("SESSION HISTORY", "APPROVE?"). It is the one recipe instead of repeating font, color, text case and kerning at each site.

- `size: CGFloat = 10`: the font size.
- `weight: Font.Weight = .medium`: the font weight.
- `color: Color = KitPalette.dim`: the text color.
- `kerning: CGFloat = 1.5`: the letter spacing.

```swift
VStack(alignment: .leading, spacing: 4) {
    Text("Session history").kicker()
    Text("Approve?").kicker(size: 11, color: KitPalette.modified, kerning: 1)
}
```

#### `AgentRosterRow`

One row in an agent tree or a compact session picker, built from plain values. It shows a status dot, the title, an unread count, the time of the last activity, provider and role badges, the model and account, and the tool count with the run time. The words ("247 tools", "run 1h 05m") shrink to glyphs when the row is too narrow.

- `title: String`: the agent's name.
- `provider: String`: the harness name (`claude`, `codex`, `grok`); it picks the badge color.
- `role: String`: the role badge text.
- `model: String? = nil`: the model; shown as its short family word.
- `account: String? = nil`: the account name, shown after the model.
- `status: String`: the status text. It sets the dot color (see `AgentRosterStyle`). A status of `"running"` colors the last-activity age green and, with `startedAt`, shows a live run time.
- `startedAt: Date? = nil`: when the run began. A running agent shows a live "run" time from it.
- `lastAt: Date? = nil`: the last activity. It is shown as a live brief age, and with `startedAt` it gives the "ran" time of a finished agent.
- `toolCalls: Int = 0`: the number of tool calls; hidden at 0.
- `unread: Int = 0`: unread messages, shown as a `CountBadge` when above 0.
- `selected: Bool = false`: draws the title in a heavier weight.
- `showsRunningLabel: Bool = false`: for a running agent, shows the word "running" instead of the last-activity age.

```swift
AgentRosterRow(
    title: "Review the diff", provider: "claude", role: "worker", model: "claude-opus-4", account: "work",
    status: "running", startedAt: startedAt, lastAt: Date(), toolCalls: 247, unread: 2, selected: true
)
```

#### `AgentRosterGroupLabel`

The header of a group of agent rows: the harness badge (with a green dot when the group is live), the group title, the project, the account and the sub-agent count.

- `title: String`: the group title; it wraps to two lines.
- `provider: String`: the harness name for the badge.
- `project: String? = nil`: the project name.
- `account: String? = nil`: the account name, drawn in an outlined capsule.
- `total: Int`: the number of sub-agents. At 0 it reads "no sub-agents".
- `running: Int`: how many are running; when above 0 the count line also says "N running" and turns green.
- `live: Bool`: shows the green dot on the badge.
- `lastAt: Date? = nil`: the last activity, shown as a live brief age.

```swift
AgentRosterGroupLabel(
    title: "Fix the login flow",
    provider: "codex",
    project: "demo-app",
    total: 4,
    running: 1,
    live: true,
    lastAt: Date()
)
```

#### `AgentRosterStyle`

The colors and the duration text behind the roster views. Use it to color your own status marks the same way. All members are static.

- `color(_ status: String) -> Color`: `running` and `working` are green, `idle` is blue, `failed` is red, `killed` and `waiting` are amber, and anything else is a dim white.
- `harnessColor(_ provider: String) -> Color`: `codex` is teal, `grok` is violet, anything else is orange (Claude's).
- `duration(from start: Date?, to end: Date?) -> String?`: `45s`, `4m 05s` or `2h 05m`. nil when a date is missing or the end is before the start.

```swift
HStack(spacing: 6) {
    Circle()
        .fill(AgentRosterStyle.color(agent.status))
        .frame(width: 7, height: 7)
    Text(agent.title)
        .foregroundStyle(AgentRosterStyle.harnessColor(agent.provider))
    Text(AgentRosterStyle.duration(from: agent.startedAt, to: agent.lastAt) ?? "")
}
```

#### `EmptyState`

What a list or pane shows when it has nothing: an icon, one sentence, an optional detail line and at most one action. It is centered in the space it is given. The action button appears only when both `actionTitle` and `action` are set.

- `symbol: String? = nil`: an SF Symbol shown above the text.
- `text: String`: the main sentence.
- `detail: String? = nil`: a dimmer second line.
- `actionTitle: String? = nil`: the title of the action button.
- `action: (() -> Void)? = nil`: runs when the button is clicked.

```swift
EmptyState(symbol: "tray", text: "No sessions yet", detail: "Start an agent to see it here.", actionTitle: "Start one") {
    startSession()
}
```

#### `InfoStrip`

A tinted line under a header or above a form field: an icon and one message. The whole strip is a button when there is something to do about it, and it has a close icon when it can be dismissed. Use it for a warning, an error or a note that stays until it no longer applies. A passing confirmation is a `NoticePill` instead.

- `text: String`: the message (the first, unlabeled parameter).
- `tone: Tone = .info`: the color and default icon (below).
- `symbol: String? = nil`: an SF Symbol that replaces the tone's icon.
- `action: (() -> Void)? = nil`: when set, a click on the strip runs it.
- `actionTooltip: String? = nil`: the tooltip of the clickable strip. The default is the message text.
- `dismiss: (() -> Void)? = nil`: when set, an X button calls it.

`Tone` cases:

- `info`: blue, with the `info.circle.fill` icon.
- `warning`: amber, with `exclamationmark.triangle.fill`.
- `error`: red, with `xmark.octagon.fill`.
- `success`: green, with `checkmark.circle.fill`.

```swift
InfoStrip(
    "The cache is 3 hours old.",
    tone: .warning,
    action: { refresh() },
    actionTooltip: "Refresh now",
    dismiss: { hideWarning() }
)
```

#### `NoticePill`

A status line: an icon, a message, an optional dim detail line, the ways to fix what it reports, and the full message behind "Details". A success notice without fixes calls `dismiss` six seconds after it appears (the timer restarts when `text` changes); an error, a warning, or a notice with a fix stays until the person dismisses it or it no longer applies. The text wraps rather than ending in an ellipsis, and it can be selected and copied.

- `text: String`: the message.
- `detail: String? = nil`: a dimmer second line.
- `more: String? = nil`: the full message (stderr, a stack, a path list), shown behind a "Details" disclosure.
- `tone: NoticePill.Tone`: `.success` (green check), `.warning` (amber) or `.error` (red). The older `isError: Bool` initializer maps to `.error` or `.success`.
- `fixes: [NoticeFix] = []`: one row per fix.
  - `NoticeFix.button(_ label:symbol:confirm:perform:)`: the label says what a press does ("Quit the older Genesis (pid 1234)"). With `confirm:` (a `NoticeFix.Confirmation` with the question, an optional consequence and the confirming label) the notice asks inside itself before it acts, so the question also works in a panel that never becomes key.
  - `NoticeFix.command(_ label:, _ command:)`: a command for the person's terminal; the notice shows it and copies it.
- `dismiss: (() -> Void)? = nil`: called by the close icon, and by the timer for a success notice. The host removes the pill in it.

```swift
if let notice {
    NoticePill(text: notice.text, detail: notice.detail, more: notice.stderr, tone: .warning, fixes: [
        .button("Quit the older Genesis (pid \(pid))", confirm: .init("Quit it?", confirmLabel: "Quit")) { quit(pid) },
        .command("Or from a terminal", "kill \(pid)"),
    ]) {
        self.notice = nil
    }
}
```

#### `NewItemsPill`

A floating "3 new" pill with a down arrow icon. A live list shows it while the reader is scrolled up and items arrived below. The list decides when to show it, so it never moves a reader who scrolled up. A click means the reader asks to go down.

- `count: Int`: how many items arrived.
- `noun: String = "new"`: the word after the count, so the pill reads "3 new".
- `action: () -> Void`: runs on click; scroll to the end here.

```swift
if unseen > 0 {
    NewItemsPill(count: unseen) { scrollToEnd() }
}
```

#### `RowArrival`

A view modifier for a row that just arrived in a live list. The row fades in while it moves up a few points over 0.2 s. Under Reduce Motion it only fades. `active` should be true only for the rows of the latest append, so a row scrolled into view later does not play it again.

- `active: Bool`: whether this row plays the arrival animation.

```swift
ForEach(messages) { message in
    MessageRow(message: message)
        .modifier(RowArrival(active: arriving.contains(message.id)))
}
```

#### `RefreshingMark`

A small spinner that says what it waits for. Its tooltip says whether the last known data is on screen while the new data loads, or nothing is yet.

- `showingCache: Bool`: true when the last known data is shown meanwhile.
- `what: String`: what is refreshing, such as "the worktree list".
- `size: ControlSize = .small`: the spinner size.

```swift
HStack {
    Text("Worktrees")
    if isRefreshing {
        RefreshingMark(showingCache: !worktrees.isEmpty, what: "the worktree list")
    }
}
```

#### `PulsingDots`

Dots in a row that grow and brighten in turn, for a "working..." state. Core Animation runs it in the render server, so the app does nothing between frames (a SwiftUI repeating animation re-evaluated the view graph on every frame). The view's own size is the width of the dots and one dot's height.

- `color: Color`: the dot color.
- `count: Int = 3`: the number of dots.
- `diameter: CGFloat = 4.5`: the diameter of one dot.
- `spacing: CGFloat = 3`: the gap between dots.
- `period: Double = 0.55`: seconds from small to full, and the same back.
- `stagger: Double = 0.18`: how much later each dot starts than the one before it.

```swift
HStack(spacing: 6) {
    Text("Working")
    PulsingDots(color: KitPalette.modified, count: 3, diameter: 5, period: 0.6)
}
```

#### `SpinningArc`

An open arc that turns clockwise, drawn and turned by Core Animation. It fills the smaller side of its frame, so give it a `.frame`. Reduce Motion draws the arc still.

- `color: Color`: the stroke color.
- `lineWidth: CGFloat = 2`: the stroke width.
- `trim: ClosedRange<CGFloat> = 0.12...0.78`: the visible part of the circle, as `Circle().trim(from:to:)` takes it.
- `period: Double = 1.65`: seconds per turn.
- `spinning: Bool = true`: false draws the arc still.

```swift
HStack(spacing: 6) {
    SpinningArc(color: KitPalette.added, lineWidth: 1.5, period: 1.2, spinning: isRunning)
        .frame(width: 12, height: 12)
    Text(isRunning ? "Running" : "Paused")
}
```

#### `View.skeletonShimmer()`

A moving highlight over a skeleton. Put it on the whole skeleton once, never on each bar. One band, 45 percent of the width and at least 120 points, sweeps across every 1.4 s. The skeleton's own shapes mask it. Reduce Motion removes the band. `TranscriptSkeleton`, `DiffSkeleton` and `PaneSkeleton` already apply it. `SkeletonBar`, `SkeletonLines` and `SkeletonRows` do not.

```swift
VStack(alignment: .leading, spacing: 12) {
    SkeletonLines(count: 3)
    SkeletonRows(count: 4, leading: .dot)
}
.skeletonShimmer()
```

#### `SkeletonBar`

One gray block that stands in for a line of text, an icon or a chip. Everything else in the skeleton family is bars laid out like the real view.

- `width: CGFloat? = nil`: the width; nil fills the row.
- `height: CGFloat = 9`: the height.
- `radius: CGFloat = 3`: the corner radius.

```swift
HStack(spacing: 8) {
    SkeletonBar(width: 18, height: 18, radius: 5)
    SkeletonBar(width: 140, height: 10)
}
```

#### `SkeletonPattern`

Text-like widths from a fixed list of twelve fractions (0.58 to 0.97), so a skeleton looks like text and never changes between renders. Use it to size your own bars.

- `fraction(_ index: Int, seed: Int = 0) -> CGFloat`: the fraction of the available width for line `index` of a block seeded by `seed`.

```swift
VStack(alignment: .leading, spacing: 6) {
    ForEach(0..<5, id: \.self) { row in
        SkeletonBar(width: availableWidth * SkeletonPattern.fraction(row, seed: 2), height: 9)
    }
}
.skeletonShimmer()
```

#### `SkeletonLines`

A paragraph of bars. The last line is shorter (45 percent of the width) when there is more than one.

- `count: Int = 3`: the number of lines.
- `seed: Int = 0`: shifts the width pattern, so neighboring paragraphs differ.
- `lineHeight: CGFloat = 9`: the height of one line.
- `spacing: CGFloat = 7`: the gap between lines.

```swift
VStack(alignment: .leading, spacing: 10) {
    SkeletonBar(width: 200, height: 14, radius: 4)
    SkeletonLines(count: 4, seed: 1, lineHeight: 9, spacing: 7)
}
.skeletonShimmer()
```

#### `SkeletonRows`

List rows: an optional leading dot or avatar, a title bar and a dimmer second line, like a sidebar list.

- `count: Int = 8`: the number of rows.
- `leading: Leading = .none`: the leading shape: `none`, `dot` or `avatar`.
- `subtitle: Bool = true`: shows the second line.
- `rowHeight: CGFloat? = nil`: the row height. nil gives 44 with a subtitle and 26 without.

```swift
if isLoading && items.isEmpty {
    SkeletonRows(count: 6, leading: .avatar, subtitle: true)
        .skeletonShimmer()
} else {
    List(items) { ItemRow(item: $0) }
}
```

#### `TranscriptSkeleton`

A transcript while it loads: per turn a prompt bubble on the right, a few tool rows and a reply paragraph. It has the shimmer built in and one accessibility label, "Loading transcript".

- `turns: Int = 3`: the number of turns.

```swift
if transcript.isLoading {
    TranscriptSkeleton(turns: 2)
} else {
    TranscriptView(transcript: transcript)
}
```

#### `DiffSkeleton`

A diff while it loads: per file a header bar, then code lines with a gutter, some tinted as added or removed. It has the shimmer built in and the accessibility label "Loading the diff".

- `files: Int = 2`: the number of files.

```swift
if let diff {
    DiffView(diff: diff)
} else {
    DiffSkeleton(files: 3)
}
```

#### `PaneSkeleton`

A detail pane while it loads: a title bar, a meta line and two paragraphs. It fills the space it is given, has the shimmer built in, and says `label` to VoiceOver.

- `label: String = "Loading"`: the accessibility label (the first, unlabeled parameter).

```swift
if let pullRequest = model.pullRequest {
    PullRequestPane(pullRequest: pullRequest)
} else {
    PaneSkeleton("Loading the pull request")
}
```

#### `FittedScroll`

A scroll area that is as tall as its content, up to `maxHeight`, with a fade at each cut edge when the content is taller. Use it for lists in overlays (a palette, prompts, a find panel), where a fixed or greedy height left empty space or showed one row. When a `GenDisclosure` inside opens or closes, the area grows or shrinks with it on the same `GenMotion` curve. Any other content change, such as a typed query, resizes it at once.

- `maxHeight: CGFloat`: the tallest the area gets; longer content scrolls.
- `minHeight: CGFloat = 0`: the shortest it gets.
- `content: () -> Content`: the scrolling content (a `@ViewBuilder`).

`maxHeight` and `minHeight` are also public `var`s.

```swift
FittedScroll(maxHeight: 320, minHeight: 40) {
    ForEach(results) { result in
        ResultRow(result: result)
    }
}
```

#### `OverlayScrollViewport`

A narrow vertical viewport whose scrollbar never adds to its proposed width, for a fixed-width rail such as a side strip of buttons. The scroller is the overlay style and hides when idle. Each edge with more content past it fades out, so an overflowing rail does not look like it ends, and the scroller flashes once when the content starts to overflow. The content is laid out at exactly `width`.

- `width: CGFloat`: the fixed width of the viewport and its content.
- `content: () -> Content`: the scrolling content (a `@ViewBuilder`).

```swift
OverlayScrollViewport(width: 44) {
    VStack(spacing: 8) {
        ForEach(modules) { ModuleButton(module: $0) }
    }
}
```

#### `View.scrollOverflowContent()`

Marks the content of a `ScrollView` so that `scrollOverflowHints(_:fade:changed:)` on that scroll view can measure it. Call it inside the `ScrollView`, on its content. It takes no parameters.

```swift
ScrollView {
    VStack { rows }
        .scrollOverflowContent()
}
.scrollOverflowHints()
```

#### `View.scrollOverflowHints(_:fade:changed:)`

A soft fade at each edge of a `ScrollView` that has more content past it, so a list that overflows never looks like it simply ends. The scrollers stay the system's. The content must carry `scrollOverflowContent()`. An outer hinted scroll view does not read an inner one's content.

- `axis: Axis = .vertical`: the scroll direction (the first, unlabeled parameter). A strip of chips with a hidden scroller is `.horizontal`.
- `fade: CGFloat = 22`: the fade length in points.
- `changed: ((ScrollOverflow) -> Void)? = nil`: told each time the overflow state changes, for an extra cue.

`ScrollOverflow` is a small `Equatable`, `Sendable` struct:

- `above: Bool = false`: more content past the top edge (the leading edge on a horizontal view).
- `below: Bool = false`: more content past the bottom edge (the trailing edge on a horizontal view).
- `init(above:below:)`, `init(content: CGRect, viewportHeight: CGFloat)` and `init(content: CGRect, viewportWidth: CGFloat)`: the last two work out the flags from the content frame in the scroll view's own coordinates, with half a point of slack for rounding.

```swift
ScrollView(.horizontal, showsIndicators: false) {
    HStack { chips }.scrollOverflowContent()
}
.scrollOverflowHints(.horizontal, fade: 16) { overflow in
    hasMoreToTheRight = overflow.below
}
```

#### `LatestScrollAnchor`

A view modifier for a chat-like scroll view. It opens at the latest content and follows growth only while the reader stays within 80 points of the end. When `identity` changes, it starts at the end again (the view is rebuilt with that id). Before macOS 15 it only anchors to the bottom.

- `enabled: Bool = true`: when false, the content is left unchanged.
- `identity: String = ""`: names the content shown (a conversation id). A change resets the position to the end.

Both are also public `let`s.

```swift
ScrollView {
    LazyVStack { ForEach(messages) { MessageRow(message: $0) } }
}
.modifier(LatestScrollAnchor(enabled: true, identity: conversation.id))
```

#### `ScrollViewPositioning.scroll(_:to:anchor:)`

Scrolls a `ScrollViewProxy` to a row id three times: on the next main-queue turn, after 0.12 s and after 0.35 s. A table that has not measured its rows places far rows at estimated heights, so the first scroll to a far row lands short. The later passes land exactly. The type is a `@MainActor` enum.

- `proxy: ScrollViewProxy`: the proxy of the enclosing `ScrollViewReader`.
- `id: String`: the id of the row to scroll to.
- `anchor: UnitPoint`: where the row should end up in the view.

```swift
ScrollViewReader { proxy in
    List(messages) { MessageRow(message: $0).id($0.id) }
        .onChange(of: target) { _, id in
            ScrollViewPositioning.scroll(proxy, to: id, anchor: .top)
        }
}
```

### Diff

Git and diffs for any host, in parts that work alone: the data comes through one provider, the views take values.
The GenesisTools review window and the markdown viewer's Changes mode, gutter, git sidebar and commit sheet are
built from these. Everything that runs `git` or `tools` goes through `GenesisKitGT.provider`, so a Swift-native
provider can replace the CLI later without a view changing.

#### `GenesisKitGTProvider` / `GenesisKitGT`

The data source of every git and agent component: `git` and `tools` runs, a diff for a scope, a file's state, a
version of a file, its history, a repository's status, an agent session's turn changes, agent blame, and opening
the session that wrote a line. `GenesisKitGT.provider` is the one in use: the one set there, else the host's
`GenesisKitHost.gtProvider`, else `GenesisKitGTCLIProvider` (`/usr/bin/git` and the `tools` binary). GenesisTools
hands its `HubGTProvider`, which answers `tools` through the hub's resident server.

```swift
final class FakeProvider: GenesisKitGTCLIProvider {
    override func agentBlame(repo: String, paths: [String]) throws -> AgentBlameResult { … }
}
GenesisKitGT.provider = FakeProvider()
```

#### `GitWorkingTreeSource` / `DiffScope`

A repository's changes for a scope as `DiffFile`s with both sides in full: `.uncommitted`, `.unstaged`, `.staged`,
`.commit(sha:title:)`, `.branch`, `.range`, `.compare` (two pushes, the older replayed onto the newer base) and
`.lastTurns(n)` (an agent session's last turns). `load(scope:session:)` returns a `Snapshot` (branch, base, files,
layout). Also `baseBranch()`, `commits(limit:)`, `worktrees()`.

- `repo: URL`: a folder in the repository.
- `preferredBase: String? = nil`: the branch the Branch scope compares against (a PR's target).

#### `GitDiffView` / `GitScopePicker`

`GitDiffView` draws files as the review window does (`PierreWebDiffRenderer`, the bundled @pierre/diffs page): split
or unified, wrap, font size, and agent blame on hover. Without the page in the app (`PierreWebDiffRenderer.isBundled`)
it says so. `GitScopePicker` is the scope of one file's diff: a chip as wide as its label (`GitPickerChip`) that
opens a popover with Unstaged · Staged · Uncommitted · Last commit · Branch, each with what it compares and, when the
viewer passes them, its counts (`GitScopeStat`). Up, down, Return and 1 to 5 pick from the keyboard. For Last commit a
`GitCommitPicker` chip sits beside it. Neither list is built until it opens.

- `files: [DiffFile]`, `options: DiffViewOptions = DiffViewOptions()`.
- `blame: AgentBlamePayload? = nil`: which session wrote the new side's lines; nil shows none.
- `onBlameOpen: ((Int) -> Void)? = nil`: "Open session" on a blame, with the index into `blame.sources`.
- Picker: `scope: Binding<GitFileScope>`, `commit: Binding<String?>`, `history: [GitCommit]`, `shown: GitCommit?`,
  `counts: [GitFileScope: GitScopeStat] = [:]`, `base: String? = nil` (Branch's base, for its label),
  `details: GitCommitDetailsLoader? = nil` (reads the commits' line counts when the commit list opens).
- `GitScopeStat.forFile(status:file:unsaved:current:phase:diff:)`: one file's counts from the repository's status
  (unstaged and staged or clean) and the exact lines of the diff on screen. `GitScopeStat.clean` / `.changed` /
  `GitScopeStat(additions:deletions:files:)` for a caller that knows more.

```swift
GitDiffView(files: [file], options: DiffViewOptions(diffStyle: .unified, wrap: true))
```

#### `GitCommitPicker` / `.gitCommitPopover` / `GitCommitChoice`

A commit chooser that opens as a popover: a filter field (words match the subject, the author or a tag; a word that
starts the id matches the id), then per commit its subject, author, relative and absolute date, short id with a copy
button on the highlighted row, and files and lines changed. Up and Down, Page Up and Page Down move, Return picks,
Esc closes. Nothing of the list is built while it is closed (a SwiftUI `Menu` builds every item with the pane), and
the open list builds only the rows on screen. What the choices lack (author, date, counts) is read when it opens by
`GitCommitDetailsLoader`, one `git log --no-walk --numstat` for all of them.

- `GitCommitPicker(choices:selection:title:details:onPick:)` with a `GitPickerChip` label (short id and subject), or
  `label:` for your own.
- `.gitCommitPopover(isPresented:choices:selection:title:details:onPick:)`: the same list from any view, for a host
  that opens it from a menu item.
- `GitCommitChoice(_ commit: GitCommit)`, `GitCommitChoice(_ commit: RepoCommit)`, or the memberwise init with
  `badge` ("#3" for a push), `relative` ("3 hours ago") and `path` (the file whose own lines to count).

```swift
GitCommitPicker(choices: history.map { GitCommitChoice($0) }, selection: shown?.sha,
                details: GitCommitDetailsLoader(folder: fileURL.deletingLastPathComponent())) { model.pick($0.sha) }
```

#### `GitFileDiffModel`

One file's diff for a `GitFileScope` (or two picked versions with `loadCompare`), with the working side taken from
the text on screen, an unsaved draft included. Publishes `phase` (loading, empty with the reason, ready, failed),
`file`, `oldText` (for a rendered diff), `history` and the `commit` Last commit shows.

#### `GitRepos` / `GitRepoModel` / `GitRepoFollower`

One `git status` per repository for every tab, status bar and tree: `GitRepos.shared.model(for: folder)` (nil while it
is looked up, the answer bumps `revision`). A `GitRepoModel` publishes `status` and a `generation` that changes with
it, and refreshes a quarter second after its git folder changes (a stage, a commit, a checkout) or a host calls
`GitRepos.shared.noteSaved(file)`. No timer: idle costs nothing. `GitRepoFollower` is the piece a model uses to run a
closure on every refresh of a file's repository.

#### `GitFileStateModel` / `GitStateBadge` / `GitFileMark` / `GitChangeMark`

A file's place in git (`GitFileState`: branch, staged and unstaged kinds and line counts, `summary` such as
"M · 3 lines unstaged · 1 line staged") kept current, the status bar badge that shows it, and the one-letter mark a
tab or a tree row carries (`GitFileMark` reads it from the repository's status). `GitChangeKind.color` and `.word`
give the colors and words.

```swift
@StateObject private var git = GitFileStateModel()
… .onAppear { git.follow(fileURL) }
if let state = git.state { GitStateBadge(state: state) }
```

#### `GitGutterModel` / `GitHunks` / `GitHunkPopover`

The hunks of the file on screen against HEAD (added, changed with the text they replaced, removed), recomputed a beat
after the text stops changing and again after a commit. `GitHunks.between(old:new:)` and `GitHunks.revert(_:in:)` are
the pure parts. `GitHunkPopover.show(_:source:at:in:revert:)` is the card a click on a bar shows: the lines, what
HEAD had, the agent session that wrote them, Revert this hunk.

#### `GitHistoryModel` / `GitCommitList` / `GitRepoPanel` / `GitCommitView`

A commit list kept current (`.file(url)`: `git log --follow`; `.repository(folder)`: the newest commits), the list
view (open on a click, compare from the context menu), the repository panel (branch with ahead and behind, staged,
unstaged and untracked files) and a commit's files with their diffs, where `rendered:` may draw a file its own
way (the markdown viewer renders a note as a rendered diff).

```swift
GitRepoPanel(repo: repo, onOpenFile: { entry, staged in … })
GitCommitList(commits: log.commits, onOpen: { commit in … })
GitCommitView(root: repo.root, commit: commit)
```

#### `GitTreeDecorationsModel`

A file tree's git marks for the repository holding its root, spelled the way the tree spells its paths (git reports
real paths: `/private/tmp` for `/tmp`). Pass `decorations` to `FileTreeView(git:)`.

#### `AgentBlameModel` / `AgentBlame`

Which agent session and turn wrote the lines of the file on screen (GenesisTools' `tools agents blame`, through the
provider). `source(forLines:)` names the session that wrote most of a range; `AgentBlame.open(_:)` shows it (the
GenesisTools hub, its transcript searched for the turn). The blame is of the file on disk.

### Disk

The live sensors and the data layer of a disk manager, at near-zero idle cost. Free space is one `statfs` per sample on a private queue (about 1 µs of CPU on this Mac under load), woken by the kernel's own low-disk events, wake from sleep and mounts, with a slow backstop timer. File activity comes from a resumable FSEvents stream on narrow roots, and a radar `lstat`s only the paths an event names. Heavy data (the size index, clone plans, the reclaim catalog) comes from the `tools` CLI: `ToolsDiskProvider` runs and decodes it, and `DuIndexReader` reads the index file directly, read-only. Nothing here walks the disk.

#### `VolumeSpaceMonitor`

Watches one volume's free space, as a `@MainActor` `ObservableObject`. Each sample is one `statfs` on a utility queue; the result is published only when a figure moved by `minimumChange` or macOS's low-disk level changed. It wakes on the kernel's `EVFILT_FS` events (VQ_NEARLOWDISK, VQ_LOWDISK, VQ_VERYLOWDISK, VQ_DESIRED_DISK; no privileges needed), on wake from sleep, on a mount or unmount, and on `poke()`. A `DispatchSourceTimer` with 10% leeway is the backstop: every `farInterval` far from the floor, every `nearInterval` within `nearBand` of it, pushed out again by every event-driven read. Finder's "Available" (free plus purgeable, from CacheDelete) costs about 10 ms of CPU and many log lines per read, so only `refreshDetailed()` reads it; the opportunistic figure is never read, because it sits far below free space.

- `configuration: Configuration`: changing it applies at once, `watchesWorkspace` included. Fields: `volumePath: String = VolumeSpaceMonitor.defaultVolumePath` (`/System/Volumes/Data`, whose `statfs` is the container's free space), `floor: Int64 = 10_000_000_000`, `nearBand: Int64 = 5_000_000_000`, `farInterval: TimeInterval = 300`, `nearInterval: TimeInterval = 30`, `minimumChange: Int64 = 1_000_000`, `pokeSpacing: TimeInterval = 2` (pokes closer than this become one read), `settleSchedule: [TimeInterval] = [5, 30, 120, 300, 900, 1200]`, `watchesLowDiskEvents: Bool = true`, `watchesWorkspace: Bool = true`.
- `sample: VolumeSample?` (published): `volumePath`, `total`, `free`, `available`, `importantUsage: Int64?` (Finder's figure; between detailed reads its purgeable part rides along on the new free figure), `lowDiskLevel: VolumeLowDiskLevel` (`.unknown` until the kernel's first event, then `.ok`, `.nearLow`, `.low`, `.veryLow`; system-wide, because the kernel names no volume: a nearly full USB stick also reads `.low`, and the per-volume query needs root, so decide on the byte figures and show the level as a hint), `date`, and `usedFraction`.
- `settling: SpaceSettling?` (published): after `beginSettling`, the `baselineAvailable`, `latestAvailable`, `gained`, `checksDone` of `checksTotal` and `finished`.
- `onSample: ((VolumeSample) -> Void)?`: every published sample, on the main actor (feed `AlertPolicy`, `DiskHistoryStore`).
- `start()`, `stop()`, `isRunning`, `poke()`. None of them waits for a read in progress, so a network volume that hangs `statfs` never blocks the main actor.
- `refreshDetailed() async -> VolumeSample?`: a read with Finder's figure. Call it while a page that shows it is visible.
- `beginSettling(label: String, baseline: VolumeSample? = nil)`, `endSettling()`: after a reclaim, APFS frees large deletes over several transactions and clone-shared blocks only with their last copy, so free space keeps rising for minutes; the monitor reads again on `settleSchedule` and the UI says "space returning" instead of "0 bytes freed".
- Static, any thread: `read(path:level:date:) throws -> VolumeSample` (one `statfs`), `readImportantUsage(path:) -> Int64?`, `mountedVolumes(includingNetwork: Bool = false) -> [DiskVolume]` (`path`, `name`, `total`, `available`, `isInternal`, `isRoot`; reads capacity, so call it off the main thread; network volumes are left out by default, because one whose server went away blocks for tens of seconds).

```swift
let monitor = VolumeSpaceMonitor(configuration: .init(floor: 10_000_000_000))
monitor.onSample = { sample in dispatcher.dispatch(policy.evaluate(Double(sample.available), at: sample.date, state: &state)) }
monitor.start()
// after `tools doctor act` freed space:
monitor.beginSettling(label: "Leaked Chrome copies", baseline: before)
```

#### `SpaceForecaster`

When the disk fills at the current pace, and how sure that is. Pure: an exponentially weighted average of the rate between consecutive `SpacePoint`s (`date`, `available`; `SpacePoint(sample)` from a `VolumeSample`) whose weights halve every `halfLife`, over the last `window`. A rise of at least `jumpThreshold` in one step is a delete or a purge and is left out; a drop of at least `dropJumpThreshold` in one step is one large copy and is left out too, so it does not read as a pace.

- `floor: Int64`, `halfLife: TimeInterval = 1800`, `window: TimeInterval = 3600`, `minimumSpan: TimeInterval = 600`, `minimumPairs: Int = 3`, `jumpThreshold: Int64 = 1_000_000_000`, `stableBytesPerHour: Double = 50_000_000`, `erraticRatio: Double = 4`, `dropJumpThreshold: Int64? = 5_000_000_000` (nil keeps every drop).
- `forecast(_ points: [SpacePoint], now: Date) -> SpaceForecast`: the forecast as of `now`. The monitor publishes only after `minimumChange`, so readings stop while the disk is quiet; the time from the last reading to `now` counts as a flat stretch and an old pace fades. `forecast(_:)` is the same as of the last reading.
- `SpaceForecast`: `verdict` (`.filling`, `.stable`, `.freeing`, `.notEnoughHistory`, `.erratic`, so the UI can refuse honestly), `bytesPerSecond` and `bytesPerHour` (negative while filling), `timeToFloor` and `timeToZero` (set while filling; 0 under the floor already), `confidence` (0...1), `pairsUsed`, `jumpsIgnored` (rises and large drops left out), `span`, `asOf` (the moment the times count from).

```swift
let forecast = SpaceForecaster(floor: 10_000_000_000).forecast(points, now: Date())
if forecast.verdict == .filling, let eta = forecast.timeToFloor { print("under the floor in \(Int(eta / 60)) min") }
```

#### `DiskHistoryStore`

An actor that keeps free-space history and reclaim markers in two append-only NDJSON files in a host-given folder (`samples.ndjson`, `events.ndjson`, about 70 bytes a line). Every `compactEvery` appends, or when the file outgrows `maxSampleBytes`, the samples are rewritten downsampled through a temporary file and a rename: full resolution for `fullResolution`, the lowest reading per hour for `hourlyFor`, per day up to `keepFor`. A file it cannot read (permissions, an I/O error, a file not downloaded) or cannot parse (more than a tenth of its lines broken, or no readable line at all) is never rewritten: `health` turns `.unreadable(path)`, appends stop and the original bytes stay. Only a missing file starts an empty history. A broken last line (a write cut short) is dropped quietly, and the next append starts on a new line. A failed compaction (a full disk) waits for the next `compactEvery` appends. Keep one store per folder: two processes that append to and compact the same folder drop each other's lines.

- `directory: URL`, `limits: Limits = Limits()`: `minimumSpacing: TimeInterval = 60` (a closer reading is skipped unless free space moved `minimumChange: Int64 = 100_000_000`), `fullResolution = 86_400`, `hourlyFor = 30 days`, `keepFor = 400 days`, `maxSampleBytes = 1_000_000`, `maxEvents = 1000`, `compactEvery = 240`.
- `append(_ sample: VolumeSample) throws -> Bool`, `record(_ event: DiskHistoryEvent) throws` (`date`, `kind`, `label`, `bytes`, `availableBefore`, `availableAfter`).
- `points(since: Date? = nil) throws -> [DiskHistoryPoint]`, `events(since:) throws -> [DiskHistoryEvent]`, `compact(now:) throws`, `health`.
- `downsample(_:now:limits:)` (static, pure).

```swift
let history = DiskHistoryStore(directory: appSupport.appendingPathComponent("disk-history"))
// One task that drains a stream keeps the samples in order (a Task per sample does not).
let (samples, feed) = AsyncStream.makeStream(of: VolumeSample.self)
Task { for await sample in samples { _ = try? await history.append(sample) } }
monitor.onSample = { feed.yield($0) }
```

#### `FileEventStream`

An FSEvents stream on its own serial queue that continues where it stopped. Batches arrive on that queue, never on the main thread, with one `FileEvent` per path (flags OR-ed, the latest id) in the order the paths first appeared. Every flag that means "the event list is incomplete" becomes `rescanRoots`: MustScanSubDirs, a dropped buffer (`dropped`, all watched roots), wrapped ids, a moved root, a mount. With a `cursorKey` and a `FileEventCursorStore`, the last event id and the FSEvents UUID of each watched volume (`FSEventsCopyUUIDForDevice`) are saved at most every `cursorSaveInterval` and on `stop()`, and the next `start()` replays everything since then (`isReplay` until `historyDone`). A cursor that does not fit (another volume UUID, an id ahead of the system's) is dropped, and the first batch (on the stream's queue, after `start()` returned) asks for a rescan of every root with `historyInvalid`.

Watch narrow roots (`$TMPDIR`, `/tmp`, the code-sign clone folder, a project). A file-level stream over all of `$HOME` makes `fseventsd` grow; use `.directory` there, which still sends one event per change (this type merges them per path). `ignoreSelf` hides this process's own writes but not its child processes' (a `tools` run).

- `configuration: Configuration`: `paths: [String]`, `granularity: Granularity = .file` (or `.directory`), `latency: TimeInterval = 2`, `ignoreSelf: Bool = true`, `watchRoot: Bool = true`, `excludedPaths: [String] = []` (FSEvents takes 8), `cursorKey: String? = nil`, `cursorSaveInterval: TimeInterval = 30`.
- `cursorStore: FileEventCursorStore? = nil`: `loadCursor(forKey:)` and `saveCursor(_:forKey:)`, called on the stream's queue. `FileEventCursorFileStore(directory:)` keeps each cursor as a small JSON file.
- `onBatch: @escaping @Sendable (FileEventBatch) -> Void`: `events`, `rescanRoots`, `dropped`, `historyInvalid`, `historyDone`, `isReplay`, `lastEventId`.
- `start() -> Bool` (false when FSEvents refused it), `stop()` (safe from any thread and from the batch callback), `saveCursor()`, `isRunning`, `lastEventId`.
- Static: `currentEventId`, `deviceUUID(forPath:) -> String?`.
- `FileEventFlags` names every `kFSEventStreamEventFlag*` (`.itemCreated`, `.itemRemoved`, `.itemModified`, `.itemIsFile`, `.itemIsDir`, `.mustScanSubDirs`, `.dropped`, …).
- Paths are reported in the `/var` and `/tmp` spelling, not `/private/var`.

```swift
let stream = FileEventStream(configuration: .init(paths: [tmpdir, "/private/tmp"], latency: 5, cursorKey: "disk.temp"),
                             cursorStore: FileEventCursorFileStore(directory: stateFolder)) { batch in
    radar.consume(batch)
}
stream.start()
```

#### `BigFileRadar`

Finds big new or growing files from `FileEventStream` batches. It `lstat`s only the paths a batch names (and, bounded, the direct entries of a folder event or a rescan root, plus the files it already tracks there), so its cost follows the event rate; an ignored folder is not listed. Work runs on its own utility queue. A file is reported when its allocated size (`st_blocks`; the real cost of a sparse disk image) first reaches `threshold`, and again each time it grew by `growthStep`. A file that is removed, moved away (or sits in a removed or moved folder), or shrinks below `threshold` leaves `hits` and is reported to `onRemove`; a listed file that changed less than a step shows its current size.

- `configuration: Configuration`: `threshold: Int64 = 500_000_000`, `growthStep: Int64 = 100_000_000`, `ignorePatterns: [String] = []` (`fnmatch` patterns in which `*` also crosses `/`, `~` is the home), `maxTracked: Int = 20_000`, `maxHits: Int = 500`, `maxDirectoryEntries: Int = 2_000`.
- `onHits: @escaping @Sendable ([RadarHit]) -> Void`: the new hits of a batch, on the radar's queue. `RadarHit`: `path`, `allocatedBytes`, `logicalBytes`, `delta`, `culprit: RadarCulprit?`, `firstSeen`, `lastSeen`, `isNew`.
- `onRemove: (@Sendable ([String]) -> Void)?`: the paths that left `hits`, on the radar's queue.
- `consume(_ batch:)`, `check(paths:)`, `forget(_:)`, `reset()`, `hits` (the latest hit per path that is still there: the newest batch first, the biggest first within a batch).
- `RadarCulprit` (`id`, `title`, `hint`): `.codeSignClone`, `.dockerImage`, `.xcodeDerivedData`, `.simulatorRuntime`, `.swiftPMBuild`, `.nodeModules`, `.jsonlLog`, `.logFile`, `.temporaryFile`; `RadarCulprit.all`, `RadarCulprit.classify(path:)`.

```swift
let radar = BigFileRadar(configuration: .init(ignorePatterns: ["*/node_modules/*"])) { hits in
    Task { @MainActor in model.add(hits) }
}
```

#### `FseventsdHealth` and `FseventsdGate`

The scan gate's input. `FseventsdHealth.read() -> FseventsdHealth?` runs one `ps` (libproc answers EPERM for this daemon; about 20 ms, blocking, so call it off the main thread) and returns `pid`, `rssBytes`, `cpuSeconds` and `date`. `FseventsdGate` keeps successive readings and says whether the daemon is hot: resident memory at or above `rssLimit` (1 GiB), growth of `growthLimit` (500 MB) within `growthWindow` (10 minutes), or `cpuLimit` (1.5 cores) over at least `cpuWindow` (60 s). Its normal load is about 0.6 of a core, so CPU alone uses a high bar. `update(_:) -> Bool`, `isHot`. A restarted daemon starts a new history.

#### `TempLocation`

The temporary folders and the rule macOS cleans each by, as data for a Temp & Leaks page: `id`, `title`, `path`, `cleanedAtBoot`, `cleanTime` (`HH:mm` local, nil when nothing cleans it while the Mac runs), `maxAgeDays` and `note`. `TempLocation.standard()` resolves `/tmp` (00:00, 3 days), `/var/tmp` (never), `$TMPDIR` (`T`, 03:35, 3 days), the cache folder `C`, the user folder `0` and the `X` folder (boot only) with `confstr`, so it does not depend on `TMPDIR`.

#### `CodeSignClone`

Chrome, Brave, Edge and Teams copy their app into `X/<bundle id>.code_sign_clone/` at every launch and remove the copy only on a clean quit. `CodeSignClone.scan(xFolder: String? = nil) -> [CodeSignClone]` lists them at fixed depth (no walk), oldest first: `path`, `bundleID`, `created`, and `state`: `.current` when the copy's main executable is a hard link of the installed app (it shares nearly all blocks), `.stale` when it holds an older version's blocks alone (deleting it frees real space).

#### `ToolsDiskProvider`

Runs the `tools` disk commands through `ToolsBridge` with a long timeout (`timeoutSeconds: Int = 600`) and decodes their JSON off the main actor. A non-zero exit throws `ToolsDiskProviderError.exit(code:stderr:)` with the stderr tail; a bad document throws `.decode(command:detail:)`. A preamble before the JSON is skipped. Build it without an output sink, so large JSON is not written to a log per call.

- Reads (they delete, rewrite or apply nothing): `duVolume`, `duClonesize(path:options:)`, `duPartners`, `clonesMeasure`, `clonesDu`, `clonesDuplicates`, `clonesReclaimPlan`, `doctorReport` (`--json --dry-run`), `hubWorktrees`, `hubWorktreeSizes`, `macosSwap`, `duIndexQuery`, `duIndexLargest`, `duIndexInfo`, `duIndexDiff`.
- Changes: `duIndexUpdate(paths:shallow:recursive:fromQueue:db:)`, `duIndexSchedule(enable:db:)`, `doctorAct(actionId:analyzerId:findingIDs:method:yes:confirmPhrases:dryRun:expect:expectPaths:)` (a refused item is a result, not a throw). `expect` maps a finding id to the `reclaimableBytes` the UI showed and `expectPaths` to the finding's `pathsHash`; the CLI refuses an item whose size drifted or whose path set changed as `stale`. A finding's `actions` carry `confirm`, `confirmPhrase` (the exact phrase a `typed` confirmation needs, such as `DELETE` or `yes, trash`) and `method`.
- Clones changes: `clonesReclaimApply(_:usesCachedPlan:) -> ClonesReclaimApplyOutcome` (`.applied(ClonesApplyResult)`, or `.nothingToApply(ClonesReclaimPlan)` when the CLI printed the plan), `clonesRollback(processId:)`, `clonesPresetSave(id:options:) -> ClonesPreset`, `clonesPresetRemove(id:)`, `clonesDaemonEnable()` and `clonesDaemonDisable()` (`ClonesDaemonChange`: `enabled`, `newlyRegistered` or `removed`, and `registered` after the call), `clonesDaemonStatus()` (`ClonesDaemonStatus`), `clonesConfig()` and `clonesConfigUpdate(addDirs:removeDirs:)` (`ClonesConfig`; the CLI skips a folder that does not exist, and a path with a comma is refused because the CLI splits comma lists). Each argv is a static `…Arguments` function. An error envelope throws `ClonesCommandError` (`rollback-space` with `required` and `available`, `unknown-process` with `closest`, `unknown-preset` with `known`, …).
- A command that changes the disk (`doctorAct`, `clonesReclaimApply`, `clonesRollback`) runs detached: cancelling the calling task (a view's `.task` that ended) does not stop it halfway. It ends on its own or after `actTimeoutSeconds` (3600). A streamed act through `ToolsLineStream` belongs in a task that is not tied to a view for the same reason.
- A relative path that starts with `-` is passed as `./-…`, so it never parses as a flag.
- Streams, for `ToolsLineStream`: `duIndexBuildArguments(...)` (parse each line with `DuIndexEvent.parse(line:)`: `.start`, `.progress`, `.phase`, `.blocked` (a folder the walk gave up on, usually behind a privacy prompt; the build result lists them in `blockedPaths`), `.built`, `.updated`, `.failed`, `.other` for a type this build does not know, and `.undecodable(type:detail:)` for a known line that did not decode, so a caller stops waiting for `.built`) and `doctorActArguments(..., ndjson: true)` (`DoctorActEvent.parse(line:)`: `.plan`, `.itemStarted`, `.itemDone`, `.volumeAfter`, `.result`, `.other`, `.undecodable`; after an undecodable `result`, read the run's manifest). Run the build with `ToolsLineStream(..., priority: .background)` so it never competes with the user. The nested event structs have public initializers for previews and tests.
- A `du index` error document (`locked`, `schema_newer`, `disk_low`, `inconsistent` (rebuild the index), …) is thrown as `DuIndexError`; a query result carries `blockedBelow` (blocked folders at or under the path) and `--info` carries `counts.blocked` and `meta.blockedDirs`; a clones error envelope as `ClonesCommandError` (`decodeClonesApply(_:)`).
- `decode(_:from:command:)` and `decode(_:from:command:snakeCaseKeys:)` (static) decode captured output.
- The models mirror the CLI field by field (`Du*`, `Clones*`, `Doctor*`, `HubWorktree*`, `Swap*`, `DuIndex*`). A string the CLI may grow new values for is an open `RawRepresentable` struct, so a new value never fails a decode. Tests decode real captured output and the frozen contract fixtures in `Sources/GenesisKitFixtures/Disk/`: the `GenesisKitFixtures` product (`KitFixture.url` / `data` / `string` by file name) is their only copy, for test targets only. The kit's and Genesis's tests load them through it, and the GenesisTools bun tests read the same files by path and check every `contract-*` file's keys and nesting against the real output of the command that prints it.

```swift
let provider = ToolsDiskProvider(bridge: ToolsBridge(resolveBinaryPath: { ToolsBridge.defaultBinaryPath() }))
let report = try await provider.doctorReport(only: ["temp-leaks", "app-bloat"])
let result = try await provider.doctorAct(actionId: "delete-clone", analyzerId: "temp-leaks",
                                          findingIDs: [report.findings[0].id], method: .delete, yes: true)
```

#### `DuIndexReader`

Reads the size index `tools du index` writes (`~/.genesis-tools/du/index.db`, schema version 1) for an Explorer, read-only by construction: `SQLITE_OPEN_READONLY`, `PRAGMA query_only`, no DDL, no `journal_mode`, no checkpoint, and each call is one short read transaction. A running build (WAL) never waits for the UI, and the UI sees the last committed snapshot. Calls block on SQLite (with `busyTimeout` for the moment a checkpoint holds the file), so call them off the main thread. A newer schema is refused at `init`.

- `init(path: String = DuIndexReader.defaultPath, busyTimeout: Int32 = 2_000) throws`: throws `ReaderError.missing` (offer `tools du index build`), `.open` (also for a database without a `schema_version`), `.schemaNewer(found:supported:)`; a failed read throws `.query(_:busy:)`.
- `lookup(_ path:) -> DuIndexLookup`: `.found(DuIndexNode)`, `.folded(path:into:)` (below a stored folder whose small subfolders were folded into it; `tools du clonesize <path> --depth 1` measures it), or `.notIndexed`.
- `roots()`, `node(id:)`, `children(of:sort:limit:minBytes:)` (sorted by `DuIndexChildSort`: `.alloc`, `.logical`, `.private`, `.files`, `.mtime`, `.name`; each child gets its `path` and `share`; a child with an attention flag (`DuIndexDirFlags.attention`: denied, incomplete, skipped, blocked) carries no bytes, so it is always listed after the others whatever `minBytes` and `limit` say, as the CLI does), `local(of:)` (the folder's own files and folded subfolders). Both read the node again in the same transaction, so a node from an older read still gives consistent shares and sizes. `blockedDirCount()` (`counts.blocked`) and `blockedBelow(_ node:)` (the query's `blocked_below`: 0 at once when meta `blocked_dirs` says the last walk blocked nothing), `topFiles(under:limit:)` (a range scan on the path key), `largestFiles(limit:)`, `scans(limit:)`, `meta()`, `schemaVersion()`, `path(of:)` (nil for a parent cycle in a damaged index).
- `DuIndexNode.flags` is a `DuIndexDirFlags` set: `.denied`, `.incomplete`, `.cloudSkipped`, `.mountSkipped`, `.gone`, `.blocked` (its totals are missing). Tombstones are left out of every read.

```swift
let reader = try DuIndexReader()
if case .found(let library) = try reader.lookup(home + "/Library") {
    let rows = try reader.children(of: library)
    if let path = library.path { let files = try reader.topFiles(under: path, limit: 10) }   // "" would read as "/"
}
```

### Files

A folder tree for a sidebar, and Finder's file verbs. `FileTreeModel` holds the open folders and the visible rows, `FileTreeView` draws them in a lazy list, and the host passes a `FileTreeStyle` (colors, font and `FileTreeMetrics` sizes) and a `FileTreeActions` for what happens on open, re-root and change. Each row's context menu is `FileItemMenu` by default, or the host's own verbs through `FileTreeMenu`, and `FileTreePulse` lights one row up once. `FileOperations` runs the verbs: rename, duplicate, move to the Trash and create. A delete is always a move to the Trash, so Finder's "Put Back" undoes it, and creating never replaces anything.

#### `FileTreeView`

The tree itself: one flat, lazily built list of rows. Wrap it in a `ScrollView`. Folders are read off the main thread and served from a cache after the first read. A click on a file calls `actions.open`, and a double-click on a file then calls `actions.openKept`. A click on a folder opens or closes it, and a double-click on a folder calls `actions.setRoot`. A row's context menu is `actions.menu` when it is set, and `FileItemMenu` otherwise. After a menu action the folder that changed is read again (for a new item, the folder it went into). Then `actions.changed` is called, or, with a custom `menu`, the `changed` handler of that menu.

- `model: FileTreeModel`: the model that owns the rows.
- `selected: String?`: the absolute path of the selected row, or nil.
- `style: FileTreeStyle`: the colors, font and sizes.
- `actions: FileTreeActions`: what the host does with clicks and changes.
- `pulse: FileTreePulse? = nil`: lights up the row whose `id` equals `pulse.id`, once for each new token. The other rows get no pulse.
- `git: GitTreeDecorations? = nil`: git marks, a letter on each changed file (its name tinted) and a dot on each folder that holds changes (`GitTreeDecorationsModel`); nil shows none.
- `changedOnly: Bool = false`: with `git`, only the changed files and the folders that hold them (`FileTreeView.changedRows`).
- `icon: (FileTreeRow) -> String = FileTreeView.defaultIcon`: returns the SF Symbol name for a row.

A `FileTreeRow` is one visible line: `id: String` (the absolute path), `name: String`, `isFolder: Bool`, `depth: Int`, `expanded: Bool`, `loading: Bool` and `url: URL`.

`FileTreeView.defaultIcon(_ row: FileTreeRow) -> String` is the default icon function. It returns a folder symbol (filled when open), and for files a symbol chosen by extension: text for `md`, `markdown` and `mdx`, a tile group for `canvas`, a table for `base` and `csv`, curly braces for `json`, `yaml`, `yml` and `toml`, a photo for common image types, and a plain document otherwise.

```swift
ScrollView {
    FileTreeView(model: tree, selected: openFile?.path, style: style, actions: actions, pulse: pulse) { row in
        row.isFolder ? FileTreeView.defaultIcon(row) : "doc.plaintext"
    }
}
.onAppear { tree.setRoot(notesFolder) }
```

#### `FileTreeModel`

The main-actor observable model behind `FileTreeView`. It keeps the set of open folders, caches each folder's listing and publishes the visible rows as one flat array. It reads nothing until the host calls `setRoot`.

- `root: URL`: the starting root. It is standardized, but no folder is read yet.

Properties (both published, read-only from outside):

- `root: URL`: the current root folder.
- `rows: [FileTreeRow]`: the visible rows, depth first, with an open folder's children right under it.

Methods:

- `func setRoot(_ url: URL)`: makes `url` the root and reads it. It does nothing when `url` is already the root and its listing is loaded or loading. An open folder under the new root that has no cached listing is read too.
- `func toggle(_ path: String)`: opens a folder, reading it first if it is new, or closes it.
- `func isExpanded(_ path: String) -> Bool`: whether a folder is open.
- `func reveal(_ file: URL)`: opens every folder between the root and `file`, so its row is in the tree. It does nothing when `file` is outside the root.
- `func reload()`: forgets every listing and reads the root and the open folders again.
- `func refresh(_ folder: String)`: reads one folder again, for example after a rename, duplicate, trash or create inside it.

```swift
let tree = FileTreeModel(root: URL(fileURLWithPath: "/Users/example/Notes"))
tree.setRoot(URL(fileURLWithPath: "/Users/example/Notes"))
tree.reveal(URL(fileURLWithPath: "/Users/example/Notes/2026/plan.md"))
```

#### `FileTreeStyle`

The host's colors, type and sizes, so the tree matches the window it sits in.

- `text: Color`: the host's main text color. The rows draw with `secondary`, `muted` and `accent`, and do not read this one.
- `secondary: Color`: the color of unselected row names (files and folders).
- `muted: Color`: the color of chevrons and file icons.
- `accent: Color`: the color of folder icons, the selected name and the pulse.
- `selection: Color`: the background of the selected row.
- `font: (_ semibold: Bool) -> Font`: returns the row font. The argument is true for the selected row.
- `metrics: FileTreeMetrics = .compact`: the glyph sizes, indent and row padding around the text. A host whose `font` grows passes `.scaled(toText:)` with the same size, so the rows grow with it.

```swift
let size: CGFloat = 12
let style = FileTreeStyle(
    text: .primary, secondary: .secondary, muted: .gray, accent: .blue,
    selection: .blue.opacity(0.15),
    font: { semibold in .system(size: size, weight: semibold ? .semibold : .regular) },
    metrics: .scaled(toText: size)
)
```

#### `FileTreeMetrics`

The sizes of a row around its text. Every field is a public `CGFloat` variable with the default shown below. The memberwise initializer is not public, so start from `.compact` or `.scaled(toText:)` and change the fields you need. A row draws again when its metrics change.

- `chevron: CGFloat = 7`: the font size of the open or closed chevron on a folder row.
- `chevronWidth: CGFloat = 8`: the width reserved for the chevron. A file row keeps the same empty space.
- `icon: CGFloat = 9`: the font size of the row icon.
- `iconWidth: CGFloat = 12`: the width reserved for the icon.
- `indent: CGFloat = 11`: the extra left padding for each depth level.
- `verticalPadding: CGFloat = 3`: the padding above and below the row.
- `spacing: CGFloat = 5`: the horizontal space between the chevron, the icon and the name.
- `static let compact`: the default sizes above, drawn for 9.5 pt text. This is the tree's first look and the hub's.
- `static func scaled(toText size: CGFloat) -> FileTreeMetrics`: every size of `compact` multiplied by `size / 9.5`, so the row height, the icons and the indent follow the font. A `size` below 1 counts as 1.

```swift
var metrics = FileTreeMetrics.scaled(toText: 13)
metrics.indent = 16
let style = FileTreeStyle(
    text: .primary, secondary: .secondary, muted: .gray, accent: .blue,
    selection: .blue.opacity(0.15), font: { _ in .system(size: 13) }, metrics: metrics
)
```

#### `FileTreeActions`

What the host does with the tree: open a file, re-root, follow the changes that the row menu makes, and optionally replace the menu.

- `open: (URL) -> Void`: called for a click on a file.
- `setRoot: (URL) -> Void`: called for a double-click on a folder, and for "Show as Root" in its menu.
- `changed: (FileChange) -> Void`: called with the result of a rename, duplicate or move to the Trash from `FileItemMenu`, so the host can update its tabs. With a custom `menu`, the `changed` handler of that menu is used instead.
- `guardChange: ((URL) -> String?)? = nil`: returns a reason to refuse a rename or a move to the Trash (for example a tab with unsaved edits), or nil to allow it. `FileItemMenu` uses it.
- `revision: Int = 0`: bump it whenever the closures would act differently. A row cannot compare closures, so without a new `revision` an unchanged row keeps the old ones.
- `menu: FileTreeMenu? = nil`: the host's own row menu. Nil keeps `FileItemMenu`.
- `openKept: ((URL) -> Void)? = nil`: called for a double-click on a file, after the first click's `open`. A host with preview tabs uses it to keep the tab.

```swift
let actions = FileTreeActions(
    open: { url in previewDocument(url) },
    setRoot: { url in tree.setRoot(url) },
    changed: { change in follow(change) },
    guardChange: { url in hasUnsavedEdits(url) ? "Save the file first." : nil },
    menu: menu,
    openKept: { url in keepTab(for: url) }
)
```

#### `FileTreeMenu`

The host's own row menu, used instead of `FileItemMenu`. The tree builds each menu with `PathActionsMenu` from the action list for the row's kind. A file row also gets an "Open" item above the verbs, which calls `actions.open`. The `PathAction`, `PathKind` and `PathMenuHandlers` types come from the Paths folder. A verb without its handler is left out of the menu, and Rename, Duplicate and Move to Trash need `changed` in the handlers.

- `folderActions: [PathAction]`: the verbs for a folder row, in order.
- `fileActions: [PathAction]`: the verbs for a file row, in order.
- `handlers: (URL, PathKind) -> PathMenuHandlers`: returns the host's handlers for one row. These cover the verbs only the host can do (its sidebar, its search, a new file or folder) and what a change did. The tree reads the changed folder again before the handler's `changed` hears about it.

```swift
let menu = FileTreeMenu(
    folderActions: PathAction.folderDefaults,
    fileActions: PathAction.fileDefaults
) { url, kind in
    PathMenuHandlers(
        newFile: { createNote(in: url) },
        changed: { change in follow(change) }
    )
}
```

#### `FileTreePulse`

A request to light up one row (or a header) once. "Show in Sidebar" uses it for the row it scrolled to. Create a new value with a new `token` each time the user asks, and pass it to `FileTreeView(pulse:)` or to the `fileTreePulse` modifier.

- `id: String`: the row to light up. It is the row's absolute path.
- `token: Int`: a new value plays the pulse again. A view that appears later with the same token plays it only while the pulse is fresh.
- `at: Date = Date()`: when it was asked for. A pulse older than `FileTreePulse.lifetime` is stale and does not play, so a row that scrolls into view later does not replay an old one.
- `static let lifetime: TimeInterval = 2`: how long after `at` a pulse still plays, in seconds.
- `func isFresh(now: Date = Date()) -> Bool`: whether the pulse is still younger than `lifetime`.

```swift
pulseToken += 1
pulse = FileTreePulse(id: file.path, token: pulseToken)
tree.reveal(file)
```

#### `View.fileTreePulse(_:color:cornerRadius:)`

Lights a view up once for each new pulse token. A fill and an outline in the given color rise fast and fade, twice, after a short wait for a scroll to land. With Reduce Motion it plays once, slower and without the wait. A new token cuts the old pulse off. `FileTreeView` applies it to its rows. Use it yourself on something else in the same sidebar, such as a header. A nil or stale pulse does nothing.

- `pulse: FileTreePulse?`: the pulse to play.
- `color: Color`: the fill and outline color.
- `cornerRadius: CGFloat = 5`: the corner radius of the fill and outline.

```swift
Text(root.lastPathComponent)
    .padding(6)
    .fileTreePulse(headerPulse, color: .accentColor, cornerRadius: 4)
```

#### `FileItemMenu`

The default context menu of a file or folder, in Finder's order: Open (or Open Folder), Show as Root, Open in Finder (folders) or Open with Default App (files), Show in Finder, Copy Path, Copy Name, Rename…, Duplicate and Move to Trash. It runs the three changing verbs through `FileOperations.runRename`, `runDuplicate` and `runTrash`. Problems are shown in an alert. It has no New File or New Folder items: use `FileTreeMenu` for those. Put it inside `.contextMenu { }`.

- `url: URL`: the file or folder.
- `isFolder: Bool`: changes the wording of the Open items.
- `open: (() -> Void)? = nil`: the Open item runs this. The item is hidden when it is nil.
- `setRoot: (() -> Void)? = nil`: the Show as Root item runs this. The item is hidden when it is nil.
- `guardChange: ((URL) -> String?)? = nil`: returns a reason to refuse a rename or a move to the Trash, or nil to allow it. The reason is shown in an alert.
- `changed: (FileChange) -> Void`: called after a verb succeeds.

`FileChange` describes what happened:

- `renamed(from: URL, to: URL)`: a file or folder got a new name.
- `duplicated(original: URL, copy: URL)`: a copy was made.
- `trashed(URL)`: the item was moved to the Trash.
- `created(URL)`: a new empty file or folder was made (New File… or New Folder…). `FileItemMenu` never reports it. A host's menu handlers do, usually after `FileOperations.runCreate`, and the tree then reads the folder the new item is in again.

```swift
.contextMenu {
    FileItemMenu(url: file, isFolder: false, guardChange: { unsavedReason(for: $0) }) { change in
        if case .renamed(_, let newURL) = change { retitleTab(to: newURL) }
    }
}
```

#### `FileOperations`

The file verbs, as static functions. `FileItemMenu` and the Paths menus use them. Call them when you build your own rename, create or delete UI. A name is trimmed of leading and trailing whitespace first.

Checks and names:

- `static func problem(renaming url: URL, to name: String) -> String?`: why `name` cannot be the new name, or nil when it can. It rejects an empty name, `/` or `:` in the name, `.` and `..`, and a name that already exists in the folder (a case-only change of the same file is allowed).
- `static func problem(creating name: String, in folder: URL) -> String?`: why `name` cannot name a new item in `folder`, or nil when it can. It applies the same name rules and refuses a name that already exists, with no case-only exception, because creating never replaces. On a case-insensitive volume `notes.md` is taken by `Notes.md` too.
- `static func duplicateURL(for url: URL) -> URL`: the URL a copy would get, with Finder's naming: `Note copy.md`, then `Note copy 2.md`, and so on.
- `static func defaultName(for kind: PathKind) -> String`: the suggested name for a new item: `Untitled.md` for a file and `Untitled Folder` for a folder.
- `static func freeName(_ name: String, in folder: URL) -> String`: `name` when it is free in `folder`, else the same name with ` 2`, ` 3` and so on before the extension, such as `Untitled 2.md`. The suggestion is never a name that the prompt would refuse.

Operations that throw:

- `static func create(_ kind: PathKind, named name: String, in folder: URL) throws -> URL`: makes an empty file or a folder and returns its URL. It throws when the name is taken and never replaces a file or merges into a folder.
- `static func rename(_ url: URL, to name: String) throws -> URL`: renames within the same folder and returns the new URL.
- `static func duplicate(_ url: URL) throws -> URL`: copies the item next to the original and returns the copy.
- `static func trash(_ url: URL) throws`: moves the item to the Trash.

Prompts (main actor):

- `static func promptRename(_ url: URL) -> String?`: shows a rename alert with the name selected up to its extension, as Finder does. It returns the typed name, or nil if the user cancels.
- `static func promptName(title: String, detail: String?, initial: String, button: String) -> String?`: an alert with a name field. `initial` is selected up to its extension, so typing replaces the stem and keeps `.md`. `detail` says why the last name was refused and gives the alert a warning style. `button` is the title of the confirm button. It returns nil when the user cancels.

Verbs as a menu runs them (main actor, they show alerts for problems and failures):

- `static func runCreate(_ kind: PathKind, in folder: URL, created: (URL) -> Void)`: New File… or New Folder…. It asks for a name with a free `Untitled.md` (a folder: `Untitled Folder`) suggested, asks again with the reason while the name is taken or invalid, creates the item and hands its URL to `created`.
- `static func runRename(_ url: URL, guardChange: ((URL) -> String?)?, changed: (FileChange) -> Void)`: refuses first with the `guardChange` reason, then asks for a name, checks it and renames. It reports `.renamed`. It does nothing when the name is unchanged.
- `static func runDuplicate(_ url: URL, changed: @escaping (FileChange) -> Void)`: copies the item off the main thread, so a large folder does not freeze the app, and reports `.duplicated`.
- `static func runTrash(_ url: URL, guardChange: ((URL) -> String?)?, changed: (FileChange) -> Void)`: refuses first with the `guardChange` reason, then moves the item to the Trash and reports `.trashed`.

```swift
if let reason = FileOperations.problem(renaming: file, to: "Plan.md") {
    showError(reason)
} else {
    let renamed = try FileOperations.rename(file, to: "Plan.md")
}
FileOperations.runCreate(.file, in: folder) { url in openDocument(url) }
```

#### `FileTreeListing`

Reads one directory for the tree. It never throws: an unreadable folder lists as empty.

- `static func entries(of path: String) -> [FileTreeEntry]`: the folder's items, folders first and then files, each group in Finder's order. Hidden files are skipped, and a package (an `.app` or `.bundle`) counts as one file.

A `FileTreeEntry` has `path: String`, `name: String` and `isFolder: Bool`.

```swift
let items = FileTreeListing.entries(of: "/Users/example/Notes")
let folders = items.filter(\.isFolder).map(\.name)
let files = items.filter { !$0.isFolder }.map(\.name)
print("\(folders.count) folders, \(files.count) files")
```

### Flow

Flow is the dictation feature: the user holds or taps a global shortcut, speaks, and the text lands in the app they were using. A host creates one `FlowFocusRuntime`, which elects an owner process, lets other processes join as clients, and exposes the `FlowSession` that runs the dictation loop. `FlowSession` records through `CompanionSpeechRecognizer`, rewrites the text with `FlowDictionary`, pastes it with `FlowInjector`, and saves history through `FlowStore`. `FlowView`, `FlowSettingsView`, `FlowWidget` and `FlowPillWindowController` are the views over that session. AI rewrites run through `FlowTransformRunner`, or through `FlowTransformTools` when the host wires it in with `FlowFocusHost`. The `Companion...` types and `AudioDevices` are the speech and microphone layer, and `FlowFocusLease`, `FlowFocusMailbox` and `FlowFocusAudioLease` are the owner and client plumbing.

#### `FlowFocusRuntime`

Starts Flow (and the Focus timer) and shares it between app processes. One process wins an owner lock and holds the shortcut, microphone, Focus capture and all disk writes. Every other process becomes a client: it shows the same views over passive models and forwards its commands to the owner. Create one per host, or use `FlowFocusRuntime.shared`.

- `dataRoot: URL? = nil`: folder for Flow and Focus data. `nil` means `FlowFocusRuntime.defaultDataRoot`, which is `~/.genesis`. The lock and the mailbox live in a `feature-runtime` subfolder.
- `hostID: String? = nil`: the name this process registers under. `nil` uses the bundle identifier, or `dev.genesis.feature-host` when there is none.
- `liveServices: Bool = true`: with `false` the runtime registers no dictation shortcut, plays no sounds, shows no notifications and runs no Focus capture. Previews pass `false`.
- `presentsWindows: Bool = true`: with `false` the Focus side installs no menu bar item and shows no timer window.
- `sharedModels: Bool = false`: with `true`, and when `dataRoot` is the default root, the runtime uses `FlowSession.shared` and `FocusController.shared`. Otherwise it builds its own models.

Properties:

- `static let shared`: a runtime on the default data root with shared models.
- `static var defaultDataRoot: URL`: `~/.genesis`.
- `role: Role` (published): `stopped`, `starting`, `owner(String)`, `client(String)` or `unavailable(String)`. The string is the host ID for an owner or client, and the failure message for `unavailable`. `role.isOwner` is true for `owner`.
- `lastError: String?` (published): the last runtime failure.
- `flow: FlowSession`: the dictation model.
- `focus: FocusController`: the Focus (timer and activity) model.
- `configuration: FlowFocusConfiguration`: the settings this runtime reads and writes.
- `dataRoot: URL`, `directory: URL`, `hostID: String`, `liveServices: Bool`: the values the runtime was created with. `directory` is the `feature-runtime` folder.
- `settingsOnly: Bool = false`: set before `start()` by a face that only edits settings. It never takes the owner role, so it starts no capture, shortcut or Do Not Disturb, and plays no sounds. It joins the running owner as a client.

Methods:

- `start() async`: elects a role. It does nothing when the runtime is already starting, owner or client. On failure `role` becomes `unavailable` and `lastError` says why.
- `stop() async`: shuts down. A host awaits it from its terminate-later path. It waits for recording to stop, the command the owner already took, and queued settings writes, then releases the lock. A terminating host should bound the wait (5 s).
- `send(action: String, payload: Data = Data()) async throws -> Data`: sends one command to the owner and returns its reply. Action names such as `flow.end` are internal to the runtime.
- `acquireExternalAudio() async throws -> FlowFocusAudioLease`: asks the owner for permission to record with another recorder. Dictation refuses to start while the lease is held.
- `beginDictation()`: starts a dictation turn aimed at the frontmost app that is not Genesis, or the last such app.
- `showDictation()`: opens the "Dictation" window with a `FlowView`.
- `showStudio()`: opens Focus Studio.
- `showTimer()`: shows the Focus timer HUD.

```swift
let runtime = FlowFocusRuntime(
    dataRoot: URL(fileURLWithPath: "/tmp/flow-demo"),
    hostID: "com.example.host",
    liveServices: false
)
Task {
    await runtime.start()
    if runtime.role.isOwner { runtime.showDictation() }
}
```

#### `FlowSession`

The dictation loop and its observable state. One turn: capture the frontmost app, start the recognizer, wait for the end of the turn, wait a trailing grace, finalize, apply dictionary rules and snippets, paste, then record history and stats. In a client process the mutating calls go to the owner. Only the owner registers the shortcut and records history. Get it from `FlowFocusRuntime.flow`.

- `store: FlowStore? = nil`: the store to read and write. `nil` uses `FlowStore.shared`.

Properties (published unless noted):

- `static let shared` (not published): the process-wide session. Its store is read-only until a runtime configures it.
- `phase: FlowPhase`: where the current turn is.
- `lastError: String?`: the last failure message, such as a refused paste.
- `isRequestingPermissions: Bool`: true while the Microphone and Speech Recognition request runs.
- `accessibilityTrusted: Bool`: whether the owner process may post the paste keystroke.
- `lastInjected: String?`: the text of the last finished turn, or `nil` when that paste was withheld because the clipboard changed. It is cleared when the next turn begins.
- `labEnabled: Bool`: the Labs switch for dictation (`app.labs.dictation`, default on).
- `hotkeyStatus: GlobalHotkeyStatus`: whether the shortcut is live.
- `config: FlowConfig` (settable): the settings. Setting it saves the file, applies the shortcut and pre-roll, and rolls the value back if the save fails.
- `history: [FlowEntry]`, `stats: FlowStats`, `suggestions: [FlowSuggestion]`: read-only results.
- `dictionary: [FlowDictionaryRule]`, `snippets: [FlowSnippet]`, `transforms: [FlowTransform]`: the stored rules. Change dictionary and snippets with the methods below so the change is saved.
- `let recognizer: CompanionSpeechRecognizer` (not published): exposed so a view can observe `partialText` and `micLevel` without invalidating the whole session.

Lifecycle:

- `start()`: registers the shortcut and starts pre-roll when dictation is on. Safe to call twice. It does nothing in a client or on a read-only store.
- `stop()`: removes the shortcut, hides the pill, stops pre-roll and cancels the turn.
- `suspendHotkey(_ suspended: Bool)`: unregisters the shortcut while a shortcut recorder listens, and cancels a listening turn. The owner registers it again by itself after two minutes.
- `setLabEnabled(_ on: Bool)`: the Labs switch. Off drops the shortcut and any turn in progress.
- `requestDictationPermissions()`: asks for Microphone, then Speech Recognition, in the owner process.
- `requestAccessibility()`: asks the owner process for Accessibility.

Turns:

- `beginTurn(target: FlowFocusTarget? = nil, captureCurrentTarget: Bool = true)`: starts listening. With `captureCurrentTarget` true it captures the frontmost app first. Pass `false` and a `target` to choose the paste target yourself.
- `endTurn()`: stops listening and runs the rest of the pipeline.
- `cancelTurn()`: drops the turn and pastes nothing.
- `toggleFromMenu()`: starts a turn, or ends the one that is listening. It works when the shortcut is taken.
- `static func offReason(labEnabled: Bool, enabled: Bool) -> String?`: the sentence that says why dictation cannot start, or `nil` when both switches are on.
- `static func turnStart(phase: FlowPhase, labEnabled: Bool, enabled: Bool) -> TurnStart`: whether a press may start a turn. `TurnStart` is `begin`, `busy` or `off(String)`.
- `static func streak(endingAt now: Date, previous: Date?, current: Int) -> Int`: the consecutive-day counter. Same day keeps it, the next day adds one, a longer gap resets it to 1.

Edits:

- `addRule(from: String, to: String)` and `removeRule(_ id: UUID)`: add or remove a dictionary rule.
- `acceptSuggestion(_ suggestion: FlowSuggestion, replacement: String)`: turns a suggestion into a learned rule.
- `dismissSuggestion(_ suggestion: FlowSuggestion)`: removes it and stops the learner from proposing that word again.
- `addSnippet(trigger: String, body: String)` and `removeSnippet(_ id: UUID)`: add or remove a snippet.
- `deleteEntry(_ id: UUID)`: removes one history entry and subtracts it from the stats.
- `clearHistory()`: empties history and resets the stats.
- `copyEntry(_ entry: FlowEntry)`: puts the entry text on the clipboard.
- `loadScratchpad() -> String` and `saveScratchpad(_ text: String)`: read and write the scratchpad text.

```swift
let session = FlowFocusRuntime.shared.flow
session.config.activation = .toggle
session.addRule(from: "next js", to: "Next.js")
session.toggleFromMenu()
```

#### `FlowView`

The main dictation window content: a section rail on the left and the selected section on the right. Show it in your own window, or call `FlowFocusRuntime.showDictation()`.

- `session: FlowSession`: the model the view observes.
- `initialSection: FlowSection = .dictation`: the section selected first.

`FlowView.FlowSection` has the cases `dictation` (history with search), `insights` (stats), `dictionary`, `snippets`, `transforms`, `scratchpad` and `settings`. Each case has a `title` and an SF Symbol name in `icon`.

```swift
FlowView(session: runtime.flow, initialSection: .insights)
    .frame(minWidth: 760, minHeight: 540)
    .preferredColorScheme(.dark)
```

#### `FlowSettingsView`

The dictation settings in the shared native settings style. It shows four cards: Access (Microphone, Speech Recognition and Accessibility), Shortcut (on/off, the shortcut recorder, activation mode), Recognition (language, trailing grace, capture before the shortcut, server recognition, dictionary learning) and Output (pill, automatic paste, clipboard restore). The Settings window and the `settings` section of `FlowView` use this same view.

- `session: FlowSession`: the model whose `config` the controls edit.
- `openLibrary: (() -> Void)? = nil`: when set, the view adds an "Open library" row that calls it. Pass `nil` inside the library itself.

```swift
ScrollView {
    FlowSettingsView(session: runtime.flow, openLibrary: { runtime.showDictation() })
        .padding(20)
}
```

#### `FlowWidget`

Quick dictation and Focus controls for the widget. It has a compact form (status text or clock), a preview form (header, Dictate button, clock, links) and an expanded form (live transcript, the Focus HUD, links to the dictation library and Focus Studio, the last three dictations, errors). Showing it never starts a recorder or a timer. The host owns the runtime start and stop.

- `runtime: FlowFocusRuntime`: the runtime the controls act on.
- `presentation: WidgetModulePresentation = .expanded`: `compact`, `preview` or `expanded`.
- `static func module(runtime: FlowFocusRuntime) -> WidgetModuleDescriptor`: the ready-made widget module: id `focus`, title "Flow", symbol `mic.fill`, expanded size 432 by 480. Its summary reads "Listening" while the phase is `listening` and "Dictation & Focus" otherwise.

```swift
FlowWidget(runtime: runtime, presentation: .preview)
// Or register it as a module:
let descriptor = FlowWidget.module(runtime: runtime)
```

#### `FlowPillWindowController`

Owns the small floating panel that shows the dictation pill (a phase label, a microphone button and level bars, built by `FlowPillView`). The panel is non-activating, never takes mouse events, joins all Spaces, and sits at the bottom center of the screen that holds the mouse. It is 260 by 96 points. `FlowSession` builds its own controller around `FlowPillView` and shows it for the `listening`, `transcribing`, `injecting` and `error` phases when `FlowConfig.showPill` is on. Build your own controller for a different pill. `FlowPillView` itself has no public init.

- `content: () -> AnyView`: builds the SwiftUI content once, when the panel is first made.

Methods:

- `show()`: positions the panel on the screen with the mouse and shows it.
- `hide()`: hides it.
- `prewarm()`: builds and lays out the panel while invisible, so the first `show()` is fast.

```swift
let pill = FlowPillWindowController { AnyView(Text("Dictating").padding()) }
pill.prewarm()
pill.show()
```

#### `FlowTransformSettingsView`

The "Text transforms" settings card. The user picks a provider, an account and a model, then presses Save. The view loads the choices from `FlowTransformTools.choices()`, shows "Saved" for two seconds after a successful write, and shows errors with a "Reload choices" button.

- `tools: FlowTransformTools`: the tools object that loads choices and stores the selection.

```swift
let tools = FlowTransformTools(
    bridge: ToolsBridge(binaryPath: "/usr/local/bin/tools"),
    configuration: runtime.configuration
)
FlowTransformSettingsView(tools: tools)
```

#### `FlowFocusHost`

Host-only hooks that shared views cannot decide. There is one instance, `FlowFocusHost.shared`, and a host sets the hooks once at start-up.

Properties:

- `openSettings: () -> Void = {}`: called when a Flow or Focus view asks to open the settings window.
- `notificationsEnabled: Bool = false`: whether Focus may post notifications. `FlowFocusRuntime` sets it on start from `liveServices` and `settingsOnly`.
- `soundsEnabled: Bool = false`: whether Focus may play sounds. `FlowFocusRuntime` sets it the same way.
- `transformConfiguration: (() -> FlowTransformConfiguration)?`: supplies the AI backend for `FlowTransformRunner`. `nil` means it reads `FlowFocusConfiguration.shared.transformConfiguration`.
- `runTransform: ((FlowTransformRequest) async throws -> String)?`: when set, `FlowTransformRunner.run` sends every transform here instead of calling a backend itself.

```swift
FlowFocusHost.shared.openSettings = { openMySettingsWindow() }
FlowFocusHost.shared.runTransform = { request in
    try await transformTools.run(request)
}
```

#### `FlowFocusConfiguration`

The Flow and Focus view of the stored settings file. It reads the `app` section of `client.json` in its directory (falling back to `config.json`) and writes only patches to it, under a cross-process lock file, never replacing keys it does not own. A runtime client hands each patch to the owner instead of writing. Views observe it, and `revision` changes after each change.

- `directory: URL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".genesis")`: the folder that holds `client.json`.

Properties:

- `static var shared`: the configuration most views read. `FlowFocusRuntime` replaces it with its own.
- `readApp: (() -> [String: Any])?`: supplies the live `app` dictionary instead of the file's cached copy.
- `forwardPatch: (([String: Any]) throws -> Task<Void, Error>)?`: set on a runtime client. It hands a patch to the owner, and the returned task ends once the owner stored it.
- `onFailure: ((String) -> Void)?`: called with each reported failure.
- `didPersist: (() -> Void)?`: called after a write reached the file.
- `revision: UInt64` (published): grows with every change or failure.
- `lastError: String?` (published): the last failure message.
- `allowsWrites: Bool = false`: whether this process may write the file. The owner sets it.
- `directory: URL`: the folder given at init.
- `app: [String: Any]`: the current `app` settings, including pending writes.
- `dictationEnabled: Bool`: `app.labs.dictation`, default `true`.
- `transformConfiguration: FlowTransformConfiguration`: the AI backend resolved from the settings (base URL, model, token).

Methods:

- `reload()`: reads the file again.
- `dismissError()`: clears `lastError`.
- `setAppValue(_ value: Any, forKey key: String)`: merges one key into `app` and writes it in the background. The value must be valid JSON, or the call reports a failure.
- `saveAppValue(_ value: Any, forKey key: String) async -> Bool`: the same, then waits. It returns `false` when the write was refused or failed.
- `flush() async`: waits until every earlier write reached disk, and for a client until the owner answered every patch.

```swift
let configuration = FlowFocusConfiguration(directory: URL(fileURLWithPath: "/tmp/flow-demo"))
configuration.allowsWrites = true
let saved = await configuration.saveAppValue(["dictation": false], forKey: "labs")
print(saved, configuration.dictationEnabled)
```

#### `FlowTransformTools`

Runs and configures AI transforms through the `tools voice transforms` command, using an account and model the user already set up. It passes only an account and model reference as arguments. The transcript goes through a private temporary file, never through process arguments. Use it as the native host's `FlowFocusHost.runTransform`.

- `bridge: ToolsBridge`: runs the `tools` binary.
- `configuration: FlowFocusConfiguration`: where the selected model reference is stored.

Properties and methods:

- `modelRef: String`: the stored reference, in the form `@account/<accountID>:<model>`, or `""` when none is set.
- `save(accountID: String, model: String) async -> Bool`: stores the choice. It returns `false` when the write was refused or failed. The result may be ignored.
- `choices() async throws -> FlowTransformChoices`: lists the available providers. `FlowTransformChoices.providers` holds `Provider` values with `id`, `title`, `accounts` (each with `id` and `name`) and `models` (each with `id` and `title`).
- `run(_ request: FlowTransformRequest) async throws -> String`: runs one transform and returns the rewritten text. It throws `ToolsBridgeError.refused` when no model is chosen or the timeout is not a positive number. The timeout is limited to 1 to 120 seconds.

```swift
let tools = FlowTransformTools(
    bridge: ToolsBridge(binaryPath: "/usr/local/bin/tools"),
    configuration: runtime.configuration
)
let choices = try await tools.choices()
if let provider = choices.providers.first, let account = provider.accounts.first, let model = provider.models.first {
    _ = await tools.save(accountID: account.id, model: model.id)
}
```

#### `FlowTransformRunner`

Applies a `FlowTransform` to a text and returns the rewritten text. Transforms never run on their own. The user chooses one for a transcript. The runner sends the transform's prompt as the system message and the text as the user message, so text that reads like an instruction cannot retarget the transform.

- `static let wordLimit = 1_000`: the longest input, in words.
- `RunError`: `notConfigured` (no backend or model), `tooLong(Int)` (the word count), `backend(String)` (the backend's message) and `empty` (empty input or empty reply).

Methods:

- `static func run(_ transform: FlowTransform, on text: String, timeout: TimeInterval = 30) async throws -> String`: uses `FlowFocusHost.runTransform` when it is set. Otherwise it posts to `<baseURL>/chat/completions` of the `FlowTransformConfiguration` from the host or from `FlowFocusConfiguration.shared`.
- `static func systemPrompt(for transform: FlowTransform) -> String`: the transform's prompt plus the instruction to treat the user message as text, not as a command.
- `static func resolveToken(configured: String, baseURL: String = "") -> String?`: an explicit token wins. Without one, the key of the local AI proxy is used, and only for a plain-http loopback address on the proxy's own port.
- `static func message(from data: Data, status: Int) -> String`: the readable sentence from a backend error body.

```swift
if let transform = session.transforms.first {
    let result = try await FlowTransformRunner.run(transform, on: "um so the build is uh green", timeout: 20)
    print(result)
}
```

#### `FlowTransformRequest`

One transform call, as `FlowFocusHost.runTransform` and `FlowTransformTools.run` receive it. Codable and Sendable.

- `systemPrompt: String`: the instruction.
- `text: String`: the text to rewrite.
- `timeout: TimeInterval = 30`: seconds to wait.

```swift
let request = FlowTransformRequest(
    systemPrompt: "Fix the grammar.",
    text: "me and him goes home",
    timeout: 15
)
let rewritten = try await FlowFocusHost.shared.runTransform?(request)
```

#### `FlowTransformConfiguration`

The OpenAI-compatible backend a transform calls when no `runTransform` hook is set. Sendable.

- `baseURL: String`: the API base, for example `http://127.0.0.1:8317/v1`.
- `model: String`: the model name.
- `token: String = ""`: an explicit bearer token. Empty means `FlowTransformRunner.resolveToken` decides.

```swift
FlowFocusHost.shared.transformConfiguration = {
    FlowTransformConfiguration(baseURL: "http://127.0.0.1:8317/v1", model: "demo-model")
}
```

#### `FlowStore`

The on-disk home for everything Flow owns, by default `~/.genesis/flow/`. Each file is written to a temporary file and renamed over the target, with owner-only permissions. A file that cannot be decoded is renamed to `<name>.corrupt-<unix time>`, never overwritten. A store with `writesEnabled` false refuses writes. When `forwardWrite` is set, most saves go to it instead of the disk. A runtime client uses that to hand writes to the owner.

- `directory: URL? = nil`: the folder. `nil` means `~/.genesis/flow`.
- `writesEnabled: Bool = true`: whether this store may write.

Properties:

- `static var shared`: the default store, read-only until a runtime replaces it.
- `directory: URL`: the folder.
- `eventsURL: URL`: the `events.jsonl` log that `FlowEvents` appends to.
- `writesEnabled: Bool`: settable.
- `forwardWrite: ((String, Data) -> Void)?`: receives a file name and its data instead of a local write.
- `didWrite: (() -> Void)?`: called after a write landed.
- `onFailure: ((String) -> Void)?`: called with a failure message.
- `static let defaultTransforms: [FlowTransform]`: the shipped set: "Clean up" (the default), "Email", "Bullets" and "Commit message". `loadTransforms()` returns them when no file exists or the file cannot be decoded. They are not re-seeded if the user empties the file.

Methods:

- `loadConfig() -> FlowConfig` and `saveConfig(_ value: FlowConfig)`: `config.json`.
- `loadHistory() -> [FlowEntry]` and `saveHistory(_ value: [FlowEntry]) -> Bool` (discardable): `history.json`.
- `loadStats() -> FlowStats` and `saveStats(_ value: FlowStats)`: `stats.json`.
- `loadDictionary() -> [FlowDictionaryRule]` and `saveDictionary(_ value: [FlowDictionaryRule])`: `dictionary.json`.
- `loadSuggestions() -> [FlowSuggestion]` and `saveSuggestions(_ value: [FlowSuggestion])`: `suggestions.json`.
- `loadSnippets() -> [FlowSnippet]` and `saveSnippets(_ value: [FlowSnippet])`: `snippets.json`.
- `loadTransforms() -> [FlowTransform]` and `saveTransforms(_ value: [FlowTransform])`: `transforms.json`.
- `loadScratchpad() -> String` and `saveScratchpad(_ text: String)`: `scratchpad.md`.

```swift
let store = FlowStore(directory: URL(fileURLWithPath: "/tmp/flow-demo/flow"), writesEnabled: true)
var config = store.loadConfig()
config.showPill = false
store.saveConfig(config)
let recent = store.loadHistory().prefix(5)
```

#### `FlowConfig`

The persisted Flow settings, saved in `config.json` of the `FlowStore`. Decoding keeps the default for any missing key, rejects a `historyLimit` below 1, and clamps `trailingGraceMs` into its range. `FlowSession.config` is the live copy.

- `init()`: all defaults.
- `enabled: Bool = true`: Flow's own on/off switch. Dictation needs this and the Labs switch.
- `activation: FlowActivation = .pushToTalk`: `pushToTalk` (hold the shortcut, release to send) or `toggle` (press to start, press to stop). `FlowActivation.label` gives "Push to talk" or "Toggle".
- `keyCode: UInt32 = 0x02`: the Carbon virtual key code of the shortcut (`D`).
- `modifiers: UInt32 = FlowConfig.defaultModifiers`: the Carbon modifier mask (control, option, command).
- `localeIdentifier: String = ""`: the recognition language. Empty means the system language.
- `forceServerRecognition: Bool = false`: use Apple's server recognition instead of on-device recognition.
- `trailingGraceMs: Int = 350`: milliseconds the microphone stays open after release, within `FlowConfig.trailingGraceRange` (0 to 2000).
- `preRoll: Bool = false`: keep a rolling 0.6 s window (`FlowPreRoll.windowSeconds`) of microphone audio in memory so the first word is not lost. The microphone stays open while it is on.
- `injectViaPaste: Bool = true`: put the text on the clipboard and send the paste keystroke.
- `restoreClipboard: Bool = false`: put the previous clipboard text back after pasting. It is off on purpose, because it can expose a password that was on the clipboard.
- `muteSystemAudioWhileRecording: Bool = false`: a stored flag for muting output while recording. Nothing in GenesisKit reads it yet.
- `soundCues: Bool = true`: a stored flag for a short cue on start and stop. Nothing in GenesisKit reads it yet.
- `dictionaryLearning: Bool = true`: suggest dictionary rules from transcripts.
- `historyLimit: Int = 2000`: the most history entries to keep.
- `showPill: Bool = true`: show the floating pill while dictating.

Statics and methods:

- `static let defaultModifiers: UInt32`: control, option and command. `static let legacyModifiers: UInt32` is the older control and option pair.
- `static let trailingGraceRange`: `0...2_000`.
- `func migratingLegacyChord() -> FlowConfig`: moves a config that still uses the old control-option-D shortcut to the new default. Any other shortcut stays.

```swift
var config = FlowConfig()
config.activation = .toggle
config.trailingGraceMs = 500
config.preRoll = true
session.config = config
```

#### `FlowPhase`

Where a dictation turn is. `FlowSession.phase` holds it, and the pill and widget show it.

- `idle`: no turn.
- `listening`: the microphone is recording.
- `transcribing`: the turn ended and the recognizer is finishing.
- `injecting`: the text is being pasted. It is its own phase so a failed paste is visible as such.
- `error`: the last attempt failed. `FlowSession.lastError` says why.

```swift
switch session.phase {
case .idle: Text("Ready")
case .listening: Text("Listening")
case .transcribing, .injecting: ProgressView()
case .error: Text(session.lastError ?? "Failed")
}
```

#### `GlobalHotkeyStatus`

Whether a global shortcut is live. Carbon reports a refusal only inside this process, so `registered` does not prove another app is not using the same shortcut. `FlowSession.hotkeyStatus` holds it.

- `off`: switched off.
- `registered(chord: String)`: Carbon accepted the shortcut.
- `unavailable(chord: String)`: Carbon refused it.
- `func menuTitle(_ action: String) -> String`: the action followed by the shortcut, or "(shortcut unavailable)", or the action alone when off.

```swift
switch session.hotkeyStatus {
case .registered(let chord): Text("Shortcut: \(chord)")
case .unavailable(let chord): Text("macOS refused \(chord)")
case .off: Text("Dictation is off")
}
Button(session.hotkeyStatus.menuTitle("Start dictation")) { session.toggleFromMenu() }
```

#### `FlowEntry`

One finished dictation in `FlowSession.history`. Codable and Identifiable. It has no public memberwise init: `FlowSession` creates entries, and decoding accepts the stored JSON.

- `id: UUID`: stable identifier.
- `text: String`: the final text, after dictionary and snippets.
- `rawText: String`: what the recognizer returned, before any rewrite.
- `targetBundleId: String?`: the bundle id of the app that received the text, if any.
- `targetAppName: String?`: that app's name at capture time.
- `createdAt: Date`: when the turn finished.
- `durationSeconds: Double`: seconds from the start of the turn until the recognizer returned its text.
- `injected: Bool`: whether the paste landed.
- `wordCount: Int`: words in `text`.
- `wordsPerMinute: Double?` (computed): `nil` when the turn was under one second or empty.

```swift
if let latest = session.history.first {
    Text("\(latest.text) (\(latest.wordCount) words)")
}
```

#### `FlowStats`

Lifetime counters for the Insights section. Automatic history trimming does not reduce them. `deleteEntry` subtracts one turn and `clearHistory` resets them. `FlowSession.stats` holds them, and the type has no public init.

- `totalWords: Int`: words dictated.
- `totalSeconds: Double`: the sum of `durationSeconds` over all turns.
- `sessionCount: Int`: number of turns.
- `dayStreak: Int`: consecutive days with a dictation, counting back from the latest.
- `lastDictationAt: Date?`: when the last turn finished.
- `averageWpm: Double` (computed): words per minute over all turns, or 0 when there is too little data.

```swift
VStack(alignment: .leading) {
    Text("\(session.stats.totalWords) words in \(session.stats.sessionCount) turns")
    Text("\(Int(session.stats.averageWpm)) wpm, \(session.stats.dayStreak) day streak")
    if let last = session.stats.lastDictationAt { Text("Last: \(last.formatted())") }
}
```

#### `FlowDictionaryRule`

A literal replacement applied to every transcript. `from` matches case-insensitively on word boundaries, and `to` is inserted as written, so "next js" becomes "Next.js". `FlowSession.dictionary` holds the rules. Create one with `FlowSession.addRule(from:to:)`, because the type has no public memberwise init.

- `id: UUID`: stable identifier.
- `from: String`: the heard text.
- `to: String`: the replacement.
- `enabled: Bool = true`: disabled rules are skipped.
- `learned: Bool = false`: true when the rule came from an accepted suggestion.
- `createdAt: Date`: when it was added.

```swift
session.addRule(from: "type script", to: "TypeScript")
let learned = session.dictionary.filter(\.learned)
if let rule = learned.first { session.removeRule(rule.id) }
let preview = FlowDictionary.apply(session.dictionary, to: "I use type script")
```

#### `FlowSnippet`

A phrase that expands on a spoken trigger. `FlowDictionary.expand` applies it. Create one with `FlowSession.addSnippet(trigger:body:)`. The type has no public memberwise init. The body may contain `{{date}}`, `{{time}}`, `{{datetime}}`, `{{clipboard}}` and `{{newline}}`.

- `id: UUID`: stable identifier.
- `trigger: String`: the spoken phrase.
- `body: String`: the text that replaces it.
- `enabled: Bool = true`: disabled snippets are skipped.

```swift
session.addSnippet(trigger: "log stamp", body: "[{{datetime}}]")
let text = FlowDictionary.expand(session.snippets, in: "log stamp: build finished")
print(text)
if let snippet = session.snippets.first(where: { $0.trigger == "log stamp" }) {
    session.removeSnippet(snippet.id)
}
```

#### `FlowSuggestion`

A dictionary entry the learner proposes. The user accepts it with `FlowSession.acceptSuggestion(_:replacement:)` or dismisses it with `FlowSession.dismissSuggestion(_:)`. `FlowSession.suggestions` holds them, and the type has no public memberwise init.

- `id: UUID`: stable identifier.
- `heard: String`: the spelling the recognizer keeps producing.
- `suggested: String`: the proposed spelling. For `technicalTerm` it equals `heard` and the user is expected to correct it.
- `reason: FlowSuggestionReason`: `variantSpread` (several spellings of one term) or `technicalTerm` (an uncommon technical word that recurs).
- `occurrences: Int`: how often the word was heard.
- `firstSeen: Date`: when it was first heard.

```swift
for suggestion in session.suggestions {
    session.acceptSuggestion(suggestion, replacement: suggestion.suggested)
}
```

#### `FlowTransform`

A named rewrite prompt, such as "Clean up" or "Email". The prompt runs on a transcript only when the user picks it. `FlowSession.transforms` holds them, and `FlowStore.defaultTransforms` ships four. The type has no public memberwise init.

- `id: UUID`: stable identifier.
- `name: String`: the label.
- `prompt: String`: the instruction sent as the system message.
- `enabled: Bool = true`: whether the transform is offered.
- `appBundleIds: [String] = []`: bundle ids of target apps the transform is meant for. Nothing in GenesisKit reads it yet.
- `isDefault: Bool = false`: marks the default transform. The library window shows a "default" badge for it. Only "Clean up" sets it in `FlowStore.defaultTransforms`.

```swift
let enabled = session.transforms.filter(\.enabled)
let chosen = enabled.first(where: \.isDefault) ?? enabled.first
if let transform = chosen {
    let result = try await FlowTransformRunner.run(transform, on: "um so it works", timeout: 20)
    print(transform.name, result)
}
```

#### `FlowDictionary`

Static text functions for the dictionary, snippets and the learner. All rules apply in a single pass, longest match first, so a later rule cannot rewrite the output of an earlier one. A word boundary is added only on an edge that is a letter, digit or underscore, so terms such as "c++" still match.

Rewriting:

- `static func apply(_ rules: [FlowDictionaryRule], to text: String) -> String`: applies the enabled rules.
- `static func expand(_ snippets: [FlowSnippet], in text: String, now: Date = Date()) -> String`: expands enabled snippet triggers and resolves their variables.
- `static func resolveVariables(in body: String, now: Date = Date()) -> String`: replaces `{{date}}` (2026-07-29), `{{time}}` (14:32), `{{datetime}}`, `{{clipboard}}` and `{{newline}}`. Unknown names stay as written.

Learning:

- `static func tokenize(_ text: String) -> [String]`: lowercase word tokens, without digits or punctuation (an apostrophe and a hyphen stay), at least three bytes long.
- `static func isCommonWord(_ token: String) -> Bool`: whether the token is in the built-in list of very common English words.
- `static func isLikelyTechnical(_ token: String) -> Bool`: true for a token of four or more bytes that is not common and that has a hyphen, very few vowels, or at least eight bytes.
- `WordStats`: per-word counters, `occurrences: Int = 0` and `lastSeen: Date = Date()`.
- `static func learn(from transcript: String, stats: inout [String: WordStats], existingRules: [FlowDictionaryRule], dismissed: Set<String>, minimumOccurrences: Int = 3) -> [FlowSuggestion]`: counts the tokens of one transcript and returns a `technicalTerm` suggestion for each likely technical token that reaches `minimumOccurrences` and is neither a rule nor dismissed.

```swift
let fixed = FlowDictionary.apply(session.dictionary, to: "i use next js")
let text = FlowDictionary.expand(session.snippets, in: fixed)
var stats: [String: FlowDictionary.WordStats] = [:]
let raised = FlowDictionary.learn(from: text, stats: &stats, existingRules: session.dictionary, dismissed: [])
```

#### `FlowInjector`

Puts text into the app the user was using. It writes the clipboard (and asks clipboard managers not to record the text), brings the saved target back to the front, and posts a synthetic command-V. Without Accessibility it still copies the text and returns `notPermitted`. It withholds the keystroke when the target is not in front at paste time, or when the clipboard changed during the short wait.

- `static var isAccessibilityTrusted: Bool`: whether the app may post the keystroke. It never prompts.
- `static func requestAccessibility()`: asks macOS to show the Accessibility prompt.
- `static func openAccessibilitySettings()`: opens the Accessibility pane.
- `static func inject(_ text: String, into target: FlowFocusTarget?, usePaste: Bool, restoreClipboard: Bool) async -> FlowInjectOutcome`: delivers the text. The result may be ignored.

`FlowInjectOutcome` is one of:

- `injected`: the paste was sent.
- `empty`: there was nothing to paste.
- `targetLost`: the captured app has quit.
- `notPermitted`: Accessibility is missing, so the text is only copied.
- `copiedOnly`: the text is on the clipboard and no keystroke was sent (`usePaste` false, or no target).
- `focusMoved`: the target was not in front at paste time.
- `clipboardChanged`: something else was copied during the wait.

```swift
let outcome = await FlowInjector.inject(
    "Hello",
    into: FlowFocusTarget.capture(),
    usePaste: true,
    restoreClipboard: false
)
if outcome == .notPermitted { FlowInjector.requestAccessibility() }
```

#### `FlowFocusTarget`

The app that was in front when dictation started. `FlowSession` captures it before any Flow window can appear, because once Flow shows a window the user's text field is no longer in front. Codable. It has no public memberwise init.

- `bundleIdentifier: String?`: the app's bundle id.
- `localizedName: String?`: the app's name.
- `processIdentifier: pid_t`: the process id.
- `static func capture() -> FlowFocusTarget?`: the current frontmost app, or `nil` when it is the current process itself (the turn then only transcribes).
- `func reactivate() -> Bool` (discardable): brings the app back to the front. It returns `false` when the app quit.

```swift
let target = FlowFocusTarget.capture()
session.beginTurn(target: target, captureCurrentTarget: false)
let name = target?.localizedName ?? "no app"
print("Dictating into \(name)")
```

#### `FlowEvents`

The completion hook for other tools. After each finished turn it posts `Notification.Name.genesisFlowTranscript` on the main queue and appends one JSON line to the store's `events.jsonl` (`~/.genesis/flow/events.jsonl` by default), which a script can follow with `tail -f`. Deleting or trimming history removes the matching lines.

- `static let payloadKey = "payload"`: the `userInfo` key that holds the payload.
- `Payload`: Codable. Fields: `id: UUID`, `text: String`, `rawText: String` (before dictionary and snippets), `targetBundleId: String?`, `targetAppName: String?`, `injected: Bool`, `wordCount: Int`, `durationSeconds: Double`, `createdAt: Date`.
- `static func publish(_ entry: FlowEntry, to url: URL? = nil)`: posts the notification and appends the line. `FlowSession` calls it after each turn with `FlowStore.eventsURL`. `nil` uses the default log.

```swift
let token = NotificationCenter.default.addObserver(forName: .genesisFlowTranscript, object: nil, queue: .main) { note in
    MainActor.assumeIsolated {
        let payload = note.userInfo?[FlowEvents.payloadKey] as? FlowEvents.Payload
        print(payload?.text ?? "")
    }
}
```

#### `FlowKeyNames`

Turns a Carbon key code and modifier mask into text a person reads.

- `static func describe(keyCode: UInt32, modifiers: UInt32) -> String`: modifiers first in the order control, option, shift, command, then the key name, for example `⌃⌥⌘D`.
- `static func keyName(_ code: UInt32) -> String`: the key cap label for an ANSI key code, or `Key <code>` for an unknown one.

```swift
let config = session.config
let chord = FlowKeyNames.describe(keyCode: config.keyCode, modifiers: config.modifiers)
let key = FlowKeyNames.keyName(0x31)
print(chord, key)
```

#### `CompanionSpeechRecognizer`

Push-to-talk speech recognition on Apple Speech, with the microphone hot only between `start()` and `finish()` or `cancel()`. It copes with pauses: when Speech closes an utterance while the hold continues, the recognizer starts a new recognition task, and the text of all utterances is kept. If the streaming result is empty although audio arrived, it recognizes the captured clip once more before it reports silence. `FlowSession` owns one as `recognizer`.

- `audioSource: CompanionAudioSource? = nil`: where audio comes from. `nil` uses a `CompanionMicSource`.

Properties:

- `preRollProvider: (() -> [AVAudioPCMBuffer])?`: returns audio captured before `start()`. Flow sets it from its pre-roll. Buffers whose format differs from the live format are dropped.
- `audioSource: CompanionAudioSource`: the current source.
- `avoidBluetoothMic: Bool`: records from the built-in microphone when the default input is Bluetooth. It acts only on a `CompanionMicSource`.
- `retryOnEmpty: Bool = true`: retry the captured clip after an empty streaming result.
- `recognizes: Bool = true`: with `false` a hold only captures audio and starts no recognition task.
- `partialText: String` (published): the whole hold so far.
- `micLevel: Double` (published): the microphone level from 0 to 1.
- `lastHold: HoldReport?`: the report of the last finished hold. `HoldReport` has `text`, `stats`, `heldMs`, `tailMs` and `retried`. `stats` has `buffers`, `frames`, `sampleRate`, `firstBufferMs`, `peakLevel` and `audioMs`.

Methods:

- `start(locale: Locale = .current, forceServer: Bool = false) throws`: begins capture and recognition. It throws a `CompanionSpeechError`, or the error of the audio source. Without `forceServer`, a language that has no on-device model is refused instead of sent to Apple.
- `finish(timeoutSeconds: Double = 3.0, tailMs: Int = 0) async -> String`: ends the hold, keeps capturing for `tailMs`, waits for the final result and returns the text. It never throws and returns `""` for a silent hold.
- `cancel()`: aborts and drops the text.
- `static func speechAuthorized() -> Bool`, `speechAuthorizationDetermined() -> Bool`, `micAuthorized() -> Bool`: read the permission state.
- `static func requestSpeechAuthorization() async -> Bool`, `requestMicAuthorization() async -> Bool`: ask for a permission.
- `static func normalizedLocale(_ locale: Locale) -> Locale`: drops the preference subtags (such as `@rg=...`) that make Speech resolve the language erratically.
- `static func transcribe(buffer: AVAudioPCMBuffer, recognizer: SFSpeechRecognizer, onDevice: Bool, timeoutSeconds: Double) async -> String`: recognizes one finished clip.
- `static func transcribeFile(_ url: URL, locale: Locale = .current, forceServer: Bool = false) async -> String`: recognizes an audio file. It returns `""` on any failure.

```swift
let recognizer = CompanionSpeechRecognizer()
try recognizer.start(locale: Locale(identifier: "en_US"))
// The user speaks. partialText updates meanwhile.
let text = await recognizer.finish(tailMs: 300)
let fromFile = await CompanionSpeechRecognizer.transcribeFile(URL(fileURLWithPath: "/tmp/sample.wav"))
```

#### `CompanionTranscriptAccumulator`

Per-hold transcript state. One hold can contain several utterances, and a later one must not erase an earlier one. A value type, so it can be tested without a microphone.

- `init()`: empty.
- `committed: String` (read-only): the utterances Speech already closed.
- `segment: String` (read-only): the live utterance.
- `text: String` (computed): the whole hold, committed text plus the live segment.
- `mutating func update(_ next: String)`: replaces the live segment with a new transcription of it. An empty string is ignored.
- `mutating func commit()`: folds the live segment into `committed`.
- `mutating func reset()`: clears both.

```swift
var accumulator = CompanionTranscriptAccumulator()
accumulator.update("hello wor")
accumulator.update("hello world")
accumulator.commit()
accumulator.update("second sentence")
print(accumulator.text)
```

#### `CompanionAudioSource`

The protocol for where a hold gets its audio. The microphone is the live source. A test can supply a file or generated audio. Main-actor isolated and class-bound. There are no default implementations.

- `var deviceLabel: String { get }`: a description for the log, such as device, transport and rate.
- `func start(onBuffer: @escaping (AVAudioPCMBuffer) -> Void) throws -> AVAudioFormat`: starts delivering buffers and returns their format. `onBuffer` runs on the audio thread.
- `func stop()`: stops delivery.

```swift
final class SilentSource: CompanionAudioSource {
    var deviceLabel: String { "silent test source" }
    func start(onBuffer: @escaping (AVAudioPCMBuffer) -> Void) throws -> AVAudioFormat {
        guard let format = AVAudioFormat(standardFormatWithSampleRate: 16_000, channels: 1) else { throw CompanionSpeechError.recognizerUnavailable }
        return format
    }
    func stop() {}
}
let recognizer = CompanionSpeechRecognizer(audioSource: SilentSource())
```

#### `CompanionMicSource`

The live `CompanionAudioSource`. It builds a fresh `AVAudioEngine` for every hold, so a changed input device or sample rate never leaves a stale format behind. The recognizer creates it when you pass no source, so read it through `recognizer.audioSource`. It has no public init.

- `avoidBluetooth: Bool = false`: record from the built-in microphone when the default input is Bluetooth. Opening a Bluetooth microphone switches the headset profile, which delays the first buffers.
- `deviceLabel: String`: the device, transport and format of the current hold. It starts as "system default".
- `start(onBuffer:)` and `stop()`: as in `CompanionAudioSource`. `start` throws `CompanionSpeechError.microphoneNotAuthorized` without the Microphone grant.

```swift
let recognizer = CompanionSpeechRecognizer()
if let mic = recognizer.audioSource as? CompanionMicSource {
    mic.avoidBluetooth = true
}
try recognizer.start()
print(recognizer.audioSource.deviceLabel)
```

#### `CompanionSpeechError`

The errors `CompanionSpeechRecognizer.start` throws. It is a `LocalizedError` with a readable `errorDescription`.

- `recognizerUnavailable`: no recognizer for the language, or the audio input has no usable format.
- `speechNotAuthorized`: Speech Recognition is not allowed.
- `microphoneNotAuthorized`: Microphone access is not allowed.
- `onDeviceUnavailable(String)`: the language (the associated value) has no on-device model and server recognition is off.

```swift
do {
    try recognizer.start()
} catch CompanionSpeechError.microphoneNotAuthorized {
    _ = await CompanionSpeechRecognizer.requestMicAuthorization()
} catch {
    print(error.localizedDescription)
}
```

#### `CompanionHotKey`

One global press and release shortcut on Carbon `RegisterEventHotKey`. A registered key is swallowed system-wide, so it never reaches the app below. Each callback receives the time of the key event (seconds on the `ProcessInfo.systemUptime` clock), not the time the callback ran, so a host can tell a tap from a hold. Two keys in one process need different `(signature, hotKeyId)` pairs, or the second registration shadows the first.

- `keyCode: UInt32 = UInt32(kVK_F6)`: the Carbon virtual key code.
- `modifiers: UInt32 = 0`: the Carbon modifier mask (command 0x100, shift 0x200, option 0x800, control 0x1000).
- `signature: OSType = CompanionHotKey.companionSignature`: the Carbon identity of this binding.
- `hotKeyId: UInt32 = 1`: the id within the signature.

Properties:

- `onKeyDown: Callback?` and `onKeyUp: Callback?`: called on the main queue. `Callback` is `(TimeInterval) -> Void`.
- `keyCode: UInt32` and `modifiers: UInt32`: the current binding, read-only from outside.
- `static let companionSignature: OSType` (`0x474E4350`) and `static let flowSignature: OSType` (`0x474E464C`): the signatures of the companion and of Flow.

Methods:

- `start() -> Bool` (discardable): registers the shortcut. It returns `false` when Carbon refuses it.
- `stop()`: unregisters. Safe to call twice.
- `rebind(keyCode: UInt32, modifiers: UInt32) -> Bool` (discardable): changes the shortcut without a restart.

```swift
let hotKey = CompanionHotKey(keyCode: 0x02, modifiers: FlowConfig.defaultModifiers, signature: CompanionHotKey.flowSignature, hotKeyId: 5)
hotKey.onKeyDown = { time in print("down at \(time)") }
hotKey.onKeyUp = { _ in print("up") }
if !hotKey.start() { print("shortcut taken") }
```

#### `AudioDevices`

CoreAudio helpers for listing and choosing an input device.

- `Device`: Identifiable and Hashable. Fields: `id: AudioDeviceID`, `uid: String` (stable across restarts), `name: String`.
- `static func inputs() -> [Device]`: every attached device that has an input channel.
- `static func systemDefaultInput() -> Device?`: the current default input.
- `static func applyInputDevice(_ uid: String, to engine: AVAudioEngine) -> Bool`: pins the engine to the device with that UID. Call it before the engine starts. It returns `false` when the device is gone, and the engine then stays on the default.
- `static func setDuckNonVoiceAudio(_ duck: Bool, on engine: AVAudioEngine) -> Bool` (discardable): turns the ducking of other apps' audio on or off when voice processing is enabled.

```swift
let engine = AVAudioEngine()
if let device = AudioDevices.inputs().first {
    let applied = AudioDevices.applyInputDevice(device.uid, to: engine)
    print(device.name, applied)
}
```

#### `CompanionInputDevices`

Read-only CoreAudio lookups that add transport and rate to a device, used to detect a Bluetooth input.

- `Device`: Equatable. Fields: `id: AudioDeviceID`, `uid: String`, `name: String`, `transport: UInt32`, `nominalRate: Double`. Computed: `isBluetooth`, `isBuiltIn`, `transportName` (`built-in`, `bluetooth`, `usb`, `virtual`, `aggregate` or `other`) and `label` (name and transport).
- `static func defaultInput() -> Device?`: the default input.
- `static func builtInInput() -> Device?`: the first built-in input.

```swift
if let input = CompanionInputDevices.defaultInput(), input.isBluetooth {
    print("Default input: \(input.label) at \(Int(input.nominalRate)) Hz")
}
```

#### `FlowFocusAudioLease`

Admission to the owner's microphone for another recorder in the same host (for example a voice-notes recorder). Dictation refuses to start while a lease is held. Get it from `FlowFocusRuntime.acquireExternalAudio()`. It has no public init.

- `attachRecorder(pid: Int32) async throws`: registers the recorder process before it opens the input. Throws when the lease was released or the process cannot be identified.
- `release() async throws`: gives the microphone back after the recorder closed its input and exited.

```swift
let lease = try await runtime.acquireExternalAudio()
try await lease.attachRecorder(pid: recorderProcess.processIdentifier)
// Record, then:
try await lease.release()
```

#### `FlowFocusMailbox`

The command channel between a client and the owner: file-backed requests and replies in a private folder, woken by a distributed notification, with a file watcher as the fallback. The notification carries no transcript or payload. `FlowFocusRuntime` builds it. A host normally sends commands with `FlowFocusRuntime.send` instead.

- `directory: URL`: the runtime folder.
- `owner: FlowFocusLease.Owner`: the owner this mailbox talks to.
- `handler: Handler? = nil`: the owner passes a handler that runs one command. A client passes `nil`. `Handler` is `@MainActor (Command) async throws -> Data`, and commands run one at a time in order. The initializer throws.

Properties and types:

- `onStateChange: (() -> Void)?`: called when the owner published new state.
- `onOwnerChange: (() -> Void)?`: called when the owner changed or is gone.
- `Command`: Codable and Sendable. Fields: `id: UUID`, `ownerNonce: UUID`, `action: String`, `payload: Data`, `createdAt: Date`, `expiresAt: Date`, `sequence: UInt64`.
- `Failure`: a `LocalizedError`. The one case is `unavailable(String)`.

Methods:

- `start()`: starts watching for commands and replies.
- `stop()`: stops, and fails pending requests with `CancellationError`.
- `stopAfterCurrentCommand() async`: stops, then waits for the command that already runs. Waiting commands are refused.
- `request(action: String, payload: Data = Data(), id: UUID = UUID(), timeout: TimeInterval = 5) async throws -> Data`: sends a command and waits for the reply. The payload is limited to 4 MiB, and the wait is limited to 0.1 to 30 seconds. A repeated `id` in the same ownership epoch returns the saved reply.
- `signalStateChange()`: wakes the other side.

```swift
let directory = URL(fileURLWithPath: "/tmp/flow-demo/feature-runtime")
let owner = try FlowFocusLease.readOwner(directory: directory)
let mailbox = try FlowFocusMailbox(directory: directory, owner: owner)
mailbox.start()
let reply = try await mailbox.request(action: "flow.end", timeout: 5)
```

#### `FlowFocusLease`

The owner election for Flow and Focus: an exclusive `flock` on `owner.lock` in the runtime folder. The process that holds the descriptor is the owner. A loser never takes a busy lock because a process id or a file looks old. `FlowFocusRuntime` uses it. A host normally does not touch it.

- `directory: URL` and `owner: Owner`: the folder and the identity of this lease.
- `Owner`: Codable, Equatable and Sendable. Fields: `version: Int`, `pid: Int32`, `nonce: UUID`, `hostID: String`, `startedAt: Date`, and `static let protocolVersion = 1`. Its init is `init(hostID: String, pid: Int32 = ProcessInfo.processInfo.processIdentifier)`.

Methods:

- `static func acquire(directory: URL, hostID: String) throws -> FlowFocusLease?`: returns the lease when this process became owner, or `nil` when another process holds it.
- `func advertise() throws`: writes `owner.json` so clients can find the owner.
- `static func readOwner(directory: URL) throws -> Owner`: reads the advertised owner. It throws on an incompatible protocol version.
- `func release()`: removes the advertisement if it is still this owner's, then unlocks.
- `static func writePrivate(_ data: Data, to url: URL) throws`: writes a file atomically with owner-only permissions.

```swift
let directory = URL(fileURLWithPath: "/tmp/flow-demo/feature-runtime")
if let lease = try FlowFocusLease.acquire(directory: directory, hostID: "com.example.host") {
    try lease.advertise()
} else {
    print("Owner pid:", try FlowFocusLease.readOwner(directory: directory).pid)
}
```

### Focus

Focus is a pomodoro timer plus a local ledger of what the desktop was doing during it. `FocusController` is the main entry point: it owns the ledger (`ActivityStore`), the recorder (`ActivityRecorder`), the timer (`PomodoroEngine`), the floating timer window, the menu-bar item and the Studio windows, and it runs the commands that the `genesis focus` CLI queues. A host does not start it: the Flow and Focus runtime (`FlowFocusRuntime.focus`) creates it and starts it when the runtime becomes the owner, and the host calls its surface methods. `FocusSettingsView` is the settings page for the whole feature. `FocusOrchestrator` is separate: it holds the app-local notification mute that the timer and voice features take, and `FocusStatusChip` and `FocusRecoveryBanner` show its state. The entries go from these through the activity ledger, the timer and its windows, to the Studio views.

Many views in this folder have a synthesized memberwise initializer. Swift makes that initializer internal, so code outside GenesisKit cannot call it. Those entries say so, and their examples show the call as GenesisKit itself makes it.

#### `FocusController`

The `@MainActor` model that makes the timer, the ledger and the CLI one feature. `FocusController.shared` is the shared instance. `start` returns without effect unless the Flow and Focus runtime has made this controller the owner, so a host normally only reads the controller and calls the surface methods below.

- `init()`: creates an independent controller. Use `FocusController.shared` unless you need a separate instance.

Properties (all read-only for a host):

- `available: Bool`: true after the ledger opened. When it is false, nothing is recorded and Settings shows a "Focus is off" card.
- `lastError: String?`: why the ledger could not open, or the last failure the runtime reported.
- `store: ActivityStore?`: the ledger. `nil` until started.
- `recorder: ActivityRecorder?`: the desktop recorder. `nil` until started.
- `engine: PomodoroEngine?`: the timer. `nil` until started.
- `studioModel: FocusStudioModel?`: the model behind the Studio window. `nil` until started.

Methods:

- `start(appConfig: [String: Any], databasePath: String = ActivityStore.defaultPath, liveServices: Bool = true, presentsWindows: Bool = true)`: opens the ledger, builds the recorder and engine from the `app` dictionary of the config, and creates the timer window, the menu-bar item and the idle watch. It closes the downtime gap, prunes expired activity and resumes a session that was open when the app died. A failure sets `available` to false and `lastError`. It never throws. With `liveServices: false` the idle watch and capture do not start. With `presentsWindows: false` no timer window or menu-bar item appears.
- `stop(preservingSession: Bool = false)`: tears everything down. With `preservingSession: true` the running session stays open in the ledger for the next owner instead of being abandoned.
- `toggleHUD()`: shows or hides the timer window.
- `showHUD()`: shows the timer window, on the screen under the pointer.
- `callAttention(bringForward: Bool)`: blinks the timer window. With `bringForward: true` it also shows a hidden window on the pointer's screen. With `false` it only blinks a window that is already up.
- `updatePlan(_ plan: PomodoroPlan)`: saves a plan edited from the timer window and applies it, the same path Settings uses.
- `openStudio()`: opens the Studio window, or raises it.
- `setHUDStyle(_ style: FocusHUDStyle)`: changes the timer window shape and shows the window.
- `openSession(_ id: Int64)`: opens the breakdown window of one session, or raises it when it is already open.
- `apply(appConfig: [String: Any])`: re-reads settings and plan from the config and pushes them to the recorder and engine.
- `forgetActivity(from: Date, to: Date) async throws -> FocusForgetResult`: deletes everything the ledger recorded in the range. The result has `segments: Int` and `sessions: Int`, the number of rows removed. A client process asks the owner to run the deletion.
- `drainIntents()`: runs the commands the CLI queued in the ledger (`studio`, `hud`, `capture-pause`, `capture-resume`, `start`, `pause`, `resume`, `stop`, `skip`). The controller calls it once a second. An unknown kind is ignored on purpose.

```swift
let focus = FocusController.shared
focus.setHUDStyle(.compact)
focus.updatePlan(PomodoroPlan(flowSec: 50 * 60, shortBreakSec: 10 * 60))
focus.openStudio()
let removed = try await focus.forgetActivity(from: Date().addingTimeInterval(-3600), to: Date())
print(removed.segments, removed.sessions)
```

#### `FocusSettingsView`

The Settings page for Focus, in the shared native settings style. It has one card per area: Timer, Alerts and idle time, Capture, Privacy, Excluded apps, Excluded sites and Projects. Edits commit as they change, through `FlowFocusConfiguration.updateFocus`. When the controller is not available the page starts with a "Focus is off" card that shows `lastError`.

- `controller: FocusController? = nil`: the controller to read from. `nil` uses `FocusController.shared`.
- `configuration: FlowFocusConfiguration? = nil`: the configuration the edits write to. `nil` uses the controller's configuration, else `FlowFocusConfiguration.shared`.

```swift
ScrollView {
    FocusSettingsView(controller: flowRuntime.focus, configuration: flowRuntime.configuration)
        .padding(18)
}
```

#### `FocusOrchestrator`

The app-local notification mute. A feature takes a hold with a reason string, and the mute lasts until every hold is released. The mute only silences Genesis system notifications and does not change macOS Focus. If `focusShortcutName` names a Shortcuts shortcut, the begin and the final end also run it through a `shortcuts://run-shortcut` URL with the text `begin` or `end`. The state is written to a snapshot file, so a crash cannot leave the mute on: `recoverIfNeeded` restores it at the next launch.

`beginSession` and `endSession` throw `FlowFocusMailbox.Failure.unavailable` when this instance does not own the Flow and Focus runtime. An instance made with a custom `stateURL` owns it. `FocusOrchestrator.shared` is the instance the runtime wires up.

- `init(stateURL: URL? = nil, fileManager: FileManager = .default, openURL: ((URL) -> Void)? = nil)`: `stateURL` is the snapshot file (default `~/.genesis/focus-snapshot.json`). `openURL` opens the Shortcuts URL (default `NSWorkspace.shared.open`).

Properties:

- `isActive: Bool`: true while any hold is active.
- `activeReason: String?`: the held reasons, sorted and joined with commas.
- `suppressesSystemNotifications: Bool`: true while Genesis system notifications are muted.
- `recoveryNotice: String?`: a one-shot message after a crash recovery. A host may set it. `clearRecoveryNotice()` empties it.
- `stateURL: URL`: the snapshot file.
- `openURL: (URL) -> Void`: the closure that opens Shortcuts URLs.
- `focusWhileListeningEnabled: Bool`: whether voice listening takes the mute. Stored in the config, default `true`.
- `focusShortcutName: String`: the optional shortcut name. Stored in the config, default empty.
- `FocusOrchestrator.shared`: the shared instance. `FocusOrchestrator.defaultStateURL`: the default snapshot path.

Methods:

- `beginSession(reason: String = "genesis-voice") throws -> Snapshot`: takes a hold. It is idempotent: a second call with the same reason returns the existing snapshot, and a new reason adds a hold.
- `endSession(reason: String? = nil) throws -> Snapshot?`: releases one hold. `nil` releases all holds. Only the last release restores the previous mode.
- `recoverIfNeeded(skipShortcut: Bool = false) -> Snapshot?`: call it at launch. A leftover snapshot is cleared and the previous mode is restored. `recoveryNotice` is set, unless `skipShortcut` is true.
- `beginForVoiceIfEnabled()` and `endForVoiceIfNeeded()`: the voice path. It begins only when `focusWhileListeningEnabled` is on and logs failures instead of throwing.
- `installTerminateHook()`: releases the `genesis-voice` hold, synchronously, when the app quits.
- `currentModeLabel() -> String` and `setModeLabel(_ mode: String)`: read and write a mode label kept in user defaults (`off` by default). It is a label, not the macOS Focus id.
- `loadSnapshot() throws -> Snapshot`: reads the snapshot file.
- Static forms `FocusOrchestrator.beginSession(reason:)`, `endSession()`, `currentModeLabel()`, `setModeLabel(_:)` and `stateURL` forward to `shared`.

Nested types:

- `Snapshot` (Codable): `previousMode: String`, `setAt: Int` (epoch milliseconds), `reason: String`, `integration: String`, `suppressSystemNotifications: Bool`, `shortcutName: String?`, `reasons: [String]?`. Its `init` takes the same names, with defaults `integration` = `Integration.appLocal.rawValue`, `suppressSystemNotifications` = `true`, `shortcutName` = `nil`, `reasons` = `nil`.
- `Integration`: `appLocal`, `shortcuts`.
- `ModeLabel`: constants `off` (`"off"`) and `genesisListening` (`"genesis-listening"`).
- `ConfigKey`: constants `focusWhileListening` and `focusShortcutName`, the keys under `app` in the config.

```swift
let dnd = FocusOrchestrator(stateURL: URL(fileURLWithPath: "/tmp/example/focus-snapshot.json"))
try dnd.beginSession(reason: "writing-session")
// ... later
try dnd.endSession(reason: "writing-session")
```

#### `FocusStatusChip`

A small purple capsule that appears while the mute is active. It shows "notifications muted" (or "mute · active" when system notifications are not suppressed), with a tooltip that names the reason. It draws nothing when `focus.isActive` is false.

- `focus: FocusOrchestrator`: the orchestrator to watch.

```swift
HStack(spacing: 8) {
    Text("Genesis")
    FocusStatusChip(focus: FocusOrchestrator.shared)
}
```

#### `FocusRecoveryBanner`

An amber strip for the notice that `FocusOrchestrator.recoverIfNeeded` sets after a crash or force-quit. It has a dismiss button that calls `clearRecoveryNotice()`. It draws nothing when `recoveryNotice` is `nil`.

- `focus: FocusOrchestrator`: the orchestrator to watch.

```swift
VStack {
    FocusRecoveryBanner(focus: FocusOrchestrator.shared)
    content
}
```

#### `AppIconService`

A `@MainActor` cache of application icons, keyed by bundle id and size. It resolves an icon once through `NSWorkspace`, caches the resized copy, and caches the fallback per size. A nil, empty or unknown bundle id gets an `app.dashed` symbol. The Studio preloads the bundle ids it is about to draw so a view body does no disk work. The initializer is private; use `shared`.

- `AppIconService.shared`: the shared instance.
- `icon(for bundleId: String?, size: CGFloat = 16) -> NSImage`: the icon at that size.
- `preload(_ bundleIds: [String?], sizes: [CGFloat] = [14, 16])`: resolves the icons ahead of drawing.
- `clear()`: empties the icon, fallback and "unresolved" caches.

```swift
let service = AppIconService.shared
service.preload(["com.apple.Safari", "com.apple.mail"], sizes: [20])
let icon = service.icon(for: "com.apple.Safari", size: 20)
let imageView = NSImageView(image: icon)
```

#### `FocusSettings`

The privacy settings of the recorder, as a value type. `FocusSettings.from(appConfig:)` reads them from the `focus` key of the `app` dictionary in the config. An unknown or invalid value falls back to the default, so a typo in the config does not stop the recorder. The defaults are conservative: the exclusion list ships non-empty and URL paths are off.

- `init()`: all defaults.
- `captureEnabled: Bool = true`: master switch for recording.
- `titleMode: TitleMode = .full`: how window titles are stored. Cases: `full`, `appOnly` (raw value `app-only`, stores the app name), `hashed` (stores a short SHA-256 prefix, so the same window is the same string but unreadable).
- `urlMode: URLMode = .host`: how browser addresses are stored. Cases: `off`, `host`, `hostPath` (raw value `host+path`).
- `idleThresholdSec: Int = 120`: seconds without input before the user counts as away.
- `retentionDays: Int = 365`: how long activity is kept. The valid range is `FocusSettings.retentionRange` (`1...36_500`). A larger stored value is clamped to the top.
- `interruptionThresholdSec: Int = 45`: seconds away from the app a flow started in before it counts as an interruption.
- `menuBarStyle: String = "time"`: `time` shows the countdown, `dot` shows only the phase dot, `off` removes the item.
- `excludedBundles: Set<String> = FocusSettings.defaultExcludedBundles`: apps that are never recorded. The default holds four bundle ids (two 1Password versions, Bitwarden and Keychain Access). Reading the config always adds them back.
- `excludedHosts: Set<String> = []`: sites that are never recorded, with their subdomains.
- `projects: [ProjectRule] = []`: rules that name the project for an activity.

Static members: `defaultExcludedBundles`, `browserBundles` (the browsers the recorder can read an address from), `retentionRange`.

Methods:

- `FocusSettings.from(appConfig: [String: Any]) -> FocusSettings`: builds settings from the config.
- `records(bundle: String) -> Bool` and `records(host: String) -> Bool`: whether the policy allows recording that app or site.
- `title(_ raw: String?, appName: String) -> String?`: applies `titleMode` to a window title.
- `urlParts(_ raw: String?) -> (host: String?, path: String?)`: splits an address under `urlMode` and the host exclusions.
- `project(cmuxSession: String?, title: String?, host: String?) -> String?`: the project name from the rules, or `nil`. Rules are checked in the order cmux session, window title, site. The first match wins.
- `storedFields: [String: Any]`: the values in the shape the config stores them. The built-in app exclusions are left out.
- `FocusSettings.normalizedHost(_ raw: String) -> String?`: turns what a user typed or pasted (an address, `*.example.com`, a trailing dot) into a host name, or `nil` when it is not one.

`ProjectRule` (nested struct): `init(name: String, cmuxSession: String? = nil, titleContains: String? = nil, host: String? = nil)`. A rule matches a cmux session name, a window title fragment or a site. `ProjectRule.validated(name:cmuxSession:titleContains:host:existingNames:) throws -> ProjectRule` trims the fields, normalizes the site and throws a `FocusRuleError` when the name is empty or taken, the site is invalid, or no condition is left. `FocusRuleError` has `message: String` and `init(_ message: String)`, and its `errorDescription` is the message.

```swift
let focusConfig: [String: Any] = ["titleMode": "hashed", "urlMode": "host", "retentionDays": 90]
var settings = FocusSettings.from(appConfig: ["focus": focusConfig])
settings.excludedHosts.insert("bank.example.com")
settings.projects.append(FocusSettings.ProjectRule(name: "Website", host: "example.com"))
let project = settings.project(cmuxSession: nil, title: nil, host: "docs.example.com")
```

#### `ActivityRecorder`

The `@MainActor` model that records what the desktop is doing. It writes segments to `ActivityStore`, one per stretch of a single app, window and address. Segments close on a focus change, on an idle change, at a phase boundary and when capture pauses or stops, so their durations add up to wall-clock time. It reads the frontmost app from `NSWorkspace`, the window title and address through Accessibility on a background queue with a short timeout, and the idle clock. It counts key presses and clicks through an `InputCounter`. When the Accessibility grant is missing, it opens the GenesisKit permission dialog.

- `init(store: ActivityStore, settings: FocusSettings = FocusSettings(), liveServices: Bool = true, probeReader: (@Sendable (pid_t, String) -> AXFocusProbe.Result)? = nil)`: `liveServices: false` starts no observers, timers or event taps. `probeReader` replaces the Accessibility read (default `AXFocusProbe.read`).

Properties (read-only for a host):

- `isCapturing: Bool`: whether capture is running.
- `isIdle: Bool`: whether the user is idle.
- `current: FocusSnapshot?`: the current focus after the privacy policy has been applied. `FocusSnapshot` has `appBundle`, `appName`, `windowTitle`, `urlHost`, `urlPath`, `cmuxSession`, `cmuxPane`, `displayId` and `project`, and `sameSegment(as:)`.
- `pausedUntil: Date?`: set while capture is paused.
- `inputHistory: [Int]`: key presses per poll tick, newest last, at most `historyLength` entries. The HUD sparkline reads it.
- `currentMix: [AppShare]`: the app mix of the running phase. `AppShare` has `appName`, `bundleId`, `ms` and `share`.
- `ActivityRecorder.historyLength` (24) and `ActivityRecorder.pollSeconds` (2).

Methods:

- `start()` and `stop()`: start and stop capture. `stop` closes the open segment and records a `capture_off` gap.
- `closeDowntime(launchedAt: Date = Date())`: records the time since the last row on disk as a gap, so a closed app reads as "not measured". Call it before `start()`.
- `installTerminateHook()`: closes the open segment when the app quits.
- `apply(settings: FocusSettings)`: applies new settings. Turning capture off stops it and turning it on starts it.
- `pauseCapture(until: Date)`, `resumeCapture()` and `resumeIfPauseExpired(now: Date = Date()) -> Bool`: pause and resume capture. The pause is recorded as a gap and its deadline survives a restart.
- `attach(sessionId: Int64?)`: the engine calls this at each phase boundary, so no segment spans two sessions.
- `applyProbe(_ probe: AXFocusProbe.Result, bundle: String, appName: String, settings: FocusSettings, idle: Bool)`: applies one probe result with the privacy policy. Tests use it as a source.
- `appMix(from: Int64, to: Int64, limit: Int = 3) -> [AppShare]`: the top apps in a time range.
- `liveInput() -> ActivityStore.InputCounts`: counts in the minute that is still open.
- `ActivityRecorder.idleSeconds() -> Double`: seconds since any keyboard or mouse input.
- `ledgerForgetting(from: Int64, to: Int64) -> DeletionFence?`, `ledgerForgot(from: Int64, to: Int64)` and `ledgerForgetEnded(_ fence: DeletionFence)`: the three calls `FocusController.forgetActivity` makes around a deletion, so the recorder does not write back rows or counts that were just deleted. `DeletionFence` is the hold token.

```swift
let store = try ActivityStore(path: ":memory:")
let recorder = ActivityRecorder(store: store, settings: FocusSettings(), liveServices: false)
recorder.start()
let now = Int64(Date().timeIntervalSince1970 * 1000)
let top = recorder.appMix(from: now - 3_600_000, to: now, limit: 3)
```

#### `ActivityStore`

The local SQLite ledger for sessions, desktop segments and input counts. It lives at `ActivityStore.defaultPath` (`~/.genesis/activity.db`). For a writable store, the initializer creates a missing directory with mode 0700 and sets the file to mode 0600. It is a separate database from the rest of Genesis. There is nowhere in the schema to store what was typed. Times are epoch milliseconds (`Int64`), and the range arguments of the input and session queries are half-open (`from` inclusive, `to` exclusive). The segment and gap queries return every row that overlaps the range. Every method that touches the database is `throws`. The row structs below have synthesized initializers that are internal, so code outside GenesisKit reads rows from the store and does not build them.

- `init(path: String = ActivityStore.defaultPath, readOnly: Bool = false) throws`: opens or creates the database and migrates it. `":memory:"` gives a throwaway store. A read-only store is for a client process that must not write.
- `dbPath: String`: the path the store was opened with.

Segments:

- `openSegment(_ segment: Segment) throws -> Int64`: stores a segment and returns its id.
- `closeSegment(id: Int64, at endedMs: Int64) throws`: closes a segment. Closing a closed segment does nothing.
- `touchSegment(id: Int64, at endedMs: Int64) throws`: moves the provisional end of an open segment forward.
- `lastRecordedMs() throws -> Int64?`, `openSegments() throws -> [Segment]`, `segments(from: Int64, to: Int64) throws -> [Segment]`: read segments. `segments` returns every segment that overlaps the range.
- `attachSegment(id: Int64, toSession sessionId: Int64?) throws`: ties a segment to a session after the fact.

Input counts:

- `appendInput(bucketMs: Int64, segmentId: Int64, counts: InputCounts) throws`
- `inputTotals(from: Int64, to: Int64) throws -> InputCounts`
- `inputSeries(from: Int64, to: Int64) throws -> [InputSample]`: the one-minute buckets themselves.

Gaps (time that was not measured):

- `recordGap(startedMs: Int64, endedMs: Int64?, reason: String, untilMs: Int64? = nil) throws -> Int64`: `untilMs` is the end of a timed pause.
- `closeGap(id: Int64, at endedMs: Int64) throws`, `gaps(from: Int64, to: Int64) throws -> [Gap]`, `setGapUntil(id: Int64, untilMs: Int64?) throws`, `gapUntil(id: Int64) throws -> Int64?`

Sessions and pauses:

- `startSession(_ session: FocusSession) throws -> Int64`, `endSession(id: Int64, at endedMs: Int64, state: SessionState) throws`, `setSessionState(id: Int64, state: SessionState) throws`
- `updateSession(id: Int64, tag: String?, note: String?, interruptions: Int?) throws`: a `nil` argument leaves that field alone. `clearSessionTag(id: Int64) throws` removes the tag.
- `openSession() throws -> FocusSession?`, `sessions(from: Int64, to: Int64) throws -> [FocusSession]`, `session(id: Int64) throws -> FocusSession?`
- `recordPause(sessionId: Int64, startedMs: Int64, endedMs: Int64?, reason: PauseReason) throws -> Int64`, `closePause(id: Int64, at endedMs: Int64) throws`, `pauses(sessionId: Int64) throws -> [Pause]`, `openPauses(sessionId: Int64) throws -> [Pause]`, `pausedMs(sessionId: Int64, now: Int64) throws -> Int64`, `closeOrphanedPauses(sessionId: Int64, keeping keepId: Int64?, now: Int64) throws -> Int`

Retention and deletion:

- `prune(before cutoff: Int64) throws -> (segments: Int, sessions: Int)`: drops what lies wholly before the cutoff and trims what crosses it.
- `forget(from: Int64, to: Int64, appBundle: String? = nil, now: Int64 = <current time>) throws -> (segments: Int, sessions: Int)`: deletes everything recorded in a range, optionally for one app only, and reports what went. `now` is the clock the live phase's remaining time is kept against.

CLI intents and rollups:

- `takeIntents(limit: Int = 16) throws -> [Intent]`: returns unconsumed commands and marks them consumed, so two drains never run one command twice. `pushIntent(kind: String, payload: [String: Any] = [:]) throws -> Int64` queues one.
- `cacheRollup(day: String, json: String, computedMs: Int64) throws` and `cachedRollup(day: String) throws -> String?`: a per-day cache.

Nested types:

- `Segment`: `id`, `startedMs`, `endedMs`, `sessionId`, `appBundle`, `appName`, `windowTitle`, `urlHost`, `urlPath`, `project`, `cmuxSession`, `cmuxPane`, `displayId`, `idle`, and `durationMs`.
- `FocusSession`: `id`, `kind`, `plannedSec`, `startedMs`, `endedMs`, `state`, `cycleIndex`, `tag`, `note`, `interruptions`, and `actualMs` (`nil` while the session is open). `kind` and `state` are strings that hold the raw values of `SessionKind` and `SessionState`.
- `SessionKind`: `flow`, `shortBreak` (`short_break`), `longBreak` (`long_break`). `SessionState`: `running`, `paused`, `done`, `abandoned`. `PauseReason`: `manual`, `idle`, `auto`.
- `InputCounts`: `keys`, `clicks`, `scrolls`, `px` (pointer distance). It supports `+`. `InputSample`: `bucketMs`, `segmentId`, `counts`.
- `Gap`: `id`, `startedMs`, `endedMs`, `reason`. `Pause`: `id`, `startedMs`, `endedMs`, `reason`. `Intent`: `id`, `kind`, `payload`.
- `StoreError`: `sqlite(String)`.

```swift
let store = try ActivityStore()
let now = Int64(Date().timeIntervalSince1970 * 1000)
let sessions = try store.sessions(from: now - 86_400_000, to: now)
let totals = try store.inputTotals(from: now - 86_400_000, to: now)
print(sessions.count, totals.keys)
```

#### `InputCounter`

Counts key presses, mouse clicks, scroll events and pointer distance through one listen-only event tap, and nothing else. The callback only increments integers: it never reads a key code, a character or the pasteboard. Counts are flushed into one-minute buckets. If the system disables the tap, a watchdog re-enables it and reports the gap. `ActivityRecorder` creates and owns one, and the initializer is internal, so a host reads the counts through `ActivityRecorder.liveInput()`.

- `onFlush: ((_ bucketMs: Int64, _ counts: ActivityStore.InputCounts) -> Void)?`: called once per bucket with its counts.
- `onGap: ((_ startedMs: Int64, _ endedMs: Int64, _ reason: String) -> Void)?`: called when the tap died and came back.
- `isRunning: Bool`: whether the tap is installed.
- `InputCounter.bucketSeconds: Int64` (60) and `InputCounter.bucketStart(_ epochMs: Double) -> Int64`: the bucket width and the start of the bucket that holds a time.
- `start() -> Bool`: installs the tap. It returns false when Accessibility is not granted.
- `stop()`: removes the tap and flushes the open bucket.
- `snapshot() -> ActivityStore.InputCounts`: the counts in the open bucket.
- `flush(now epochMs: Double, force: Bool = false)` and `discardPending(overlapping from: Int64, to: Int64)`: flush the bucket, or drop it when its minute overlaps a range that was forgotten.
- `recordForTesting(type: CGEventType, at point: CGPoint? = nil)`: drives the counter without a real tap.

```swift
let nowMs = Date().timeIntervalSince1970 * 1000
let bucketStart = InputCounter.bucketStart(nowMs)
let counts = recorder.liveInput()
print("minute starting at", bucketStart, "keys:", counts.keys, "clicks:", counts.clicks)
```

#### `AXFocusProbe`

Reads the focused window of one process through the Accessibility API: its title, its address (for the browsers in `FocusSettings.browserBundles`) and the display it is on. The read has a short messaging timeout and a read budget, so an app that stops answering costs a missing title and nothing else. `ActivityRecorder` calls it on a background queue.

- `AXFocusProbe.messagingTimeout: Float`: the per-request timeout (0.25 seconds).
- `AXFocusProbe.read(pid: pid_t, bundle: String) -> Result`: one probe.
- `Result` (nested struct): `title: String?`, `url: String?`, `displayId: Int64?`.

```swift
if let app = NSWorkspace.shared.frontmostApplication {
    let probe = AXFocusProbe.read(pid: app.processIdentifier, bundle: app.bundleIdentifier ?? "")
    print(probe.title ?? "no title", probe.url ?? "no address")
}
```

#### `CmuxAttribution`

Reads the session and pane from a cmux terminal window title, which is the most reliable project signal for terminal work. It only parses the title and never runs a command.

- `CmuxAttribution.bundles: Set<String>`: the bundle ids it treats as cmux.
- `CmuxAttribution.parse(title: String?, bundle: String) -> (session: String?, pane: String?)`: for a cmux bundle, a title of the form `session · pane` gives both parts, and any other non-empty title is the session. For another app, or an empty title, both are `nil`.

```swift
let settings = FocusSettings()
let parts = CmuxAttribution.parse(title: "build-api · server", bundle: "com.cmuxterm.app")
let project = settings.project(cmuxSession: parts.session, title: nil, host: nil)
print(parts.pane ?? "no pane", project ?? "unattributed")
```

#### `PomodoroPlan`

The phase table of the timer, as a Codable value. It holds the lengths and the rules, so they can be tested without a store or a clock. `PomodoroPlan.from(appConfig:)` reads it from the `timer` dictionary under `focus` in the config. An invalid value keeps the default.

- `flowSec: Int = 25 * 60`: length of a flow.
- `shortBreakSec: Int = 5 * 60`: length of a short break.
- `longBreakSec: Int = 30 * 60`: length of a long break.
- `cycleLength: Int = 4`: a long break follows every this many completed flows.
- `autoStartBreaks: Bool = true`: a finished flow starts its break by itself.
- `autoStartFlows: Bool = false`: a finished break starts the next flow by itself.
- `allowOverrun: Bool = true`: a flow that reaches zero keeps counting up instead of ending.
- `dndWhileFlowing: Bool = true`: a flow takes the notification mute through `FocusOrchestrator`.
- `sound: String = "Glass"`: a name from `FocusChime.available`, or `"off"`.
- `idlePauseSec: Int = 60`: seconds without input before a running flow pauses itself. `0` turns it off. Breaks never pause.
- `resumeOnActivity: Bool = true`: a flow that paused for idleness resumes on the first input.
- `nudgeEverySec: Int = 10 * 60`: the shortest gap between two "no flow is running" nudges. `0` turns it off.

All twelve are parameters of `init`, in this order, with these defaults.

Methods:

- `duration(of phase: Phase) -> Int`: the planned seconds of a phase.
- `next(after phase: Phase, completedFlows: Int) -> Phase` and `previous(before phase: Phase, completedFlows: Int) -> Phase`: the phase that follows or precedes, given the completed flow count.
- `autoStarts(_ phase: Phase) -> Bool`: whether the phase starts by itself.
- `PomodoroPlan.from(appConfig: [String: Any]) -> PomodoroPlan`

`Phase` (nested enum, Codable): `flow`, `shortBreak` (`short_break`), `longBreak` (`long_break`). It has `isBreak: Bool` and `label: String` ("Flow", "Short break", "Long break").

```swift
let plan = PomodoroPlan(flowSec: 50 * 60, shortBreakSec: 10 * 60, cycleLength: 3, sound: "Ping")
let after = plan.next(after: .flow, completedFlows: 3)   // .longBreak
let seconds = plan.duration(of: after)
```

#### `PomodoroEngine`

The timer. It keeps one session in the ledger per phase, so a crash in the middle of a flow resumes with the right remaining time. Remaining time is derived from the clock on every tick and never decremented, so a missed tick or a sleeping Mac cannot drift it. A `@MainActor` `ObservableObject`. In a client process, commands are forwarded to the owner.

- `init(store: ActivityStore, plan: PomodoroPlan = PomodoroPlan())`

Properties:

- `state: State`: `idle`, `running`, `paused` or `overrun`.
- `phase: PomodoroPlan.Phase`: the current or next phase.
- `remainingSec: Int`: seconds left. Negative while overrunning.
- `completedFlows: Int`: flows completed in this run.
- `tag: String?` and `interruptions: Int`: the session's tag and interruption count.
- `pauseReason: ActivityStore.PauseReason?`: why the current pause began. `nil` when not paused.
- `plan: PomodoroPlan`: settable. The controller replaces it when settings change.
- `isTicking: Bool`: whether the one-second ticker exists.
- `clock: () -> Date`: the engine's only clock. Tests replace it.

Callbacks a host sets:

- `onSessionChange: ((Int64?) -> Void)?`: a session started (with its id) or ended (`nil`).
- `onPhaseEnd: ((PomodoroPlan.Phase, Int64) -> Void)?`: a phase reached zero, with the end time.
- `onBoundary: (() -> Void)?`: fires once per announced phase boundary, after the chime and the notification.
- `beginDND: (() -> Void)?` and `endDND: (() -> Void)?`: arm and release the notification mute.
- `announcePhaseChange: ((PomodoroPlan.Phase, PomodoroPlan.Phase, Bool) -> Void)?`: replaces the chime and the notification. Tests use it to stay silent.

Methods:

- `start(_ phase: PomodoroPlan.Phase = .flow, seconds: Int? = nil, tag: String? = nil)`: starts a phase. It abandons a running one.
- `pause(reason: ActivityStore.PauseReason = .manual, since: Date? = nil)`: `since` backdates the pause, so an idle pause starts when input stopped.
- `resume()`, `skip()` (ends the phase and moves on, recording the session as done), `goBack()` (steps back one phase and starts it fresh), `stop()`
- `setTag(_ value: String?)`, `setNote(_ value: String)`, `recordInterruption()`
- `resumeOpenSessionIfAny()`: picks up a session the app died in.
- `tick()`: recomputes the remaining time from the clock. The engine's timer calls it once a second.
- `apply(intent: ActivityStore.Intent)`: runs one queued CLI command (`start`, `pause`, `resume`, `stop`, `skip`). It ignores other kinds.

```swift
let store = try ActivityStore()
let engine = PomodoroEngine(store: store, plan: PomodoroPlan(flowSec: 25 * 60))
engine.beginDND = { try? FocusOrchestrator.shared.beginSession(reason: "pomodoro") }
engine.endDND = { try? FocusOrchestrator.shared.endSession(reason: "pomodoro") }
engine.start(.flow, tag: "report")
```

#### `FocusIdleWatch`

Watches keyboard and mouse idleness for the timer and acts on it. A running flow pauses itself after `plan.idlePauseSec` without input, backdated to the last input. A flow it paused resumes on the first input when `plan.resumeOnActivity` is on. While no flow runs, about five seconds of typing earns one soft nudge, at most every `plan.nudgeEverySec`. It uses the system idle clock, so it needs no event tap and no extra permission.

- `init(engine: PomodoroEngine, now: Date = Date())`
- `onAutoPause: (() -> Void)?`, `onAutoResume: (() -> Void)?`, `onNudge: (() -> Void)?`: called when it paused, resumed or wants to nudge.
- `start()` and `stop()`: start and stop the one-second poll.
- `step(now: Date, idleSec: Double, sinceKeySec: Double)`: one decision, with its inputs as values. Tests call it directly.
- Static tuning values: `typingPollsForNudge` (5 polls with a key press), `graceAfterStopSec` (60), `activeWithinSec` (2), `typingResetIdleSec` (30).

```swift
let watch = FocusIdleWatch(engine: engine)
watch.onNudge = { FocusChime.nudge() }
watch.start()
```

#### `FocusChime`

The sound and the notification a phase boundary makes. The chime is a named system sound. The notification carries the same sentence, so a phase change lands whether the timer window is visible or not. Sounds and notifications are silent unless `FlowFocusHost.shared.soundsEnabled` and `notificationsEnabled` are on. A `@MainActor` enum.

- `FocusChime.available: [String]`: `Glass`, `Ping`, `Submarine`, `Tink`, `Blow`, `Pop`.
- `FocusChime.defaultName: String`: `"Glass"`.
- `FocusChime.notificationKind: String`: `"focus.phase"`, the `kind` value in the notification's user info, so a click can be routed to the timer.
- `play(_ name: String?)`: plays a named sound. `nil`, empty and `"off"` play nothing.
- `preview(_ name: String)`: the same as `play`, for a settings picker.
- `nudge()`: plays a soft two-note chime, synthesized in code.
- `nudgeWAV(sampleRate: Int = 44_100) -> Data`: the WAV data of that nudge.
- `notify(finished: PomodoroPlan.Phase, next: PomodoroPlan.Phase, autoStarted: Bool)`: posts "<finished phase> finished" with "<next phase> has started." or "<next phase> is ready when you are."

```swift
let plan = PomodoroPlan(sound: "Ping")
FocusChime.play(plan.sound)
FocusChime.notify(finished: .flow, next: .shortBreak, autoStarted: true)
FocusChime.nudge()
```

#### `FocusHUDWindowController`

Hosts the timer window: a floating, borderless panel that does not take focus, can be dragged, and remembers its position and visibility. It never becomes key by itself, so it cannot swallow a keystroke meant for your editor. A text field inside it gets key status for as long as it is open, through `beginTextEditing()` and `endTextEditing()`. `FocusController` creates one with the kit's own timer view (`FocusHUDView`, built inside GenesisKit) as content. Build your own only for a different timer view.

- `init(content: @escaping () -> AnyView)`: the closure builds the window's SwiftUI content. It runs again when a hidden window is shown and when the style changes.
- `isVisible: Bool` and `style: FocusHUDStyle`: read-only state.
- `FocusHUDWindowController.savedStyle: FocusHUDStyle`: the style saved in user defaults (`.full` by default).
- `FocusHUDWindowController.wasVisible: Bool`: whether the window was up when the app last closed (`true` by default).
- `show(followPointer: Bool = false)`: shows the window. With `followPointer: true`, a window on another screen moves to the screen under the pointer.
- `hide()`, `toggle()`
- `setStyle(_ next: FocusHUDStyle)` and `toggleStyle()`: switch between the full and compact shape. The window keeps its top-left corner.
- `beginTextEditing()` and `endTextEditing()`: lend key status to a text field and give focus back to the previous app.

```swift
let hud = FocusHUDWindowController {
    AnyView(MyTimerView(engine: engine, recorder: recorder))
}
hud.show(followPointer: true)
hud.setStyle(.compact)
```

#### `FocusHUDStyle`

The two shapes of the timer window. `full` is the working surface with the mix, the sparkline and hover controls. `compact` shows the phase, the time, one button and the cycle dots.

- `full`: the full window.
- `compact`: the small window.
- `label: String`: "Full" or "Compact".
- Conforms to `CaseIterable` and `Identifiable` (`id` is the raw value, `"full"` or `"compact"`).

```swift
Picker("Timer window", selection: $style) {
    ForEach(FocusHUDStyle.allCases) { Text($0.label).tag($0) }
}
```

#### `FocusHUDMetrics`

The fixed sizes of the timer window, so a window controller and the view agree.

- `size: CGSize`: the full window, 320 by 250.
- `compactSize: CGSize`: the compact window, 260 by 104.
- `cornerRadius: CGFloat`: 20, for the full window.
- `compactCornerRadius: CGFloat`: 16.
- `size(for style: FocusHUDStyle) -> CGSize` and `cornerRadius(for style: FocusHUDStyle) -> CGFloat`: pick the value for a style.

```swift
let style = FocusHUDStyle.compact
let size = FocusHUDMetrics.size(for: style)
let radius = FocusHUDMetrics.cornerRadius(for: style)
print(size.width, size.height, radius)
```

#### `FocusStatusItem`

The menu-bar item. Its title is a phase dot, and the remaining time in monospaced digits behind it. A click opens a popover with today's totals and the phase controls. A right-click shows a menu with the same commands and no stats. The title is colored by phase, and in the secondary label color while the timer is idle.

- `init(engine: PomodoroEngine, recorder: ActivityRecorder, store: ActivityStore, onOpenStudio: @escaping () -> Void, onToggleHUD: @escaping () -> Void)`
- `isHUDVisible: () -> Bool = { false }`: read when the popover opens, so it can say "Hide timer window" when the window is already up.
- `install(style: String)`: adds the item. `style` is `"time"` (countdown), `"dot"` (dot only) or `"off"` (adds nothing). Calling it again while installed does nothing.
- `remove()`: removes the item.

```swift
let item = FocusStatusItem(engine: engine, recorder: recorder, store: store,
                           onOpenStudio: { focus.openStudio() },
                           onToggleHUD: { focus.toggleHUD() })
item.install(style: "time")
```

#### `FocusStudioModel`

Everything the Studio draws, computed off the view body. One `reload()` per range or filter change fills the published arrays, and the views only read them. The Studio shows one range of time through four tabs, and every filter below applies to all of them. A `@MainActor` `ObservableObject`.

- `init(store: ActivityStore)`

Inputs a host or view sets:

- `tab: Tab = .timeline`: `Tab` cases are `timeline`, `breakdown`, `heatmap` and `sessions` (raw values "Timeline", "Breakdown", "Heatmap", "Sessions").
- `range: FocusRange = FocusRange.make(.day)`: the visible range.
- `tagFilter: String?` and `projectFilter: String?`: show only sessions with that tag, or work attributed to that project.
- `search: String = ""`: filters windows and sites.
- `sessionFilter: Int64?`: scopes every view to one session.
- `onOpenSession: ((Int64) -> Void)?`: called when the user opens a session. `FocusController` sets it to open the session window.

Published results (read-only):

- `totals: FocusAggregate.Totals`, `keys: Int`, `unmeasuredMs: Int64`
- `bars: [TimelineBar]`, `lanes: [String]`, `gapBars: [GapBar]`, `phaseBands: [PhaseBand]`: the timeline.
- `appBuckets`, `hostBuckets`, `projectBuckets: [FocusAggregate.Bucket]` and `childBuckets: [String: [FocusAggregate.Bucket]]`: the breakdown.
- `heatCells: [FocusAggregate.HeatCell]`: the heatmap.
- `sessionCards: [SessionCard]` and `sessionOptions: [SessionCard]`: the Sessions tab and the session picker.
- `availableTags: [String]` and `availableProjects: [String]`: the filter menus.
- `emptiness: Emptiness`: why a range is empty. Cases: `notEmpty`, `nothingRecorded`, `captureWasOff`, `noMatches`.
- `laneSpanMinutes: Double`: minutes in one timeline lane (60 on a day view, 1440 otherwise).

Methods:

- `reload(now: Date = Date())`: recomputes everything.
- `step(_ delta: Int)`: moves the range by whole periods and reloads.
- `setGranularity(_ granularity: FocusRange.Granularity)`: changes the range length and reloads.
- `digestMarkdown() -> String`: the same digest the CLI prints, for the copy button.

Nested value types: `TimelineBar`, `PhaseBand` and `GapBar` carry `startedMs`, `endedMs`, `laneKey` and the offsets inside that lane (`offsetStartMs`, `offsetEndMs`). `TimelineBar` also has `segmentId`, `appName`, `appBundle`, `detail`, `idle` and `sessionId`. `PhaseBand` has `sessionId`, `kind`, `tag`, `isBreak` and `label`. `GapBar` has `gapId`, `reason` and a readable `label`. `SessionCard` has `id`, `kind`, `tag`, `note`, `startedMs`, `actualMs`, `plannedMs`, `interruptions`, `state`, `keys` and `topApps`.

```swift
let model = FocusStudioModel(store: store)
model.tab = .breakdown
model.tagFilter = "report"
model.setGranularity(.week)
model.reload()
print(model.totals.focusedMs, model.appBuckets.first?.key ?? "none")
```

#### `FocusStudioView`

The Studio: four views over one range, a toolbar and a footer. The toolbar has a tab picker (Timeline: what happened. Breakdown: where it went. Heatmap: when you are good at this. Sessions: what each pomodoro contained), previous and next buttons with the range label, a day, week, month and year picker, a session picker, tag and project filters, a search field and a "Copy digest" button. The footer shows focused time, idle time, switches, the longest stretch, keystrokes and, when it is more than a minute, the time that was not measured. When the range has no data, the view shows an empty state that depends on `FocusStudioModel.emptiness`. The four tabs are drawn by `FocusTimelineView`, `FocusBreakdownView`, `FocusHeatmapView` and `FocusSessionsView`. They read the same `FocusStudioModel` and have internal initializers. The view reloads the model when it appears and has a minimum size of 880 by 560.

- `model: FocusStudioModel`: the model to draw.

```swift
let model = FocusStudioModel(store: store)
model.tab = .heatmap
let window = NSWindow(contentViewController: NSHostingController(rootView: FocusStudioView(model: model)))
window.makeKeyAndOrderFront(nil)
```

#### `FocusStudioWindowController`

The Studio window: titled, resizable, 1040 by 680, with its frame autosaved. There is one window, reused. Showing it again reloads the range and does not open a second copy. `FocusController.openStudio()` creates and presents one.

- `init(model: FocusStudioModel)`
- `present()`: centers the window the first time when no saved frame exists, reloads the model, brings the window to the front and activates the app.

```swift
let model = FocusStudioModel(store: store)
model.setGranularity(.week)
let studio = FocusStudioWindowController(model: model)
studio.present()
```

#### `FocusSessionDetailModel`

Everything the single-session window draws. The unit of truth is the event: segments, pauses and capture gaps are merged into one chronological list, and the rankings are derived from it. Everything is read in `reload()` and published as plain arrays. A `@MainActor` `ObservableObject`.

- `init(store: ActivityStore, sessionId: Int64)`
- `sessionId: Int64`

Published results (read-only):

- `session: ActivityStore.FocusSession?`
- `totals: FocusAggregate.Totals`, `counts: ActivityStore.InputCounts`, `pausedMs: Int64`, `unmeasuredMs: Int64`
- `appBuckets`, `windowBuckets`, `siteBuckets`, `projectBuckets: [FocusAggregate.Bucket]`
- `events: [Event]` and `effort: [EffortPoint]`
- `missing: Bool`: true when the session row is gone, for example after a deletion.

Derived values:

- `title: String`: the kind, the tag and the start time of the session, or `Session <id>` while the row is not loaded.
- `plannedMs: Int64` and `actualMs: Int64`
- `completion: Double`: the share of the planned length that was spent, capped at 1.
- `density: Double`: the share of the session spent focused on something, as opposed to idle, paused or unmeasured.

Methods:

- `reload(now: Date = Date())`
- `markdown() -> String`: the same numbers as text, in the shape `genesis focus sessions` prints.

Nested types: `Event` has `id`, `kind`, `startedMs`, `endedMs`, `appName`, `appBundle`, `windowTitle`, `urlHost`, `urlPath`, `project`, `cmux`, `keys`, `durationMs` and `detail` (the line shown under the app name). `Event.Kind` cases are `work`, `idle`, `pause(String)` and `gap(String)`, with `isWork`. `EffortPoint` has `id`, `startedMs`, `keys` and `clicks`.

```swift
let detail = FocusSessionDetailModel(store: store, sessionId: 42)
detail.reload()
if !detail.missing { print(detail.title, detail.density) }
```

#### `FocusSessionDetailView`

The breakdown of one session. The reading order is how it went (ring and stats), when it went that way (a strip and an effort chart), where it went (apps, sites and windows, each with the app icon), and what happened (the event log). It shows a "This session is no longer in the ledger." state when the model is `missing`. It reloads the model when it appears.

- `model: FocusSessionDetailModel`: the model to draw.

The rows of the event log are `FocusSessionEventRow` views. They have an internal initializer.

```swift
let detail = FocusSessionDetailModel(store: store, sessionId: 42)
let view = FocusSessionDetailView(model: detail)
let host = NSHostingView(rootView: view)
host.frame = NSRect(x: 0, y: 0, width: 820, height: 640)
```

#### `FocusSessionWindowController`

The window that one session card opens. There is one window per session id, and each new window cascades from the last, so two sessions can be compared side by side. `FocusController.openSession(_:)` keeps one controller per id.

- `init(model: FocusSessionDetailModel)`
- `sessionId: Int64`: the session shown.
- `onClose: ((Int64) -> Void)?`: called with the session id when the window closes, so the owner can drop its reference.
- `present()`: reloads the model, sets the window title from it, brings the window to the front and activates the app.

```swift
let window = FocusSessionWindowController(model: detail)
window.onClose = { id in print("closed", id) }
window.present()
```

#### `FocusAggregate`

Pure functions that turn ledger rows into the numbers the Studio draws and the CLI prints. No view runs a query. Idle time never counts as focus, and idle breaks a stretch instead of causing a context switch. All times are epoch milliseconds, and `now` clips a segment that is still open.

- `span(_ segment: ActivityStore.Segment, from: Int64, to: Int64, now: Int64) -> Int64`: the duration of a segment clipped to a range.
- `totals(_ segments: [ActivityStore.Segment], from: Int64, to: Int64, now: Int64) -> Totals`: `Totals` has `focusedMs`, `idleMs`, `switches` and `longestStretchMs`.
- `buckets(_ segments: [ActivityStore.Segment], from: Int64, to: Int64, now: Int64, bundle: ((ActivityStore.Segment) -> String?)? = nil, key: (ActivityStore.Segment) -> String?) -> [Bucket]`: groups time by the key you return (an app name, a host, a project), sorted by time. `bundle` supplies a bundle id for the icon.
- `heatmap(_ segments: [ActivityStore.Segment], from: Int64, to: Int64, now: Int64, calendar: Calendar = .current) -> [HeatCell]`: focused time per weekday and hour. Each segment counts in the hour it started in.

Nested types: `Bucket` has `key`, `ms`, `share`, `visits` and `bundleId`. Its `init` is `init(key: String, ms: Int64, share: Double, visits: Int, bundleId: String? = nil)`. `HeatCell` has `weekday`, `hour` and `ms`. `HeatKey` has `weekday` and `hour`.

```swift
let range = FocusRange.make(.day)
let now = Int64(Date().timeIntervalSince1970 * 1000)
let segments = try store.segments(from: range.fromMs, to: range.toMs)
let totals = FocusAggregate.totals(segments, from: range.fromMs, to: range.toMs, now: now)
let byApp = FocusAggregate.buckets(segments, from: range.fromMs, to: range.toMs, now: now,
                                   bundle: { $0.appBundle }) { $0.appName }
print(totals.focusedMs, byApp.first?.key ?? "none")
```

#### `FocusFormat`

Text formatting that matches the CLI, so a screenshot and a terminal never disagree about a range.

- `duration(_ ms: Int64) -> String`: `20s`, `45m` or `1h 30m`.
- `percent(_ share: Double) -> String`: `42%`.
- `clockTime(_ ms: Int64) -> String`: `HH:mm` in the local time zone.
- `dayKey(_ date: Date, calendar: Calendar = .current) -> String`: `yyyy-MM-dd`.

```swift
let text = FocusFormat.duration(5_400_000)
let share = FocusFormat.percent(0.42)
let start = FocusFormat.clockTime(Int64(Date().timeIntervalSince1970 * 1000))
let day = FocusFormat.dayKey(Date())
```

#### `FocusRange`

A time range for the Studio, with its length and a label. Weeks start on Monday. `FocusRange.make` is the way to build one, because the memberwise initializer is internal.

- `fromMs: Int64` and `toMs: Int64`: the range, end exclusive.
- `granularity: Granularity`: `day` (`"D"`), `week` (`"W"`), `month` (`"M"`) or `year` (`"Y"`).
- `label: String`: a `yyyy-MM-dd` date for a day, a date span for a week, a month name and year for a month, and the year for a year.
- `FocusRange.make(_ granularity: Granularity, containing date: Date = Date(), calendar: Calendar = .current) -> FocusRange`: the range of that length that holds the date.
- `stepped(by delta: Int, calendar: Calendar = .current) -> FocusRange`: the range moved by whole periods. Negative goes back.

```swift
let week = FocusRange.make(.week)
let lastWeek = week.stepped(by: -1)
let segments = try store.segments(from: lastWeek.fromMs, to: lastWeek.toMs)
print(lastWeek.label, segments.count)
```

#### `FocusDaySummary`

Today's numbers for the menu-bar popover: focused time, finished sessions, context switches and the top three apps.

- `focusedMs: Int64`, `sessionsDone: Int`, `switches: Int`, `topApps: [ActivityRecorder.AppShare]`
- `FocusDaySummary.empty`: all zeros.
- `FocusDaySummary.today(store: ActivityStore, now: Date = Date()) -> FocusDaySummary`: reads the ledger for the day of `now`. It returns `empty` when the read fails.

```swift
let summary = FocusDaySummary.today(store: store)
let focused = FocusFormat.duration(summary.focusedMs)
let top = summary.topApps.first?.appName ?? "none"
print(focused, summary.sessionsDone, summary.switches, top)
```

#### `FocusPalette`

Stable colors per app and per key, so the timeline does not change colors from week to week. A key is hashed into a fixed set of eight swatches.

- `FocusPalette.swatches: [Color]`: the eight colors.
- `FocusPalette.gapFill: Color`: the fill for unmeasured gaps. It looks different from both idle and busy time.
- `FocusPalette.color(for key: String) -> Color`: the swatch for a name. The same key always gives the same color.

```swift
HStack(spacing: 4) {
    Rectangle().fill(FocusPalette.color(for: "Safari"))
    Rectangle().fill(FocusPalette.color(for: "Mail"))
    Rectangle().fill(FocusPalette.gapFill)
}
.frame(height: 12)
```

### Keymap

Keyboard shortcuts as data (Martin, 2026-10-15): every app keeps its keys in one `KeymapLibrary`, the user's own keys
in a `KeymapConfiguration` beside it, and the menu, the tooltips, the help list and the key handling all read the same
`Keymap`. Before it, a key lived on a hidden `Button` with `.keyboardShortcut`, a `performKeyEquivalent` override, a
menu item or an event monitor, matched by character in some places and by key code in others, and a hand-typed
"(⌘S)" in a tooltip could say anything.

#### Keys: `KeyChord`, `KeyStroke`, `KeyModifiers`

A `KeyChord` is a key and `KeyModifiers` (⌃ ⌥ ⇧ ⌘). The key is one of two kinds, and the choice matters on any
keyboard that is not US:

- `.code(UInt16)`: a position (virtual key code), whatever the layout types there. Use it for keys picked for where
  they sit: the two keys right of P (`33`, `30`; "[" and "]" on US, "ú" and ")" on Czech), arrows, Return, F-keys.
- `.character(String)`: what the key types. Use it for letters (⌘Z follows the Z of a QWERTZ layout) and for
  symbols whose meaning is the symbol (⌘+ zooms in on whichever key types +).

`matches(_ stroke: KeyStroke)`: a position compares the key code and all four modifiers. A character compares the
typed character (`charactersIgnoringModifiers`); Shift counts only for a letter or when the chord holds Shift,
because the layout decides whether a symbol needs Shift (⌘+ is Shift and = on US, one key on Czech).
`matchesByUSPosition` is the fallback for keys that type no ASCII character: ⌘ with the Czech ě key reaches ⌘2.
Letters never fall back. `Keymap` matches in three passes (`KeyMatchPass`): positions, then characters, then the
fallback, so ⇧⌘ on the ú key is Previous Tab even though it also types "/".

Measured on the Czech layout (UCKeyTranslate, 2026-10-15): ⌘ on the number row types "+ ě š č ř ž ý á í é", so a
chord written as `.character("1", .command)` fires on ⌘⇧ there; "=" sits where US has "-", "-" where US has "/", and
the US "=" key is a dead key.

Labels: `chord.label` (main actor, the current layout) or `label(layout:)`; "⇧⌘Ú" on Czech, "⇧⌘[" on US, "⌘↩",
"F6". `SystemKeyLayout` reads the current input source (or a pinned one, `SystemKeyLayout(sourceID:)`) and caches per
layout; `TableKeyLayout` is a fixed table (`.us`, or a layout in a test). The saved form is `description`:
`"shift+cmd+code:33"`, `"cmd+char:+"`. `KeyChord.recorded(_:)` is what a recorder keeps: an ASCII letter by
character, every other key by position. `menuKeyEquivalent` is the string for an `NSMenuItem`.

#### Commands: `KeymapCommand`, `KeymapLibrary`, `KeymapScope`

```swift
static let library = KeymapLibrary(id: "markdown", title: "Markdown Viewer", commands: [
    KeymapCommand("markdown.tab.next", "Next Tab", group: "Tabs", keys: [.code(30, [.shift, .command])]),
    KeymapCommand("markdown.view.bigger", "Bigger Text", group: "View",
                  keys: [.character("+", .command), .character("=", .command)]),
    KeymapCommand("markdown.find.next", "Next Match", group: "Find", keys: [.character("g", .command)],
                  scope: "markdown.find"),
    KeymapCommand("markdown.app.quit", "Quit", group: "Window", keys: [.character("q", .command)], scope: .app,
                  configurable: false),
])
```

An id is dotted and stable (it is saved in the user's file). `detail` is one more sentence for the help list. A
command with `configurable: false` (Return in a field, Copy) is listed in the help but not offered in the editor;
list it anyway, so the conflict check knows the key is taken. `scope`: `.window` (default), `.app` (the menu bar: it
meets every scope but `.global`), `.global` (system-wide), or a name of your own for a part that comes and goes (a
find bar, a sheet, a text view). Two commands in one scope must not share a key; a narrower scope may reuse a
window key, because its handler is newer and takes the key only while it is on screen.

#### The user's keys: `KeymapConfiguration`, `KeymapStore`

Only what differs from the defaults is saved, by command id; an empty list turns the key off.
`KeymapStore.standard(library:)` is `<GenesisKitHost.keymapDirectory>/<library id>.json`, else
`~/Library/Application Support/GenesisKit/Keymaps`. A missing file is no override. A file that is not JSON is
logged and ignored until the next save. One chord this version cannot read is kept and written back; the other
keys still load. A missing `version` is version 1.

#### In force: `Keymap`

`@MainActor ObservableObject`, one per library and process (a `static let shared = Keymap(library: library)`).
`chords(for:)`, `chord(for:)`, `label(for:)` ("⇧⌘Ú" or nil), `hint("Save", id)` ("Save (⌘S)", the tooltip
convention), `isCustomized(_:)`, `setChords(_:for:)` (the defaults again clear the override), `reset(_:)`,
`resetAll()`, `reload()`, `commands(for: KeyStroke, in: scopes)`, `conflicts()`, `commands(using:besides:)` (what a
recorder warns about), and `bind(_ item: NSMenuItem, to: id)`, which keeps a menu item's key current.

Tests: `Keymap(library:store: nil, layout: TableKeyLayout(...))` keeps changes in memory and names keys from a table.

#### Running commands: `KeymapDispatcher`, `.keymapAction`

One local key-down monitor per process. A press goes to the live handlers of its window (that window's own first,
then app-wide ones, each newest first) before any view, the menu or SwiftUI's shortcuts see it; a press no handler
takes goes on unchanged. A chord with no ⌘ and no ⌃ never fires while text input (an editable text view, a field
editor, a web view) has the focus.

- SwiftUI: `.keymapAction("markdown.file.pdf", in: keymap, enabled: canExport) { exportPDF() }`, in place of a hidden
  `Button(...).keyboardShortcut(...)`. It is live while the view is in a window; where `ViewThatFits` keeps several
  copies alive, the newest runs.
- AppKit: `KeymapDispatcher.shared.register(id, in: keymap, window: window) { ... }` returns a `KeymapRegistration`;
  hold it (it ends when released or cancelled). `window: nil` is any window of the app.
- A menu item shows the key (`keymap.bind(item, to: id)`) and runs on a click; the handler above takes the key.
  A SwiftUI menu (`Commands`, `MenuBarExtra`) shows it with `.keymapShortcut(id, in: keymap)`
  (`KeyChord.keyboardShortcut`); SwiftUI then runs it by character, so register it with the dispatcher as well when
  it must work by position or on another layout.
- Bold, italic, link and task register with the dispatcher while the source editor is the first responder
  (`MarkdownKeymap.registerSourceCommands`), so they take a window key only then. Indent and outdent stay on
  the text view. `MarkdownKeymap.sourceCommand(for:)` is the same lookup.

#### Showing and changing keys: `KeymapHelpWindow`, `KeymapHelpView`, `KeymapListView`, `KeyChordRecorder`, `KeyCaps`

`KeymapHelpWindow.show(keymap)` opens one window. `show(_:)` also takes several `KeymapPage`s, each a keymap and an
optional set of command ids, and a key two of those pages share is marked on both. The window has a search field,
the commands by group with their keys as `KeyCaps`, "Changed" on a user key, and "Change Keys…", which turns each
row into a `KeyChordRecorder` with buttons for no key and for the default. `KeymapListView(keymap:editing:)` is the
same list for a settings page. The recorder listens only while its window is key: a press in another window, or the
window resigning key, stops it and the press is delivered. Starting a second recorder stops the first. It needs ⌘,
⌃ or ⌥ (a function key may stand alone), refuses macOS's own keys (⌘Tab, ⌘Space, ⌘`, ⇧⌘3/4/5), and suspends the
dispatcher while it listens. Ids: `keymap-search`, `keymap-edit`, `keymap-restore-all`, `keymap-row-<id>`,
`keymap-recorder-<id>`, `keymap-conflict-<id>`.

The markdown viewer is the first library (`Markdown/Window/MarkdownKeymap.swift`).

### Markdown

The Markdown folder is the Genesis Markdown viewer: one window with tabs that reads and edits markdown and other text files, plus building blocks for a host that draws markdown in its own screens. A host runs the viewer as its own process with `MarkdownViewerApp.run(_:)` and a `MarkdownViewerAppConfiguration`, or keeps its own process and opens files with `MarkdownDocumentWindowController.shared.show(paths:focus:range:)`. `GenesisKitMarkdownConfiguration.shared` holds the viewer's tunables, which the window reads live, and the markdown members of `GenesisKitHost` lend it the notes vault, completion values, the default-app offer and the `tools` binary. For markdown inside a host's own screens, `MarkdownContentView` with a tunable `MarkdownStyle` draws it natively (a host's find marks it through `MarkdownFindMarks`), `MarkdownPreviewView` is a scrolling reading pane, `MarkdownWebPage` is the offline web renderer, and `MarkdownRenderer` names the three engines. The parsers and helpers (`MarkdownBlocks`, `WikilinkParser`, `MarkdownLineRange`, `MarkdownDocumentLinks`, `MarkdownFrontmatter`, `VaultIndex`) are public and need no view. The window's own parts (documents model and view, web view, toolbar, path bar, source editor, find panel, status bar, outline, file tree, hover preview, go to sheet, conflict banner, export, drop, default app dialog, dashboard share) are internal to GenesisKit, so a host reaches them only through the window controller and the configuration.

#### What the viewer window offers

The features a reader sees in the Genesis Markdown window. Where a `GenesisKitMarkdownConfiguration` field switches a feature, it is named in parentheses. The window follows a change to the configuration while it is open.

- Find panel: Command F opens a floating panel at the top right of the document with match case, whole word, regular expression and find in selection. It searches the source editor and the web-rendered page. The native renderers draw no match marks, and the panel then says "Web renderer only".
- Find in all open tabs: with more than one tab open, a button on the find panel lists every tab that has a match, with the count and the first matching line. A click selects that tab and runs the find there.
- Match ticks: ticks on the page's right edge show where the matches are, with the current match in the accent color. A click on a tick goes to that match (`scrollbarMatchMarks`).
- Breadcrumb path: the title bar shows the open file's path. Each folder and the file open a menu of path verbs, taken from `folderActions` and `fileActions`. A path too long for the strip folds its first folders into one "..." control.
- Show in Sidebar and Navigate in Sidebar: Show in Sidebar opens the folders down to the row, scrolls to it and pulses it. It re-roots the tree instead when the item is outside the root or more than four folders would have to open above its row. Navigate in Sidebar re-roots the tree at the folder (for a file, its folder) and pulses the sidebar header. Show in Sidebar is in the default `folderActions` and `fileActions`. Navigate in Sidebar is in the default `folderActions`, and a host can add it to `fileActions`.
- New File and New Folder: the "+" button in the tree header and the folder menus ask for a name and create the item. A new file opens as a tab when the viewer can read its type. The tree reveals a new file or folder. The folder menus offer them through `newFile` and `newFolder` in `folderActions`.
- Search in Folder: a folder verb that limits the tree's text search to that folder and shows the limit as a removable chip (`searchInFolder` in `folderActions`).
- Tree font: the file tree's text shrinks until the names fit and grows with the sidebar's width only while they all still fit. It is never below 10.5 points, and never above the configured size plus one point per 60 points of width past the standard width, at most four more (`treeFontScalesWithWidth`, `treeFontSize`).
- Wrapped tabs and preview tabs: with `wrapTabs`, tabs flow onto more rows instead of scrolling sideways. With `previewTabs`, a single click in the file tree opens an italic preview tab that the next single click replaces. A double-click, an edit or Keep Tab keeps it.
- Hover preview: a floating, bordered, read-only preview of a note opens after the pointer rests on an unselected tab, a file row in the tree or a link in the web page. A click in the panel opens the note as a tab (`hoverPreview`, `hoverPreviewDelay`, `hoverPreviewSize`).
- Heading anchors: a "#" beside a heading on hover. A click copies a wikilink to the heading, such as `[[plan#Setup]]` (`headingAnchors`).
- Git state: the status bar shows the branch and the note's state ("M · 3 lines unstaged · 1 line staged"), a changed tab its letter. Both follow git's own folder events. Every git part is off with `git` and hidden outside a repository.
- Change gutter: bars beside the lines that differ from HEAD in the source editor and beside the changed blocks on the page. A click shows what HEAD had there, the agent session that wrote the lines, and Revert this hunk (`gitGutter`).
- Changes mode: a fourth mode beside Read, Split and Source with the file's diff per scope (Unstaged, Staged, Uncommitted, Last commit or any commit, Branch), as lines (split or unified) or, for a note, rendered: added blocks green, changed ones with their old version struck through above them, word marks in a changed paragraph (`gitDefaultScope`). An open with `diff=staged` or `--diff staged` lands there.
- Git sidebar: This file lists the note's commits (a click reads that version with Compare with current and Restore, the context menu compares any two); Repository shows the branch, the staged and unstaged files (a click opens one in the Changes mode) and recent commits (a click opens the commit's files in a sheet, notes as rendered diffs).
- Tree marks: the file tree marks changed files and folders that hold changes, with a Changed only filter (`gitTreeDecorations`).
- Agent attribution: which agent session wrote a changed line, in the gutter card and on hover in the line diff, with Open session (`gitAgentAttribution`, one switch).
- Open Recent: File, Open Recent lists the files opened lately; an open one is checked, a closed one says when it was closed ("closed 3h ago").
- Code block bar: every fenced code block in the web page gets a bar with its language and a Copy button. Mermaid diagrams and a file shown as one numbered code block get none. `MarkdownPreviewView` adds the Copy button to its blocks (`codeBlockBar`).
- Sticky section line: a line pinned to the top of the page shows the heading path of the section on screen. A click on a part scrolls to that heading. Reduce Transparency makes the line opaque (`stickySection`).
- Live saved time: the status bar reads "saved 3m ago" and keeps itself current. The exact time is in its tooltip.
- High contrast text: secondary and muted text in the chrome and in the page have more contrast by default. The dark themes get brighter text and the light theme gets darker text (`contrast`, default `high`).
- Grouped toolbar: toolbar buttons sit in segmented groups. They show their names beside the icons while the whole row fits the window's width (`toolbarLabels`, default `whenRoom`).

#### `MarkdownViewerApp.run(_:)`

Runs the whole process as the markdown viewer. Call it from the entry point of an app whose only job is the viewer (Genesis runs it as `Genesis Markdown.app`, GenesisTools as `GenesisTools --markdown`). It is `@MainActor` and returns `Never`, so nothing after it runs.

What it does, in order:

- Adds `defaultsSuite` to the standard defaults when one is set. Reads fall through to the suite. Writes land in this process's own domain and shadow it.
- Calls `prepare`.
- Sets the activation policy to `.regular`, installs a `MarkdownViewerDelegate` and builds the menu bar with `MarkdownViewerMenu.build(appName:)`. There is no SwiftUI `App`, because a SwiftUI scene would insist on a main window of its own.
- Creates `MarkdownDocumentWindowController.shared` and starts the run loop.

The viewer then behaves as a one-window app. Files that macOS opens (a drop on the Dock icon, Open With) become tabs. A launch with nothing to open restores the tabs from last time. Closing the window or the last tab quits the app. Quit asks per unsaved tab.

- `_ configuration: MarkdownViewerAppConfiguration`: the app name, defaults suite, files to open, focus flag, launch hook and URL handler.

```swift
MarkdownViewerApp.run(MarkdownViewerAppConfiguration(
    appName: "Example Markdown",
    defaultsSuite: "com.example.notes",
    paths: Array(CommandLine.arguments.dropFirst()),
    handleURL: { url in
        MarkdownDocumentWindowController.shared.show(paths: [url.path], focus: true)
    }
))
```

#### `MarkdownViewerAppConfiguration`

What a host passes to `MarkdownViewerApp.run(_:)`. A plain struct with public fields and a public init.

- `appName: String`: the name in the app menu ("Hide ...", "Quit ...").
- `defaultsSuite: String? = nil`: a defaults suite that reads fall through to. Genesis passes the main app's suite, so tabs, zoom and the window frame carry over.
- `paths: [String] = []`: files to open once launch completes, besides whatever macOS opens.
- `focus: Bool = true`: whether those files bring the window to the front. Use `false` for a background launch such as `open -g`.
- `prepare: () -> Void = {}`: runs before the run loop starts, for the host's own launch setup (tooltip theme, hang watch).
- `handleURL: (URL) -> Void`: receives a URL that reached this process through the host's URL scheme. Route it, usually to `MarkdownDocumentWindowController.shared.show(paths:focus:range:)`. A URL that arrives before launch completes waits and is passed in once launch is done.

```swift
let configuration = MarkdownViewerAppConfiguration(
    appName: "Example Markdown",
    paths: ["/tmp/demo/readme.md"],
    focus: false,
    prepare: { applyTooltipTheme() },
    handleURL: { url in route(url) }
)
```

#### `MarkdownDocumentWindowController`

The one markdown window. `show` adds tabs to it. It never opens a second window, and opening a path that is already open selects its tab. The window has a transparent title bar, a minimum size of 560 by 400 points, and a frame that macOS remembers (autosave name `genesis.markdown-window.v2`). On the first show it takes 1280 by 880 points, shrunk to fit the screen under the pointer, and centers there. The title bar shows the open file's path as a breadcrumb in place of the title text. The window title and the represented file still follow the selected tab, for the Window menu, Mission Control and VoiceOver. Use `MarkdownDocumentWindowController.shared`. There is no public init.

Properties:

- `static let shared: MarkdownDocumentWindowController`: the single instance.

Methods:

- `show(paths: [String], focus: Bool, range: MarkdownLineRange? = nil)`: opens or re-selects the files and orders the window front. A path may start with `~`. An empty `paths` shows the viewer as it was last closed, with its remembered tabs. `focus: true` brings the app and window forward. `focus: false` only orders the window front. `range` belongs to the last path, the tab that ends up selected: the source editor selects those lines and the preview marks them.
- `closeSelectedTab(_ sender: Any?)`: the target of File, Close Tab (command W). The selected tab closes, not the window. A tab with unsaved changes asks first (save, don't save, cancel). When the last tab closes, the window closes too.
- `saveSelected(_ sender: Any?)`: the target of File, Save. Saves the selected tab.
- `goToLocation(_ sender: Any?)`: the target of File, Go to Location (shift command G). Shows the window and opens the Go to Location sheet.
- `windowWillUseStandardFrame(_:defaultFrame:)`: the green button and a title bar double-click fill the visible screen, then restore.
- `windowShouldClose(_:)`: saves the scroll positions and asks per unsaved tab. It returns `false` when the reader cancels. The tabs stay, so the window reopens the way it was closed.

```swift
let range = MarkdownLineRange(first: 10, last: 20)
MarkdownDocumentWindowController.shared.show(
    paths: ["~/Notes/plan.md", "/tmp/demo/readme.md"],
    focus: true,
    range: range
)
```

#### `GenesisKitMarkdownConfiguration`

The viewer's tunables in one observable object: hover previews, tabs, contrast, the toolbar, the file tree, the page extras, and the actions a file or a folder offers. A host sets them at launch, and a settings screen can bind to them. The window and the web page read them live: a change shows without a relaunch. The switches are remembered in the defaults under the prefix `markdown.config.`. The three values a host chooses (`hoverPreviewSize`, `folderActions`, `fileActions`) are not remembered. The class is `@MainActor`. Use `GenesisKitMarkdownConfiguration.shared`. The `PathAction` verbs are documented with the Paths folder.

- `init(defaults: UserDefaults = .standard)`: reads the saved switches from `defaults`. A host rarely needs its own instance, and tests pass a private suite.

Properties (each `@Published`, so a SwiftUI view can observe them). Each line names what the viewer does with the field.

- `hoverPreview: Bool = true`: a floating, bordered preview of a note opens after the pointer rests on an unselected tab, on a file row in the file tree, or on a link in the page. Off: no preview opens, and a tab shows its path as a tooltip again.
- `hoverPreviewDelay: TimeInterval = 1.0`: how long the pointer rests before the preview opens, in seconds. While a preview is up, the next tab, row or link opens its preview after 0.08 seconds.
- `hoverPreviewSize: CGSize = CGSize(width: 560, height: 440)`: the preview's size, before it is fitted to the screen. Not remembered.
- `wrapTabs: Bool = false`: the tab strip wraps its tabs onto more rows instead of scrolling sideways. The tab bar and every tab also offer a "Wrap Tabs" toggle in their context menu that sets this field.
- `previewTabs: Bool = true`: a single click in the file tree opens a preview tab (italic title) that the next single click replaces. A double-click in the tree, a double-click on the tab, an edit or "Keep Tab" in the tab's menu keeps it. Off: every open is a normal tab.
- `contrast: MarkdownContrast = .high`: the window's theme uses it for the secondary and muted text of the chrome (toolbar, tabs, file tree, status bar) and of the page. Cases: `standard` (the original grays) and `high` (stronger secondary and muted text: brighter on the dark themes, darker on the light theme).
- `toolbarLabels: MarkdownToolbarLabels = .whenRoom`: the toolbar shows a short name beside each icon `always`, `never`, or `whenRoom`, which means only while the whole row fits at the window's current width. The zoom buttons never show a name.
- `treeFontScalesWithWidth: Bool = true`: the file tree's font follows the sidebar's width and its names. It is the largest size at which every name in the list (or every search hit) fits whole, between 10.5 points and a ceiling. The ceiling is `treeFontSize` plus one point for each 60 points of width past the standard width, at most four more. With a system scroller beside the list, its width is taken off first. Off: it stays at `treeFontSize`.
- `treeFontSize: Double = 13`: the file tree's font size at the standard sidebar width (230 points), in points. It is the base of the ceiling, so it is also the size short names get at that width.
- `headingAnchors: Bool = true`: the web page shows a `#` beside a heading on hover, and a click copies a wikilink to the heading. `MarkdownWebPage` follows it too.
- `codeBlockBar: Bool = true`: the web page draws a bar on every fenced code block with its language and a Copy button (not on mermaid diagrams, nor on a file shown as one numbered code block). `MarkdownPreviewView` adds the Copy button to its fenced blocks. `MarkdownWebPage` follows it too.
- `stickySection: Bool = true`: the web page pins a line to its top with the heading path of the section on screen. `MarkdownWebPage` follows it too.
- `scrollbarMatchMarks: Bool = true`: the find panel puts ticks on the web page's right edge where the matches are.
- `folderActions: [PathAction] = PathAction.folderDefaults`: the verbs, in menu order, of a breadcrumb folder, a file tree folder row, the tree's empty-space menu (without `showInSidebar` and `navigateInSidebar`) and a link to a folder in a note. The defaults are `showInSidebar`, `navigateInSidebar`, `searchInFolder`, `newFile`, `newFolder`, `openInFinder`, `openInCursor`, `openInTerminal`, `copyPath`. Not remembered.
- `fileActions: [PathAction] = PathAction.fileDefaults`: the verbs, in menu order, of the breadcrumb's file, a file tree row and a tab's context menu. The defaults are `showInSidebar`, `openInDefaultApp`, `openInObsidian`, `openInFinder`, `openInCursor`, `copyPath`, `rename`, `duplicate`, `trash`. Not remembered.

```swift
let config = GenesisKitMarkdownConfiguration.shared
config.wrapTabs = true
config.toolbarLabels = .always
config.hoverPreviewDelay = 0.6
config.fileActions = [.showInSidebar, .openInFinder, .copyPath]
```

#### `GenesisKitHost` (markdown hooks)

`GenesisKitHost` is the protocol an app implements to lend things to the kit. The kit finds the host by the Objective-C class name `GenesisKitHostAdapter` (declare the class with `@objc(GenesisKitHostAdapter)`), and `GenesisKit.install(_:)` sets one by hand, for tests. Every member has a default, so an app implements only what it has. These are the members the markdown viewer reads. The rest of the protocol is documented with the Style folder.

- `var markdownVaultRoot: String? { get }`: the notes vault that the viewer resolves vault links and `[[wikilinks]]` against, that vault-rooted images and files resolve against, and that "Open in Obsidian" and the completion index use. Default `nil`: the app has no vault.
- `var markdownConfiguredVault: String? { get }`: the vault path the app's config names. It gives "Open in Obsidian" its vault name. Default `nil`.
- `func markdownCompletions(_ request: MarkdownCompletion.Request) -> [String]?`: the values for `[[` and `#` completion in the source editor. Called on the main actor. Default `nil`: the viewer reads the vault's `VaultIndex` read-only at `markdownVaultRoot`. Without a vault, or before the vault has an index, it offers nothing.
- `func markdownPropertyVocabularyJSON() -> String?`: the property keys and their values, as JSON, for the Properties block's suggestions. The shape is an object from each key to a list of its values. Default `nil`: the viewer builds it from the `VaultIndex`. It asks at most once a minute.
- `var markdownDefaultAppBundleID: String? { get }`: the bundle id the viewer offers as the default app for the file types it reads (`md`, `markdown`, `mdx`, `txt`, `json`, `yaml`, `yml`, `canvas`, `base`). The prompt shows once per install, on a launch where some of those types still open in another app. The same id gives the app menu its "Set as Default App..." item. Default `nil`: the viewer never offers, and the menu has no such item.
- `var toolsBinaryPath: String? { get }`: the `tools` binary the viewer runs for the dev-dashboard share button (`tools dev-dashboard share <note>`). Default `nil`: the viewer resolves the binary the usual way.
- `func transcriptMarkdown(_ text: String, style: TranscriptMarkdownStyle) -> AnyView?`: draws the transcript's markdown (replies, prompt parts) in the app's own renderer. A typical answer is `MarkdownContentView` with `MarkdownStyle(style)`. Default `nil`: the transcript draws inline markdown in one `Text`.
- `func log(_ line: String)`: receives the kit's diagnostic lines, among them the viewer's (for example `viewer: url queued until launch completes`). Default: does nothing.

```swift
@objc(GenesisKitHostAdapter)
final class GenesisKitHostAdapter: NSObject, GenesisKitHost {
    var markdownVaultRoot: String? { "/Users/alice/Notes" }
    var markdownDefaultAppBundleID: String? { Bundle.main.bundleIdentifier }
    func transcriptMarkdown(_ text: String, style: TranscriptMarkdownStyle) -> AnyView? {
        AnyView(MarkdownContentView(markdown: text, style: MarkdownStyle(style)))
    }
}
```

#### `MarkdownContentView`

A stack of rendered markdown blocks for any surface that shows model output or short notes: chat bubbles, a HUD, a transcript, a pull request description. It draws natively and is tuned through `MarkdownStyle`. It has no scroll view and no background, so the caller owns the container. The parse is cached by text, so a streaming reply renders live. It draws headings, paragraphs, fenced code, quotes, list items with task checkboxes, rules, frontmatter keys as pills and GFM tables. Inline bold, italic, code and links work. `[[wikilinks]]` become tappable links. The HTML that GitHub and review bots write (`<details>`, `<br>`, comments) becomes markdown or goes, unless the style turns that off. A host's find marks matches inside it through `MarkdownFindMarks`.

- `markdown: String`: the text to render.
- `style: MarkdownStyle = .vault`: the look.
- `onWikilink: ((String) -> Void)? = nil`: called when a wikilink is clicked, with its target (`Note`, `Note#Heading` or `Note#^block`). Without it, wikilinks are not intercepted.

```swift
ScrollView {
    MarkdownContentView(
        markdown: reply.text,
        style: .chat.with { $0.highlightsCode = true },
        onWikilink: { target in openNote(target) }
    )
    .padding(12)
}
```

#### `MarkdownStyle`

The look of `MarkdownContentView`, so one renderer serves the vault pane, chat, the companion HUD, the transcript and a host's own panels. Every field is a public `var` with a default, and `MarkdownStyle()` is the vault's look. Start from a preset and change what the surface needs with `with(_:)`. The struct is `Equatable` and `Sendable`. Colors such as `.settingsText` are GenesisKit's own palette.

- `init()`: the vault look, with every field at its default.
- `with(_ change: (inout MarkdownStyle) -> Void) -> MarkdownStyle`: a copy with `change` applied, such as `MarkdownStyle.chat.with { $0.bodySize = 12 }`.
- `init(_ transcript: TranscriptMarkdownStyle)`: a style from the transcript's fields (body size, the text, secondary, muted, accent, code and task colors, line spacing, block spacing and heading scale). It also sets `selection = .none`, `codeFontSize = nil` and `codeWraps = true`: the transcript rows turn selection on under the pointer, and a sideways scroller in every row is too costly. `GenesisKitHost.transcriptMarkdown` is the usual caller.

Fields:

- `bodySize: CGFloat = 13`: the paragraph size, in points.
- `textColor: Color = .settingsText`: paragraphs, list items, table cells, and h1 and h2.
- `secondaryColor: Color = .settingsTextSecondary`: quotes, and h3 to h6 while `dimsMinorHeadings` is on.
- `mutedColor: Color = .settingsTextMuted`: the code language label and Copy button, rules, table header cells, the unchecked box, and the text of a done task.
- `accentColor: Color = .neonAmber`: bullets, ordered markers, and the quote bar unless `quoteBarColor` is set.
- `codeColor: Color = .neonCyan`: the text of fenced code.
- `codeBackground: Color = Color.black.opacity(0.35)`: the fill behind a fenced block.
- `taskDoneColor: Color = .genSuccess`: the checked box of a done task.
- `lineSpacing: CGFloat = 3`: extra space between the lines of a paragraph.
- `blockSpacing: CGFloat = 10`: space between blocks.
- `headingScale: CGFloat = 1`: multiplies the heading sizes.
- `monoBody: Bool = false`: paragraphs, quotes, list items and table cells in the monospaced font. Headings keep the system font.
- `headingSizes: [CGFloat] = [22, 18, 15, 13, 13, 13]`: h1 to h6, in points, before `headingScale`.
- `headingWeights: [Font.Weight] = [.bold, .bold, .semibold, .semibold, .semibold, .semibold]`: h1 to h6.
- `dimsMinorHeadings: Bool = true`: h3 and below use `secondaryColor`. Off: every heading uses `textColor`.
- `codeFontSize: CGFloat? = 11`: the fenced code size. `nil` follows the body: `bodySize - 1.5`.
- `highlightsCode: Bool = false`: fenced blocks in syntax colors by their language, for example `tsx`.
- `codeWraps: Bool = false`: long code lines wrap. Off: the block scrolls sideways and keeps its lines whole.
- `codeShowsLanguage: Bool = true`: the fence's language above the block.
- `codeCopyButton: Bool = false`: a Copy button above the block, beside the language.
- `codePadding: CGFloat = 10`: the inner padding of a fenced block.
- `codeCornerRadius: CGFloat = GenRadius.sm`: the corner radius of a fenced block.
- `inlineCodeBackground: Color? = nil`: a fill behind `inline code`. `nil` keeps only the monospace.
- `quoteBarColor: Color? = nil`: the color of the quote bar. `nil` is `accentColor` at 70 %.
- `quoteItalic: Bool = true`: quotes in italic.
- `selection: MarkdownStyle.Selection = .codeOnly`: which text the reader can select. A selectable block costs a selection overlay, a focus ring and a key-view entry, which a long list pays on every row.
- `wikilinks: Bool = true`: `[[Note]]` becomes a link that `MarkdownContentView(onWikilink:)` receives. Off: it stays text.
- `linkColor: Color? = nil`: the color of links. `nil` is the environment's tint.
- `cleansHTML: Bool = true`: the HTML that GitHub and review bots write becomes markdown or goes, instead of showing as tags. Fenced code is left alone.

`Selection` cases:

- `none`: no block is selectable.
- `codeOnly`: only fenced code is selectable.
- `all`: every block is selectable.

Presets:

- `static let vault`: `MarkdownStyle()`, the near-black vault reading pane. The default of `MarkdownContentView`.
- `static let chat`: chat bubbles, `bodySize` 13.5, `blockSpacing` 9.
- `static let companion`: the teal companion HUD, `bodySize` 14, teal accent and done-task colors, `blockSpacing` 8, `headingScale` 0.82.
- `static let transcript`: Session Details transcript turns, `bodySize` 12.5, the transcript palette, `blockSpacing` 8, `headingScale` 0.88.
- `static let companionUser`: the "You" row and the user's chat bubble, `bodySize` 13, dimmer teal colors, `blockSpacing` 6, `headingScale` 0.8.

```swift
let style = MarkdownStyle.chat.with {
    $0.bodySize = 12
    $0.highlightsCode = true
    $0.codeCopyButton = true
    $0.selection = .all
}
MarkdownContentView(markdown: reply.text, style: style)
```

#### `MarkdownRenderer`

The three reading engines a pane can use. The raw values are stored in `UserDefaults` under `markdownWindow.renderer`, so they never change. The window's toolbar cycles through them with `next`. `MarkdownWebPage` is the `web` engine. `MarkdownPreviewView` draws `native` and, with `rich: true`, `nativeRich`.

- `web`: WKWebView with markdown-it, highlight.js and mermaid, offline.
- `native`: the native Swift baseline, with flat code and no diagrams.
- `nativeRich`: native, with BeautifulMermaid diagrams and highlighted code.
- `var id: String`: the raw value, for `Identifiable`.
- `var label: String`: "Web", "Native" or "Native+".
- `var icon: String`: an SF Symbol name: `globe`, `swift` or `sparkles`.
- `var detail: String`: a one-line description for a picker.
- `var next: MarkdownRenderer`: the cycle `web`, `native`, `nativeRich`, back to `web`.

```swift
let engine = MarkdownRenderer(rawValue: stored) ?? .web
Label(engine.label, systemImage: engine.icon)
    .help(engine.detail)
```

#### `MarkdownFindMarks`

A host's find, marking its matches inside a `MarkdownContentView`. The view draws its text in units. A paragraph, heading, list item, quote or code block is one unit, and so is each cell of a table. A rule or a frontmatter block is one empty unit. Units are numbered from 0, in the order `MarkdownContentView.searchBlocks(_:style:)` lists them, so a match found in the n-th string of that list belongs to unit n. A host hands the value to the view through `EnvironmentValues.markdownFindMarks`.

- `id: AnyHashable`: names the marks. Two values are equal when their ids are, because a closure cannot be compared. Make the id carry everything the marks depend on, such as the query, the options and the current match.
- `mark: (inout AttributedString, _ unit: Int) -> Void`: tints the matches in the text one unit shows. It receives that text, with its links and code spans, and the unit's number.
- `anchor: (_ unit: Int) -> String?`: the unit's scroll target, applied as the unit's `.id`. `nil` for none. A host scrolls to it with a `ScrollViewReader`.
- `init(id: AnyHashable, mark: @escaping (inout AttributedString, _ unit: Int) -> Void, anchor: @escaping (_ unit: Int) -> String?)`: builds the value.

```swift
let marks = MarkdownFindMarks(
    id: query,
    mark: { shown, unit in
        if let hit = shown.range(of: query) { shown[hit].backgroundColor = .yellow }
    },
    anchor: { unit in unit == currentUnit ? "current-match" : nil }
)
MarkdownContentView(markdown: text).environment(\.markdownFindMarks, marks)
```

#### `EnvironmentValues.markdownFindMarks`

The enclosing find's marks for every `MarkdownContentView` below. The type is `MarkdownFindMarks?` and the default is `nil`, which means no find. A host sets it on a container with `.environment(\.markdownFindMarks, marks)`.

```swift
VStack {
    ForEach(replies) { reply in
        MarkdownContentView(markdown: reply.text, style: .chat)
    }
}
.environment(\.markdownFindMarks, find.isOpen ? marks : nil)
```

#### `MarkdownContentView.searchBlocks(_:style:)`

The text of every unit the view draws, in drawing order. It is what a host's find matches against, so the n-th entry is the unit that the n-th mark lands in (see `MarkdownFindMarks`). A paragraph, heading, list item or quote gives its text without markdown markup. A code block gives its raw code. A table gives its header cells in capitals, then every row's cells. A rule or a frontmatter block gives an empty string. The function is `nonisolated` and cached, so a find can call it off the main actor.

- `_ markdown: String`: the text the view renders.
- `style: MarkdownStyle = MarkdownStyle()`: the style the view draws with. `cleansHTML` and `wikilinks` change which text is shown.
- Returns `[String]`: one string per unit.

```swift
let units = MarkdownContentView.searchBlocks(text)
let hits = units.indices.filter { units[$0].localizedCaseInsensitiveContains(query) }
let count = hits.count
let currentUnit = hits.first
```

#### `MarkdownContentView.highlighted(_:info:)`

A fenced block in GenesisKit's token colors (`SyntaxHighlighter`), cached by language and text. The first 400 lines are colored and the rest stay plain. An unlabelled or unknown fence comes back as plain text. The function is `nonisolated`. Two related helpers sit beside it:

- `static func fenceMarker(_ line: String) -> (mark: Character, count: Int, info: String)?`: reads a fence line. It forwards to `MarkdownBlocks.fenceMarker(_:)`.
- `static func fenceLanguage(_ info: String) -> SyntaxLanguage`: the language an info string names, from its first word (split at a space, `{` or a comma). `tsx title="x"` is `.typescript`. `.plain` means an unlabelled fence or an unknown name, and gets no colors. `SyntaxLanguage` belongs to GenesisKit's token highlighter.

Parameters of `highlighted`:

- `_ text: String`: the code.
- `info: String`: the fence's info string, such as `tsx title="App"`.
- Returns `AttributedString`: the colored code.

```swift
let line = "~~~tsx title=\"App\""
let fence = MarkdownContentView.fenceMarker(line)
let language = MarkdownContentView.fenceLanguage(fence?.info ?? "")
let colored = MarkdownContentView.highlighted(code, info: fence?.info ?? "")
```

#### `MarkdownContentView.inline(_:codeBackground:)`

Inline markdown (bold, italic, code, links) as an `AttributedString`, with every code span on `codeBackground`. Wikilinks are not converted. The function is `nonisolated` and cached.

- `_ text: String`: one line or paragraph of markdown.
- `codeBackground: Color`: the fill behind each code span.
- Returns `AttributedString`.

```swift
let line = MarkdownContentView.inline(
    "Run `tools say` after **every** task",
    codeBackground: .gray.opacity(0.2)
)
Text(line)
```

#### `MarkdownWebPage`

The web renderer as a plain view, for a host's own reading pane (Genesis uses it for the vault pane). It renders the markdown with markdown-it, highlight.js and mermaid from bundled files, with no network. It understands Obsidian syntax: wikilinks, callouts and the Properties block for frontmatter. This view does not handle relative file links. Its page extras follow `GenesisKitMarkdownConfiguration`: heading anchors (`headingAnchors`), a bar with the language and a Copy button on every fenced block (`codeBlockBar`), and a sticky line with the heading path of the section on screen (`stickySection`). A change to those fields reaches an open page. The markdown window itself uses an internal web view with find, zoom, column and line-sync options.

- `markdown: String`: the document text.
- `scrollTarget: String?`: a heading to scroll to. The view turns it into a slug, so heading text and a slug both work. Pass `nil` for none.
- `highlightQuery: String?`: text to jump to and flash in the page. Pass `nil` for none.
- `highlightToken: Int`: bump it to run the jump again for the same query.
- `onWikilink: (String) -> Void`: called with the target of a clicked wikilink.
- `onActiveSection: (String) -> Void`: called with the slug of the heading that is at the top of the page as the reader scrolls. It can drive a sections list.
- `onProperties: (([MarkdownProperty]) -> Void)? = nil`: when set, the Properties block is editable and every edit sends the new rows. Write them back with `MarkdownFrontmatter.replacing(properties:in:)`. When `nil`, the block is read-only.
- `documentURL: URL? = nil`: the file being shown. Its images and JSON files resolve against its folder. With `nil` the page shows no local media.
- `vaultRoot: String? = nil`: the vault, for vault-rooted and name-only references.

```swift
MarkdownWebPage(
    markdown: note.text,
    scrollTarget: pendingHeading,
    highlightQuery: searchText, highlightToken: searchToken,
    onWikilink: { target in openNote(target) },
    onActiveSection: { slug in activeSlug = slug },
    onProperties: { rows in note.text = MarkdownFrontmatter.replacing(properties: rows, in: note.text) },
    documentURL: note.url,
    vaultRoot: vaultRoot
)
```

#### `MarkdownPreviewView`

A scrolling reading pane that renders a note natively (Obsidian-style preview), without a web view. It scrolls to a heading or a block, and it jumps to and blinks the first block that matches a search query. Links with the schemes `http`, `https`, `mailto` and `obsidian` go to the system. A `file:` link goes to `onWikilink` as its absolute string (see `MarkdownDocumentLinks.fileLinkTarget(_:vaultRoot:)`). Other links are dropped. Fenced blocks get a Copy button while `GenesisKitMarkdownConfiguration.codeBlockBar` is on.

- `markdown: String`: the note text.
- `scrollTarget: String?`: a heading name or slug to scroll to, or a `^block` id. Pass `nil` for none.
- `onWikilink: (String) -> Void`: called for a clicked wikilink (its target) and for a `file:` link (its absolute string).
- `highlightQuery: String?`: the search text to jump to. The matching block flashes twice. Pass `nil` for none.
- `highlightToken: Int = 0`: bump it each time a search result is clicked, so the jump runs again for a repeated query or the same file.
- `rich: Bool = false`: draws fenced code with syntax highlighting and `mermaid` fences as diagrams (the `nativeRich` engine). `false` draws flat code.

```swift
MarkdownPreviewView(
    markdown: note.text,
    scrollTarget: "setup",
    onWikilink: { target in openNote(target) },
    highlightQuery: searchText,
    highlightToken: searchToken,
    rich: true
)
```

#### `MarkdownBlocks`

The block-level markdown model that `MarkdownContentView` and `MarkdownPreviewView` render. It is a pure function from text to blocks, so a host can use it for outlines or tests.

- `static func parse(_ markdown: String) -> [Block]`: splits the text into blocks (frontmatter, headings, paragraphs, fenced code, quotes, list items, rules, tables). It keeps the last 12 results by exact source text, so a SwiftUI body that runs again does not parse again. A fence is three or more backticks or tildes. Only a fence of the same character, at least as long and with nothing after it, closes the block, so a shorter fence or a fence of the other character inside it is code. `parse` leaves HTML as it is; `MarkdownContentView` calls `strippingHTML(_:)` first when its style asks.
- `static func parseUncached(_ markdown: String) -> [Block]`: the same parse without the cache.
- `static func fenceMarker(_ line: String) -> (mark: Character, count: Int, info: String)?`: reads a fence line: its character, its length and the info string after it, trimmed. `nil` when the line is not a fence. `MarkdownContentView.fenceMarker(_:)` forwards here.
- `static func cleanHTML(_ line: String) -> String`: one line with its known tags turned into markdown, or removed with their text kept. Unknown tags stay, so a generic type written in prose, `Array<Int>`, is not eaten.
- `static func strippingHTML(_ markdown: String) -> String`: the HTML that GitHub and review bots write, as markdown. Comments go. `<summary>`, `<br>`, `<b>`, `<i>`, `<code>` and `<a>` become their markdown. The other known tags, `<details>` among them, go with their text kept. A line that held only tags is dropped, and fenced code is untouched.
- `static func slugify(_ heading: String) -> String`: the slug of a heading. It lowercases, drops everything except letters a to z, digits, spaces and hyphens, and joins the words with `-`.
- `Block`: an enum that is `Identifiable`, with a stable `id` string. The `index` of each case is the block's position in the document. The cases are:
  - `heading(level: Int, text: String, slug: String, index: Int)`
  - `paragraph(text: String, index: Int)`
  - `code(language: String?, code: String, index: Int)`
  - `quote(text: String, index: Int)`
  - `listItem(indent: Int, ordered: Bool, marker: String, text: String, task: Bool?, index: Int)`: `task` is `nil` for a plain item, `false` for an open task and `true` for a done task.
  - `rule(index: Int)`
  - `frontmatter(keys: [String], index: Int)`
  - `table(header: [String], aligns: [ColumnAlign], rows: [[String]], index: Int)`
- `ColumnAlign`: `leading`, `center` or `trailing`, from the `|:---:|` separator row.

```swift
let blocks = MarkdownBlocks.parse(MarkdownBlocks.strippingHTML(note.text))
let headings = blocks.compactMap { block -> String? in
    if case .heading(_, let text, _, _) = block { return text }
    return nil
}
let slug = MarkdownBlocks.slugify("Setup and Install")
let fence = MarkdownBlocks.fenceMarker("~~~swift")
```

#### `NativeCodeHighlighter`

Syntax highlighting for the native renderers, through highlight.js in JavaScriptCore with the atom-one-dark theme and Menlo 11. The engine is built once and reused, so use it from the main actor.

- `static func highlight(_ code: String, language: String?) -> AttributedString?`: the highlighted text, or `nil` when the engine or the language is unavailable (draw plain text then). The aliases `ts`, `tsx`, `js`, `jsx`, `sh`, `shell`, `zsh`, `yml`, `rb`, `py` and `rs` map to their highlight.js names.

```swift
if let colored = NativeCodeHighlighter.highlight("let total = 1 + 2", language: "swift") {
    Text(colored)
}
```

#### `MarkdownViewerDelegate`

The `NSApplicationDelegate` that `MarkdownViewerApp.run(_:)` installs. A host uses it directly only when it builds its own app setup, or in a test.

It queues URLs that arrive before launch completes, because a window ordered front that early never appears. It shows files that macOS opens as tabs, restores the last tabs for a launch or a Dock click with nothing to open, quits when the last window closes, and asks per unsaved tab on Quit. After launch it shows the default-app prompt once, if `GenesisKitHost.markdownDefaultAppBundleID` is set and some file types open elsewhere.

- `init(handle: @escaping (URL) -> Void, initialPaths: [String] = [], initialFocus: Bool = true)`: `handle` receives the host's URLs. `initialPaths` and `initialFocus` are opened after launch, like `MarkdownViewerAppConfiguration.paths` and `focus`.
- `var handle: (URL) -> Void`: the URL router. Tests replace it.
- `private(set) var pendingURLs: [URL]`: URLs waiting for launch to complete.
- `private(set) var launched: Bool`: whether launch is complete.
- `func receive(_ url: URL)`: passes the URL to `handle`, or queues it until launch completes.
- `func finishLaunching()`: marks launch complete and replays the queued URLs in order.

```swift
let delegate = MarkdownViewerDelegate(
    handle: { url in route(url) },
    initialPaths: ["/tmp/demo/readme.md"]
)
NSApplication.shared.delegate = delegate
```

#### `MarkdownViewerMenu`

The menu bar of the viewer process. Its keys come from `MarkdownKeymap` (`Keymap.bind`), so a key the user changes shows there too; the window's commands take the key press first (`MarkdownKeymap.registerWindowCommands`), so the menu shows the key and runs on a click. The type is `@MainActor`.

- `static func build(appName: String) -> NSMenu`: builds the main menu with these menus. The app menu has Hide, Hide Others, Show All and Quit, and "Set as Default App..." first when `GenesisKitHost.markdownDefaultAppBundleID` is set. The File menu has Close Tab, Close Window, Go to Location and Save. The Edit menu has Undo, Redo, Cut, Copy, Paste and Select All, which the text views need to receive those shortcuts. The Go menu has Back and Forward (the notes shown, ⌘ with the two keys right of P by default; a closed tab opens again), Next Tab, Previous Tab and Reopen Closed Tab; Back, Forward and the tab items are dimmed when there is nowhere to go. The Window menu has Minimize and Zoom. The Help menu has Keyboard Shortcuts (⇧⌘K), the list of every viewer key with "Change Keys…" (`KeymapHelpWindow`).

```swift
let menu = MarkdownViewerMenu.build(appName: "Example Markdown")
NSApplication.shared.mainMenu = menu
NSApplication.shared.windowsMenu = menu.items.last?.submenu
```

#### `MarkdownLineRange`

Lines of a file that the viewer is asked to show. They are 1-based, inclusive and counted over the whole file, the way an editor and grep count them. They come from `genesis-md://open?path=...&range=10-20`, from `genesis open --range 10-20`, and from a link `[x](/abs/file.ts#L10-L20)` inside a note.

- `let first: Int`: the first line.
- `let last: Int`: the last line.
- `init?(first: Int, last: Int)`: `nil` unless both are at least 1. Given in reverse order, they are swapped.
- `static func parse(_ text: String?) -> MarkdownLineRange?`: reads `30`, `30-50`, `L30`, `L30-50` and `L30-L50` (a lowercase `l` too). A fragment such as `Heading` or `page=2`, and anything with a zero, gives `nil`.
- `static func fromQuery(_ items: [URLQueryItem]) -> MarkdownLineRange?`: reads the `range` item of an open URL.
- `var queryValue: String`: the `range=` value: `3-6`, or `3` for one line.

```swift
let range = MarkdownLineRange.parse("L10-L20")
let items = URLComponents(string: "genesis-md://open?path=/tmp/demo/a.md&range=3-6")?.queryItems ?? []
let fromURL = MarkdownLineRange.fromQuery(items)
let value = fromURL?.queryValue
```

#### `MarkdownDocumentLinks.filePath(_:)`

Turns a `file:` link into the path (plus its `#fragment`) that the viewer's link resolver takes. A `%` or `#` in the file name goes back encoded, because the resolver cuts at the first `#` and then decodes percent escapes.

- `_ ref: String`: the link text.
- Returns `String?`: `nil` for anything that is not a `file:` link, or has an empty path.

```swift
let link = "file:///tmp/demo/notes.md#Setup"
if let path = MarkdownDocumentLinks.filePath(link) {
    openNote(path)
}
```

#### `MarkdownDocumentLinks.fileLinkTarget(_:vaultRoot:)`

Decides where a `file:` link in a vault note goes. A host's native preview sends these links to its `onWikilink`.

- `_ ref: String`: the link text.
- `vaultRoot: String?`: the vault root. A `.md` file inside it opens in place as a note.
- Returns `FileLinkTarget?`:
  - `note(path: String, fragment: String?)`: a note inside the vault, as its vault-relative path and the link's fragment.
  - `document(URL)`: a regular file whose type is content (text, PDF, image, media, an office file), for its default app.
  - `nil`: the link is not `file:`, or it points at an app or other bundle, a folder, an executable, a script, a Terminal settings file, a location file, an archive or an installer. A note is untrusted, so one click cannot launch anything.

```swift
switch MarkdownDocumentLinks.fileLinkTarget(link, vaultRoot: "/Users/alice/Notes") {
case .note(let path, let fragment): openNote(path, heading: fragment)
case .document(let url): NSWorkspace.shared.open(url)
case nil: break
}
```

#### `MarkdownLinkHover`

The pointer resting on a link in the rendered page: what the link points at, and where it sits. The viewer's web view reports it to the window, which opens the floating preview of the linked note from it (`GenesisKitMarkdownConfiguration.hoverPreview`). No public view takes it as a parameter.

- `href: String`: the link target as written in the page.
- `rect: CGRect`: the link's box in the web view, with a top-left origin, in points.
- `init(href: String, rect: CGRect)`: memberwise.

```swift
let hover = MarkdownLinkHover(
    href: "./plan.md",
    rect: CGRect(x: 40, y: 120, width: 90, height: 18)
)
let anchor = CGPoint(x: hover.rect.midX, y: hover.rect.maxY)
```

#### `WikilinkParser`

Parses Obsidian wikilinks and embeds out of markdown text. It matches `[[Target]]`, `[[Target#Heading]]`, `[[Target#^block]]`, `[[Target|alias]]` and the embed form `![[Target]]`.

- `static func parse(_ markdown: String) -> [Link]`: every link in order of appearance.
- `static func extractTargets(_ markdown: String) -> [String]`: the distinct targets, in order of first appearance.
- `Link`: one match, with these fields:
  - `raw: String`: the matched text.
  - `target: String`: the note name.
  - `heading: String?`: the text after `#`.
  - `block: String?`: the id after `#^`.
  - `alias: String?`: the text after `|`.
  - `embed: Bool`: `true` for `![[...]]`.
  - `range: NSRange`: where the match sits in the text.

```swift
let links = WikilinkParser.parse("See [[Plan#Goals|the goals]] and ![[Diagram]].")
for link in links where !link.embed {
    print(link.target, link.heading ?? "", link.alias ?? "")
}
let targets = WikilinkParser.extractTargets("[[Plan]] then [[Plan]] and [[Notes]]")
```

#### `MarkdownCompletion`

What the caret is in the middle of typing in the source editor: a `[[wikilink]]` or a `#tag`. A host sees these types in `GenesisKitHost.markdownCompletions(_:)`.

- `Kind`: `wikilink` or `tag`.
- `Request`: a completion question.
  - `kind: Kind`: what is being typed.
  - `range: NSRange`: the part already typed, which the chosen value replaces.
  - `query: String`: the typed text.
  - `init(kind: Kind, range: NSRange, query: String)`: memberwise.

```swift
func markdownCompletions(_ request: MarkdownCompletion.Request) -> [String]? {
    guard request.kind == .tag else { return nil }
    return ["idea", "todo"].filter { $0.hasPrefix(request.query.lowercased()) }
}
```

#### `MarkdownProperty`

One row of a note's YAML frontmatter, shown as an Obsidian Property. The page edits the rows and `MarkdownWebPage` hands them to its `onProperties` closure. The fields are internal. A host passes the rows on to `MarkdownFrontmatter.replacing(properties:in:)`, and cannot build one. Rows compare equal by key, kind, value, items and inline style.

`MarkdownPropertyKind` is the type of a row (`String` raw value, `Codable`, `CaseIterable`). It follows Obsidian's types, inferred from the value:

- `text`: plain text.
- `number`: a number.
- `checkbox`: true or false.
- `date`: a date.
- `datetime`: a date and time.
- `list`: a list of text items.
- `tags`: a list of tags.

```swift
var rows: [MarkdownProperty] = []
MarkdownWebPage(
    markdown: text, scrollTarget: nil, highlightQuery: nil, highlightToken: 0,
    onWikilink: { _ in }, onActiveSection: { _ in },
    onProperties: { rows = $0 }
)
```

#### `MarkdownFrontmatter.replacing(properties:in:)`

Writes edited Properties rows back into a note and returns the new text. A row that equals a row already in the file keeps its original lines, so an edit to one property is a one-line diff. Lines that belong to no row (comments, blank lines) stay where they were. With no rows the frontmatter block is removed. A file without a block gets one at the top.

- `properties: [MarkdownProperty]`: the rows to write, as received from `onProperties`.
- `in markdown: String`: the full note text.
- Returns `String`: the note with its frontmatter replaced.

```swift
func saveProperties(_ rows: [MarkdownProperty]) throws {
    let updated = MarkdownFrontmatter.replacing(properties: rows, in: note.text)
    try updated.write(to: note.url, atomically: true, encoding: .utf8)
    note.text = updated
}
```

#### `VaultIndex`

The notes vault's search index: an SQLite FTS5 sidecar file that the Genesis vault pane maintains. It lives outside the vault, at `~/.genesis/knowledge/<hash>/index.sqlite`, so sync tools never see it. The full note bodies are indexed, and a table stores the wikilink edges. The markdown viewer opens it read-only for `[[` and `#` completion and for the property vocabulary, in any host. All access goes through one serial queue.

- `init(vaultRoot: String, directory: URL? = nil, readOnly: Bool = false) throws`: opens the index for a vault. `directory` replaces the default folder. With `readOnly: true` it never creates the folder, the file or the tables, and it throws when there is no index yet.
- `let dbPath: String`: the path of the SQLite file.
- `static func sidecarDirectory(vaultRoot: String) -> URL`: the default folder: `~/.genesis/knowledge/` plus the first 16 hex digits of the SHA-256 of the vault root.

Writes (for the app that maintains the index):

- `upsert(path:title:body:mtimeMs:headings:tags:props:resolvedLinkPaths:)`: replaces one note and its links. `props` is the frontmatter as space-joined `key:value` pairs. Parameters: `path: String`, `title: String`, `body: String`, `mtimeMs: Double`, `headings: [String]`, `tags: [String]`, `props: String`, `resolvedLinkPaths: [String]`.
- `remove(path: String)`: drops one note and every link to or from it.
- `removeAll()`: empties the index.

Reads:

- `indexedMtimes() -> [String: Double]`: the modification time of every indexed note, for incremental re-index decisions.
- `noteCount() -> Int`: how many notes are indexed.
- `allLinks() -> [(from: String, to: String)]`: every wikilink edge, as vault-relative paths.
- `backlinks(of path: String) -> [String]`: the notes that link to a note.
- `search(query raw: String, limit: Int = 60) -> [SearchRow]`: full-text search. Each whitespace-separated term is a quoted prefix match and the terms are combined with AND. An empty query gives an empty list.
- `recent(limit: Int = 30) -> [NoteMeta]`: the newest notes by modification time.
- `noteNames(matching prefix: String, limit: Int = 20) -> [String]`: note names without `.md`, for the `[[` picker. Names that start with the text come first, then the shortest.
- `tags(matching prefix: String, limit: Int = 20) -> [String]`: the tags the vault already uses, for the `#` picker. Names that start with the text come first, then the most used.
- `propertyVocabulary(keyLimit: Int = 60, valueLimit: Int = 30) -> [String: [String]]`: the property keys of the vault and the values each one is given, most used first.
- `static func terms(_ raw: String) -> [String]`: the lowercased whitespace-separated terms of a query.
- `static func ftsMatchExpression(_ raw: String) -> String`: the FTS5 match string for a query, such as `"foo"* AND "bar"*`. The terms are quoted, so operators typed by a person cannot change the query.

Result types:

- `SearchRow`: `path: String`, `title: String`, `mtimeMs: Double`, `bm25: Double`, `snippet: String?`, `matchedTitle: Bool`, `matchedHeadings: Bool`, `matchedProps: Bool`.
- `NoteMeta`: `path: String`, `title: String`, `mtimeMs: Double`.
- `IndexError.sqlite(String)`: thrown when SQLite cannot open the file or run a statement.

```swift
let index = try VaultIndex(vaultRoot: "/Users/alice/Notes", readOnly: true)
let names = index.noteNames(matching: "pla")
let hits = index.search(query: "release plan", limit: 10)
```

### Media

Media shows pictures, video poster frames and documents, and opens pictures larger. `MediaThumbnailView` is the entry point for a tile: it asks `MediaThumbnailCache` for a decoded thumbnail sized to its frame and handles the loading, failed and retry states. A click previews the file in place over the surface when an ancestor applies `.mediaPreviewHost()` (state in `MediaPreviewState`, keys in `MediaPreviewKeyboard`). For zoom, pan, stepping and compare, a host calls `ImageViewer.present(_:)` with an `ImageViewerRequest`: it opens a window driven by `ImageViewerModel` and drawn by `ImageViewerView` and `ImageViewerCanvasView`. The remaining entries are pure helpers for zoom math, compare layout, window placement, key mapping, clipboard copy and `data:` URLs.

#### `MediaThumbnailView`

The picture of one file: an image, a video poster frame or a document. It decodes off the main thread at the pixel size its frame needs, fits the picture inside the frame the caller gives, and shows a placeholder while it loads. When no picture can be made it shows the file name and a Retry button. A tile less than 76 points wide or 64 points high (unless `emphasis` is `.large`) shows only a retry icon. It loads again when the file changes on disk. A click opens the in-place preview (`.mediaPreviewHost()`), or the file in its app when there is no host. The context menu offers Preview (or Play, once the picture is ready), Open in its app, Show in Finder and Copy path.

Two initializers. The first takes a ready item:

- `item: MediaPreviewItem`: the file to show.
- `gallery: [MediaPreviewItem] = []`: the set the left and right arrows move through in the preview. Empty means the item alone.
- `aspect: CGFloat? = nil`: width divided by height, when the caller knows it. It shapes the loading placeholder. A value that is not finite or not positive is ignored.
- `cornerRadius: CGFloat = 7`: the corner radius of the picture.
- `interactive: Bool = true`: when true (and `emphasis` is not `.large`) the tile is a button that opens the preview. When false it is only the picture.
- `emphasis: Emphasis = .regular`: how much chrome the tile draws.
- `onOpen: (() -> Void)? = nil`: replaces the preview action when set.

The second builds the item from a path:

- `path: String`: the file path.
- `name: String? = nil`: display name. Defaults to the last path component.
- `kind: MediaKind? = nil`: defaults to the kind the extension implies.
- `duration: Double? = nil`: a video's length in seconds, when known.
- `aspect: CGFloat? = nil`: as above.
- `cornerRadius: CGFloat = 7`: as above.
- `emphasis: Emphasis = .regular`: as above.

`Emphasis` cases:

- `compact`: row icons and composer chips. A play glyph without the length.
- `regular`: play glyph and length badge on a video, and an expand mark on hover.
- `large`: the preview itself. No play glyph and no hover.

```swift
MediaThumbnailView(item: MediaPreviewItem(path: "/tmp/demo/shot.png"), gallery: shots, aspect: 16.0 / 9.0)
    .frame(width: 160, height: 90)
MediaThumbnailView(path: "/tmp/demo/clip.mov", duration: 12, emphasis: .compact)
    .frame(width: 44, height: 44)
```

#### `MediaThumbnailView.frame(aspect:height:maxWidth:minWidth:)`

Static helper that returns the frame for a picture of a given aspect ratio, so a layout can reserve the size before the picture arrives. With no usable aspect it returns a 4 to 3 frame, capped at `maxWidth`.

- `aspect: CGFloat?`: width divided by height, or nil.
- `height: CGFloat`: the largest height.
- `maxWidth: CGFloat`: the largest width.
- `minWidth: CGFloat = 0`: the smallest width.

```swift
let size = MediaThumbnailView.frame(aspect: 1.6, height: 120, maxWidth: 220, minWidth: 72)
MediaThumbnailView(path: "/tmp/demo/shot.png", aspect: 1.6)
    .frame(width: size.width, height: size.height)
```

#### `MediaPreviewItem`

One file a preview can show: a picture, a video or a document. It is the item type of `MediaThumbnailView` and `MediaPreviewState`.

- `id: String? = nil`: a stable id. Defaults to the path.
- `path: String`: the file path.
- `name: String? = nil`: display name. Defaults to the last path component.
- `kind: MediaKind? = nil`: defaults to `MediaKind.of(path:)`.
- `duration: Double? = nil`: a video's length in seconds, when the caller already knows it.

```swift
let clip = MediaPreviewItem(path: "/tmp/demo/clip.mov", name: "Demo clip", duration: 12)
let shot = MediaPreviewItem(id: "shot-1", path: "/tmp/demo/shot.png")
MediaThumbnailView(item: clip, gallery: [clip, shot])
```

#### `MediaKind`

What a file shows as. Cases:

- `image`: a picture.
- `video`: a moving picture with a poster frame.
- `file`: any other document.

Members:

- `static func of(path: String) -> MediaKind`: decides by the file extension only. It does no disk access, so it is safe in a view body.
- `var symbol: String`: the SF Symbol name for the kind (`photo`, `film`, `doc`), used where no picture is shown yet.

```swift
let paths = ["/tmp/demo/shot.png", "/tmp/demo/clip.mov", "/tmp/demo/notes.txt"]
let kinds = paths.map { MediaKind.of(path: $0) }   // [.image, .video, .file]
let glyphs = kinds.map(\.symbol)                    // ["photo", "film", "doc"]
```

#### `MediaPreviewState`

The in-place preview of one surface (a widget panel, a module). At most one preview is open across all surfaces, and that one answers the keyboard through `MediaPreviewKeyboard`. A host usually does not create it: `.mediaPreviewHost()` owns one and puts it in the environment. It is `@MainActor` and an `ObservableObject`. The initializer takes no parameters.

Properties:

- `items: [MediaPreviewItem]`: the open set. Read-only. Empty when closed.
- `index: Int`: the shown item's position. Read-only.
- `current: MediaPreviewItem?`: the shown item.
- `isOpen: Bool`: true while a set is open.
- `copyStatus: CopyStatus`: the state of the Copy button. Read-only. Cases are `idle`, `copying`, `copied` and `refused(String)` with the reason.
- `focusReturns: PassthroughSubject<String, Never>`: sends the opener's item id once the preview has closed, so the thumbnail that opened it takes keyboard focus back.

Methods:

- `present(_ items: [MediaPreviewItem], selectedID: String? = nil)`: opens the set on `selectedID` (the first item when the id is not found). An empty set does nothing. A preview open on another surface closes first.
- `dismiss()`: closes the preview and returns focus to the opener.
- `step(_ delta: Int)`: moves through the set and wraps around. It does nothing for fewer than two items.
- `copyImage(_ item: MediaPreviewItem)`: puts the picture and its file on the pasteboard. It uses `MediaImageCopy` and gives up after 10 seconds. A click while a copy runs is ignored. The status returns to `idle` after about 1.4 seconds (copied) or 5 seconds (refused).

```swift
let preview = MediaPreviewState()
preview.present([MediaPreviewItem(path: "/tmp/demo/a.png"), MediaPreviewItem(path: "/tmp/demo/b.png")],
                selectedID: "/tmp/demo/b.png")
preview.step(1)
```

#### `View.mediaPreviewHost()`

Lets every `MediaThumbnailView` inside this view preview its file over it, Quick Look style. Put it on the surface that should be covered (a panel's content, a module). While the preview is open the covered view is disabled and hidden from accessibility. The overlay has a header with the file name, the position ("2 of 5", only with more than one item), Copy image (images only), Show in Finder, Open in its app and Close. A click on the backdrop closes it. With more than one item it also shows previous and next buttons. The keys come from `MediaPreviewKeyboard`. It respects Reduce Motion and Reduce Transparency.

The modifier sets `EnvironmentValues.mediaPreview`, a `MediaPreviewState?` that is nil outside a host. A thumbnail with no host opens the file in its app.

```swift
VStack {
    MediaThumbnailView(path: "/tmp/demo/shot.png")
}
.mediaPreviewHost()
```

#### `MediaPreviewKeyboard`

Quick Look's keys for the open in-place preview. A window's own key handler asks first and stops when the answer is true.

- `static var isOpen: Bool`: true while some preview is open. `@MainActor`.
- `static func handle(keyCode: UInt16, editingText: Bool) -> Bool`: Escape (key code 53) closes. Space (49) closes, and left (123) and right (124) arrows step, but only when `editingText` is false so a text field keeps them. Returns true when the key was used. `@MainActor`.

```swift
override func keyDown(with event: NSEvent) {
    let editing = window?.firstResponder is NSText
    if MediaPreviewKeyboard.handle(keyCode: event.keyCode, editingText: editing) { return }
    super.keyDown(with: event)
}
```

#### `MediaThumbnailCache`

An actor that makes thumbnails for images, video poster frames and documents. It decodes off the main thread, keys each thumbnail by file identity and pixel size, shares a decode that is already running, and bounds its memory. Pixel sizes round up to powers of two between 64 and the ceiling, so a resize does not decode again and a larger cached picture serves a smaller request. Images use ImageIO with a Quick Look fallback, videos use AVFoundation, other files use Quick Look. A file written over gets a new identity, so the cache never shows a stale picture. A failure is remembered per path until the file changes or `reload` is true. A decode that passes its deadline reports a failure, and the late picture replaces it when it lands.

Initializer:

- `byteLimit: Int = 96 << 20`: the memory the cached pictures may use, in bytes. The oldest go first.
- `concurrency: Int = 3`: how many decoders run at once.
- `deadline: Duration = .seconds(20)`: how long a decode, or a wait for a free slot, may take.

Static members:

- `shared`: the cache every thumbnail view uses.
- `defaultCeiling = 4096`: the largest picture an ordinary request asks for.
- `largestCeiling = 8192`: the largest picture any request can ask for.
- `bucket(forPixels pixels: CGFloat, ceiling: Int = MediaThumbnailCache.defaultCeiling) -> Int`: the power of two a request of that many pixels rounds up to.

Methods:

- `thumbnail(path: String, maxPixels: CGFloat, kind: MediaKind? = nil, reload: Bool = false, ceiling: Int = MediaThumbnailCache.defaultCeiling) async -> MediaThumbnailResult`: the thumbnail whose longest side is at least `maxPixels`, up to the ceiling. `kind` defaults to the extension's kind. `reload` forgets an earlier failure for the file (the Retry button).
- `lateAnswer(path: String, maxPixels: CGFloat) async -> Bool`: for a tile that shows "took too long". It waits until the slow decoder answers, then returns true so the tile loads again. It returns false when no decoder ran, the file changed, or the task is canceled.
- `removeAll()`: drops every cached picture and remembered failure.

Result types:

- `MediaThumbnailResult`: `ready(MediaThumbnail)` or `failed(String)` with a message fit to show.
- `MediaThumbnail`: `image: CGImage`, `kind: MediaKind`, `sourceSize: CGSize` (the source's pixels after orientation), `duration: Double?` (video seconds), `isIcon: Bool = false` (the file type's icon, not a picture of the content), and `aspect: CGFloat` (width divided by height).
- `MediaFileIdentity`: the path plus the device, inode, size and modification time of the bytes. `MediaFileIdentity.current(_ path: String)` does one `stat` and returns nil when the file is gone.

```swift
let result = await MediaThumbnailCache.shared.thumbnail(
    path: "/tmp/demo/shot.png", maxPixels: 512, kind: .image)
switch result {
case .ready(let thumbnail): print(thumbnail.sourceSize, thumbnail.aspect)
case .failed(let message): print(message)
}
```

#### `MediaImageCopy`

What Copy image puts on the pasteboard for a picture. A copy needs the whole picture, so `prepare` works inside a size budget and a file past the budget is never read: the file itself is offered instead. It blocks while it reads, so call it off the main thread.

- `static let maxBytes = 64 << 20`: a file larger than this many bytes is not read.
- `static let maxPixels = 48_000_000`: a picture with more pixels than this is not decoded.
- `static func prepare(path: String, maxBytes: Int = MediaImageCopy.maxBytes, maxPixels: Int = MediaImageCopy.maxPixels) -> Outcome`: checks the file and decodes it.

`Outcome` cases:

- `image(Data)`: the picture as TIFF, in its own orientation and size.
- `fileOnly(String)`: too large to copy as a picture. The text says why. The file can still be copied.
- `failed(String)`: the file is gone, is not a picture, or could not be read.

```swift
switch MediaImageCopy.prepare(path: "/tmp/demo/shot.png") {
case .image(let tiff): print("TIFF bytes:", tiff.count)
case .fileOnly(let reason), .failed(let reason): print(reason)
}
```

#### `MediaDataURL`

A picture embedded in a page as `data:image/...;base64,...`. `materialize` writes it once to a private temporary file, so it takes the same path as every other picture (`MediaThumbnailCache`, Copy, Open in Preview).

- `static let imageTypes: [String: String]`: the MIME types let through, mapped to the file extension they get (`"image/png": "png"`). It holds PNG, JPEG, GIF, WebP, AVIF and SVG.
- `static let maxBytes = 64 << 20`: the largest decoded picture.
- `static func decode(_ url: String, allowed: [String: String] = MediaDataURL.imageTypes, maxBytes: Int = MediaDataURL.maxBytes) -> (data: Data, ext: String)?`: the bytes and extension of a base64 `data:` image of an allowed type. Nil for anything else (another type, no base64, too large, not decodable).
- `static func materialize(_ url: String, allowed: [String: String] = MediaDataURL.imageTypes, maxBytes: Int = MediaDataURL.maxBytes, folder: URL = MediaDataURL.defaultFolder) -> URL?`: the temporary file for the picture. It is named by a hash of its bytes, so the same picture is written once, and only this user can read it. Nil when the URL is refused or the file cannot be written.
- `static var defaultFolder: URL`: the `genesiskit-embedded-images` folder in the temporary directory.

```swift
let embedded = "data:image/png;base64,iVBORw0KGgo="
if let decoded = MediaDataURL.decode(embedded) { print(decoded.ext) }   // "png"
if let file = MediaDataURL.materialize(embedded) {
    print(file.path)
}
```

#### `MediaFormat.duration(_:)`

Formats a video's length the way the system shows it: `0:07`, `1:05`, `1:02:09`. A negative value reads as zero.

- `seconds: Double`: the length in seconds.

```swift
let short = MediaFormat.duration(7)       // "0:07"
let long = MediaFormat.duration(3729)     // "1:02:09"
Text(verbatim: MediaFormat.duration(65))  // shows "1:05"
```

#### `ImageViewer`

The image viewer entry point: a window with zoom, pan, stepping through a document's pictures, and compare of two pictures with a slider or side by side. It is a `@MainActor` enum with static members. One viewer exists per source surface (`ownerID`). The viewer has its own `MediaThumbnailCache` with a 192 MB budget, so a full-size decode does not evict the shared thumbnails. The window size is remembered in `UserDefaults`.

- `static func present(_ request: ImageViewerRequest)`: opens the viewer for the request's owner, or shows the request's picture in that owner's open window. A request with no items does nothing. The window waits up to 120 ms for the picture, then flies in from `request.origin` (with a placeholder if the picture is not ready). Without an origin, or with Reduce Motion on, it fades in.
- `static func prefetch(path: String, screen: NSScreen? = nil)`: for the first click of a double-click. It decodes the picture at the size the viewer will ask for and builds a spare window, so the open that follows starts with the real picture.
- `static func prepare()`: builds the spare window alone, for a picture that has no file to decode yet.
- `static func close(owner: ObjectIdentifier)`: closes that owner's viewer at once, without a zoom back. Use it when the source goes away.

```swift
ImageViewer.prefetch(path: "/tmp/demo/shot.png")
ImageViewer.present(ImageViewerRequest(
    ownerID: ObjectIdentifier(webView),
    items: [ImageViewerItem(id: "0", path: "/tmp/demo/shot.png")], selectedID: "0"))
```

#### `ImageViewerRequest`

Everything a host passes to `ImageViewer.present(_:)`. The initializer parameters are also public `var`s with the same names.

- `ownerID: ObjectIdentifier`: the source surface. A second request from the same owner shows its picture in the open window.
- `items: [ImageViewerItem]`: the source's pictures in document order.
- `selectedID: String`: the id of the picture to show.
- `origin: ImageViewerOrigin? = nil`: where the picture is on its source now. Nil opens with a fade.
- `background: NSColor = ImageViewerRequest.defaultBackground`: the window color behind the picture.
- `level: NSWindow.Level = .normal`: the window level of the source, so a floating document keeps its viewer above it.
- `screen: NSScreen? = nil`: the screen to open on when `origin` is nil.
- `currentOrigin: (@MainActor (ImageViewerItem) async -> ImageViewerOrigin?)? = nil`: asked when the viewer closes, for where the picture is on the source then. Nil, or no answer within about 150 ms, fades instead of zooming back.
- `startedAt: CFTimeInterval = CACurrentMediaTime()`: when the user asked. The transition log measures its first frame from here.

`ImageViewerRequest.defaultBackground` is a static `NSColor`: the Genesis Markdown page color.

```swift
let request = ImageViewerRequest(
    ownerID: ObjectIdentifier(webView), items: items, selectedID: "3",
    origin: origin, level: window.level,
    currentOrigin: { item in await currentRect(of: item) })
```

#### `ImageViewerOrigin`

Where a picture sits on its source surface right now, in screen coordinates. The viewer flies from this frame when it opens and back to it when it closes.

- `rect: CGRect`: the picture itself.
- `clip: CGRect`: the area the picture is clipped to (a web view's visible rect).
- `cornerRadius: CGFloat = 0`: the picture's corner radius there.

```swift
let origin = ImageViewerOrigin(
    rect: CGRect(x: 120, y: 340, width: 200, height: 120),
    clip: CGRect(x: 0, y: 100, width: 800, height: 600),
    cornerRadius: 6)
ImageViewer.present(ImageViewerRequest(
    ownerID: ObjectIdentifier(webView), items: items, selectedID: "0", origin: origin))
```

#### `ImageViewerItem`

One picture the viewer can show: a readable local file the host already admitted.

- `id: String`: stable within its source (for example the page's image number), so the source can find it again.
- `path: String`: the file path.
- `name: String? = nil`: display name. Defaults to the last path component.
- `group: String? = nil`: items with the same group sit together in their source (one table row, a before and its after). Compare offers the same group first.
- `isTemporary: Bool = false`: true for a picture made from an embedded `data:` URL. There is no user file to show in Finder.

```swift
let before = ImageViewerItem(id: "0", path: "/tmp/demo/before.png", group: "row-1")
let after = ImageViewerItem(id: "1", path: "/tmp/demo/after.png", group: "row-1")
let embedded = ImageViewerItem(
    id: "2", path: "/tmp/demo/pasted.png", name: "Embedded picture 3", isTemporary: true)
```

#### `ImageViewerModel`

The state of one viewer: the pictures of its source, the one shown (A), the one compared with it (B), the picker and the actions. The canvas (`ImageViewerCanvasView`) owns zoom and pan. The model tells it what to show. It is `@MainActor` and an `ObservableObject`. A host that only opens windows uses `ImageViewer.present(_:)`. A host that embeds the viewer creates the model and shows it in `ImageViewerView`.

Initializer:

- `items: [ImageViewerItem]`: the pictures.
- `selectedID: String`: the id to show first. The first item when not found.
- `cache: MediaThumbnailCache = .shared`: where pictures are decoded.
- `canvas: ImageViewerCanvasView? = nil`: a canvas to use. A new one is made when nil.

Properties:

- `items: [ImageViewerItem]` and `index: Int`: the set and the shown position. Read-only.
- `current: ImageViewerItem?` and `itemB: ImageViewerItem?`: the A and B pictures.
- `title: String`: the window title: the name of A, or the names of A and B joined by " and " while comparing. "Image" when there is no item.
- `compare: Compare?`: nil, or the active compare with `bID: String`, `mode: CompareMode` and `divider: CGFloat` (from 0.02 to 0.98, 0.5 at the start).
- `CompareMode` cases: `slider` and `sideBySide`. The last mode used is remembered in `UserDefaults`.
- `compareNote: String?`: "B is scaled to A's width (...)" when the two pictures differ in width.
- `picking: Bool`: the "Compare with..." picker is open.
- `pickerFocus: Int`: the highlighted picker tile. Settable.
- `pickerItems: (sameRow: [ImageViewerItem], others: [ImageViewerItem])`: what the picker offers.
- `stateA`, `stateB: PictureState`: `loading`, `ready(pixelSize: CGSize)` or `failed(String)`.
- `copyStatus: MediaPreviewState.CopyStatus`: the state of Copy.
- `background: Color`: the color behind the picture. Settable.
- `readout: ImageViewerZoomReadout`: a small observable object with `percent: Int` and `isFit: Bool` for the toolbar label.
- `canvas: ImageViewerCanvasView`: the picture surface.
- `canStepBack`, `canStepForward: Bool`: whether a step is possible.

Methods:

- `replace(items:selectedID:)`: swaps the set and shows `selectedID`.
- `show(_ next: Int)`: shows the item at that index.
- `start()`: loads picture A (and B while comparing) for the canvas's size.
- `waitUntilLoaded(timeout: Duration = .seconds(5)) async -> Bool`: waits until the slots have a picture or a failure. Returns true when they did.
- `step(_ delta: Int)`: previous or next. While comparing, a pair from one row moves to the same places in the next row.
- `openPicker()`, `closePicker()`: show and hide the picker.
- `compare(with item: ImageViewerItem)`: starts compare against `item`.
- `setCompareMode(_ mode: CompareMode)`: switches slider and side by side.
- `swap()`: A becomes B and B becomes A.
- `endCompare()`: leaves compare.
- `moveDivider(by delta: CGFloat)`: moves the slider's divider.
- `copyCurrent()`: copies A to the pasteboard.
- `revealCurrent()`: shows A in Finder. Does nothing for a temporary picture.
- `openCurrentInPreview()` and `static func openInPreview(_ path: String)`: open a file in Preview.app, or in its default app when Preview is missing.
- `dismiss()`: closes the window (the window controller sets the handler).
- `perform(_ action: ImageViewerAction)`: runs one mapped key. Escape steps back one layer: the picker, then compare, then the window.
- `retry(_ slot: ImageViewerCanvasView.Slot)`: decodes a failed slot again.

```swift
let model = ImageViewerModel(items: [before, after], selectedID: "0")
model.start()
model.compare(with: after)
model.setCompareMode(.sideBySide)
```

#### `ImageViewerView`

The viewer window's SwiftUI content: a compact control row in the title bar (title, position, zoom controls, Compare, Copy, Show in Finder, Open in Preview), the picture canvas, the compare bar while comparing, and the "Compare with..." picker as a panel over the canvas. It forces a dark color scheme.

- `model: ImageViewerModel`: the model to show.
- `static let defaultBackground: Color`: the Genesis Markdown page color.

```swift
ImageViewerView(model: model)
    .frame(minWidth: 640, minHeight: 420)
    .background(ImageViewerView.defaultBackground)
```

#### `ImageViewerCanvasView`

The viewer's picture surface, an `NSView`. It shows one picture, or two compared with a slider or side by side. Core Animation draws the pictures, so zoom and pan move layer frames and cost no SwiftUI render. It handles pinch, smart magnify, scroll, Command-scroll zoom, drag to pan, double-click to toggle zoom, and a draggable divider. It reports the slider role to accessibility, with increment and decrement moving the divider. A host reaches it as `ImageViewerModel.canvas`. The initializer is `init(frame: NSRect)`.

- `Slot`: `a` or `b`, the two picture positions.
- `Mode`: `single`, `slider` or `sideBySide`.
- `displayedRectA: CGRect?`: picture A's frame as shown now, in the view's own bottom-left coordinates. Nil without a picture.
- `fittedRectA: CGRect?`: where picture A would sit at the fit.
- `clipRectA: CGRect`: the area A is clipped to: its pane side by side, the whole canvas otherwise.

```swift
let canvas = ImageViewerCanvasView(frame: CGRect(x: 0, y: 0, width: 800, height: 600))
let model = ImageViewerModel(items: items, selectedID: "0", canvas: canvas)
model.start()
let shown = canvas.displayedRectA
```

#### `ImageViewerSnapshot`

Renders the real viewer window at a given state into a bitmap, off screen: alpha 0, below the desktop, never key and never active. Tests use it for pixel checks and to write PNGs of each state. It is `@MainActor`.

`render(items:selectedID:state:size:background:)` is `static func render(items: [ImageViewerItem], selectedID: String, state: State, size: CGSize = CGSize(width: 1180, height: 760), background: NSColor = ImageViewerRequest.defaultBackground) async -> Result?`. It returns nil when the window cannot be made.

`State` cases:

- `single`: one picture, fitted.
- `zoomed(multiple: CGFloat, anchor: CGPoint)`: `multiple` times 100 % about a point given as fractions of the canvas from its top left corner (0.5, 0.5 is the center).
- `picker`: the "Compare with..." picker open.
- `compare(bID: String, mode: ImageViewerModel.CompareMode, divider: CGFloat)`: compared with item `bID`.

`Result` fields: `bitmap: NSBitmapImageRep`, `model: ImageViewerModel` (for assertions), `pictureA: CGRect?` (A's frame in the bitmap's points, top-left origin), `canvas: CGRect` (the canvas in the bitmap's points) and `titlebar: WindowTitlebar.Audit` (the title bar check, without the flat-band rule).

```swift
let shot = await ImageViewerSnapshot.render(
    items: [ImageViewerItem(id: "0", path: "/tmp/demo/shot.png")], selectedID: "0",
    state: .zoomed(multiple: 2, anchor: CGPoint(x: 0.5, y: 0.5)))
print(shot?.model.readout.percent ?? 0)
```

#### `ImageZoomMath`

The viewer's zoom and pan as pure functions of the content size (image pixels) and the viewport (points). Coordinates have the origin at the top left, y growing down. A scale is points per image pixel. 100 % is one image pixel on one display pixel (`actualScale`). The companion `ImageZoom` struct holds the state.

`ImageZoom`:

- `init(scale: CGFloat, origin: CGPoint)`: `scale` is points per image pixel, `origin` is where the content's top-left corner sits in the viewport.
- `viewPoint(_ content: CGPoint) -> CGPoint` and `contentPoint(_ view: CGPoint) -> CGPoint`: convert between content and viewport points.
- `frame(of rect: CGRect) -> CGRect`: a rect in content pixels as it lies in the viewport.

`ImageZoomMath` functions:

- `actualScale(backingScale: CGFloat) -> CGFloat`: the scale for 100 %.
- `fitScale(content: CGSize, viewport: CGSize, backingScale: CGFloat, margin: CGFloat = 0) -> CGFloat`: shows the whole content inside the viewport, never above 100 %.
- `limits(fit: CGFloat, actual: CGFloat) -> ClosedRange<CGFloat>`: from the fit (or 100 % for a small picture) to 32 times 100 %.
- `fitted(content: CGSize, viewport: CGSize, backingScale: CGFloat, margin: CGFloat = 0) -> ImageZoom`: the fitted, centered zoom.
- `clamped(_ zoom: ImageZoom, content: CGSize, viewport: CGSize) -> ImageZoom`: centers an axis the content does not fill, and keeps the content's edges at or past the viewport's otherwise.
- `zoomed(_ zoom: ImageZoom, to scale: CGFloat, anchor: CGPoint, content: CGSize, viewport: CGSize, limits: ClosedRange<CGFloat>) -> ImageZoom`: zooms to `scale` (clamped to `limits`) and keeps the content point under `anchor` where it is.
- `panned(_ zoom: ImageZoom, by delta: CGSize, content: CGSize, viewport: CGSize) -> ImageZoom`: pans, then clamps.
- `ladder: [CGFloat]`: the stops the zoom keys move between, as multiples of 100 % (0.05 up to 32).
- `step(from scale: CGFloat, up: Bool, fit: CGFloat, actual: CGFloat) -> CGFloat`: the next stop up or down, a ladder step or the fit, whichever is nearer.
- `toggleTarget(current: CGFloat, fit: CGFloat, actual: CGFloat) -> CGFloat`: the double-click target: from the fit to 100 % (200 % for a picture that already fits at 100 %), from anywhere else back to the fit.
- `percent(scale: CGFloat, backingScale: CGFloat) -> Int`: the number for the "68 %" label.

```swift
let content = CGSize(width: 3200, height: 2000)
let viewport = CGSize(width: 1000, height: 700)
let fit = ImageZoomMath.fitted(content: content, viewport: viewport, backingScale: 2, margin: 14)
let next = ImageZoomMath.step(from: fit.scale, up: true, fit: fit.scale, actual: 0.5)
```

#### `CompareLayout`

How two pictures share one frame: B is scaled to A's width and their top edges line up (screenshots of one window before and after share the top). Rects are in A's pixels.

- `a: CGRect`, `b: CGRect`: the two pictures' rects.
- `content: CGSize`: the size that holds both.
- `bScale: CGFloat`: the factor B is scaled by (A's width divided by B's width), 1 when both are the same width.
- `scalesB: Bool`: true when B was scaled.
- `static func make(a: CGSize, b: CGSize) -> CompareLayout`: builds the layout from the two pixel sizes.
- `func note(aPixels: CGSize, bPixels: CGSize) -> String?`: the "B is scaled to A's width" sentence with both sizes, or nil when nothing was scaled.

```swift
let a = CGSize(width: 3200, height: 2000)
let b = CGSize(width: 1600, height: 1000)
let layout = CompareLayout.make(a: a, b: b)
let note = layout.note(aPixels: a, bPixels: b)
```

#### `WebImageRect`

Maps an image of a `WKWebView` page to a rect in the web view. `getBoundingClientRect()` answers in CSS pixels of the page's scaled viewport, and one CSS pixel is `pageZoom` times `magnification` points. Use it to build an `ImageViewerOrigin` for the zoom from and back to a page.

- `static func viewRect(css: CGRect, pageZoom: CGFloat, magnification: CGFloat) -> CGRect`: the CSS rect in the web view's own top-left coordinates.
- `static func visibleFraction(of rect: CGRect, in visible: CGRect) -> CGFloat`: the share of `rect` inside `visible`, 0 to 1.
- `static func isVisible(_ rect: CGRect, in visible: CGRect) -> Bool`: true when at least 40 % of the image is on screen, enough to zoom from it.

```swift
let rect = WebImageRect.viewRect(
    css: cssRect, pageZoom: web.pageZoom, magnification: web.magnification)
let share = WebImageRect.visibleFraction(of: rect, in: web.bounds)
let usable = WebImageRect.isVisible(rect, in: web.bounds)
```

#### `ImageViewerPlacement`

Where the viewer window opens: its remembered size, or most of the screen (82 % wide, 86 % high), never larger than the visible area less a margin, and centered.

- `static let minSize = CGSize(width: 640, height: 420)`: the smallest window.
- `static let margin: CGFloat = 40`: the room kept at each edge.
- `static func frame(remembered: CGSize?, visible: CGRect) -> CGRect`: the window frame for a remembered size (or nil) and the screen's visible frame.

```swift
let remembered = CGSize(width: 1200, height: 800)
let frame = ImageViewerPlacement.frame(remembered: remembered, visible: screen.visibleFrame)
window.setFrame(frame, display: false)
```

#### `ImageViewerOrdering`

Which images "Compare with..." offers, and how the arrows move through a compared pair.

- `static func compareCandidates(_ items: [ImageViewerItem], current: ImageViewerItem) -> (sameRow: [ImageViewerItem], others: [ImageViewerItem])`: the images that share the current one's group first, then every other image in document order. The current file and repeats of one file are left out.
- `static func stepPair(_ items: [ImageViewerItem], a: Int, b: Int, by delta: Int) -> (a: Int, b: Int)?`: the left and right arrows while comparing. A pair from one row moves to the next (or previous) row that has both places and keeps each picture's place in its row. Any other pair moves A by one and keeps B. Nil at either end.

```swift
let (sameRow, others) = ImageViewerOrdering.compareCandidates(items, current: items[0])
let offered = sameRow + others
if let pair = ImageViewerOrdering.stepPair(items, a: 0, b: 1, by: 1) { print(pair.a, pair.b) }
```

#### `ImageViewerKeys`

Maps a key event to what it does in the viewer. The window's key handler asks first. Nil leaves the key to the app.

- `static func action(keyCode: UInt16, characters: String?, modifiers: NSEvent.ModifierFlags, picking: Bool, comparing: Bool) -> ImageViewerAction?`

Mapping:

- Command with `=` or `+` zooms in, `-` zooms out, `0` fits, `1` shows 100 %, and `C` copies. The key codes work on layouts that print other characters.
- While the picker is open: Escape dismisses, the arrows move the highlight, Return and Enter choose.
- Otherwise: Escape dismisses, left and right step, and Option with left or right moves the divider by 0.05 (0.01 with Shift) while comparing.

`ImageViewerAction` cases: `dismiss`, `previous`, `next`, `zoomIn`, `zoomOut`, `fit`, `actualSize`, `copy`, `divider(CGFloat)`, `pickerMove(dx: Int, dy: Int)` and `pickerChoose`. Pass one to `ImageViewerModel.perform(_:)`.

```swift
if let action = ImageViewerKeys.action(
    keyCode: event.keyCode, characters: event.charactersIgnoringModifiers,
    modifiers: event.modifierFlags, picking: model.picking, comparing: model.compare != nil)
{
    model.perform(action)
}
```

### Overlay

Screen effects: a click-through panel over each targeted display that tints the screen (vignette, sepia, blur, dim, edge glow, or no tint), with an optional message pill and a camera bubble. PostureWatcher uses it to nudge a slouch, Disk Manager for the critical-space edge glow. The panels never take a click, the keyboard or focus, and show on every Space and over full-screen apps. The look is a still SwiftUI view; the ramp in and out is one window-alpha animation, so nothing redraws while an effect sits on screen.

Screen shares: no public API keeps a window out of another app's capture. `NSWindow.sharingType = .none` only works against the legacy `CGWindowList` captures; ScreenCaptureKit (Zoom, Meet, Teams, QuickTime and the screenshot tools on macOS 15 and later) captures the panels anyway, and Apple calls `.none` a legacy value not to be used for this. So the controller asks `ScreenCaptureDetector` whether a capture runs, when an effect shows and once a second while it is up, and hides what `duringScreenCapture` names: by default the camera bubble, so the user's face never reaches a share. The tint and the message still show unless the host picks a stricter behaviour.

#### `ScreenEffectsController`

Owns the panels. `show()` ramps the effect in over `rampIn` on the screens `target` picks; `hide()` clears it over `rampOut` (both at once under Reduce Motion). A configuration change applies to the panels on screen at once. When displays change, the panels are rebuilt half a second later at the current strength, without a new ramp.

Safety: an effect hides itself after `maximumDuration` and calls `onTimeout`. `suppress(until:)` is the kill switch: it hides at once and refuses every show, previews included, until then (`clearSuppression()` lifts it). `ScreenEffectsController.dismissAll(suppressingUntil:)` is the same for every controller of the process, and also orders out any panel left on screen. Releasing a controller takes its panels down even without `tearDown()` (AppKit would otherwise keep an ordered-in panel on screen forever), and the timeout clears the panels even when the controller is gone. `preview(_:seconds:)` shows a configuration for a few seconds and puts the old one back; it never covers a real effect, and a real `show()` during a preview takes it over.

- `configuration: ScreenEffectConfiguration = .init()`
- `screens: () -> [ScreenEffectScreen] = NSScreen.screens`: the displays, main first. Tests pass made-up screens.
- `cursor: () -> CGPoint = NSEvent.mouseLocation`, `now: () -> Date = Date.init`
- `reduceMotion: () -> Bool`, `reduceTransparency: () -> Bool`: the system settings by default, read at each show.
- `screenCapture: () -> Bool? = ScreenCaptureDetector.current`: whether the screen is captured now, nil when unknown (counted as captured). Tests pass a fake.

Members: `show() -> Bool` (false while suppressed), `hide(animated:)`, `suppress(until:)`, `clearSuppression()`, `static dismissAll(suppressingUntil: Date? = nil)`, `preview(_:seconds:) -> Bool`, `setCameraBubble(_ view: NSView?)` (the host's camera preview in a round bubble at the bottom-right of the target screen, shown only with the effect and hidden during a capture), `tearDown()` (also calls `onVisibilityChange(false)` when an effect was up), `isVisible` (true also while `.holdBack` keeps it off screen), `isPreviewing`, `suppressedUntil`, `isScreenCaptureDetected`, `onTimeout`, `onVisibilityChange: ((Bool) -> Void)?`.

The bubble shows whatever the host's view draws. A camera that stops between interval checks (Battery saver) leaves a black or frozen picture, so keep the camera running while the bubble shows, or pass nil until it runs.

Panel facts: borderless and non-activating, level `.statusBar` (above the Dock and the menu bar, below menus and pop-up windows), `hidesOnDeactivate = false`, `ignoresMouseEvents = true`, collection behavior `[.canJoinAllSpaces, .stationary, .fullScreenAuxiliary, .ignoresCycle]`, accessibility identifiers `screen-effect-<display>` and `screen-effect-bubble`.

```swift
let effects = ScreenEffectsController(configuration: ScreenEffectConfiguration(
    style: .vignette, intensity: settings.intensity, target: .allScreens,
    message: ScreenEffectMessage("Sit up straight", symbol: "figure.stand")))
effects.onTimeout = { monitor.noteEffectTimedOut() }
effects.setCameraBubble(camera.previewView)
effects.show()                                        // slouching
effects.hide()                                        // upright again
effects.suppress(until: .now.addingTimeInterval(600)) // menu: "Hide Screen Effect"
```

#### `ScreenEffectConfiguration`

What a screen effect draws and how it behaves.

- `style: ScreenEffectStyle = .vignette`: `.vignette`, `.transparent` (pill and bubble only), `.sepia`, `.blur` (behind-window blur, `.active`, strength through its alpha; drawn as `.dim` under Reduce Transparency), `.dim`, `.edgeGlow`. Each case has `title`, `detail` and `symbol` for a settings picker.
- `intensity: Double = 1`: 0...2 (×); `clampedIntensity` is the value drawn.
- `glow: ChartColor = red`: the edge glow's colour.
- `target: ScreenEffectTarget = .allScreens`: `.allScreens`, `.mainScreen` or `.cursorScreen` (each with a `title`).
- `message: ScreenEffectMessage? = nil`: `ScreenEffectMessage(text, symbol:)`, the pill a third of the way down each screen.
- `coversMenuBar: Bool = true`: the whole frame, or only the visible frame.
- `rampIn: TimeInterval = 2.0`, `rampOut: TimeInterval = 0.3`
- `maximumDuration: TimeInterval? = 180`: nil is no limit.
- `sharingType: NSWindow.SharingType = .none`: keeps the panels out of legacy `CGWindowList` captures only (see the section intro). The bubble always uses `.none`.
- `duringScreenCapture: ScreenCaptureBehavior = .hideCameraBubble`: `.showEverything`, `.hideCameraBubble`, `.hideCameraBubbleAndMessage`, or `.holdBack` (nothing drawn; the effect stays on, its timeout keeps counting, and it appears when the capture ends). Each case has a `title`.

The blur's alpha is capped at 0.85 and the dim's opacity at 0.78, so the screen stays readable at intensity 2.

```swift
var configuration = ScreenEffectConfiguration(style: .edgeGlow, target: .allScreens, maximumDuration: 30)
configuration.glow = ChartColor(red: 0.96, green: 0.38, blue: 0.40)
```

#### `ScreenEffectView`

What one screen of an effect shows: the tint of `style` at `intensity` and the pill. A still view, cheap to keep on screen; a settings page can show it in a small frame as a live preview of the chosen style.

- `style: ScreenEffectStyle`, `intensity: Double`
- `glow: ChartColor = red`
- `message: ScreenEffectMessage? = nil`
- `pillCenter: CGPoint? = nil`: the pill's centre from the top-left; nil is a third of the way down.
- `reduceTransparency: Bool = false`: blur as dim, the pill solid.

```swift
ScreenEffectView(style: model.style, intensity: model.intensity,
                 message: ScreenEffectMessage("Sit up straight", symbol: "figure.stand"))
    .background(LinearGradient(colors: [.gray, .black], startPoint: .top, endPoint: .bottom))
    .frame(width: 240, height: 150)
    .clipShape(RoundedRectangle(cornerRadius: 10))
```

#### `ScreenEffectGeometry`

The pure geometry, for tests and for a host that places its own panels. A `ScreenEffectScreen(id:frame:visibleFrame:)` (or `ScreenEffectScreen(nsScreen)`) is a display as values.

- `static func screens(for: ScreenEffectTarget, among: [ScreenEffectScreen], cursor: CGPoint) -> [ScreenEffectScreen]`: the cursor's screen falls back to the main one.
- `static func panelFrame(on:coversMenuBar:) -> CGRect`
- `static func bubbleScreen(for:among:cursor:) -> ScreenEffectScreen?`, `static func bubbleFrame(on:) -> CGRect` (`bubbleSize` 176, `bubbleMargin` 28)
- `static func pillCenter(panel:visible:) -> CGPoint`

```swift
let screens = NSScreen.screens.map(ScreenEffectScreen.init)
let covered = ScreenEffectGeometry.screens(for: .cursorScreen, among: screens, cursor: NSEvent.mouseLocation)
```

#### `ScreenCaptureDetector`

Whether something captures the screen right now: a share, a recording, a screenshot tool, an always-on recorder. It reads WindowServer's "screen watcher present" flag (`SLSIsScreenWatcherPresent` from the private SkyLight framework, `CGSIsScreenWatcherPresent` as a fallback), looked up with `dlsym`, so nothing links against a private symbol.

- `static func current() -> Bool?`: nil when this macOS has no such check.
- `static var isAvailable: Bool`

Measured on macOS 26.3: false at rest, true within 0.1 s after a ScreenCaptureKit stream starts and while `screencapture -v` records, false within a second after either stops; one call costs about 5 ns. Not guaranteed: it is private API (a later macOS can drop it, and then `current()` is nil); it was not tried with Zoom, Meet, Teams or FaceTime themselves, only with ScreenCaptureKit and `screencapture`, which they use; any capture counts, not only a share; it is polled, so a capture that starts between two checks can catch up to a second of the screen; and it cannot see a camera or a capture card pointed at the display. `ScreenEffectsTests.testTheSystemCaptureCheckSeesARealRecording` records a 2 by 2 pixel corner for two seconds to check it (opt in with `GENESISKIT_CAPTURE_PROBE=1`).

```swift
if ScreenCaptureDetector.current() ?? true {
    effects.setCameraBubble(nil) // or let the controller's duringScreenCapture do it
}
```

#### `ScreenEffectMachine`

The show, hide, timeout and kill-switch rules without windows or timers (the controller runs on it).

- `mutating func show(at: Date, preview: Bool = false) -> ShowResult`: `.presented`, `.promoted` (a preview became real), `.alreadyShown` or `.suppressed(until:)`.
- `mutating func hide() -> Bool`, `mutating func suppress(until:) -> Bool`, `mutating func clearSuppression()`
- `func deadline(maximumDuration:) -> Date?`, `isShown`, `isPreview`, `isSuppressed(at:)`, `suppressedUntil`

```swift
var machine = ScreenEffectMachine()
_ = machine.show(at: .now)
machine.suppress(until: .now.addingTimeInterval(600))
assert(machine.show(at: .now) == .suppressed(until: machine.suppressedUntil!))
```

### Paths

Everything a host needs to show a file or folder path and act on it. `PathLabel` is the main entry point: a clickable path with copy, reveal and open icons, and a right-click menu (`PathActionsMenu`). A host that configures its own verbs lists them as `[PathAction]`, builds the menu with `PathMenu`, shows it as a context menu (`PathActionsMenu`) or below a button (`PathMenuButton`), and supplies the verbs that need its window through `PathMenuHandlers`. Under the menus, `PathOpener` decides and performs each open through a `PathWorkspace` that tests can replace. `Clipboard` and `CopyToast` copy text and confirm it next to the pointer, and `DefaultApp` finds the app macOS opens a file with. Views never call `NSWorkspace` or `NSPasteboard` for these tasks themselves.

#### `PathLabel`

A path you can act on, the one component for every file or folder path on screen. A click calls `PathOpener.primary`: a folder opens in Finder, a file opens in Cursor at `line`, and a missing path says so in a toast. A right-click lists every action (`PathActionsMenu`). The three icons copy the path, reveal it in Finder and open it in Cursor. The menu is a context menu, not a SwiftUI `Menu`, because a `Menu` with a truncating label inside a header stack caused a layout cycle.

- `path: String`: the absolute or `~` path to act on.
- `font: Font = .system(size: 11, design: .monospaced)`: the text font.
- `showIcons: Bool = true`: shows the copy, reveal and open-in-Cursor icons.
- `findField: String = "path"`: the key a panel find lists this text under.
- `line: Int? = nil`: a line in the file; the click opens Cursor there.
- `title: String? = nil`: text to show instead of the path (for a row that names a folder by its last component). Every action still uses the full path.
- `color: Color = KitPalette.dim`: the text color.

Static member:

- `display(_ path: String) -> String`: the shown form. A path inside the home folder becomes `~/...`; the home folder itself becomes `~`; a sibling folder such as `/Users/mean` keeps its full path.

```swift
PathLabel(
    path: "/Users/alice/Projects/demo/Sources/App.swift",
    line: 42
)
PathLabel(path: project.folder, showIcons: false, title: project.name, color: .secondary)
```

#### `PathActionsMenu`

The menu items for a path, for a `.contextMenu` on any row that shows one. It has three forms. `init(path:line:)` is a fixed list for a path with no host behind it: Open in Finder, Reveal in Finder, Open in Cursor, Open in a new cmux workspace (only when the host's `opensTerminal` is true), then a divider, Copy path and Copy ~ path. `init(url:kind:actions:handlers:leading:)` shows a host's configured verbs (see `PathMenu.entries`). `init(entries:)` draws a list built elsewhere. The entries are built when the menu opens, not when the row draws.

`init(path:line:)`:

- `path: String`: the path to act on.
- `line: Int? = nil`: a line in the file; Open in Cursor goes there.

`init(url:kind:actions:handlers:leading:)`:

- `url: URL`: the file or folder.
- `kind: PathKind`: whether `url` is a file or a folder.
- `actions: [PathAction]`: the verbs to offer, in order.
- `handlers: PathMenuHandlers`: the verbs only the host can do.
- `leading: [PathMenuItem] = []`: the host's own items above the verbs, followed by a divider when there are verbs (a tree file's "Open").

`init(entries:)`:

- `entries: [PathMenuEntry]`: the lines to draw.

```swift
HStack {
    Image(systemName: "doc.text")
    Text(row.name)
}
.contextMenu {
    PathActionsMenu(path: row.path, line: row.line)
}
```

```swift
Text(row.name)
    .contextMenu {
        PathActionsMenu(
            url: row.url,
            kind: PathKind.of(row.url),
            actions: PathAction.fileDefaults,
            handlers: PathMenuHandlers(showInSidebar: { reveal(row.url) })
        )
    }
```

#### `PathMenu`

The one menu of verbs for a file or a folder, built from an ordered `[PathAction]` list. The verbs any app can do run inside it: Finder, Cursor, the default app, Obsidian, a terminal, copy path, rename, duplicate and move to the Trash. The verbs that need the host's window come in as `PathMenuHandlers`, and a verb without a handler is left out. A divider goes between verbs of different groups: sidebar and search verbs, new file and new folder, the open verbs, copy path, rename and duplicate, then Trash. The same entries render as a SwiftUI context menu (`PathActionsMenu`) or as an `NSMenu` (`nsMenu`, `popUp`). All three members run on the main actor.

- `entries(for url: URL, kind: PathKind, actions: [PathAction], handlers: PathMenuHandlers, environment: PathMenuEnvironment? = nil) -> [PathMenuEntry]`: `actions` in their order, minus what this path or this host cannot do. That is a host verb without its handler, the default app or Obsidian on a folder, the default app when none is found, Obsidian when it is not installed, and rename, duplicate and trash without `changed`. A nil `environment` asks the system (`PathMenuEnvironment.system`).
- `nsMenu(_ entries: [PathMenuEntry]) -> NSMenu`: the entries as an `NSMenu`. A picked item runs its closure. Submenus nest, and an SF Symbol name becomes the item image.
- `popUp(_ entries: [PathMenuEntry], below view: NSView? = nil) -> Bool`: opens the menu with its top-left corner just below `view` when the view is in a window, else at the pointer. It returns true when an item was picked, and false at once for an empty list. The result is discardable.

```swift
let entries = PathMenu.entries(
    for: url,
    kind: PathKind.of(url),
    actions: PathAction.fileDefaults,
    handlers: PathMenuHandlers(changed: { change in tree.apply(change) })
)
PathMenu.popUp(entries)
```

#### `PathMenuButton`

A button that drops a path menu below itself, the way a breadcrumb segment or a "+" button does. It is not a SwiftUI `Menu`, because a `Menu` whose label truncates inside a header stack caused a layout cycle. The entries are built on the click, so a row of these costs nothing until one opens. The type is generic over its label view.

- `entries: () -> [PathMenuEntry]`: builds the menu at the click.
- `label: () -> Label`: the button content (a `@ViewBuilder`).

```swift
PathMenuButton(entries: {
    PathMenu.entries(for: folder, kind: .folder, actions: [.newFile, .newFolder], handlers: handlers)
}) {
    Image(systemName: "plus")
}
.buttonStyle(.genHoverPlain())
```

#### `PathMenuHandlers`

The verbs only the host can do: its sidebar, its search, a new file in its window, and what a change did. A nil handler leaves its verb out of the menu, so pass nil for a verb that does not apply to the path (a folder-only verb on a file). All seven are public `var`s, and the initializer takes each as a labeled optional with a nil default.

- `showInSidebar: (() -> Void)? = nil`: for `showInSidebar`.
- `navigateInSidebar: (() -> Void)? = nil`: for `navigateInSidebar`.
- `searchInFolder: (() -> Void)? = nil`: for `searchInFolder`.
- `newFile: (() -> Void)? = nil`: for `newFile`.
- `newFolder: (() -> Void)? = nil`: for `newFolder`.
- `changed: ((FileChange) -> Void)? = nil`: told what a rename, a duplicate or a move to the Trash did (a `FileChange`). nil leaves those three verbs out.
- `guardChange: ((URL) -> String?)? = nil`: a reason to refuse a rename or a move to the Trash first (a tab with unsaved edits), or nil to allow it.

```swift
let handlers = PathMenuHandlers(
    showInSidebar: { tree.reveal(url) },
    searchInFolder: kind == .folder ? { search(in: url) } : nil,
    changed: { change in tree.apply(change) },
    guardChange: { file in hasUnsavedEdits(file) ? "Save the file first." : nil }
)
```

#### `PathMenuEnvironment`

What a menu asks the system before it offers a verb. A test passes its own, so building a menu touches no Launch Services.

- `defaultAppName: (URL) -> String?`: the app macOS opens a file with, for the "Open in ..." title (for example "Preview"). nil when none does, or when it is this app.
- `obsidianInstalled: Bool`: whether Obsidian is installed.
- `hostTerminal: Bool`: whether the host opens its own terminal (a cmux workspace) instead of Terminal.

`system` (static, main actor) is the real environment. It asks Launch Services once per file extension and once for Obsidian, because a menu is built on every right-click and a tree builds one per row. Its `hostTerminal` is the host's `opensTerminal`.

```swift
let environment = PathMenuEnvironment(
    defaultAppName: { _ in "Preview" },
    obsidianInstalled: false,
    hostTerminal: true
)
let entries = PathMenu.entries(
    for: url, kind: .file, actions: PathAction.fileDefaults,
    handlers: PathMenuHandlers(), environment: environment
)
```

#### `PathMenuEntry`

One line of a path menu. It is `Identifiable`. A host builds entries for `PathActionsMenu(entries:)`, `PathMenuButton` and `PathMenu.popUp`, or reads the ones `PathMenu.entries` returns.

- `item(PathMenuItem)`: a pickable item (see below).
- `submenu(id: String, title: String, systemImage: String, entries: [PathMenuEntry])`: a titled submenu, such as each folder a collapsed breadcrumb hides, with its own verbs.
- `divider(id: String)`: a separator.
- `id: String`: the id of the item, submenu or divider.
- `outline(_ entries: [PathMenuEntry]) -> [String]` (static): the titles, a divider as `-` and a submenu as `title >`. A test compares it.

`PathMenuItem` (the payload of `item`) is `Identifiable` and has an initializer with these parameters:

- `id: String`: a stable id.
- `title: String`: the menu text.
- `systemImage: String = ""`: an SF Symbol name; empty draws the title alone.
- `action: PathAction? = nil`: the configurable verb the item came from; nil for an item the host adds itself.
- `destructive: Bool = false`: draws the item as destructive.
- `run: () -> Void`: runs when the item is picked.

```swift
let open = PathMenuItem(id: "open", title: "Open", systemImage: "doc.text") { openFile(url) }
let entries: [PathMenuEntry] = [
    .item(open),
    .divider(id: "divider-open"),
    .submenu(id: "parents", title: "Parent folders", systemImage: "folder", entries: parentEntries),
]
PathMenu.popUp(entries)
```

#### `PathKind`

A file or a folder, as a path menu treats it. It is `Sendable` and `Equatable`.

- `file`: a file, a package, or a path that cannot be read.
- `folder`: a directory that is not a package.
- `of(_ url: URL) -> PathKind` (static): what is at `url`. A package such as an `.app` counts as a file, because Finder shows it as one item.

```swift
let url = PathOpener.fileURL("~/Projects/demo")
let kind = PathKind.of(url)
let actions = kind == .folder ? PathAction.folderDefaults : PathAction.fileDefaults
```

#### `PathAction`

The verbs a file or a folder can offer in a path menu. A host picks and orders them per kind (`GenesisKitMarkdownConfiguration.folderActions` and `.fileActions`) and passes the list to `PathMenu.entries` or `PathActionsMenu`. `PathMenu` runs the verbs any app can do and takes the sidebar ones from `PathMenuHandlers`. `PathAction` is a `String` enum that is `CaseIterable`, `Sendable` and `Codable`. Each case below gives its menu title and what it needs.

- `showInSidebar`: "Show in Sidebar". Reveals the item in the file sidebar with an animated scroll and a highlight. Needs `handlers.showInSidebar`.
- `navigateInSidebar`: "Navigate in Sidebar". Roots the sidebar at the folder (for a file, its folder) and pulses it. Needs `handlers.navigateInSidebar`.
- `openInFinder`: "Open in Finder" for a folder, "Show in Finder" for a file. Runs `PathOpener.finder`. Needs nothing from the host.
- `openInCursor`: "Open in Cursor". Runs `PathOpener.cursorWorkspace`: Cursor on the whole folder, or for a file its folder with the file opened. Needs nothing from the host.
- `openInDefaultApp`: "Open in" and the app's name. Files only. Left out when `environment.defaultAppName` gives nil. Runs `PathOpener.open`.
- `openInObsidian`: "Open in Obsidian". Files only. Left out when `environment.obsidianInstalled` is false. Runs `PathOpener.obsidian`.
- `openInTerminal`: "Open in Terminal", or "Open in a New cmux Workspace" when `environment.hostTerminal` is true. Runs `PathOpener.terminal`.
- `copyPath`: "Copy Path". Runs `Clipboard.copy`.
- `searchInFolder`: "Search in Folder…". The sidebar's text search, limited to the folder. Needs `handlers.searchInFolder`.
- `newFile`: "New File…". Needs `handlers.newFile`.
- `newFolder`: "New Folder…". Needs `handlers.newFolder`.
- `rename`: "Rename…". Needs `handlers.changed`; asks `handlers.guardChange` first.
- `duplicate`: "Duplicate". Needs `handlers.changed`.
- `trash`: "Move to Trash", drawn as destructive. Needs `handlers.changed`; asks `handlers.guardChange` first.

Static members:

- `folderDefaults: [PathAction]`: `showInSidebar`, `navigateInSidebar`, `searchInFolder`, `newFile`, `newFolder`, `openInFinder`, `openInCursor`, `openInTerminal`, `copyPath`.
- `fileDefaults: [PathAction]`: `showInSidebar`, `openInDefaultApp`, `openInObsidian`, `openInFinder`, `openInCursor`, `copyPath`, `rename`, `duplicate`, `trash`.

```swift
// configuration: GenesisKitMarkdownConfiguration
configuration.folderActions = [.showInSidebar, .openInFinder, .copyPath]
configuration.fileActions = PathAction.fileDefaults.filter { $0 != .trash }
```

#### `PathOpener`

The static entry points that open a path. A path may carry `~`, `.` and `..`. `perform` logs what it did. `finder`, `reveal`, `open` and `primary` call `perform` with one intent each. The other methods act on their own.

Methods:

- `fileURL(_ path: String) -> URL`: a file URL for a path as a person wrote it, with `~` expanded and `.` and `..` resolved. It never goes through `URL(string:)`, so a space, `#` or non-ASCII letter is safe.
- `target(for url: URL, intent: PathIntent, kind: PathItemKind, line: Int? = nil) -> PathOpenTarget`: the decision alone, with no side effect.
- `perform(_ intent: PathIntent, _ path: String, line: Int? = nil, workspace: PathWorkspace = SystemPathWorkspace()) -> PathOpenTarget`: decides, runs the side effect through the workspace and returns the target. The result is discardable.
- `finder(_ path: String)`: Open in Finder. A folder opens in a Finder window; a file is selected in its folder.
- `reveal(_ path: String)`: Reveal in Finder. The item is selected in its parent folder.
- `open(_ path: String)`: a file opens in its default app; a folder opens in Finder.
- `primary(_ path: String, line: Int? = nil)`: what a click on `PathLabel` does.
- `cursor(_ path: String, line: Int? = nil)`: runs the `cursor` command line tool (`-g path:line` with a line) from `~/.local/bin`, `/usr/local/bin` or `/opt/homebrew/bin`. Without one it runs `open -a Cursor`. A start failure shows a problem toast.
- `cursorWorkspace(_ path: String, kind: PathKind)`: "Open in Cursor" from a path menu. A folder opens as a workspace. A file opens inside its folder, so it lands in the folder's window rather than alone. It uses the same command line tool and fallback as `cursor`.
- `cursorWorkspacePaths(for path: String, kind: PathKind) -> [String]`: what `cursorWorkspace` hands Cursor: the folder alone, or for a file its folder and then the file.
- `obsidianURL(for path: String) -> URL?`: `obsidian://open?path=<absolute path>`. Obsidian finds the vault that holds the file itself.
- `obsidian(_ path: String)`: "Open in Obsidian". Opens that URL, so the note opens in its vault.
- `terminal(_ path: String)`: "Open in Terminal". Uses the app's own terminal (a cmux workspace, through the host's `openTerminal(folder:)`) when the host offers one. Otherwise it opens Terminal.app in the path's folder (for a file, its folder). A failure shows a problem toast.
- `terminalFolder(for path: String) -> String`: the folder a terminal opens in: the path itself, or a file's folder.
- `cmux(_ path: String)`: opens a shell in that folder through the host's `openTerminal(folder:)`. It does nothing when the host does not offer a terminal.
- `copy(_ text: String, what: String? = nil)`: the same as `Clipboard.copy`.

`PathIntent` (the first argument of `perform` and `target`):

- `finder`: a folder opens in a Finder window; a file or package is revealed in its folder.
- `reveal`: Finder shows the parent folder with the item selected.
- `open`: a file opens in the app macOS picks; a folder opens in Finder.
- `primary`: a click on the path itself. A folder opens in Finder, a file opens in Cursor at its line, a package is revealed.

`PathOpenTarget` (what `perform` and `target` return):

- `folderInFinder(URL)`: the folder opens in Finder.
- `revealInFinder(URL)`: the item is selected in its folder.
- `openFile(URL)`: the file opens in its default app.
- `editFile(URL, line: Int?)`: the file opens in Cursor, at the line when one is known.
- `missing(String)`: nothing is at the path (tilde expanded).

```swift
PathOpener.primary("~/Projects/demo/README.md")
let target = PathOpener.perform(.reveal, "/Users/alice/Projects/demo")
PathOpener.cursor("/Users/alice/Projects/demo/main.swift", line: 12)
PathOpener.cursorWorkspace("/Users/alice/Projects/demo/main.swift", kind: .file)
PathOpener.obsidian("~/notes/todo.md")
```

#### `PathWorkspace`

The side effects of `PathOpener.perform`. Implement it to test the open logic with a spy instead of launching Finder. None of the requirements has a default implementation.

- `func kind(of url: URL) -> PathItemKind`: what is on disk. `PathItemKind` has `missing`, `folder`, `package` (a directory macOS shows as one item, such as an `.app`) and `file`.
- `func openFolderInFinder(_ url: URL)`: opens the folder in a Finder window.
- `func revealInFinder(_ url: URL)`: selects the item in its folder.
- `func openFile(_ url: URL)`: opens the file in its default app.
- `func editFile(_ url: URL, line: Int?)`: opens the file in the editor, at the line when known.
- `func reportMissing(_ path: String)`: tells the person nothing is at the path.

```swift
struct FileOnlyWorkspace: PathWorkspace {
    func kind(of url: URL) -> PathItemKind { .file }
    func openFolderInFinder(_ url: URL) {}
    func revealInFinder(_ url: URL) {}
    func openFile(_ url: URL) { print("open", url.path) }
    func editFile(_ url: URL, line: Int?) {}
    func reportMissing(_ path: String) {}
}
PathOpener.perform(.open, "/tmp/demo.txt", workspace: FileOnlyWorkspace())
```

#### `SystemPathWorkspace`

The real `PathWorkspace`, and the default of `PathOpener.perform`. It checks the file system, opens folders in Finder by name (never the folder's default app), reveals items, opens files with `NSWorkspace`, and edits through `PathOpener.cursor`. A failure shows a `CopyToast` problem.

- `init()`: takes no parameters.

```swift
let workspace = SystemPathWorkspace()
let url = PathOpener.fileURL("~/Downloads")
if workspace.kind(of: url) == .folder {
    workspace.openFolderInFinder(url)
}
```

#### `Clipboard`

The one way a control copies text: the pasteboard, then the `CopyToast` confirmation.

- `copy(_ text: String, what: String? = nil)`: copies `text`. `what` names the value in the confirmation ("Copied path"); nil says "Copied". Empty text copies nothing and shows a "Nothing to copy" problem toast. A path under the home folder shows as `~/...` in the confirmation.

```swift
Button("Copy id") {
    Clipboard.copy(session.id, what: "session id")
}
```

#### `CopyToast`

A small capsule beside the pointer that confirms a copy, or says why a path did not open. It is a borderless panel that takes no click and never becomes key, so it shows over any window, popover or web view. It holds for 0.9 s (a confirmation) or 2.2 s (a problem), then fades over 0.3 s. It is not a notification and plays no sound.

- `post(title: String, detail: String, style: Style)`: shows the capsule. Callable from any thread; the panel appears on the main thread.
- `preview(_ text: String, limit: Int = 56) -> String`: one short line of what was copied. A multi-line text becomes its line count ("3 lines"); a long line loses its middle.
- `origin(pointer: CGPoint, size: CGSize, screen: CGRect) -> CGPoint`: where the capsule goes: above and to the right of the pointer, kept inside the visible screen.
- `Style`: `copied` (a check mark) or `problem` (an exclamation mark).

```swift
do {
    try export(to: file)
    CopyToast.post(title: "Exported", detail: CopyToast.preview(file.path), style: .copied)
} catch {
    CopyToast.post(title: "Export failed", detail: error.localizedDescription, style: .problem)
}
```

#### `ClosureMenuItem`

An `NSMenuItem` that runs a closure when picked. Use it to build a native menu in Swift from data, such as a right-click menu for a page that only reports which file was clicked.

- `init(_ title: String, _ handler: @escaping () -> Void)`: the title and the action to run.

```swift
let menu = NSMenu()
menu.addItem(ClosureMenuItem("Reveal in Finder") { PathOpener.reveal(path) })
menu.addItem(ClosureMenuItem("Copy path") { PathOpener.copy(path, what: "path") })
```

#### `DefaultApp`

The default app for one file, as Launch Services answers it right now, and the link that opens that app at a line. An editor that declares one of the `lineSchemes` (Cursor, VS Code and its forks) lands on the line instead of the top of the file. A menu can then say "Open in Cursor" instead of "Open".

- `url: URL`: the app's location.
- `name: String`: the name Finder shows, without `.app`.
- `bundleIdentifier: String?`: the app's bundle id.
- `schemes: [String]`: the URL schemes the app declares, lowercased.
- `init(url: URL, name: String, bundleIdentifier: String?, schemes: [String])`: all four values are required.

Members:

- `lineSchemes: [String]` (static): `cursor`, `vscode`, `vscode-insiders`, `vscodium`, `windsurf`, in the order tried.
- `opensAtLine: Bool`: true for a code editor that takes a line link.
- `forFile(_ file: URL) -> DefaultApp?` (static): the app that opens the file; nil when no app claims it.
- `lineURL(path: String, line: Int?) -> URL?`: `cursor://file/<path>:<line>` in the first matching scheme. nil without a line (or with a line below 1), or when the app has none of the schemes.
- `open(_ file: URL, line: Int?)`: opens the file with this app, at the line through the editor's scheme when it has one. When the app opens the file itself (no line link) and fails, a problem toast appears.

```swift
let file = PathOpener.fileURL("~/notes/todo.md")
if let app = DefaultApp.forFile(file) {
    print(app.name, app.opensAtLine)
    app.open(file, line: 12)
}
```

### Perf

Perf is the kit's profiling layer: span timing into one log file per app, a main-thread stall detector that captures stacks, a dropped-frame counter, and run-loop busy-time meters. The host sets where the log goes and whether it is on through `PerfConfiguration` (the `GenesisKitHost.perf` hook). Every piece stays silent while `PerfLog.enabled` is false. The main entry points are `PerfLog` for spans and marks, `HangWatch.start()` and `FrameWatch.start()` at launch, `PerfContext.area` to say which screen is open, and `MainBusy.measure(_:window:)` after a user action.

#### `PerfLog`

Lightweight span timing. Every line goes to one plain file (`PerfConfiguration.logDirectory` plus `fileName`) and to the unified log under the app's subsystem, category `perf`. A line starts with the stamp `[HH:mm:ss.SSS]`, followed by the configuration's `processTag`. The file is written by one serial queue and rotates once at 16 MiB, keeping one `.1` backup. `PerfLog` is an enum of static functions. Every function that writes a line is a no-op while `enabled` is false.

Read the unified log with `log show --last 3m --predicate 'subsystem == "<subsystem>" AND category == "perf"'`.

- `static let enabled: Bool`: the switch. The environment variable named by `PerfConfiguration.environmentKey` wins (`0` or `false` is off, anything else is on). Without it, the log is off under XCTest, and otherwise follows `enabledByDefault`.
- `static let processStart: Date`: when the kernel started the process, so "ms since launch" includes dyld and static init.
- `static var msSinceLaunch: Double`: milliseconds since `processStart`.
- `static func phase(_ label: String)`: marks a startup phase with its offset from process start (`phase <label> +N.Nms since-launch`). The gap between two phases is the cost of what sits between them.
- `static func span<T>(_ label: String, _ body: () throws -> T) rethrows -> T`: times a synchronous block and logs `<label> <ms>ms`. Returns the block's result.
- `static func spanAsync<T>(_ label: String, _ body: () async throws -> T) async rethrows -> T`: the same for an async block.
- `static func span<T>(_ label: String, over minMs: Double, _ body: () throws -> T) rethrows -> T`: writes the line only when the block took at least `minMs`. Use it for per-tick or per-chunk main-thread work.
- `static let frameMs: Double = 16`: one 60 Hz frame, the usual `minMs` for main-thread paths.
- `static func now() -> CFAbsoluteTime?`: the current time, or `nil` while logging is off. Keep it as the start of a span that crosses an async boundary.
- `static func since(_ label: String, _ start: CFAbsoluteTime?)`: logs the time elapsed since a start from `now()`.
- `static func mark(_ label: String)`: writes a one-line event (`mark <label>`). It also feeds `PerfContext`, except for labels that start with `main-stall` or `frames `.
- `static func markOnce(_ label: String)`: writes a phase line the first time a label is seen. For code that runs many times, such as a SwiftUI body.
- `static let fileURL: URL`: the log file.
- `static func stampedLine(_ line: String, at date: Date, tag: String) -> String`: the exact text written for a line.
- `static func loadAverage() -> Double`: the 1-minute load average, or `-1` when it cannot be read. Stall marks carry it, so a stall on a starved machine reads differently from work on the main thread.
- `static let rotateBytes = 16 * 1024 * 1024`: the rotation size.
- `static func rotateIfHuge(url: URL = PerfLog.fileURL, limit: Int = PerfLog.rotateBytes, fileManager: FileManager = .default)`: moves the file to `<name>.1` when it reached `limit`, replacing an older backup.

```swift
PerfLog.phase("window.ready")
let rows = PerfLog.span("rows.load") { loadRows() }
PerfLog.span("row.layout", over: PerfLog.frameMs) { layoutRows() }
```

#### `PerfConfiguration`

Where an app's perf lines, hang captures and stall stacks go, and whether they are on. The host supplies it through `GenesisKitHost.perf`, and the kit reads it once, when perf logging is first used. A struct (`Sendable`) whose properties are public `var`s.

- `environmentKey: String`: the environment variable that switches logging (`GENESIS_TOOLS_PERF` or `GENESIS_PERF` in the two apps). `0` or `false` turns it off, anything else turns it on.
- `enabledByDefault: Bool`: whether logging is on when the environment says nothing.
- `subsystem: String`: the unified log subsystem. It is also the prefix of the writer queue's label.
- `logDirectory: URL`: the folder of the log file. Hang captures go in its `hangs` folder.
- `fileName: String`: the log file name.
- `processTag: String = ""`: put before every line this process writes. Use it when two processes write one file.
- `stackFilePrefix: String = "stack-"`: the file prefix of the in-process stall stacks.
- `appName: String`: named in the "is not responding" notification.
- `alertBundlePrefix: String?`: the notification goes out only from a bundle whose id starts with this. `nil` never posts one.
- `static let fallback`: the value an app with no host gets. It is off unless `GENESIS_PERF` asks, and it logs to `~/.genesis/logs/perf.log`.

```swift
var perf: PerfConfiguration {
    PerfConfiguration(
        environmentKey: "MYAPP_PERF", enabledByDefault: true, subsystem: "com.example.myapp",
        logDirectory: FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".myapp/logs"),
        fileName: "perf.log", appName: "MyApp", alertBundlePrefix: "com.example.myapp")
}
```

#### `MonitorPerf`

The monitor's spans in the app's perf file. It wraps `PerfLog` and puts `monitor.` in front of every label, so the monitor's lines sit in sequence with the other spans. An enum of static functions.

- `static let enabled: Bool`: the same switch as `PerfLog.enabled`.
- `static func span<T>(_ label: String, _ body: () throws -> T) rethrows -> T`: times a synchronous block.
- `static func spanAsync<T>(_ label: String, _ body: () async throws -> T) async rethrows -> T`: times an async block.
- `static func now() -> CFAbsoluteTime?`: a start time, or `nil` while logging is off.
- `static func since(_ label: String, _ start: CFAbsoluteTime?)`: logs the time since a start, for spans that cross an async boundary.
- `static func mark(_ text: String)`: writes a one-line event.
- `static func record(_ label: String, ms: Double)`: logs a duration measured elsewhere, such as a child process wall clock.

```swift
let start = MonitorPerf.now()
await refresh()
MonitorPerf.since("usage.refresh", start)
```

#### `PerfContext`

What the app was showing and doing when a stall or a dropped frame happened. Every stall and frame-drop line ends with the current area and the last few spans and marks, newest first, each with how long ago it ended. `PerfLog` feeds the steps by itself. The host sets the area. An enum of static members.

- `static var area: String`: the screen the user is looking at. Set it when the mode, selection or panes change. A change adds an `area <name>` step.
- `static func note(_ label: String)`: records one step. `PerfLog` calls it, and a host may add its own.
- `static let keep = 6`: how many steps are kept.
- `static var run: String?`: what kind of run this process is when no one watches it (`"snapshot"`, `"bench"`). Set it once at launch. A run with this value adds ` run=<run> pid=<pid>` to every stall line and spawns no `sample` process.
- `static var runTag: String`: that ` run=… pid=…` text, or an empty string.
- `static func describe(now: CFAbsoluteTime = CFAbsoluteTimeGetCurrent()) -> String`: ` run=… area=<area> recent=[a -0.1s; b -0.9s]`. Empty when nothing is known.
- `static func resetForTesting()`: clears the area and the steps.

```swift
PerfContext.run = "bench"
PerfContext.area = "agents/transcript"
PerfContext.note("filter.changed")
let context = PerfContext.describe()
```

#### `HangWatch`

A main-thread stall detector that captures stacks. A background timer posts a ping block to the main queue every 250 ms and measures how long it waits to run. A stall over 0.5 s lands in the perf log as `main-stall recovered after <ms>ms`, with the load average and the `PerfContext` text. A stall over 1 s also runs `/usr/bin/sample` on the process (once per stall, at most once per 60 s, never in a run with `PerfContext.run` set) and writes the main-thread call graph to `<log folder>/hangs/hang-<time>.txt`. `MainStackSampler` starts with it and reads the main thread's stack in process from 150 ms into a stall, into stack files named with `PerfConfiguration.stackFilePrefix`. Past 20 s, the watchdog logs `main-thread WEDGED` and posts a local notification, "<appName> is not responding", from a bundle whose id starts with `alertBundlePrefix`. An enum of static members.

- `@MainActor static func start(force: Bool = false)`: starts the watchdog. It does nothing unless `force` or `PerfLog.enabled`, and it starts only once. `force` lets a test run it although the log is off under XCTest.
- `static let stallThreshold: CFAbsoluteTime = 0.5`: seconds of delay that count as a stall.
- `static let sampleThreshold: CFAbsoluteTime = 1.0`: seconds of delay before a `sample` capture.
- `static let wedgeThreshold: CFAbsoluteTime = 20`: seconds after which the main thread counts as wedged and the alert goes out.
- `static let sampleCooldown: CFAbsoluteTime = 60`: the least gap between two captures.
- `static let sleepGap: CFAbsoluteTime = 30`: a wall-clock gap between ticks above this counts as a Mac sleep.
- `static let wakeWindow: CFAbsoluteTime = 120`: stall lines inside this many seconds after a wake carry `wake+<s>s`.
- `static var hangsDirectory: URL`: where captures go. The default is the `hangs` folder of `PerfConfiguration.logDirectory`.
- `static var lastCaptureFile: URL?`: the path of the last capture.
- `static var onWedge: ((CFAbsoluteTime) -> Void)?`: replaces the notification. A test sets it so no real notification goes out.
- `static func stallMark(ms: Double, load: Double, sinceWake: CFAbsoluteTime?, hidden: Bool = false) -> String`: the text of a stall line. `hidden` adds `hidden` for a stall when no window of the process was on screen.
- `static func trimToMainThread(_ file: URL, stillStalled: Bool = true)`: cuts a `sample` file down to its header and the main thread. `stillStalled: false` adds a note that the main thread had recovered during the sample.
- `static func reportWedgeForTesting(stallSoFar: CFAbsoluteTime)`: runs the wedge report without a real 20 s stall.

```swift
HangWatch.hangsDirectory = logsURL.appendingPathComponent("hangs")
HangWatch.onWedge = { seconds in print("blocked for \(seconds) s") }
HangWatch.start()
```

#### `FrameWatch`

Counts dropped frames, the lag below the stall watchdog's 500 ms. A display link on the main run loop measures the gap between two frames. A gap of 50 ms or more counts as a drop. Every 5 s window that had a drop writes one line: `frames <n> dropped of <m> in <s>s, worst <ms>ms, lost <ms>ms`, followed by the `PerfContext` text. It runs only while the app is active. `GENESIS_FRAMEWATCH=0` turns it off. `@MainActor`.

- `static let shared`: the single instance.
- `static let dropMs: Double = 50`: the gap that counts as a dropped frame.
- `static let windowSeconds: Double = 5`: the length of one summary window.
- `static func start()`: begins watching. It does nothing unless `PerfLog.enabled`.

```swift
PerfLog.phase("window.ready")
HangWatch.start()
FrameWatch.start()
```

#### `MainBusy`

Main-thread busy time after an event: the run loop's awake time summed over a window, then one line in the perf file. It includes anything else the main thread did in that window, so the number is an upper bound. A span times work, but not the SwiftUI layout it causes. This is what an append or a reload really costs on screen. `@MainActor` enum.

- `static func measure(_ label: String, window: TimeInterval = 0.6)`: starts a window now and, `window` seconds later, writes `<label> main busy <ms> ms of <window> ms`, with the window in milliseconds. The same label again inside an open window joins that window, so a keystroke in a filter does not log a line each. The line also names the bodies that rendered when `RenderProbe` is on.
- `static func measureUntilSettled(_ label: String, cap: TimeInterval = 10, quietMs: Double = 8, detail: @escaping () -> String)`: measures until the main thread settles, for work that runs past any fixed window. Settled means less than `quietMs` of busy time in each of three 100 ms checks in a row, or `cap` seconds. Writes `<label> main busy <ms> ms, settled after <ms> ms: <detail()>`, with `detail` read at the end. The line says `(cap)` after the settle time when the cap ended the measurement. Does nothing while logging is off.

```swift
Button("Fold all") {
    groups.foldAll()
    MainBusy.measure("groups.fold", window: 0.3)
}
.onAppear { MainBusy.measureUntilSettled("transcript.open", cap: 5) { "rows=\(rows.count)" } }
```

#### `MainBusy.Meter`

The run-loop meter behind `MainBusy`, for benches and tests that read the number themselves. It sums the run loop's awake time between `start()` and `stop()`. A final class.

- `init()`: takes no parameters.
- `func start()`: begins counting from now. A second call does nothing.
- `func read(now: CFAbsoluteTime = CFAbsoluteTimeGetCurrent()) -> Reading`: the total so far, with the open pass counted up to `now`.
- `@discardableResult func stop() -> Reading`: stops counting and returns the total.
- `Reading` (`Sendable`, `Equatable`): `busyMs: Double` is the summed awake time, `longestMs: Double` is the longest single pass (the worst stall the reader felt), and `passes: Int` is the number of passes.

```swift
let meter = MainBusy.Meter()
meter.start()
openWindow()
let reading = meter.stop()   // reading.busyMs, reading.longestMs, reading.passes
```

#### `RenderProbe`

Named counters for body evaluations and other per-frame work. Render tests read them. In the app, `GENESIS_RENDER_PROBE=1` turns them on, and each `MainBusy` line then names the bodies that a render evaluated, which tells a change that re-rendered one row from one that re-rendered them all. Off, a hit is one Bool read. An enum of static members, with Foundation only.

- `static var enabled: Bool`: true when `GENESIS_RENDER_PROBE` is `1`. A test can set it.
- `static func hit(_ name: String)`: counts one hit for `name`.
- `static func snapshot() -> [String: Int]`: the counts so far, left in place. It starts one measurement's window, and another measurement keeps its own counts.
- `static func summary(since start: [String: Int]) -> String`: ` bodies[row.body=3 codeBlock.body=1]`: what ran since `start`. ` bodies[none]` when nothing ran, and empty when the probe is off.
- `static func summary() -> String`: the same text for all counts so far, then resets them.
- `static func take() -> [String: Int]`: the counts so far, then zero.

```swift
var body: some View {
    let _ = RenderProbe.hit("row.body")
    Text(title)
}
```

#### `AnimationTiming`

Times an existing animation driver. It creates no display link or timer and cannot measure presented frames. Feed it the start and finish time of each callback the driver makes, then ask for a summary. A struct.

- `init(at time: CFTimeInterval = CACurrentMediaTime())`: the start of the animation.
- `mutating func record(startedAt: CFTimeInterval, finishedAt: CFTimeInterval)`: records one callback.
- `func summary(at time: CFTimeInterval = CACurrentMediaTime(), outcome: String) -> Summary`: the result. `outcome` is a label you choose, such as "finished".
- `AnimationTiming.Summary` (`Codable`, `Sendable`): `outcome: String`, `elapsedMs: Double`, `callbacks: Int`, `firstCallbackMs: Double?`, `gapP50Ms`, `gapP95Ms` and `gapMaxMs` (all `Double`, the gaps between callback starts), `gapsOver50Ms: Int`, `workTotalMs` and `workMaxMs` (both `Double`), and `description: String` (one line with all of them).

```swift
var timing = AnimationTiming()
let t0 = CACurrentMediaTime()
stepAnimation()
timing.record(startedAt: t0, finishedAt: CACurrentMediaTime())
print(timing.summary(outcome: "finished").description)
```

#### `SessionOpenBench`

Times one open of a session screen in a window nobody sees (alpha 0, below the desktop, never activated). It measures the first frame, the first transcript rows, the main-thread busy time and the longest pass until the main thread has been quiet for 3 s, a 40-step scroll, the CPU of the app and of every `tools` child, and the memory footprint. Both apps' bench tests use it, one open per process. It costs nothing until a test calls it. `run` turns `RenderProbe.enabled` on. `@MainActor`.

- `init()`: takes no parameters.
- `func run(_ make: () -> (NSWindow, AnyObject)) -> Result`: opens the window that `make` returns together with an object to keep alive, measures until the main thread has been quiet for 3 s (at most 60 s), scrolls the transcript up in 40 steps, then waits for every `tools` child except the live follow to exit (at most 30 s). The window is closed at the end.
- `SessionOpenBench.Result`: `values: [String: Double]` and `counts: [String: Int]`.
- `static func append(_ result: Result, label: String, sessionId: String, to path: String) throws`: appends one JSON line to the file at `path`. The line holds `arm` (the label), `session` (the first 8 characters of the id), `at`, `load1` and every key of the result.

Keys in `values`: `firstFrameMs`, `rowsVisibleMs`, `settledMs`, `mainBusyMs`, `longestStallMs`, `scrollStepP50Ms`, `scrollStepP95Ms`, `scrollStepMaxMs`, `appCpuMs`, `childCpuMs`, `footprintAfterLoadMB`, `peakFootprintMB`.

Keys in `counts`: `rowBodies`, `toolRowLoads`, `toolChangeProcesses`, `toolChangeProcessesTotal`, `gitProcesses`, `scrollSteps`, `scrollStepsOver16Ms`, `scrollStepsOver50Ms`, `liveChildren`.

The `scrollStep*` keys other than `scrollSteps` are present only when the scroll made at least one step.

```swift
let result = SessionOpenBench().run { (window, model) }
print(result.values["firstFrameMs"] ?? -1, result.counts["rowBodies"] ?? 0)
try SessionOpenBench.append(
    result,
    label: "baseline",
    sessionId: sessionId,
    to: "/tmp/session-open.jsonl"
)
```

### Permissions

Permissions is the one place a missing macOS privacy grant goes. A feature builds a `PermissionNeed` and passes it to `PermissionCenter.shared.require(_:)` (or `await`s `ensure(_:)`). The center shows one dialog per grant (`PermissionDialogView` in a panel from `PermissionPanelPresenter`), asks macOS in place or opens the exact System Settings pane, and closes the dialog when the grant arrives. `PermissionKind` names the grants and `PermissionStatus` reports them. `PermissionAccess` reads and requests them, with a `PermissionSimulation` applied on top so the real app can show every dialog without touching macOS.

#### `PermissionCenter`

The one place a missing grant goes. It shows one dialog per `PermissionKind` at a time. A second need for the same kind joins the open dialog. It grants in place where macOS allows it. Otherwise it explains the grant and opens the right System Settings pane. It reads the grant while the dialog is open and closes the dialog when the grant arrives. The class is `@MainActor`.

How it treats the two triggers: a `.userAction` need always shows the dialog and brings an open one forward. An `.automatic` need stops showing the dialog for that kind, in this process, after the user closed it with "Not now". When another process of the same app already shows the dialog (see `PermissionDialogLock`), a user's need brings that dialog forward, and the retry (`onGranted`) runs here once the grant is seen.

`PermissionCenter.shared` is the center of the running app: a floating-panel presenter, the host's `freshPermissionStatus` probe, a relaunch through `PermissionRelaunch`, and a dialog lock for this app. In a test process, `shared` reads every grant as denied, sends nothing to macOS and shows nothing, because it uses a `RecordingPermissionPresenter`.

Initializer, for a custom or test center:

- `access: PermissionAccess = .live`: how grants are read and requested.
- `presenter: any PermissionPresenting`: puts a dialog on screen.
- `freshProbe: @escaping (PermissionKind) async -> PermissionStatus? = { _ in nil }`: what a new process reads for a kind.
- `relaunch: @escaping @MainActor () -> Bool = { false }`: relaunches the app. Returns whether it started.
- `lock: PermissionDialogLock? = nil`: one dialog per kind across the processes of the app.
- `pollInterval: Duration = .milliseconds(1500)`: how often an open dialog reads the grant.
- `pollDeadline: Duration = .seconds(600)`: how long an open dialog keeps reading. After that, "Check again" starts it again.
- `closeDelay: Duration = .milliseconds(900)`: how long the "is on" confirmation stays before the dialog closes.
- `activateForPrompt: @escaping @MainActor () -> Void = { NSApp?.activate(ignoringOtherApps: true) }`: brings the app forward before a macOS prompt.

Properties:

- `static let shared`: the app's center.
- `let access: PermissionAccess`: the access this center uses.
- `private(set) var dialogs: [PermissionKind: PermissionDialogModel]`: the open dialogs.
- `private(set) var dismissed: Set<PermissionKind>`: the kinds the user closed with "Not now".
- `var onAllDialogsClosed: (@MainActor () -> Void)?`: runs when the last open dialog closes.

Methods:

- `func status(_ kind: PermissionKind) -> PermissionStatus`: the current status, with the simulation applied.
- `func isGranted(_ kind: PermissionKind) -> Bool`: whether the status is granted.
- `@discardableResult func require(_ need: PermissionNeed) -> Bool`: returns `true` when the grant is there. Otherwise it shows the dialog and returns `false`. An automatic need shows nothing for a kind the user closed with "Not now".
- `func ensure(_ need: PermissionNeed) async -> Bool`: as `require`, but a need with `grantWorksInNewProcess` for Input Monitoring or Screen Recording first asks what a new process reads, since this process may hold an old answer. Returns `true` when the feature can go ahead.
- `func recheckGrantedProbes() async`: probes again the remembered grants of Automation and the three folders, so a grant revoked in System Settings stops reading as granted. The center also does this when the app becomes active, at most every 10 s.

```swift
let allowed = PermissionCenter.shared.require(
    PermissionNeed(.microphone, reason: "Dictation needs the microphone.") { startDictation() }
)
if !allowed { return }
```

#### `PermissionNeed`

A feature that needs a grant it does not have. It carries the kind, the reason shown in the dialog and a retry. A struct with a public init.

- `_ kind: PermissionKind`: the grant that is missing.
- `reason: String? = nil`: one or two sentences on what the feature does with the grant. `nil` uses `kind.reason`.
- `trigger: PermissionTrigger = .userAction`: who noticed. `.userAction` means the user pressed something that needs the grant, so the dialog always shows. `.automatic` means the app noticed on its own (a launch, a background start), so the dialog stops showing after the user closes it with "Not now".
- `grantWorksInNewProcess: Bool = false`: set `true` when the grant is used by a new process (a screenshot taken by `screencapture`). A grant that this process cannot see yet then still counts, and no relaunch is needed. This matters only for Input Monitoring and Screen Recording, the two kinds that macOS caches per process.
- `onGranted: (@MainActor () -> Void)? = nil`: runs once when the grant arrives while the dialog is open. Use it to retry the action that needed the grant.

Read back with the same names: `kind`, `reason`, `trigger`, `grantWorksInNewProcess`, `onGranted`.

```swift
let need = PermissionNeed(
    .accessibility, reason: "Pasting needs Accessibility.",
    trigger: .userAction, grantWorksInNewProcess: false
) { retryPaste() }
```

#### `PermissionKind`

Every privacy grant that GenesisTools and Genesis ask macOS for. An enum with a string raw value (`CaseIterable`, `Identifiable`, `Sendable`, `Codable`). The raw value is the id that the denial simulation, `GenesisTools --permission-status` and `--permission-dialog` use.

Cases, with the raw value where it differs from the case name:

- `inputMonitoring` (`"input-monitoring"`), `accessibility`, `microphone`, `speechRecognition` (`"speech"`), `screenRecording` (`"screen-recording"`).
- `calendars` (`"calendar"`), `reminders`, `contacts`, `fullDiskAccess` (`"full-disk-access"`), `automation`.
- `desktopFolder` (`"desktop"`), `documentsFolder` (`"documents"`), `downloadsFolder` (`"downloads"`), `localNetwork` (`"local-network"`).

Members:

- `init?(id: String)`: reads the id or a short name someone types. It accepts `input`, `listen`, `listen-event`, `keyboard`, `ax`, `mic`, `speech-recognition`, `dictation`, `screen`, `screen-capture`, `capture`, `calendars`, `fda`, `full-disk`, `all-files`, `lan`, `network` and `local`. Returns `nil` for anything else.
- `var id: String`: the raw value.
- `var title: String`: the name System Settings shows, such as "Input Monitoring".
- `var reason: String`: one sentence on what the grant lets the app do. A feature passes its own reason when it has a sharper one.
- `var settingsAnchor: String`: the Privacy & Security anchor of the grant's list, such as `Privacy_ListenEvent`.
- `var settingsURL: URL`: the exact System Settings pane.
- `static func settingsURL(anchor: String) -> URL`: the pane URL for an anchor. `"Privacy"` opens Privacy & Security itself.
- `var symbol: String`: an SF Symbol name for the grant.
- `var requestStyle: PermissionRequestStyle`: how macOS lets an app ask. The cases are `systemPrompt` (macOS shows its own prompt while the grant is undetermined: microphone, speech recognition, calendars, reminders, contacts, local network), `promptThenSettings` (a request lists the app in System Settings, the switch is there: accessibility, screen recording, input monitoring), `settingsOnly` (no request exists: full disk access) and `probe` (touching the resource once makes macOS ask: automation and the three folders).
- `var cachedPerProcess: Bool`: true for Input Monitoring and Screen Recording. macOS answers these from a per-process cache, so a grant given while the process runs is seen only by a new one.
- `var folderPath: String?`: the folder a probe lists, for the three folder kinds. `nil` for the others.
- `func systemPromptAsks(from status: PermissionStatus) -> Bool`: whether macOS still shows its own prompt for this kind from `status`. That is an undetermined grant, or an Add Only Calendars or Reminders grant.

```swift
if let kind = PermissionKind(id: "mic") {
    print(kind.title, kind.rawValue, kind.requestStyle)
}
NSWorkspace.shared.open(PermissionKind.screenRecording.settingsURL)
```

#### `PermissionStatus`

What macOS reports for a grant. An enum (`Equatable`, `Sendable`).

- `granted`: the grant is on.
- `denied`: the grant is off.
- `notDetermined`: macOS has not asked yet.
- `restricted`: an administrator or profile blocks the grant.
- `partial(String)`: a grant that exists but is not enough. The text names it.
- `unknown(String)`: there is no status API. The text says how to find out. Probe kinds report `unknown("asks on first use")` until a probe is answered.
- `static let needsRelaunch`: `partial("granted, relaunch to use")`. Input Monitoring is on in System Settings, but this process still reads its old answer.
- `static let addOnly`: `partial("Add Only")`. EventKit's write-only grant, which lets events be added but not read.
- `var isGranted: Bool`: true only for `granted`.
- `var label: String`: a short text: "granted", "denied", "not asked yet", "restricted", or the text of `partial` or `unknown`.
- `var wireValue: String`: one line for the stdout of `GenesisTools --permission-status`, such as `granted` or `partial:Add Only`.
- `init?(wireValue: String)`: reads that line back. Returns `nil` for an unknown value.

```swift
if PermissionCenter.shared.status(.inputMonitoring) == .needsRelaunch {
    showRelaunchHint()
}
```

#### `PermissionAccess`

What every feature reads and requests grants through: the system, with the denial simulation applied on top. A simulated kind never reaches macOS. A struct (`Sendable`).

- `static let live`: the real system (`SystemPermissions`) with the simulation from this app's defaults (`PermissionSimulation.current()`).
- `init(system: any PermissionSystem, simulation: @escaping @Sendable () -> PermissionSimulation = { PermissionSimulation() })`: builds an access over any system. Tests pass a fake.
- `let system: any PermissionSystem`: the system underneath.
- `func status(_ kind: PermissionKind) -> PermissionStatus`: the simulated status when the kind is simulated. Otherwise the system status, or the last probe answer for a probe kind that reads `unknown`.
- `func isGranted(_ kind: PermissionKind) -> Bool`: whether the status is granted.
- `func simulatedMode(_ kind: PermissionKind) -> PermissionSimulation.Mode?`: the simulated mode, or `nil` when the kind reads the real grant.
- `func simulatedFreshStatus(_ kind: PermissionKind) -> PermissionStatus?`: what a new process would read under the simulation. `nil` when the kind is not simulated.
- `func request(_ kind: PermissionKind) async -> PermissionStatus`: asks macOS in place where it allows it. For a simulated `:ask` kind it lifts the simulation for this process, as if the prompt was answered. A lift holds only until the simulation changes.
- `func recheck(_ kind: PermissionKind) async -> PermissionStatus`: reads a probe kind again for a dialog that waits on System Settings. It starts no probe for a kind that has had no answer yet.
- `func recheckGrantedProbes() async`: probes again every probe kind whose last answer was a grant.
- `@MainActor @discardableResult func openSettings(_ kind: PermissionKind) -> Bool`: opens the kind's System Settings pane.

```swift
let access = PermissionAccess.live
if !access.isGranted(.microphone) {
    let result = await access.request(.microphone)
    print(result.label)
}
```

#### `PermissionSimulation`

Makes chosen kinds report what a Mac without the grant would, so the real app shows every permission dialog without touching macOS privacy settings. The defaults key `GenesisToolsSimulateDeniedPermissions` holds comma-separated kind ids (`bun scripts/native/staging.ts deny <ids>` writes it, `allow` removes it). A struct (`Equatable`, `Sendable`).

An entry is a kind id, optionally with a mode: `input-monitoring` (denied), `microphone:ask` (not asked yet), `input-monitoring:stale` (denied here, granted for a new process). `all` and `all:ask` apply to every kind. Entries that name no kind or mode are collected in `ignored`.

`Mode` cases:

- `denied`: the dialog explains the grant and opens System Settings.
- `ask`: the status is not determined. The dialog offers Continue, which lifts the simulation for this process in place of a macOS prompt.
- `stale`: denied in this process, granted for a new one. The dialog offers Relaunch.

Members:

- `init(modes: [PermissionKind: Mode] = [:], ignored: [String] = [])`: builds a simulation.
- `static let defaultsKey = "GenesisToolsSimulateDeniedPermissions"`: the defaults key.
- `private(set) var modes: [PermissionKind: Mode]`: the mode per simulated kind.
- `private(set) var ignored: [String]`: the entries that named no kind.
- `var isEmpty: Bool`: true when no kind is simulated.
- `static func parse(_ text: String?) -> PermissionSimulation`: reads the text. Entries are separated by commas, spaces or new lines.
- `static func current(defaults: UserDefaults = .standard) -> PermissionSimulation`: reads the defaults key.
- `func mode(for kind: PermissionKind) -> Mode?`: the mode of one kind.
- `func status(for kind: PermissionKind) -> PermissionStatus?`: the status this process reports for a simulated kind.
- `func freshStatus(for kind: PermissionKind) -> PermissionStatus?`: the status a new process would report. Only `stale` differs from `status(for:)`.
- `var serialized: String`: the defaults value that parses back to this simulation, kinds in declaration order.

```swift
let simulation = PermissionSimulation.parse("input-monitoring, microphone:ask, screen:stale")
simulation.status(for: .microphone)           // .notDetermined
simulation.freshStatus(for: .screenRecording) // .granted
```

#### `PermissionDialogModel`

One open dialog: the kind, why it is needed, what macOS reports, and the actions. An observable object (`@MainActor`). A host does not create it. The center creates it and hands it to the presenter, and `PermissionDialogView` draws it.

`Phase` cases:

- `asking`: the grant is missing. The primary action asks macOS or opens System Settings.
- `working`: a macOS request is open.
- `waiting`: System Settings is open. The dialog reads the grant until it arrives.
- `expired`: the dialog stopped reading after the center's `pollDeadline`. "Check again" reads it and waits again.
- `relaunch`: System Settings shows the grant, but this process reads it only at launch.
- `granted`: the grant arrived. The dialog closes itself.

`Action` cases: `allow`, `openSettings`, `relaunch`.

Properties:

- `let kind: PermissionKind`: the grant.
- `let appName: String`: the app's display name.
- `@Published private(set) var reason: String`: why the feature needs it.
- `@Published private(set) var status: PermissionStatus`: the last status read.
- `@Published private(set) var phase: Phase`: where the dialog is.
- `@Published private(set) var note: String?`: feedback for the last action, `nil` when there is none.
- `@Published private(set) var checking: Bool`: true while a read is running.
- `var id: PermissionKind`: the kind.
- `var title: String`: "Allow <title>", or "<title> is on" once granted.
- `var primaryAction: Action`: what the main button does now.
- `var primaryTitle: String`: "Continue", "Open System Settings" or "Relaunch <app>".
- `var instructions: String`: what to do, in one or two sentences.
- `var offersCheckAgain: Bool`: whether "Check again" makes sense.

Methods:

- `func primary()`: runs `primaryAction`.
- `func allow()`: asks macOS in place.
- `func openSettings()`: opens the pane. For a kind with the `promptThenSettings` style, it asks first, so the app is listed in System Settings.
- `func checkAgain()`: reads the grant again.
- `func relaunch()`: relaunches the app, or sets a note when it cannot.
- `func dismiss()`: closes the dialog the way "Not now" does.

```swift
if let dialog = PermissionCenter.shared.dialogs[.microphone] {
    PermissionDialogView(model: dialog)
}
```

#### `PermissionDialogView`

The content of the dialog, laid out like a macOS alert. The app icon carries the grant's symbol on its corner. Next to it are the title, the reason and the instructions, then a status line (a note, or a spinner while it waits). The buttons sit on the trailing edge: "Not now", "Check again" (when offered) and the primary button, which is the default. The view is 420 pt wide. Accessibility identifiers: `permission-dialog-<kind id>`, `permission-not-now`, `permission-check-again`, `permission-primary`, `permission-note`.

- `model: PermissionDialogModel`: the dialog to draw.

```swift
@State private var dialog: PermissionDialogModel?

var body: some View {
    content.sheet(item: $dialog) { PermissionDialogView(model: $0) }
}
```

#### `PermissionPanelPresenter`

The real presenter: one small floating panel per dialog. It never blocks the app (no modal session). It stays above the widget panels, follows the user to the active Space, and takes keyboard focus only for a user's own action. A panel opens centered in the upper third of the screen under the pointer, and each further open dialog sits a little lower. ⌘W closes a dialog the way "Not now" does.

- `init()`: takes no parameters.
- `func present(_ dialog: PermissionDialogModel, takesFocus: Bool)`: opens the panel.
- `func bringToFront(_ dialog: PermissionDialogModel, takesFocus: Bool)`: orders the panel front. `takesFocus` makes it the key window.
- `func close(_ dialog: PermissionDialogModel)`: removes the panel.

```swift
let presenter = PermissionPanelPresenter()
let center = PermissionCenter(presenter: presenter)
center.onAllDialogsClosed = { NSApp.terminate(nil) }
```

#### `PermissionPresenting`

The protocol that puts a dialog on screen. `PermissionPanelPresenter` is the real one. A host implements it to show the dialog its own way. A class-bound protocol, `@MainActor`. It has no default implementations.

- `func present(_ dialog: PermissionDialogModel, takesFocus: Bool)`: shows the dialog.
- `func bringToFront(_ dialog: PermissionDialogModel, takesFocus: Bool)`: a need joined an open dialog. A user's request makes it key, and an automatic one only orders it front.
- `func close(_ dialog: PermissionDialogModel)`: removes the dialog.

```swift
@MainActor
final class SheetPresenter: PermissionPresenting {
    func present(_ dialog: PermissionDialogModel, takesFocus: Bool) { show(PermissionDialogView(model: dialog)) }
    func bringToFront(_ dialog: PermissionDialogModel, takesFocus: Bool) {}
    func close(_ dialog: PermissionDialogModel) { hide(dialog.kind) }
}
```

#### `RecordingPermissionPresenter`

A presenter that shows nothing and remembers what it was asked. A test process gets this one as the shared presenter. `@MainActor`.

- `init()`: takes no parameters.
- `private(set) var presented: [PermissionKind]`: kinds shown.
- `private(set) var fronted: [PermissionKind]`: kinds brought forward.
- `private(set) var focused: [PermissionKind]`: kinds shown or brought forward with keyboard focus.
- `private(set) var closed: [PermissionKind]`: kinds closed.

```swift
let presenter = RecordingPermissionPresenter()
let center = PermissionCenter(access: PermissionAccess(system: FakeSystem()), presenter: presenter)
center.require(PermissionNeed(.microphone))
// presenter.presented is [.microphone]
```

#### `PermissionSystem`

Where grants are read and requested. `SystemPermissions` talks to macOS. A test passes a fake. A `Sendable` protocol with no default implementations.

- `func status(_ kind: PermissionKind) -> PermissionStatus`: reads the grant. It never prompts.
- `func request(_ kind: PermissionKind) async -> PermissionStatus`: asks macOS in place where it allows it (see `PermissionRequestStyle`), then reads the grant again.
- `@MainActor func openSettings(_ kind: PermissionKind) -> Bool`: opens the kind's pane in System Settings. Returns whether it opened.

```swift
struct FakeSystem: PermissionSystem {
    func status(_ kind: PermissionKind) -> PermissionStatus { .denied }
    func request(_ kind: PermissionKind) async -> PermissionStatus { .denied }
    @MainActor func openSettings(_ kind: PermissionKind) -> Bool { false }
}
```

#### `SystemPermissions`

The real reads and requests against macOS (TCC). Requests run from this process, so the prompt names this app. A prompt that waits for the user ends after 180 s, and the request then reads the grant as it is.

- `init()`: takes no parameters.
- `func status(_ kind: PermissionKind) -> PermissionStatus`: reads the grant without a prompt. Input Monitoring reports `needsRelaunch` when the system says granted but this process still reads the old answer. Accessibility reports `notDetermined` when not trusted, since macOS has no "denied" there. Full Disk Access is read by opening the user's TCC database. Automation and the folder kinds report `unknown("asks on first use")`. Local Network is read from the rule store through `LocalNetworkPrivacy`.
- `func request(_ kind: PermissionKind) async -> PermissionStatus`: asks in place. Automation runs an AppleScript against System Events. A folder kind lists the folder. Local Network makes one connection to the gateway of the local network. Full Disk Access has no request.
- `@MainActor func openSettings(_ kind: PermissionKind) -> Bool`: opens `kind.settingsURL`.

```swift
let access = PermissionAccess(system: SystemPermissions())
let result = await access.request(.calendars)
print(result.label)
```

#### `LocalNetworkPrivacy`

Reads the Local Network answer. macOS asks the first time an app reaches a device on the local network and keeps the answer in a rule store. No API reads that answer, so this enum reads the store itself (`/Library/Preferences/com.apple.networkextension.plist`, readable by every user). An executable outside the installed bundle gets a rule of its own, keyed by its path.

- `static let ruleStorePath`: the path of the rule store.
- `LocalNetworkPrivacy.Rule`: one answer macOS keeps. Fields: `signingIdentifier: String`, `path: String?` (the executable the answer is for, `nil` for the installed app's own answer), `allowed: Bool`. It has a public init with those three parameters.
- `static func answeredRules(for signingIdentifier: String, in data: Data) -> [Rule]?`: the answered rules for an identifier in rule store data. `nil` when the data is not a keyed archive.
- `static func status(of rules: [Rule], path: String? = nil) -> PermissionStatus`: the answer for `path` (`nil` is the installed app). No matching rule means `notDetermined`.
- `static func status(for signingIdentifier: String) -> PermissionStatus`: the installed app's answer from the store as it is now. Reports `unknown("rule store unreadable")` when the store cannot be read.
- `static func rules(for signingIdentifier: String) -> [Rule]?`: every answered rule for an identifier. `nil` when the store cannot be read.

```swift
let id = "com.example.myapp"
let status = LocalNetworkPrivacy.status(for: id)
let rules = LocalNetworkPrivacy.rules(for: id) ?? []
let strayPaths = rules.compactMap(\.path)
```

#### `PermissionDialogLock`

One dialog per grant across the processes of one app. A process holds `<kind>.lock` while its dialog is open. A second process asks the first to come forward and does not open another dialog. Pass it to `PermissionCenter(lock:)`.

- `init(directory: URL, namespace: String)`: the folder that holds the lock files, and the namespace of the distributed notifications (use the bundle id).
- `static func forThisApp() -> PermissionDialogLock?`: the lock in `~/Library/Application Support/<bundle id>/permission-dialogs`. `nil` without a bundle id.

```swift
let lock = PermissionDialogLock(
    directory: supportURL.appendingPathComponent("permission-dialogs"),
    namespace: "com.example.myapp"
)
let center = PermissionCenter(presenter: PermissionPanelPresenter(), lock: lock)
```

#### `PermissionRelaunch`

Starts the app again with the same arguments once this process has exited, then quits. The app holds a single-instance lock until it exits, so the new process waits for the old pid (at most 15 s) before it starts. `PermissionCenter.shared` uses it for the Relaunch action.

- `@MainActor static func relaunchCurrentProcess() -> Bool`: returns `false` when it cannot start the new process. On success it terminates the app.

```swift
let center = PermissionCenter(
    presenter: PermissionPanelPresenter(),
    relaunch: { PermissionRelaunch.relaunchCurrentProcess() }
)
```

### Pose

Pose turns camera frames or AirPods motion into `PoseSample` values and draws them. `VisionBodyPoseEngine` (the default) and `VisionFaceEngine` read frames through Apple Vision, with no model download; `HeadphoneMotionEngine` pushes AirPods head pitch. `PoseSkeletonOverlay` draws a sample over `CameraPreviewView`, and `PoseSkeletonLiveOverlay` does it from a `PoseSampleFeed`, the only object a live sample reaches on the main thread.

Measured on synthetic 640x480 frames on this Mac (`VisionPoseBenchTests`, `POSTURE_BENCH=1`, four fresh processes, 60 calls each, load average 10 to 17): body pose 4.4 ms wall and 0.7 ms of process CPU per call, face rectangles 3.4 ms wall and 1.9 ms CPU, both together 8.9 ms wall and 3.3 ms CPU. The body request runs mostly off the CPU, so the face request is not cheaper in CPU; the energy saver is the Battery saver interval policy, not the face engine. The frames held no real person, so a real face may cost more in the later pose stage.

#### `PoseSample`

One reading of the user's pose. A `Codable`, `Equatable`, `Sendable` struct with a public init.

- `time: TimeInterval`: uptime seconds (`ProcessInfo.systemUptime`), so durations survive a clock change.
- `engine: PoseEngineKind`: `.visionBody`, `.visionFace` or `.headphones`.
- `joints: [PoseJoint: PoseJointPoint] = [:]`: nose, both eyes, both ears, neck and both shoulders, each with `x`, `y` and `confidence`. Coordinates run 0...1 from the top left of the image as the sensor delivers it, not mirrored. Vision names the subject's own left and right.
- `face: PoseFace? = nil`: the face `box` in the same space, `confidence`, and `roll`, `yaw`, `pitch` in radians (pitch positive nodding down).
- `headphonePitch: Double? = nil`: AirPods pitch in radians, positive nodding down.
- `imageAspect: Double = 4/3`: what the overlay needs to match an aspect-fill preview.
- `lowLight: Bool = false`: too dark to judge.
- `shoulderSource: PoseShoulderSource? = nil`: the request behind the shoulders and the neck, `.body2D` or `.body3D`. Nil without shoulders.
- `shoulderAge: TimeInterval? = nil`: seconds since that request ran, 0 on the frame it ran (`hasFreshShoulders`). A throttled 3D reading is reused for several seconds.

Members: `joint(_:) -> PoseJointPoint?` returns a joint above `minimumConfidence` (0.3, Dorso's and Apple's gate); `hasPerson` is true for a confident nose, a face, both shoulders or AirPods motion. The shoulders count so that a head bent out of the frame reads as a slouch, not as away.

#### `PoseEngine` and `FramePoseEngine`

`PoseEngine` is any source of samples: `kind` and `usesCamera`. `FramePoseEngine` adds `analyze(_ frame: CameraFrame) -> PoseSample?`, called from one serial queue (the camera's delivery queue); the engine keeps its Vision request between calls and makes a fresh request handler per frame. Nil means Vision failed; a sample without a person means nobody is there.

#### `VisionBodyPoseEngine`

Vision 2D body pose (`VNDetectHumanBodyPoseRequest`, `preferBackgroundProcessing`). It keeps the nearest person: the widest confident shoulders, else the most confident nose.

- `faceDetection: FaceDetection = .fallback`: `.fallback` runs face rectangles on the same frame when the body has no confident nose or misses a shoulder (a seated upper body sometimes yields no body, which is why Dorso has the same fallback); `.always` runs both on every frame (use it while calibrating, so the baseline also holds the face measures); `.never`. Change it only from the queue that calls `analyze`.
- `body3D: Body3D = .throttled`, `body3DInterval: TimeInterval = 4`: the shoulders and the neck come from `VNDetectHumanBodyPose3DRequest` instead of the 2D request, which often finds no body for a person close to a laptop camera (real frames, 2026-10-14). The two place the shoulders differently (3D about a third narrower), so a reading never mixes them. 3D costs about 80 ms of CPU a frame against 7 ms for 2D plus face: `.throttled` runs it at most once per interval and keeps its shoulders for two intervals; `.always` runs it on every frame (calibration); `.never` keeps the 2D shoulders. Each sample says which request placed its shoulders and how old they are (`shoulderSource`, `shoulderAge`). `readShouldersOnNextFrame()` makes the next `analyze` run the 3D request even when it is not due.

#### `VisionFaceEngine`

Vision face rectangles alone (`VNDetectFaceRectanglesRequest` revision 3): the face box, roll, yaw and pitch. No shoulders, so it measures head drop, forward head (face width), sideways tilt and head pitch. It still works when a chair back or a monitor hides the shoulders.

#### `HeadphoneMotionEngine`

AirPods head pitch as samples, with no camera (`CMHeadphoneMotionManager`, macOS 14). A `final class`.

- Updates arrive at about 25 Hz; it forwards at most one sample per `sampleInterval` and does nothing else per update.
- Taking a bud out sends a disconnect and putting it back a connect (Automatic Ear Detection). `isConnected` and `onConnectionChange` (main queue) report it, and `stop(keepConnectionMonitor: true)` keeps that monitor alive while motion stops.
- macOS ends a process that starts motion updates without `NSMotionUsageDescription`, and creating the manager already sends a privacy request, so the manager is made only on first use and only with the key. `start()` returns false without it, after a refusal, or with no supported headset paired. The first start shows the motion prompt. `isAvailable` reads the manager only once the grant is given (or after a start), so it never raises the prompt by itself.
- `stop()` without `keepConnectionMonitor` also forgets the buds: `isConnected` turns false, since nothing reports them any more.

Initializer: `sampleInterval: TimeInterval = 0.5`, `queue: DispatchQueue? = nil` (where samples arrive).

Members: `onSample: (@Sendable (PoseSample) -> Void)?`, `onConnectionChange: ((Bool) -> Void)?`, `isConnected`, `latestPitch`, `isAvailable`, `start() -> Bool`, `startConnectionMonitor() -> Bool` (the in-ear monitor without motion updates), `stop(keepConnectionMonitor: Bool = false)`, and the statics `authorization: HeadphoneMotionAuthorization`, `hasUsageDescription`, `settingsURL` (Privacy & Security, Motion & Fitness).

```swift
let airPods = HeadphoneMotionEngine()
monitor.setSource(.auto, headphones: airPods)   // AirPods while a bud is in, the camera otherwise
```

#### `PoseSkeletonOverlay`

The detected pose drawn over a camera preview: joints as small rings (3.5 pt, a centre dot), the shoulder line and the neck up to the nose as 1.5 pt lines, each over a faint dark halo so it reads on a bright wall without a shadow. A face-only sample draws its face box. With a `target` it draws that pose as a dashed ghost in `targetTint` and an arrow from every joint that moved further than `arrowThreshold` from it (SlouchSniper's "overlay target"). One `Canvas` pass, no animation of its own, no hit testing, hidden from accessibility (the status line says the same). It is `Equatable`, so a parent update with the same inputs does not repaint it.

- `sample: PoseSample?`
- `target: PoseSample? = nil`
- `mirrored: Bool = true`: match `CameraPreviewView`.
- `tint: Color = .white`, `targetTint: Color = .mint`
- `arrowThreshold: Double = 0.03`: a fraction of the view's shorter side.

`PoseOverlayGeometry(size:imageAspect:mirrored:)` is the pure aspect-fill mapping it uses: `imageRect`, `point(_:_:)`, `rect(_:)`.

```swift
PoseSkeletonOverlay(sample: snapshot, target: slot.referencePose, mirrored: true)
    .equatable()
```

#### `PoseSkeletonLiveOverlay`

`PoseSkeletonOverlay` fed by a `PoseSampleFeed`. It is the only view that observes the feed, so a new sample re-renders this leaf and nothing else in the window, and it tells the feed it is watched while it is on screen.

- `feed: PoseSampleFeed` (usually `monitor.feed`)
- `target: PoseOverlayTarget = .none`: `.none`, `.lastGood` (the last upright, clear sample) or `.pose(PoseSample)` (the calibration's reference pose).
- `mirrored: Bool = true`, `tint: Color = .white`, `targetTint: Color = .mint`

#### `PoseSampleFeed`

The live sample for a preview, apart from the monitor's state. A `@MainActor` `ObservableObject` with `sample`, `lastGood` and `score` (the sample's `PostureScore`: each fault's drift and thresholds, for a debug metrics view). The monitor publishes into it only while it is watched, so a hidden window costs no main-thread hop per frame. `beginWatching()` and `endWatching()` count the views that show it (the live overlay calls them); `isWatched` reads or overrides the count; `setLastGood(_:)` sets the target by hand.

### Posture

Posture is the logic of a webcam posture coach (PostureWatcher in Genesis), kept pure wherever it can be. `PostureMetrics` reads scale-free measures from a pose sample, `PostureScorer` scores them against a `PostureBaseline` with a dead zone and a sensitivity, and `PostureStateMachine` turns readings into monitoring, slouching, recovery and away with an onset delay, hysteresis and a reset-streak time. `PostureHealth` is the health bar. `PostureCalibrationBook` keeps named calibration slots, picked by the connected displays. `PostureHistoryStore` keeps per-minute history. `ActivityGate` says when to pause, by events only. `PostureMonitor` runs it all off the main thread and drives a `CameraFrameSource`.

A frontal webcam cannot measure the clinical craniovertebral angle (that needs a side view), so every metric is a proxy that only means something against the user's own baseline. Defaults come from Dorso's source (tldev/dorso at 80a41c22) and the PostureApps and PoseEngines research notes in the vault (`GenesisTools.native/Posture/`); each default below names where it comes from.

#### `PostureMetrics`

The measures read from one sample, as `[PostureMeasure: Double]` with a subscript. `init(sample:)` reads every measure the sample supports. Horizontal distances are first scaled by `imageAspect`, so lengths are in image heights and angles are true angles; body measures are then divided by the shoulder width, so the distance to the camera cancels out. `median(_:)` takes the per-measure median of several readings and drops a measure present in fewer than half of them.

Measures (`PostureMeasure`) and the fault (`PostureMetricKind`) each stands in for:

- `headHeight` (shoulder midpoint y − nose y, over shoulder width), `faceCenterY`: `.headDrop`.
- `eyeSpanRatio` (eye span over shoulder width), `faceWidthRatio` (face box width over shoulder width, when the shoulders come from 3D and the eyes are missing), `faceWidth`: `.forwardHead`.
- `shoulderWidth`: `.leanIn`.
- `shoulderTilt` (radians): `.shoulderTilt`.
- `lateralOffset`, `faceRoll`, `faceCenterX`: `.lateralLean`.
- `headphonePitch`, `facePitch`: `.headPitch`.

A fault reads its first available measure in that order, so body joints win over the face box.

#### `PostureBaseline`

The calibrated upright posture: the upright `metrics` (median), the `tolerance` each measure may always drift (noise, looking around the screen: the spread of the upright readings, never below the measure's minimum), and the `span`, the drift that counts as one whole slouch (from the slouch sample when there was one). `Codable`.

- `static calibrate(upright: [PostureMetrics], slouch: [PostureMetrics] = [], shoulderSource: PoseShoulderSource? = nil) -> PostureBaseline?`: nil with fewer than `minimumUprightReadings` (4, Dorso) usable readings. `PostureCalibrationSession.baseline()` passes the source most of its upright samples had.
- `shoulderSource: PoseShoulderSource?`: the request that placed the shoulders while calibrating; nil in a file saved before 2026-10-20. `shoulderSourceDiffers(from:)` is true when the baseline has shoulder measures (`PostureMeasure.usesShoulders`) and its source is not the live one or is unknown: the 2D and 3D requests place the shoulders differently, so such a baseline cannot judge live shoulders.

Defaults without a slouch sample: span 0.15 and minimum tolerance 0.05 for `faceWidth` and `eyeSpanRatio` (Dorso's forward-head numbers), span 0.3 rad and tolerance 0.15 rad for pitch (Dorso's AirPods numbers); the other measures use proposals in the same units (head height span 0.2 shoulder widths, shoulder tilt 0.17 rad).

#### `PostureScorer`

Scores a reading against a baseline. Pure.

- `deadZone: PostureDeadZone = .medium`: Strict 0, Tight 0.08, Medium 0.15, Relaxed 0.25, Loose 0.40 of the calibrated range (Dorso `SettingsWindow.swift:61`; the middle default because the tight end drew unwanted-alert reports, Dorso #55 and #84).
- `sensitivity: PostureSensitivity = .medium`: the effect curve `strength = severity ^ (1 / exponent)` with Gentle 0.08, Easy 0.15, Medium 0.35, Firm 0.65, Aggressive 1.2 (Dorso's "Intensity", `PostureEngine.swift:226`). It changes how hard the effect hits, not what counts as a slouch.
- `enabled: Set<PostureMetricKind> = all`.

Per fault: bad above `tolerance + deadZone × span`, clear again below `0.85 × tolerance + 0.7 × deadZone × span` (Dorso exits at 0.7 of its threshold), severity `(drift − enter) / (span × (1 − deadZone))` clamped to 0...1. The reading takes the worst fault (Dorso takes the max). Shoulders in view with no nose and no face, against a baseline with a head height, score as a full head drop (severity 1): the head went below the frame.

`score(_:against:shoulderSource:) -> PostureScore` gives `signals` (one `PostureSignal` per fault, with drift, thresholds and severity), `severity`, `strength`, `isBad`, `isClear` and `worst`, the fault to name in the UI ("Head drop"), so the score is never opaque. When the baseline's shoulder source differs from `shoulderSource` (the live one; nil skips the check), every measure that needs the shoulders is left out, the faults only they measure go to `unjudged`, and `shoulderSourceMismatch` is true: the UI asks for a new calibration.

The monitor lets a shoulder fault from the throttled 3D request turn bad only when two fresh 3D readings in a row are bad, each scored without the smoother. Until the second one agrees, the signal is `held` (neither bad nor clear, severity 0, listed in `PostureScore.held`) and the engine reads the shoulders again on the next frame. A fresh reading that is no longer bad lets the fault go at once. Without this, one wrong 3D reading held a tilt for 6.8 s (debug recording 2026-10-19).

`PostureSmoother(window: 1, maxCount: 5)` takes the median of the readings of the last second; Dorso averages 5 readings, and a time window keeps the lag the same at 2 and 10 fps.

```swift
let scorer = PostureScorer(deadZone: .relaxed, sensitivity: .firm)
let score = scorer.score(PostureMetrics(sample: sample), against: baseline)
if score.isBad { statusLine = score.worst?.title ?? "Slouching" }
```

#### `PostureStateMachine`

The decisions as a value: control inputs and readings in, a `PostureState` and `PostureEvent`s out. Time is passed in (uptime seconds), so tests run without waiting.

States, in the order they win: `.disabled`, `.needsCalibration`, `.paused(PosturePause)` (reasons and an optional end), `.cameraUnavailable(PostureCameraIssue)`, then `.away`, `.monitoring`, `.slouching`, `.recovery`. `isWatching` and `isPosturePhase` group them; `title` is a short label.

`PostureTiming`, all in seconds so the behaviour is the same at every frame rate (Dorso issue #14):

- `confirmBad = 2` and `confirmGood = 0.5`: Dorso's 8 readings at 4 fps and 5 at 10 fps.
- `onsetDelay = 15`, range 0 to 60: the wait after confirmation before the slouch state and the effect. Dorso defaults to 0 and drew "looking down is a slouch" reports (#84); HeadsUp waits 15 s.
- `resetStreak = 10`, range 5 to 60: upright time in recovery before the episode ends (a proposal; no app documents a number).
- `awayAfter = 4`: no person for this long is away (Dorso's 15 readings are 3.75 s at 4 fps). Dark frames never count.
- `resumeGrace = 5`: after a resume, an unlock or a return from away, the first slouch waits this much longer (Dorso #35).

Methods: `setControl(enabled:hasBaseline:userPause:gateReasons:cameraIssue:usesCamera:at:)` returns the state change, and coming back to a posture phase starts afresh; `observe(_ reading: PostureReading, at:) -> Step` returns the events and the time to credit to health and history. `isConfirming` is true while a bad reading waits out the delay. A slouch that returns during recovery comes back without a new `slouchStarted`, so there is one alert per episode.

`static captureMode(state:confirming:policy:rates:) -> CameraCaptureMode` picks the camera mode. `PostureFrameRatePolicy`: `.batterySaver` (bursts of 3 frames every 30 s, 4 fps to confirm a bad burst; steal list and PoseEngines research), `.balanced` (2 fps upright, 10 fps while a slouch is pending, on or recovering, 1 fps away; Dorso's 2 and 4 fps cost about the same, so 1 fps upright gains little), `.responsive` (10 fps). Off whenever nothing is watched, so the light goes dark while paused. The rates are `PostureCaptureRates`.

#### `PostureHealth`

The health bar, 0...1. It drains 1% a second while slouching and refills 3% a second while upright (100 s to empty, about 33 s back to full: Dorso's 3-to-1 ramp asymmetry at a slower scale; no source gives SlouchSniper's numbers). A pending slouch, away and paused freeze it. It keeps `uprightStreak`, `bestUprightStreak` and `slouchStreak`; `percent` is the whole-percent value a bar shows.

#### `PostureCalibrationBook`

Named calibration slots and the active one. `Codable`; a file from an older version still loads.

- `static standard`: Home, Office and Cafe (ids `home`, `office`, `cafe`), none calibrated, Home active.
- `PostureCalibrationSlot`: `id`, `name`, `kind` (`PostureSlotKind`), `baseline`, `referencePose` (the overlay's ghost), `cameraID`, `displaySet` (sorted display UUIDs), `calibratedAt`.
- `store(_:referencePose:cameraID:displaySet:at:in:)`, `addCustom(name:)`, `remove(id:)`, `clear(id:)`.
- `slot(matching:)` and `autoSelect(displaySet:) -> Bool`: the calibrated slot of the connected displays, an exact match first, else the one sharing the most displays (Dorso keys calibrations by display set). `autoSelectByDisplays` turns it off.

`PostureDisplays.currentSet()` gives the sorted UUIDs of the active displays. `PostureCalibrationSession` collects samples during a guided calibration (`add(_:as: .upright | .slouch)`, skipping empty and dark ones) and returns `baseline()` and `referencePose`.

`PostureCalibrationStore(directory:fileName:)` saves a book as JSON off the main thread (`load() async -> LoadResult`, `save(_:completion:)`). A file it cannot read is never overwritten: `load` reports `.unreadable` and `save` refuses until `discardUnreadable()`. `save` also refuses until the first `load()`, so a save that races the start-up load cannot replace slots nobody read. Only a missing file is `.missing`; any other read error (permissions, a folder in its place) is `.unreadable`.

```swift
var book = PostureCalibrationBook.standard
book.autoSelect(displaySet: PostureDisplays.currentSet())
monitor.setBaseline(book.activeSlot?.baseline)
```

#### `PostureHistoryStore`

Per-minute history in a folder the host names: one append-only JSON-lines file per local day, about 70 bytes a row. Files older than `retentionDays` (60) are pruned once a day and a day file stops growing at `maxBytesPerDay` (512 KB), so the folder stays bounded. A line it cannot read is skipped and the file is never rewritten. Every read and write runs on its own utility queue.

- `append(_ rows: [PostureMinute])`; `minutes(on:) async`, `summary(for:) async -> PostureDaySummary`, `lastDays(_:endingAt:) async` (oldest first, empty days as zero rows); `flush()`.
- `clear(completion: (@Sendable (Error?) -> Void)? = nil)`: deletes every day file, after the writes queued before it; other files in the folder stay.
- Rows are appended with `O_APPEND` and never rewrite the file; a torn last line gets a newline first, so the next row is still readable.
- `PostureMinute`: `minute`, `upright`, `slouch`, `away` (seconds) and `alerts`. Several rows may name one minute; readers add them up. A pending slouch counts as slouch time.
- `PostureDaySummary`: the day's totals and `uprightFraction`.
- `PostureMinuteAccumulator` folds credited time into rows across minute boundaries.

```swift
let today = await history.summary(for: Date())
let week = await history.lastDays(7, endingAt: Date())
```

#### `ActivityGate`

Says why watching should pause, by events only: NSWorkspace sleep, wake, screen sleep and session changes, the distributed screen lock and screen saver notifications, an IOKit power-source run-loop source, Low Power Mode, the screen list (debounced 0.5 s, Dorso), and key-value observation of the chosen camera's `isInUseByAnotherApplication` (Apple's documented signal; whether it fires for a shared built-in camera is not verified). No polling timer runs. Idle is the one input macOS does not post: one one-shot timer for the moment the threshold would pass, then a global event monitor that waits for the next mouse event (keys reach it only with Accessibility). A `@MainActor` `ObservableObject`.

- `reasons: Set<ActivityPauseReason>`: every reason that applies now (`.systemSleep`, `.screensAsleep`, `.screenLocked`, `.screenSaver`, `.sessionInactive`, `.onBattery`, `.lowPowerMode`, `.laptopOnlyDisplay`, `.cameraInUse`, `.idle`, `.fullScreenApp`; `.user` and `.headphonesRemoved` come from the monitor). Published only on change.
- `watchesFullScreenApps: Bool = false`: reports `.fullScreenApp` while the frontmost app (not this one) has a normal-level window the size of a screen. It checks 0.6 s after the frontmost app or the Space changes (the Space animation), never on a timer. `static frontmostAppIsFullScreen()` and the pure `coversScreen(windows:pid:screens:)` are public.
- `onChange: ((Set<ActivityPauseReason>) -> Void)?`
- `idleThreshold: TimeInterval? = nil`: nil turns the idle check off.
- `start()`, `stop()`, `observeCamera(uniqueID:)`.
- Statics: `isOnBattery()`, `isScreenLocked()`, `activeDisplaysBuiltIn()`, `isLaptopOnly(builtIn:)`.

#### `PostureMonitor`

Runs PostureWatcher. A `@MainActor` `ObservableObject`.

- Readings are scored off the main thread, on the camera's delivery queue or the AirPods queue, under one lock. The main actor hears only changes: `state`, `healthPercent`, `strength` (in 5% steps), `worst`, `cameraState`, `source`, `lastAlert`. The camera mode and the snapshot leave the core while its lock is held, so a reading scored just before a pause cannot turn the camera back on after it. A frame that changes none of them costs the main thread nothing (`PostureMonitorTests.testTheMainActorHearsOnlyChanges` plants the regression).
- The live skeleton goes to `feed` (a `PoseSampleFeed`), only while a view watches it.
- It sets the camera's mode from the state and the policy, so the light goes dark while disabled, paused or not calibrated.
- A timed pause ends on one wall-clock timer; nothing else runs while paused. AirPods motion stops too; their in-ear monitor stays on, so a bud going back in is seen.
- In `.auto`, AirPods drive it only while a bud is in and the baseline has an AirPods pitch; otherwise it keeps the camera.
- Releasing the monitor turns the camera off, stops AirPods motion and cancels a calibration, even without `disable()`.
- History rows go to the store, which writes off the main thread.

Initializer: `configuration: Configuration = Configuration()`, `camera: CameraFrameSource?` (it takes over `onFrame` and `onStateChange`; nil for AirPods only), `engine: FramePoseEngine = VisionBodyPoseEngine()`, `history: PostureHistoryStore? = nil`.

`Configuration`: `scorer`, `timing`, `policy`, `rates`, `pauseReasons` (default: sleep, screen sleep, lock, screen saver, another session, AirPods removed; battery, laptop-only, call and idle are opt-in), `drainPerSecond`, `refillPerSecond`.

Methods: `enable()`, `disable()`, `setBaseline(_:)`, `pause(for:)`, `pause(until:)`, `resume()`, `observe(gate:)`, `setEngine(_:)`, `setSource(_:headphones:)` (`PostureSource`: `.camera`, `.headphones`, `.auto`), `ingest(_:)` (any thread), `resetHealth()`, `flushHistory()` (writes the open minute and waits until it is on disk), `setHistory(_ store: PostureHistoryStore?)` (swap or switch off history; the open minute goes to the old store), and `history: PostureHistoryStore?`. `onEvent` gets each `PostureEvent` on the main actor: state changes, `slouchStarted` (one per episode), `recoveryStarted`, `streakReset`.

`collectCalibrationSamples(count: Int, timeout: TimeInterval) async throws -> [PoseSample]` gathers `count` samples with a person in them (dark frames skipped) from the running pipeline: the camera runs at the active rate meanwhile whatever the state, a Vision body engine adds the face request, and readings are not scored. It throws `PostureCalibrationError`: `.busy` while another collection runs, `.timedOut(collected:)` and `.cameraUnavailable(_:collected:)` with what it gathered, `.cancelled` when the task is cancelled or the monitor goes away. No second camera lease is needed.

`captureShots(count: Int, label: String, into directory: URL)` (any thread) saves the next `count` analyzed camera frames to `<directory>/<label>/<stamp>-<NN>.png`, each with its `PoseSample` as `.json`, for replaying in `PostureShotsTests` (frames in `Tests/PostureShots/<pose>/`, gitignored because they show the user, or in `POSTURE_SHOTS_DIR`). Only frames the monitor analyzes count, so it must be watching or calibrating.

`startDebugRecording(into folder: URL, maxDuration: TimeInterval = 10, completion:)` and `stopDebugRecording()` (any thread) record a bug report: the analyzed camera frames as `<folder>/movie.mp4` (H.264, at capture time) and every reading as `<folder>/log.ndjson`, a `start` line (baseline, scorer) then one `frame` line per frame with `t`, `state`, `sample`, `metrics` and `score` (each signal's deviation, enter and exit thresholds, severity). It ends after `maxDuration` seconds of frames or at the stop call; `completion` gets a `PostureDebugRecording` (folder, movie, log, frames, duration, error) once, off the main thread. Only analyzed frames count, so the monitor must be watching or calibrating.

`holdScoring(_ hold: Bool)` holds scoring while a calibration sheet is open (`isScoringHeld` reads it back): readings still reach `feed` and a collection, but none is judged, so the slouch a calibration asks for never starts an episode or an alert. Holding, releasing and a different `setBaseline` all start the posture afresh (upright, with the resume grace), so a slouch judged against the old baseline does not outlive it.

`PostureScorer.forwardHeadWithoutShoulders` (`PostureForwardHeadFallback?`) decides Forward head when a body-pose reading has no shoulders and only the face width is left, since the face also grows when the user only sits closer: `.needsShoulders` leaves it out and lists it in `PostureScore.unjudged`, `.faceSize` judges the face width with at least `PostureForwardHeadFallback.faceOnlyTolerance` (0.20) tolerated, and nil keeps the calibrated tolerance. The monitor judges Vision face engine readings as nil whatever the setting, because that engine never sees shoulders.

`onAlert: ((PostureAlert) -> Void)?` and `lastAlert` describe each new slouch episode, right after its `slouchStarted`. `PostureAlert` carries the `kind`, the `measure`, the `deviation` from the baseline in its `unit`, `severity`, `strength`, `rangeFraction` (the drift over the calibrated slouch) and every fault's `signals`. A frontal webcam gives no centimetres, so `unit` is honest: `.shoulderWidths` (head drop, sideways lean on the body engine), `.faceWidths` (the face engine), `.radians` (tilt, roll, pitch; `degrees` converts) or `.fraction` (forward head, leaning in; `percent` converts). `approximateCentimeters(shoulderWidthCM: 39, faceWidthCM: 14)` turns the first two into an estimate from typical body sizes, nil for the others; show it as "about".

```swift
let camera = CameraFrameSource()
let monitor = PostureMonitor(camera: camera, history: PostureHistoryStore(directory: historyFolder))
monitor.configuration.policy = .batterySaver
monitor.setBaseline(book.activeSlot?.baseline)
monitor.observe(gate: gate)
monitor.onEvent = { event in if event == .slouchStarted { effects.show() } }
monitor.onAlert = { alert in
    let size = alert.approximateCentimeters().map { ", about \(Int($0.rounded())) cm" } ?? ""
    notify("\(alert.kind.title)\(size)")
}
monitor.enable()

// Calibration from the running pipeline.
let upright = try await monitor.collectCalibrationSamples(count: 12, timeout: 15)
monitor.setBaseline(PostureBaseline.calibrate(upright: upright.map(PostureMetrics.init(sample:))))
```

### Providers

Display names, glyphs and colors for the AI providers the apps show. `AIProviders` is the entry point: it holds the known providers and returns an `AIProviderMeta` for any plugin id. `AIProviderGlyph` draws that metadata as a one-letter tinted box. The values mirror `provider-meta.ts` in the GenesisTools dev-dashboard, so both surfaces name and color a provider the same way.

#### `AIProviders`

The registry of known providers and the lookup for a plugin id. All members are static.

- `anthropicSubscription: String`: the id `"anthropic-sub"`, the only provider the legacy Claude-only cache and the scored ranker can describe.
- `known: [AIProviderMeta]`: three entries in display order. Claude (id `anthropic-sub`, alias `claude`, glyph `C`), Codex (id `openai-sub`, alias `codex`, glyph `X`) and Grok (id `grok-sub`, alias `grok`, glyph `G`).
- `meta(for id: String, displayName: String? = nil, alias: String? = nil) -> AIProviderMeta`: the known entry whose id or alias equals `id`. For an unknown provider it builds an entry from `displayName` (else the id), `alias` (else the id), the uppercased first letter of the name as the glyph, and the secondary color.
- `order(_ id: String) -> Int`: the index of the id in `known`, or `known.count` for an unknown id. Use it to sort provider rows.

```swift
let meta = AIProviders.meta(for: "codex")
let unknown = AIProviders.meta(for: "acme-sub", displayName: "Acme")
let rows = accounts.sorted { AIProviders.order($0.providerId) < AIProviders.order($1.providerId) }
```

#### `AIProviderMeta`

The display vocabulary for one provider. It is `Equatable` and `Sendable`.

- `id: String`: the plugin id, such as `"anthropic-sub"`.
- `alias: String`: the short name, such as `"claude"`.
- `displayName: String`: the name shown to a person.
- `glyph: String`: one character for tight spaces, such as the menu bar title and row leaders.
- `color: Color`: the provider's color.

```swift
let acme = AIProviderMeta(
    id: "acme-sub",
    alias: "acme",
    displayName: "Acme",
    glyph: "A",
    color: .teal
)
AIProviderGlyph(meta: acme, size: 18)
```

#### `AIProviderGlyph`

The provider's one-letter glyph in a box tinted with its color. It leads an account row and marks a session row that is not Claude's. VoiceOver reads the display name.

- `meta: AIProviderMeta`: the provider to draw.
- `size: CGFloat = 16`: the side of the square box; the letter is 62.5 percent of it.

```swift
let meta = AIProviders.meta(for: "grok-sub")
HStack(spacing: 6) {
    AIProviderGlyph(meta: meta, size: 18)
    Text(meta.displayName)
}
```

### Recording

Screen recording for any host. `ScreenRecorder` is the entry point: it shows `RecordingTargetPicker` in a floating panel (a window, an app or a display), checks the Screen Recording grant, runs `tools control capture session` through `RecordingSessionController`, and floats `RecordingControlsView` next to what is recorded: pause or resume, switch what is recorded, restart, the host's "stop and use" action and stop and discard. The host says what "use" means through `ScreenRecordingHost` (the widget pastes the movie into a session's draft as "Stop and paste", the Capture shelf stages it as "Stop and save"). The recorder records in segments and joins them into one H.264 MP4 of at most ten minutes; the controls panel is left out of every movie by its window id, because ScreenCaptureKit ignores `sharingType = .none` on macOS 15 and later. One recording runs at a time in a process. `RecordingSettings` holds the preferences and `RecordingSettingsView` is their settings page.

#### `ScreenRecorder`

The whole flow for one host. It is `@MainActor` and an `ObservableObject`.

- `bridge: ToolsBridge`: runs `tools control capture targets --json` and `tools control capture session`.
- `settings: RecordingSettings? = nil`: the preferences; `RecordingSettings.shared` when nil.
- `permissionGate: ((PermissionNeed) async -> Bool)? = nil`: the Screen Recording check; `PermissionCenter.shared.ensure` when nil.

Properties and methods:

- `isActive: Bool`: true from the picker's first appearance until the recording ended.
- `begin(host: ScreenRecordingHost, anchor: CGPoint? = nil, preferredPid: Int32? = nil)`: opens the picker near `anchor` (a Cocoa screen point, the pointer when nil), starting on the front window of `preferredPid` (else the frontmost app that is not this process), then records the choice. While another recording runs it brings that one's controls forward instead.
- `stopAndUse()`, `discard()`: what the controls' buttons do, for a host control (the widget's video button stops and pastes on a second press).
- `showControls()`: brings the controls forward.

Switching target pauses the recording while the picker is open, so the movie never shows the picker; a cancel resumes.

```swift
let recorder = ScreenRecorder(bridge: bridge)
recorder.begin(host: ScreenRecordingHost(
    useTitle: "Stop and save",
    permissionReason: "Records the window, app or display you choose.",
    onUse: { movie in try await library.add(movie) },
    onError: { message in notice = message }))
```

#### `ScreenRecordingHost`

What a host does with a recording.

- `useTitle: String`: the name of "stop and keep" in the controls, such as "Stop and paste".
- `useSymbol: String = "stop.fill"`: its symbol.
- `permissionReason: String`: why the recording needs Screen Recording, shown in the permission dialog.
- `onUse: (URL) async throws -> Void`: gets the finished movie; the file is the host's from then on. A throw is reported through `onError` with the movie's path.
- `onDiscard: () -> Void = {}`: the person discarded the recording.
- `onError: (String) -> Void`: the recording could not start or failed, or `onUse` threw.
- `onStart: () -> Void = {}`: the controls are up and the recorder starts; a host can step aside (the widget collapses).

#### `RecordingTargetPicker`

Picks what to record: tabs for windows (grouped under their app, with titles and sizes), apps and displays, a filter field, and the rows as buttons. It starts on `initial`. ↑ and ↓ move, Return records, Esc cancels, a click on a row records it. Values and closures only.

- `load: RecordingTargetPicker.Load`: `.loading`, `.failed(String)` (with a Try again button) or `.loaded(RecordingTargets)`.
- `title: String = "Choose what to record"`
- `initial: RecordingTarget?`: the highlighted row and the first tab.
- `onChoose: (RecordingTarget) -> Void`, `onCancel: () -> Void`, `onRetry: () -> Void = {}`

```swift
RecordingTargetPicker(load: .loaded(targets), initial: targets.defaultTarget(preferredPid: pid),
                      onChoose: { start($0) }, onCancel: { close() })
```

#### `RecordingControlsView`

The floating controls of a running recording: a grip, the recorded time with a red dot (a spinner while starting or saving, a pause glyph while paused, the time left in the last minute), what is recorded as a chip that switches it, pause or resume, restart, the use button and stop and discard. The grip, dot and time drag the window. With `confirmsDiscard`, discard and restart ask inside the controls once something was recorded ("Discard 1:23 of recording?" with Discard and Keep).

- `state: RecordingControlsState`: `phase`, `elapsedMs`, `limitMs`, `target`, `pauseReason` (`user`, `limit`, `recorder`), `notice`, `useTitle`, `useSymbol`, `confirmsDiscard`.
- `actions: RecordingControlsActions`: `pause`, `resume`, `switchTarget`, `restart`, `use`, `discard`, `dismissNotice`, `moved`.

```swift
RecordingControlsView(
    state: RecordingControlsState(phase: .recording, elapsedMs: 83_000, target: target, useTitle: "Stop and paste"),
    actions: RecordingControlsActions(pause: pause, resume: resume, switchTarget: pick, restart: restart,
                                      use: stop, discard: discard))
```

#### `RecordingSessionController`

One `tools control capture session --json --stop-on-stdin` child on `ToolsLineStream`. It publishes `phase` (`RecordingPhase`: idle, starting, recording, paused, finishing, done, discarded, failed), `elapsedMs` (time in the movie: no arming, no paused time), `limitMs`, `target`, `pauseReason`, `segments` and `notice`, and calls `onDone(URL, durationMs)`, `onDiscarded()` or `onFailed(message, code)` (`screen-recording-denied` for a missing grant).

- `start(target:excludeWindowIDs:frameRate:showsBorder:) throws`: `excludeWindowIDs` are windows no movie may show.
- `pause()`, `resume()`, `switchTo(_:)`, `restart()`, `stop()` (keeps the movie), `discard()`, `terminate()` (SIGTERM: the session stops and keeps what it recorded).

#### `RecordingTarget`, `RecordingTargets`

`RecordingTarget` is `.window(ids:app:title:pid:)`, `.app(app:name:)` (a pid, name or bundle id) or `.display(index:name:)` (NSScreen order); `json` is the CLI's form, and `title`, `subtitle` and `symbol` describe it. `RecordingTargets` decodes `tools control capture targets --json`: `windows` (`RecordingWindow`: id, pid, app, title, bounds in CG points), `apps` (`RecordingApp`), `displays` (`RecordingDisplay`) and `frontmostPid`; `excluding(pids:)` drops a host's own process and `defaultTarget(preferredPid:)` is the front window of that app, else of the frontmost app, else the main display.

#### `RecordingSettings`, `RecordingSettingsView`

The recorder's preferences in the app's defaults (`recording.*`), with their page (the widget shows it as Widgets › Screen recording):

- `placement: RecordingPanelPlacement = .nearTarget`: where the controls appear (under the recorded window, or at the bottom of a recorded display), or a corner of that display. A drag moves them for the rest of the recording.
- `frameRate: Int = 15`: frames per second while something moves (5, 10, 15, 24 or 30); a still screen records at 2.
- `showsBorder: Bool = true`: the pulsing red border around what is recorded. It is never in the movie.
- `confirmsDiscard: Bool = true`: discard and restart ask first.

```swift
NativeSettingsPage(id: "app.recording", title: "Screen recording", symbol: "record.circle", tint: .red) {
    RecordingSettingsView()
}
```

### Sessions

Sessions shows one AI coding session (Claude, Codex or Grok) as a screen. `SessionDetailScreen` is the main entry point: a header, a transcript (`SessionTranscriptList`) and a 300 pt sidebar of usage, files, commits and sub-agents, and `SessionSidebarSplit` lets the sidebar cover the transcript in a narrow pane. A host turns `tools ai sessions tail` turns into a `TranscriptDocument` and a `SessionActivityDigest`, fills `SessionDetailInfo` for the header and passes its buttons as closures in `SessionDetailActions`. The host hooks are `TranscriptServices` (the session file, change log, row actions, notice buttons and the search callback for the tool rows), `SessionDetailActions`, `TranscriptBus` (jump and reveal messages from the sidebar to the transcript) and `TranscriptFilters` (the tool filter of each session). `TranscriptLiveTail` follows a running session, `TranscriptActivityFeed` carries its live activity row, and `SessionPalette` and `SessionFormat` hold the shared look and number formats. The entries below start with the transcript, its document model, the live tail and the shared tokens.

#### `SessionTranscriptList`

The conversation view of a session: a toolbar (search, filter chips, detail level, expand and collapse, line wrapping, prompt arrows) over a list of prompt sections whose headers stay pinned. It draws one row per prompt, reply, thinking block, tool call and notice. Cmd+F focuses the search field, and Cmd+[ and Cmd+] move between prompts. The reader's detail level and wrap choices persist in UserDefaults under `sessionTranscript.verbosity`, `sessionTranscript.wrapInputs` and `sessionTranscript.wrapOutputs` (the level starts at `TranscriptVerbosity.inputs`).

- `document: TranscriptDocument`: the sections and rows to show.
- `provider: AIProviderMeta`: names and colors the author of a reply.
- `modelName: String?`: the model shown on a reply that carries no model of its own.
- `loadState: TranscriptLoadState`: `.loading` draws a skeleton and `.failed(String)` draws the message, both only while the document is empty; `.loaded` draws the rows.
- `hasEarlier: Bool`: adds a "Load earlier turns" row at the top.
- `loadingEarlier: Bool`: that row shows a spinner and is disabled.
- `windowNote: String?`: text for the toolbar such as `Turns 190 to 269 of 269`; nil when the whole session is loaded.
- `onLoadEarlier: () -> Void`: called when the reader presses the "Load earlier turns" row.
- `preset: TranscriptPreset = TranscriptPreset()`: starting filter, query, open rows and scroll target.
- `services: TranscriptServices = .none`: what the tool rows need, and the hook that hears the applied search query.
- `followsLatest: Bool = false`: for a live chat. New rows scroll into view while the reader is at the end, and a "Latest" button appears after they scroll away.
- `emptyMessage: String = "No turns in this session file."`: text shown when the document has no sections.
- `activity: TranscriptActivityFeed? = nil`: draws the live activity row as the last row while a feed is passed. It is hidden during a search.
- `onReaderAtEnd: (Bool) -> Void = { _ in }`: called each time the reader reaches or leaves the latest turn, so a host trims old turns only while nobody reads them.

`TranscriptLoadState` has three cases: `loading`, `loaded` and `failed(String)`. The list also keeps the viewport still while earlier turns are inserted above it, shows an "N new" pill when rows arrive while the reader is scrolled up, and applies the per-session tool filter from `TranscriptFilters`.

```swift
SessionTranscriptList(
    document: document,
    provider: AIProviders.meta(for: "anthropic-sub"),
    modelName: "opus",
    loadState: .loaded,
    hasEarlier: windowStart > 0, loadingEarlier: false,
    windowNote: nil,
    onLoadEarlier: { loadEarlierTurns() },
    services: services
)
```

#### `TranscriptPreset`

The starting state of a `SessionTranscriptList`. Snapshot tests and previews use it. The window opens with the default value: everything shown, collapsed, at the latest turn.

- `chips: Set<TranscriptFilter> = []`: filter chips that start on.
- `query: String = ""`: search text that starts applied.
- `expanded: Set<String> = []`: ids of rows that start open.
- `scrollTo: String? = nil`: a row id to open at instead of the latest turn.
- `verbosity: TranscriptVerbosity? = nil`: overrides the stored detail level. The cases are `minimal`, `inputs`, `outputs` and `verbose`.
- `jumpToPrompt: Int? = nil`: opens as if the prompt arrows had been pressed to this 0-based prompt.

```swift
SessionTranscriptList(
    document: document, provider: provider, modelName: nil, loadState: .loaded,
    hasEarlier: false, loadingEarlier: false, windowNote: nil, onLoadEarlier: {},
    preset: TranscriptPreset(chips: [.errors], query: "timeout", verbosity: .outputs)
)
```

#### `TranscriptDocument`

The pure model behind the transcript: sections (one per user prompt) of flat rows. `TranscriptDocument.build` computes everything a row shows (clock text, duration, key argument, search text) once, so a row body only reads stored values. Build it off the main thread.

- `sections: [TranscriptSection]`: the sections in order.
- `turnCount: Int`: turns in the document.
- `toolCount: Int`: tool calls in the document.
- `errorCount: Int`: failed tool calls in the document.
- `firstAt: Date? = nil`: time of the first dated turn.
- `lastAt: Date? = nil`: time of the last dated turn.

Properties and methods:

- `static let empty`: a document with no sections.
- `var finishedToolsInLastSection: Int`: calls of the latest section that have their result. This is the "N done" of the live activity row.
- `func filtered(_ chips: Set<TranscriptFilter>, query: String) -> [TranscriptSection]`: keeps rows that match any chip and contain the query, and decides which replies show an author row. A prompt stays as context for the hits of its section.
- `static func folded(_ sections: [TranscriptSection]) -> [TranscriptSection]`: the Minimal level. Thinking goes, and each run of tool rows becomes one `toolGroup` row with the id `g-` plus the first call's row id.
- `static func markAuthors(_ rows: inout [TranscriptRow])`: sets `showsAuthor`. The first reply of a section shows its author, and a later reply only when its model changes.
- `static func build(_ turns: [TranscriptTurn], turnOffset: Int = 0, native: SessionNativeSummary? = nil, fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }) -> TranscriptDocument`: `turnOffset` is the session-wide index of the first turn, so a page loaded from the middle numbers its prompts correctly. `native` supplies per-section usage and the model of each reply. `fileExists` checks image paths named in a prompt.
- `static func toolLine(_ tool: TranscriptTool, at: Date?, nextAt: Date?, isLastTurn: Bool) -> TranscriptToolLine`: builds one tool line. A call without a result in the last turn is `pending`.
- `static func displayName(_ name: String) -> String`: turns `mcp__server__tool` into `server · tool`.
- `static func keyArgument(_ preview: String, kind: TranscriptToolKind) -> String`: the one-line argument of a call. For a read or edit call, a path becomes its parent folder and file name. Any other call keeps the first line of its input.
- `static func imageRefs(in text: String, fileExists: (String) -> Bool) -> [TranscriptImageRef]`: existing image files a prompt names by path, then `[Image #N]` placeholders.

`TranscriptFilter` has the cases `chat`, `tools` and `errors`, each with a `title`. Several can be on at once, and none on means everything. A prompt always passes a chip filter, and a section left with only its prompt is dropped unless `chat` is on.

```swift
let document = TranscriptDocument.build(envelope.turns, turnOffset: envelope.windowStart)
let failures = document.filtered([.errors], query: "build")
let folded = TranscriptDocument.folded(failures)
```

#### `TranscriptSection`

Everything between one user prompt and the next. The list draws it as a section with a pinned header.

- `id: String`: the section id (`s-` plus the prompt's turn id; `s-lead` and `s-gap-` ids mark rows that have no prompt in the window).
- `number: Int`: 1-based turn number of the prompt in the whole session file; 0 for rows before the first prompt of the window.
- `startedAt: Date? = nil`: when the prompt arrived.
- `duration: TimeInterval? = nil`: from the prompt to the section's last entry.
- `toolCount: Int`: tool calls in the section.
- `errorCount: Int`: failed tool calls in the section.
- `usage: SessionUsage? = nil`: tokens and cost of the section's model calls, from the native session file when read, else from the envelope. nil when neither reports any.
- `rows: [TranscriptRow]`: the rows in order.

`SessionUsage` has two public conversion initializers in this folder: `SessionUsage(_ usage: TranscriptUsage)` for one envelope turn, and `SessionUsage(_ totals: TranscriptTotals?)`, which returns nil when the totals report no model call and no cost.

```swift
let section = TranscriptSection(
    id: "s-u1", number: 1, startedAt: Date(), duration: 42,
    toolCount: 1, errorCount: 0,
    rows: [promptRow, replyRow]
)
let document = TranscriptDocument(sections: [section], turnCount: 1, toolCount: 1, errorCount: 0)
```

#### `TranscriptRow`

One line of the transcript. A host builds rows through `TranscriptDocument.build`, or builds them by hand for a chat that keeps its own records.

- `id: String`: a stable row id. `build` uses `p-`, `a-`, `r-` and `t-` plus the turn or tool id for prompt, reply, thinking and tool rows.
- `kind: TranscriptRow.Kind`: what the row shows (cases below).
- `at: Date? = nil`: when the row happened.
- `clock: String? = nil`: the precomputed `14:32:10` text.
- `searchText: String`: lowercased text the search box matches.
- `showsAuthor: Bool = true`: whether a reply draws its author line.
- `parts: [TranscriptPromptPart] = []`: the parts of a prompt that holds more than the user's words.

Computed: `isPrompt: Bool`, `isError: Bool` and `func matches(_ chips: Set<TranscriptFilter>) -> Bool`.

`TranscriptRow.Kind` cases:

- `prompt(text: String, images: [TranscriptImageRef])`: the user's prompt. `TranscriptImageRef(path: String? = nil, label: String)` is an image file on disk (`path` set) or a placeholder such as `Image #2`.
- `reply(text: String, usage: String?, model: String?)`: an assistant reply with an optional cost line and the model that wrote it.
- `thinking(text: String)`: the model's reasoning.
- `tool(TranscriptToolLine)`: one tool call.
- `toolGroup(TranscriptToolGroup)`: a run of tool calls folded into one line. `TranscriptToolGroup(members: [TranscriptRow])` reads `summary` (such as `Ran 3 commands · Read 2 files`), `failed` and `duration` from its members.
- `notice(TranscriptNotice)`: an inline note from the host.
- `activity(TranscriptActivity)`: the running turn, as the last row of a live transcript.

```swift
TranscriptRow(
    id: "a-1",
    kind: .reply(text: "The build passes.", usage: nil, model: "opus"),
    at: Date(),
    clock: SessionFormat.clock(Date()),
    searchText: "the build passes."
)
```

#### `TranscriptToolLine`

One tool call as the transcript stores it. `TranscriptToolStatus` has the cases `ok`, `failed` and `pending`.

- `toolId: String`: the call id.
- `name: String`: the tool name, such as `Bash`.
- `displayName: String`: the name as shown.
- `symbol: String`: an SF Symbol name for the call's kind.
- `keyArgument: String`: the one argument that says what the call did.
- `input: String`: the input preview.
- `result: String? = nil`: the result text, when there is one.
- `status: TranscriptToolStatus`: whether the call worked, failed or waits for its result.
- `exitCode: Int? = nil`: the process exit status of a command.
- `resultChars: Int? = nil`: length of the full result before it was clipped.
- `duration: TimeInterval? = nil`: time to the next entry. The transcript records no tool timing, so this is an upper bound and the view prints it with a `~`.

```swift
TranscriptToolLine(
    toolId: "call-1", name: "Bash", displayName: "Bash",
    symbol: TranscriptToolKind.of("Bash").symbol,
    keyArgument: "bun run test", input: "bun run test",
    result: "12 passed", status: .ok, exitCode: 0
)
```

#### `TranscriptNotice`

An inline note a host adds to a transcript, such as an approval request or a lost connection. It never comes from a session file.

- `level: TranscriptNotice.Level`: `info`, `success`, `warning` or `error`. An `error` notice counts for the `errors` chip.
- `title: String`: the headline.
- `detail: String? = nil`: a second line.
- `actions: [String] = []`: button titles. A press reaches `TranscriptServices.onNoticeAction` with the row id and the title.

```swift
let notice = TranscriptNotice(
    level: .warning,
    title: "Approval · open_url",
    detail: "https://example.org",
    actions: ["Approve", "Deny"]
)
let row = TranscriptRow(id: "n-1", kind: .notice(notice), searchText: "approval open_url")
```

#### `TranscriptActivity`

What a running turn does now, drawn as a row with a pulsing mark. The row computes the elapsed time itself, so the document does not change every second. Hosts that follow a live session usually get this from `TranscriptActivityFeed` instead of building it.

- `startedAt: Date`: when the current step began.
- `label: String`: short text such as `Thinking…` or `Running Bash`.
- `detail: String? = nil`: the running call's main argument, one line.
- `finishedTools: Int`: calls of the turn that already have their result.
- `tone: TranscriptActivity.Tone = .working`: `working` pulses the mark, `waiting` shows a still orange mark for a user answer, `stalled` shows a still mark with the time in orange.
- `moreRunning: Int = 0`: other calls running beside the named one.

```swift
let activity = TranscriptActivity(
    startedAt: Date(),
    label: "Running Bash",
    detail: "bun run test",
    finishedTools: 3,
    tone: .working,
    moreRunning: 1
)
let row = TranscriptRow(id: "activity-1", kind: .activity(activity), searchText: "")
```

#### `TranscriptRowAction`

A button a prompt or reply offers on hover and in its context menu, such as Copy or Fork. The host builds the actions per row through `TranscriptServices.rowActions`.

- `id: String`: a stable id, also used for the accessibility identifier.
- `title: String`: the tooltip and the context menu title.
- `symbol: String`: an SF Symbol name.
- `run: () -> Void`: called when the reader presses the button.

```swift
let copy = TranscriptRowAction(id: "copy", title: "Copy", symbol: "doc.on.doc") {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(text, forType: .string)
}
let services = TranscriptServices(
    sessionId: "a1b2c3d4", cwd: nil, nativeLog: nil, changes: nil, showChange: nil,
    rowActions: { _ in [copy] }
)
```

#### `PromptCard`

The card of a user prompt: an avatar, the clock, the text as markdown and image thumbnails. A prompt longer than 14 lines or 1600 bytes is cut until the reader presses the "Show all N lines" button (or "Show the full message" when only the byte count is over the limit). With actions, the card shows hover buttons and a context menu.

- `id: String`: the expansion key passed to `onToggle`.
- `text: String`: the prompt text.
- `images: [TranscriptImageRef]`: images the prompt names.
- `clock: String?`: the time text.
- `expanded: Bool`: whether a long prompt shows in full.
- `actions: [TranscriptRowAction] = []`: hover buttons and context menu items.
- `onToggle: (String) -> Void`: called with `id` when the reader presses the show more or show less button.

```swift
PromptCard(
    id: "p-u1",
    text: promptText,
    images: [TranscriptImageRef(label: "Image #1")],
    clock: "14:32:10",
    expanded: openIds.contains("p-u1"),
    actions: [copy]
) { id in toggle(id) }
```

#### `PromptPartsView`

Draws a prompt that holds more than the user's own words: a peer agent's message, a finished background task, the Esc marker, a reminder. Each `TranscriptPromptPart` appears in order in its own shape, chosen by its `kind`: `teammate` (a card with a colored dot, sender, type pill and markdown body), `task` (a status line, with a sub-agent's report under it), `interrupt`, `system`, and `user` or any unknown kind (the usual `PromptCard`). A part's expansion key is `TranscriptPromptParts.partId(rowId, index)`. The same enum holds `searchText(_:)` and `userText(_:)`, which `TranscriptDocument.build` uses for the search text and the image references.

- `rowId: String`: the prompt row id, the base of every part key.
- `parts: [TranscriptPromptPart]`: the parts in order.
- `images: [TranscriptImageRef]`: images; they show under the first `user` part.
- `clock: String?`: the time text.
- `open: Set<String>`: part keys that are open.
- `onToggle: (String) -> Void`: called with a part key when the reader presses show more or show less.

```swift
PromptPartsView(
    rowId: row.id,
    parts: row.parts,
    images: [],
    clock: row.clock,
    open: [TranscriptPromptParts.partId(row.id, 0)]
) { key in toggle(key) }
```

#### `TranscriptRowView`

Draws one `TranscriptRow` by its kind: `PromptCard` or `PromptPartsView` for a prompt, a reply block with an author line, a notice card, the activity row, a thinking line, a tool call row or a folded tool group. It is `Equatable`, so SwiftUI skips a row whose inputs did not change. `SessionTranscriptList` builds these itself. Use this view when a host lays out rows in its own container.

- `row: TranscriptRow`: the row to draw.
- `provider: AIProviderMeta`: names and colors the reply author.
- `modelName: String?`: the model for a reply that has none.
- `verbosity: TranscriptVerbosity`: the detail level for tool rows.
- `expanded: Bool`: whether this row is open (a tool call, a thinking block or a long prompt).
- `showAll: Bool`: whether an open row shows its whole body instead of a trimmed one.
- `openMembers: Set<String>`: ids of the members open inside a folded group, or the parts open inside a prompt.
- `fullMembers: Set<String> = []`: ids of group members that show their whole body.
- `wrap: TranscriptWrap = TranscriptWrap()`: whether tool inputs and outputs wrap their long lines.
- `services: TranscriptServices`: what the tool rows need.
- `onToggle: (String) -> Void`: called with a row or member id when the reader opens or closes it.

```swift
TranscriptRowView(
    row: row, provider: provider, modelName: "opus", verbosity: .inputs,
    expanded: false, showAll: false, openMembers: [],
    services: .none
) { id in toggle(id) }
```

#### `TranscriptToolKind`

The tool taxonomy of the transcript: it groups tool names across Claude, Codex and Grok, and drives the summaries of folded groups and the icons.

- `command`: `Bash`, `BashOutput`, `Monitor`, `shell`, `exec_command` and similar.
- `read`: `Read`, `NotebookRead`, `read_file`.
- `edit`: `Edit`, `Write`, `MultiEdit`, `apply_patch` and similar.
- `search`: `Grep`, `Glob`, `LS`, `ToolSearch`.
- `web`: `WebSearch`, `WebFetch`.
- `agent`: `Task`, `Agent`, `Workflow`, `SendMessage`.
- `skill`: `Skill`.
- `mcp`: any name that starts with `mcp__`.
- `other`: every other name.

Members:

- `static func of(_ name: String) -> TranscriptToolKind`: the kind of a tool name.
- `func summarize(_ count: Int) -> String`: text such as `Ran 3 commands` or `2 searches`.
- `var symbol: String`: the SF Symbol name for the kind.

```swift
let kind = TranscriptToolKind.of("Grep")      // .search
let text = kind.summarize(2)                  // "2 searches"
let icon = Image(systemName: kind.symbol)     // magnifyingglass
```

#### `TranscriptBus`

The messages between a host's sidebar, the host and the transcript. The sidebar posts a `request` (a jump to a turn). The host loads the window that holds the turn, then posts a `list` message, and `SessionTranscriptList` reveals the row. Messages carry a session id, so another open session ignores them.

- `static let request: Notification.Name`: sidebar to host.
- `static let list: Notification.Name`: host to the transcript list.
- `static func post(_ name: Notification.Name, sessionId: String, _ command: TranscriptCommand)`: posts a message.
- `static func message(_ note: Notification, for name: Notification.Name, sessionId: String) -> TranscriptCommand?`: the command in a notification, or nil when the name does not match or the session id is empty or does not match.
- `static func onlyTool(_ name: String?, in sections: [TranscriptSection]) -> [TranscriptSection]`: keeps the calls of one tool under their prompts. A prompt with none of them goes. nil returns the sections unchanged.
- `static func visibleRow(_ rowId: String, in sections: [TranscriptSection]) -> String?`: the id of the row that shows `rowId`, which is the folded group when the call sits in one.
- `static func contains(_ rowId: String, in sections: [TranscriptSection]) -> Bool`: whether a row is visible in the sections.

`TranscriptCommand` has two cases: `jump(turnIndex: Int, rowId: String)` and `reveal(rowId: String)`. `TranscriptMessage(sessionId:command:)` is the notification object.

```swift
TranscriptBus.post(TranscriptBus.request, sessionId: "a1b2c3d4", .jump(turnIndex: 12, rowId: "p-u12"))
// In the host, after loading the window that holds turn 12:
TranscriptBus.post(TranscriptBus.list, sessionId: "a1b2c3d4", .reveal(rowId: "p-u12"))
```

#### `TranscriptFilters`

The tool filter of each session: set by a click on a tool in the host's sidebar, cleared by the orange chip the list shows in its toolbar. It is keyed by session id, so another session opens unfiltered. It is a main-actor `ObservableObject`, so the list updates when the filter changes.

- `static let shared`: the one instance.
- `func tool(for sessionId: String) -> String?`: the filtered tool name, or nil.
- `func setTool(_ name: String?, for sessionId: String)`: sets the filter, or clears it with nil. An empty session id is ignored.

```swift
let filters = TranscriptFilters.shared
filters.setTool("Bash", for: "a1b2c3d4")
let active = filters.tool(for: "a1b2c3d4")   // "Bash"
filters.setTool(nil, for: "a1b2c3d4")
```

#### `TranscriptLiveTail`

Follows an open transcript with one `tools ai sessions tail <query> --live` follow for as long as the screen shows it. It runs inside the host's resident `ToolsServerClient` when one is passed, else as a `tools` process. It starts when created. Call `stop()` when the screen closes or hides. After an unexpected exit it starts once more from the last turn it saw. It is `@MainActor`.

- `query: String`: a session id, a worker name or an absolute transcript path.
- `offset: Int`: the session-wide turn index to start from. The follow sends the turns from this index on.
- `provider: String? = nil`: names the provider of a path outside the known roots.
- `bridge: ToolsBridge`: runs the `tools` binary.
- `server: ToolsServerClient? = nil`: the resident server to run the follow in.
- `log: ((String) -> Void)? = nil`: gets the `transcript.follow` lines. nil writes them to the perf file.
- `onBatch: (TranscriptLiveTail.Batch) -> Void`: called with each chunk.

Methods:

- `func stop()`: ends the follow.
- `nonisolated static func batch(of lines: [String], log: (String) -> Void = { _ in }) -> Batch`: decodes the lines of one chunk into a batch: turns in order, the last totals line and the last activity line.

`TranscriptLiveTail.Batch` holds `turns: [TranscriptTurn]` (each with its session-wide `index`), `totals: Totals?` (the last totals line of the chunk) and `activity: TranscriptLiveActivity?` (sent only when the activity changed). `Totals` holds `modelCalls`, `inputTokens`, `cacheReadTokens`, `outputTokens`, `reasoningTokens`, `costUsd`, `terminated`, `nextOffset` and `turnCount`, and its `transcriptTotals` property converts it to `TranscriptTotals`.

```swift
let bridge = ToolsBridge(binaryPath: "/usr/local/bin/tools")
tail = TranscriptLiveTail(query: "a1b2c3d4", offset: lastTurnIndex, bridge: bridge) { batch in
    apply(batch.turns)
    feed.receive(batch.activity, finishedTools: document.finishedToolsInLastSection)
}
// On close: tail?.stop()
```

#### `TranscriptLiveActivity`

What the followed agent does now: the follow's `activity` line. A transcript records a message only when it is complete, so without this a working agent looks idle until its rows land at once. It is `Decodable`; times are epoch milliseconds, and an unknown phase from a newer CLI decodes as `idle`.

- `phase: Phase`: `thinking` (a turn runs and no call is open), `tool` (a call has no result), `waiting` (a question or plan waits for the user), `idle` or `interrupted`.
- `since: Double? = nil`: when the phase began.
- `turnStartedAt: Double? = nil`: when the turn's prompt arrived.
- `tool: TranscriptLiveActivity.Tool? = nil`: the oldest open call, or the question tool. `Tool(id:name:summary:startedAt:)` holds a one-line summary.
- `openTools: Int = 0`: calls open at once.
- `question: String? = nil`: the question a waiting turn asks.
- `stalled: Bool = false`: true when the turn wrote nothing for ten minutes.
- `lastEventAt: Double? = nil`: the last transcript write.

Properties and methods:

- `var isWorking: Bool`: the model thinks (not stalled) or a tool runs.
- `var headerState: HeaderState`: the coarse state for a session header: `working`, `stalled`, `waiting(plan: Bool)`, `idle` or `interrupted`.
- `static func status(_ state: HeaderState, over fallback: SessionLiveness) -> Status`: the header status. `Status` holds a `liveness`, an optional `label` that replaces the liveness text (such as "Waiting") and an optional tooltip `note`. A finished turn keeps an ended session ended.
- `func row(finishedTools: Int, now: Date = Date()) -> TranscriptActivity?`: the activity row, or nil when the agent does not work on a turn.

```swift
let tool = TranscriptLiveActivity.Tool(id: "call-1", name: "Bash", summary: "bun run test")
let live = TranscriptLiveActivity(phase: .tool, tool: tool, openTools: 1)
let row = live.row(finishedTools: 2)
```

#### `TranscriptActivityFeed`

Holds the content of the live activity row apart from the document. What an agent does changes several times per tool call, and passing it as a document value made the whole list redraw. Through the feed, each change redraws that one row. Pass the feed to `SessionTranscriptList` (or `SessionDetailScreen`) only while `row` is non-nil. It is a main-actor `ObservableObject`.

- `init()`: creates an empty feed.
- `row: TranscriptActivity?`: the row to draw. Published only when it changes.
- `live: TranscriptLiveActivity?`: the last activity line received.
- `func receive(_ live: TranscriptLiveActivity?, finishedTools: Int, now: Date = Date()) -> Bool`: takes a new line and returns true when it differs from the last. The result is discardable.
- `func refresh(finishedTools: Int)`: updates the "N done" count after the document is rebuilt.

```swift
let feed = TranscriptActivityFeed()
feed.receive(batch.activity, finishedTools: document.finishedToolsInLastSection)
let activity = feed.row == nil ? nil : feed   // pass this as the list's `activity`
```

#### `SessionActivityDigest`

What a session touched, derived from its tool calls: files read, edited or written, commits and sub-agents. The detail sidebar shows it. The struct has no public initializer: a host starts from `empty` or builds it with `build`, and can then assign `subagents` from a richer source.

- `files: [SessionFileTouch] = []`: files in first-touch order. `SessionFileTouch(path:edits:writes:reads:)` adds `name`, `folder` and `changed` (true when `edits + writes > 0`).
- `commits: [SessionCommit] = []`: commits seen in `git commit` output. `SessionCommit(sha:branch:subject:)`, where `branch` defaults to nil.
- `subagents: [SessionSubagent] = []`: sub-agents the session started. `SessionSubagent(id:kind:summary:state:startedAt:)`, where `startedAt` defaults to nil, has the states `done`, `running`, `background`, `idle` and `failed`.
- `commandCount: Int = 0`: command calls (`Bash` and similar).

Properties and methods:

- `static let empty`: a digest with nothing in it.
- `var changedFiles: [SessionFileTouch]` and `var readOnlyFiles: [SessionFileTouch]`: the files split by `changed`.
- `static func build(_ turns: [TranscriptTurn]) -> SessionActivityDigest`: derives the digest from the turns.
- `static func patchPaths(_ patch: String) -> [String]`: the paths in the `*** Update File:`, `*** Add File:` and `*** Delete File:` lines of a Codex patch.
- `static func commits(in output: String) -> [SessionCommit]`: parses `[branch sha] subject` lines.
- `SessionSubagent.ordered(_ agents: [SessionSubagent]) -> [SessionSubagent]`: working ones first, then idle, failed and done, newest start first inside a group.

```swift
var digest = SessionActivityDigest.build(envelope.turns)
digest.subagents = SessionSubagent.ordered(digest.subagents)
let edited = digest.changedFiles.map(\.name)
```

#### `SessionLiveness`

Whether a session is running, idle or ended. `label` returns `Running`, `Idle` or `Ended`.

- `running`: activity in the last two minutes, or a tool call still waits for its result.
- `idle`: a pane holds the session, or its cache is still warm.
- `ended`: the transcript recorded an end, or no pane holds the session and its cache is cold or unknown.

Method:

- `static func resolve(lastActivity: Date?, terminated: String?, pendingTool: Bool, cacheCold: Bool?, inPane: Bool?, now: Date = Date()) -> SessionLiveness`: applies those rules in the order `terminated`, `pendingTool`, `lastActivity`, `inPane`, `cacheCold`.

```swift
let state = SessionLiveness.resolve(
    lastActivity: lastWrite, terminated: envelope.terminated,
    pendingTool: false, cacheCold: nil, inPane: true
)
```

#### `SessionGitBranch`

Reads a working folder's branch from the files, without starting `git`. It walks up from the folder to the repository, follows a worktree's `.git` file and reads `HEAD`.

- `static func read(cwd: String, maxDepth: Int = 12) -> String?`: the branch name, or a short sha on a detached head. nil when no repository is found.
- `static func parseHead(_ head: String) -> String?`: the same rule applied to the text of a `HEAD` file.

```swift
let branch = SessionGitBranch.read(cwd: "~/projects/demo", maxDepth: 6) ?? "unknown"
let named = SessionGitBranch.parseHead("ref: refs/heads/feat/demo\n")    // "feat/demo"
let detached = SessionGitBranch.parseHead("4e7a3bcd28f0c1d2")            // "4e7a3bcd"
```

#### `TranscriptMarkdownStyle`

How the transcript wants its markdown drawn (replies, prompt parts, teammate messages). The kit passes the text and this style to `GenesisKitHost.transcriptMarkdown(_:style:)`, which maps it onto the app's own renderer. When the host returns nil, the transcript draws inline markdown in one `Text`. The struct has no public initializer: start from `sessionTranscript` and change fields.

- `bodySize: CGFloat`: body text size (13 in `sessionTranscript`).
- `textColor: Color`: body text color.
- `secondaryColor: Color`: secondary text color.
- `mutedColor: Color`: muted text color.
- `accentColor: Color`: bullets, ordered markers and the quote bar.
- `codeColor: Color`: code text color.
- `codeBackground: Color`: code background.
- `taskDoneColor: Color`: color of a checked task item.
- `lineSpacing: CGFloat`: space between lines.
- `blockSpacing: CGFloat`: space between blocks.
- `headingScale: CGFloat`: multiplies heading sizes.
- `static let sessionTranscript`: the transcript's look, built from `SessionPalette`.

```swift
// In the host (a `GenesisKitHost` implementation):
func transcriptMarkdown(_ text: String, style: TranscriptMarkdownStyle) -> AnyView? {
    AnyView(MyMarkdownView(text: text, fontSize: style.bodySize, color: style.textColor))
}
```

#### `View.hoverTextSelection()`

Makes the text inside a view selectable only while the pointer is over it. `.textSelection(.enabled)` gives every `Text` an AppKit selection field and a key-view proxy, and a transcript page of 17 to 23 rows carried 141 of them, which slowed every session switch. The pointer is over a message before any drag can select in it, so selecting works the same. Selection stays on for VoiceOver and Full Keyboard Access. Set the environment variable `GENESIS_TRANSCRIPT_SELECT_ALWAYS=1` to keep it on everywhere. The modifier type is `HoverTextSelection`.

```swift
VStack(alignment: .leading, spacing: 4) {
    Text(verbatim: title)
    Text(verbatim: replyText)
}
.hoverTextSelection()
```

#### `TranscriptThumbnailCache`

An actor that decodes image thumbnails off the main thread and keeps them in memory. The prompt card uses it for the images a prompt names.

- `static let shared`: the one instance.
- `func thumbnail(for path: String) -> NSImage?`: a thumbnail of at most 256 px for an image file, or nil when it cannot be read. The result is cached by path.

```swift
@State private var thumbnail: NSImage?

Image(nsImage: thumbnail ?? NSImage())
    .task {
        thumbnail = await TranscriptThumbnailCache.shared.thumbnail(for: path)
    }
```

#### `SessionPalette`

The color and font tokens of the session screens: a near-black ground, hairlines at white 8%, five status colors and a monospaced code font. The look follows the GenesisTools review window.

- `backgroundNS: NSColor` and `background: Color`: the window ground.
- `sidebar: Color`: the sidebar ground.
- `card: Color`: the fill of cards on the ground.
- `hairline: Color`: a divider line (white 8%).
- `cardBorder: Color`: a card border (white 10%).
- `fill: Color` and `fillStrong: Color`: subtle fills (white 4% and 7%).
- `text`, `secondary`, `dim`, `faint`: text colors from strongest (white 92%) to weakest (white 32%).
- `green`, `red`, `orange`, `blue`, `purple`: status and accent colors.
- `codeFont: Font`: monospaced, 11.5 pt.
- `static func mono(_ size: CGFloat, weight: Font.Weight = .regular) -> Font`: a monospaced system font.

```swift
Text(verbatim: "12 failed")
    .font(SessionPalette.mono(11, weight: .medium))
    .foregroundStyle(SessionPalette.red)
    .padding(8)
    .background(SessionPalette.card)
```

#### `SessionStatusDot`

A small filled circle used as a status marker.

- `color: Color`: the fill.
- `size: CGFloat = 6`: the diameter.

```swift
HStack(spacing: 6) {
    SessionStatusDot(color: SessionPalette.green, size: 8)
    Text(verbatim: "Running")
}
```

#### `SessionPill`

A capsule badge with a hairline border, one line of text.

- `text: String`: the label.
- `color: Color = SessionPalette.secondary`: the text color and the border tint.

```swift
HStack(spacing: 6) {
    SessionPill(text: "Local")
    SessionPill(text: "teammate", color: SessionPalette.purple)
}
```

#### `SessionSectionTitle`

A small uppercase section title with an optional monospaced count on the right.

- `title: String`: the title; the view uppercases it.
- `count: Int? = nil`: the count shown beside it.

```swift
VStack(alignment: .leading, spacing: 6) {
    SessionSectionTitle(title: "Files", count: digest.files.count)
    ForEach(digest.changedFiles) { file in Text(verbatim: file.name) }
}
```

#### `SessionStatChip`

One statistic: a dim label over a monospaced value on a rounded fill. Place it in a two-column grid.

- `label: String`: the small label.
- `value: String`: the value.
- `color: Color = SessionPalette.text`: the value color.

```swift
LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 6) {
    SessionStatChip(label: "Turns", value: "\(document.turnCount)")
    SessionStatChip(label: "Cost", value: SessionFormat.usd(0.42), color: SessionPalette.orange)
}
```

#### `FilterChip`

A toggle chip: filled with the tint when on, a hairline outline when off. Its width does not change between the two states, so a toolbar does not re-layout when the chip toggles.

- `title: String`: the label.
- `isOn: Bool`: whether the chip is on.
- `tint: Color = SessionPalette.blue`: the fill and border color when on.
- `action: () -> Void`: called when the reader presses the chip.

```swift
HStack(spacing: 4) {
    FilterChip(title: "All", isOn: chips.isEmpty) { chips = [] }
    FilterChip(title: "Errors", isOn: chips.contains(.errors), tint: SessionPalette.red) {
        chips.insert(.errors)
    }
}
```

#### `SessionFormat`

Number, time and date formats shared by the header, the sidebar and the transcript.

- `static func tokens(_ value: Int) -> String`: `850`, `1.2K`, `3.4M`.
- `static func usd(_ value: Double) -> String`: `$0.42`; `$123` from 100 up.
- `static func duration(_ seconds: TimeInterval) -> String`: `850ms`, `12s`, `4m 12s`, `2h 05m`.
- `static func ago(_ seconds: TimeInterval) -> String`: `just now`, `45s ago`, `12m ago`, `7h 14m ago`, `3d ago`. A label that must stay current needs a `LiveTime` instead.
- `static func chars(_ count: Int) -> String`: `842 chars`, `1.2K chars`.
- `static func clock(_ date: Date) -> String`: `HH:mm:ss`.
- `static func shortClock(_ date: Date) -> String`: `HH:mm`, with each minute formatted once.
- `static func moment(_ date: Date, now: Date = Date()) -> String`: `14:32` for today, `Sep 23, 14:32` for another day.
- `static func parseISO(_ value: String?) -> Date?`: an ISO 8601 date with or without fractional seconds; nil for nil, empty or invalid text.

```swift
let cost = SessionFormat.usd(0.4213)             // "$0.42"
let size = SessionFormat.tokens(88_400)          // "88.4K"
let when = SessionFormat.moment(Date())          // "14:32"
```

#### `SessionDetailScreen`

The session details screen as a pure view: a two-line header, the transcript on the left and a 300 pt sidebar on the right. The sidebar holds stat chips, a usage grid, status, files touched, commits, sub-agents and the closing action buttons Focus, Wake and Keepalive. The screen takes plain values and closures and loads nothing itself, so a host fills it from its own data. It always draws dark. Generic over `SidebarExtra`, a view the host adds to the sidebar.

- `info: SessionDetailInfo`: the identity, status, place and counters shown in the header and the sidebar.
- `digest: SessionActivityDigest`: files touched, commits and sub-agents for the sidebar. Use `SessionActivityDigest.empty` or `SessionActivityDigest.build(_:)`.
- `document: TranscriptDocument`: the transcript to draw. Use `TranscriptDocument.empty` before the first load.
- `loadState: TranscriptLoadState`: `.loading`, `.loaded` or `.failed(String)`.
- `hasEarlier: Bool = false`: the loaded window starts after the first turn, so the transcript offers to load earlier turns.
- `loadingEarlier: Bool = false`: an earlier page is loading now.
- `windowNote: String? = nil`: a short note such as `Turns 41-190`, drawn in the transcript toolbar. nil when the whole session is loaded.
- `banner: String? = nil`: a dismissable message under the header. An empty string shows nothing.
- `onLoadEarlier: () -> Void = {}`: the reader asked for earlier turns.
- `onDismissBanner: () -> Void = {}`: the reader closed the banner. The host clears `banner`.
- `onReaderAtEnd: (Bool) -> Void = { _ in }`: tells the host each time the reader reaches or leaves the latest turn.
- `preset: TranscriptPreset = TranscriptPreset()`: starting filter chips, search query, open rows, scroll target, verbosity and a prompt to jump to.
- `leadingInset: CGFloat = SessionDetailScreenChrome.leadingInset`: space before the header's first row. The default 80 clears the traffic lights of a window the screen fills. Pass 16 when the screen sits beside the host's own sidebar.
- `services: TranscriptServices = .none`: the session file, the change source and the "Open diff" hook for the tool rows. Build it once per loaded session file.
- `activity: TranscriptActivityFeed? = nil`: what the agent does now, drawn as the transcript's last row.
- `showsSidebar: Bool = true`: whether the sidebar is open. A change of this value folds or opens the sidebar without a new screen.
- `sidebarExtraFirst: Bool = false`: true puts the extra view right under the usage grid. false puts it after the sub-agents.
- `actions: SessionDetailActions`: the closures the header and the sidebar call.
- `sidebarExtra: () -> SidebarExtra`: a `@ViewBuilder` closure with the extra sidebar content. Return `EmptyView()` for none.

When the pane is narrower than the transcript's 460 pt plus the sidebar, the sidebar covers the transcript's trailing edge (see `SessionSidebarSplit`).

```swift
SessionDetailScreen(
    info: info,
    digest: digest,
    document: document,
    loadState: .loaded,
    hasEarlier: windowStart > 0,
    onLoadEarlier: { loadEarlier() },
    services: services,
    actions: actions
) { EmptyView() }
```

#### `SessionDetailInfo`

The value that describes one session for `SessionDetailScreen` and `SessionDetailHeader`. A struct with a public init. Only the first three parameters are required.

- `sessionId: String`: the full id. The header shows its first 8 characters (`shortId`).
- `title: String`: the session title, shown in the header.
- `provider: AIProviderMeta`: the provider's name, glyph and color. Use `AIProviders.meta(for:)`.
- `account: String? = nil`: the account the session bills. Shown as a header label and a sidebar row.
- `model: String? = nil`: the model name, shown as a pill. A click copies it.
- `modelSwitched: Bool = false`: shows a "switched" pill when the model changed since the previous turn.
- `cwd: String? = nil`: the session's working folder.
- `cwdExists: Bool = false`: whether the folder is on disk. The Finder and Cursor buttons stay off while it is false.
- `branch: String? = nil`: the git branch of the folder.
- `liveness: SessionLiveness = .ended`: `.running`, `.idle` or `.ended`. Sets the status dot color (green, orange, gray).
- `livenessNote: String = ""`: the reason behind the status, shown in the sidebar and in a tooltip.
- `livenessLabel: String? = nil`: replaces the label of `liveness`, for example "Waiting" for a turn that waits for the user's answer.
- `cacheNote: String? = nil`: a line such as `58m of cache left` or `cache cold`. nil for a provider without a cache clock.
- `cacheCold: Bool = false`: draws the cache note dim.
- `inPane: Bool? = nil`: true when a live cmux pane holds the session, false when none does, nil when that is not known. The sidebar shows "Open in a cmux pane" or "No cmux pane".
- `startedAt: Date? = nil`: first entry of the loaded transcript.
- `lastActivityAt: Date? = nil`: last transcript entry or file write. The header shows it as a live "active ... ago" label.
- `contextTokens: Int? = nil`: the context size of the last turn.
- `compacted: Bool = false`: marks the context size as the size after the last compaction.
- `usage: SessionUsage? = nil`: whole-session tokens and cost. The usage grid shows only when it is not empty.
- `filePath: String? = nil`: the session file. A click on its sidebar row reveals it.
- `turnCount: Int = 0`: turns, shown in the sidebar.
- `toolCount: Int = 0`: tool calls, shown in the sidebar.
- `errorCount: Int = 0`: failed tool calls, shown in the sidebar and the header.
- `note: String? = nil`: explains why the session is missing from the recent list, when it is.
- `alert: String? = nil`: a warning line under the header, for example a stuck-agent verdict.
- `alertIsSevere: Bool = false`: draws the alert red instead of orange.

Read-only values: `shortId`, `statusLabel` (the `livenessLabel`, else the label of `liveness`) and `livenessColor`.

```swift
var info = SessionDetailInfo(
    sessionId: "3f9c1a52-7d0e-4b8a-9c11-0a6e2d4f8b77",
    title: "Fix the parser after the dependency bump",
    provider: AIProviders.meta(for: "anthropic-sub"),
    model: "opus",
    cwd: "/Users/dev/projects/atlas",
    cwdExists: true,
    liveness: .running
)
info.turnCount = 42
```

#### `SessionDetailActions`

The closures the header and the sidebar call. Every field is a `var`, so a host can build it with the init or set fields one by one. An optional closure that is nil disables its button or hides its row, as each line below says.

- `refreshing: Bool = false`: while true, the header's reload button shows a spinner and is disabled.
- `refresh: () -> Void = {}`: the header's reload button, also bound to Command-R.
- `openInCursor: (() -> Void)? = nil`: opens the session folder in Cursor. Used by the sidebar folder button and the header folder's context menu. nil hides it.
- `openInFinder: (() -> Void)? = nil`: shows the session folder in Finder. Used by the folder click in the header and the sidebar, and by the folder button. nil hides the button.
- `copy: (String) -> Void = { _ in }`: the copy hook of the header and the sidebar: title, session id, model, account, counters, folder path, branch name, commit hash and resume command. The context menu of a file row copies through `PathOpener` instead.
- `focus: (() -> Void)? = nil`: raises the session's cmux pane. nil disables the Focus button. It also serves as the fallback for `openTerminal`.
- `wake: (() -> Void)? = nil`: types a poke into the pane. nil disables the Wake button.
- `keepalive: (() -> Void)? = nil`: sends `/keepalive` to the pane. nil disables the Keepalive button.
- `resumeCommand: String = ""`: the shell command that resumes the session. The header's terminal button and the title's context menu copy it. The terminal button copies it as is, so set it whenever the button should work.
- `openBranch: (() -> Void)? = nil`: opens the branch's web page. When nil, a click on the branch copies its name.
- `openTerminal: (() -> Void)? = nil`: raises or chooses the terminal pane. Used by the status pill and the "Open in a cmux pane" row. nil falls back to `focus`.
- `alertAction: (() -> Void)? = nil`: a click on the header's alert line. nil makes the line inert.
- `openInHub: (() -> Void)? = nil`: opens the session in the GenesisTools hub. nil hides the "Open in GenesisTools" row.
- `openSubagent: ((SessionSubagent) -> Void)?`: a click on a sidebar sub-agent row. nil makes the rows plain text. It is a property only and not an init parameter, so set it after the init.

```swift
var actions = SessionDetailActions(
    refresh: { reload() },
    openInFinder: { PathOpener.finder("/Users/dev/projects/atlas") },
    copy: { PathOpener.copy($0) },
    resumeCommand: "cd /Users/dev/projects/atlas && claude --resume 3f9c1a52"
)
actions.openSubagent = { agent in openAgent(agent.id) }
```

#### `SessionDetailScreenChrome`

The window setup the screen is drawn for, plus its two layout constants. Call `apply(to:)` on the window that hosts the screen when the screen fills the window.

- `static let leadingInset: CGFloat = 80`: the default space before the header's first row, so the row clears the traffic lights.
- `static let rowHeight: CGFloat = 38`: the height of the unified compact title bar, so the header row and the traffic lights share a center line.
- `static func apply(to window: NSWindow)`: runs on the main actor. Hides the title text, makes the title bar transparent with full-size content, sets an empty toolbar in the unified compact style, makes the window movable by its background, and sets a dark appearance and background.

```swift
let window = NSWindow(contentViewController: NSHostingController(rootView: screen))
SessionDetailScreenChrome.apply(to: window)
window.makeKeyAndOrderFront(nil)
```

#### `SessionDetailHeader`

The two-line header of the details screen, usable on its own. The first row has the provider glyph, title, status pill, model, account, token and cost counters and the buttons for the resume command, reload and the sidebar toggle. The second row has the folder, branch, start time, last activity and short id. An optional alert line sits under it.

- `info: SessionDetailInfo`: what to show.
- `actions: SessionDetailActions`: the closures the header calls.
- `leadingInset: CGFloat = SessionDetailScreenChrome.leadingInset`: space before the first row.
- `showSidebar: Binding<Bool>`: the sidebar toggle button flips this binding.

```swift
@State private var showSidebar = true

var body: some View {
    SessionDetailHeader(
        info: info,
        actions: actions,
        leadingInset: 16,
        showSidebar: $showSidebar
    )
}
```

#### `SessionSidebarSplit`

A `Layout` that puts a main view and a fixed-width sidebar side by side. When the width is too small for both, the sidebar covers the main view's trailing edge instead of growing past the frame. `SessionDetailScreen` uses it. Give it the main view first and the sidebar last. With one child, the child gets the whole area.

- `mainMinWidth: CGFloat = 460`: the least width the main view keeps before the sidebar starts to cover it.
- `static let sidebarWidth: CGFloat = 300`: the width of the details sidebar. The screen adds a 1 pt hairline before it.
- `static func overlays(width: CGFloat, sidebar: CGFloat, mainMinWidth: CGFloat) -> Bool`: true when the sidebar has to cover the main view at this width.

```swift
SessionSidebarSplit(mainMinWidth: 460) {
    transcript
    sidebar
}
```

#### `TranscriptPaging`

Paging rules for a session screen that loads its transcript in windows through `tools ai sessions tail --offset --limit`. A host uses the constants to size each fetch and `fetchWindow` to load a window that reaches the latest turn.

- `static let pageSize = 150`: turns per "Load earlier turns" page, and the room a refresh adds past the loaded window.
- `static let firstPage`: turns in the first fetch. The default is 12, so the first layout handles one screenful. The environment variable `GENESIS_TRANSCRIPT_FIRST_PAGE` (or the older `GENESIS_HUB_FIRST_PAGE`) sets it. A value that is not a positive integer gives the default 12.
- `static func firstPage(in environment: [String: String]) -> Int`: the same rule on a given environment.
- `static func refreshLimit(loaded: Int) -> Int`: the limit for a refresh that keeps every loaded page.
- `static func refetchLimit(after fetched: TranscriptEnvelope, start: Int, limit: Int) -> Int?`: the limit for another fetch from `start`, or nil when `fetched` already reaches the latest turn.
- `static func fetchWindow(using bridge: ToolsBridge, sessionId: String, offset: Int?, limit: Int, throughEnd: Bool, isCurrent: @MainActor () -> Bool = { true }) async throws -> TranscriptEnvelope`: fetches a window. With `throughEnd` and an `offset`, it fetches again while the answer stops short of the latest turn, at most three more times. `isCurrent` returning false stops the retries.

```swift
let envelope = try await TranscriptPaging.fetchWindow(
    using: bridge,
    sessionId: sessionId,
    offset: windowStart,
    limit: TranscriptPaging.refreshLimit(loaded: turns.count),
    throughEnd: true
)
```

#### `TranscriptBuildQueue`

Runs a session screen's document builds one at a time. Builds can overlap (a fetch, the native scan, an earlier page, a live append). The queue runs one build and keeps only the newest of the builds that arrive meanwhile, so a burst of appends costs two builds. The publisher of each build still checks its own revision. Both methods run on the main actor.

- `init()`: creates an empty queue.
- `func submit(_ operation: @escaping @MainActor () async -> Void) async`: queues the build and returns once the queue has no build left to run. A newer build replaces a waiting one.
- `func cancel()`: drops the pending build. The running build finishes.

```swift
let builder = TranscriptBuildQueue()
await builder.submit { await rebuild() }
// When the screen disappears:
builder.cancel()
```

#### `TranscriptServices`

Everything the tool rows need beyond their own value: the session file for full inputs and results, the change source for Bash edits, and the host's "open the diff" hook. Rows compare it by identity, so build it once per loaded session file and keep it. A class.

- `sessionId: String`: the session the services belong to.
- `cwd: String?`: the session folder, used to show paths relative to it.
- `nativeLog: SessionNativeLog?`: the scanned session file. nil when none is available.
- `changes: ToolChangeSource?`: where files changed by a command come from.
- `showChange: ((String, Int?) -> Void)?`: opens the host's changes view at a file path and an optional line. nil hides every "Open diff" button.
- `detailLoader: (@Sendable (String) -> ToolCallDetail?)? = nil`: gives the detail of a tool call by id for a host without a session file. It runs off the main thread. `nativeLog` wins when both are set.
- `rowActions: ((TranscriptRow) -> [TranscriptRowAction])? = nil`: buttons a prompt or reply shows on hover and in its context menu, such as Copy, Edit and Fork.
- `onNoticeAction: ((String, String) -> Void)? = nil`: a press on a notice button, with the row id and the button title.

Properties:

- `onQuery: ((String) -> Void)?`: the host hears the applied search query, so Command-F can search the whole session and not only the loaded window. Set it on your own instance, never on `.none`.
- `static let none`: services with no session, no file and no change source.

Methods:

- `func loaded(toolId: String) -> ToolLoaded?`: the detail of a finished call that an earlier load kept, if any.
- `func load(toolId: String, finished: Bool) async -> ToolLoaded?`: reads the detail of one call off the main thread and, for an Edit, the file's current lines and the edit's line. A `finished` call is kept for `loaded(toolId:)`.

```swift
let services = TranscriptServices(
    sessionId: envelope.sessionId,
    cwd: "/Users/dev/projects/atlas",
    nativeLog: SessionNativeLogStore.shared.load(path: envelope.filePath),
    changes: BatchedToolChangeSource(toolsBinary: bridge.binaryPath),
    showChange: { path, line in openDiff(path, line: line) }
)
services.onQuery = { query in searchWholeSession(query) }
```

#### `TranscriptVerbosity`

How much of the transcript's tool work is open and how many body lines show. The raw value is the case name. The transcript's toolbar stores the choice. A host can override it with `TranscriptPreset(verbosity:)`.

- `minimal`: chat only. Each run of tool calls folds into one summary line.
- `inputs`: one line per tool call with its main argument. A click opens the call.
- `outputs`: every call open, its output trimmed.
- `verbose`: every call open, nothing trimmed, thinking open.

Members:

- `title: String`, `detail: String`, `symbol: String`: the menu title, the one-line explanation and the SF Symbol name.
- `opensTools: Bool`: true for `outputs` and `verbose`.
- `opensThinking: Bool`: true for `verbose`.
- `bodyLimit: Int?`: body lines shown before `... +N lines`. 10, or nil (all lines) for `verbose`.

```swift
let preset = TranscriptPreset(verbosity: .outputs)

ForEach(TranscriptVerbosity.allCases) { level in
    Label(level.title, systemImage: level.symbol)
        .instantTooltip(level.detail)
}
```

#### `TranscriptWrap`

Which code blocks of a tool call wrap long lines instead of scrolling sideways. The transcript's toolbar persists the choice.

- `inputs: Bool = false`: wrap the full input block of a call, such as a long command or the JSON arguments.
- `outputs: Bool = false`: wrap the main body of a call: its result, a Write's content or an Edit's diff.
- `any: Bool`: true when either is on.
- `detail: String`: a sentence that names the current setting.

```swift
let wrap = TranscriptWrap(inputs: false, outputs: true)

CodeBlockText(block: input, cacheKey: "in-1", wrap: wrap.inputs)
CodeBlockText(block: output, cacheKey: "out-1", wrap: wrap.outputs)
Text(wrap.detail)
```

#### `SessionNativeLogStore`

A small cache of scanned session files, so a window that reopens a session does not scan it again. It keeps an entry while the file is unchanged. When the file only grew, it indexes the appended lines. The least recently used entries go when the count or the retained bytes pass a limit. `load` does synchronous file I/O, so call it off the main thread. A class.

- `byteLimit: Int = 32 * 1024 * 1024`: the most index bytes the store keeps.
- `countLimit: Int = 6`: the most session files the store keeps.
- `static let shared`: the process-wide store.
- `func load(path: String) -> SessionNativeLog?`: the scanned log for a session file. nil when the file cannot be read.

```swift
let log = await Task.detached(priority: .utility) {
    SessionNativeLogStore.shared.load(path: envelope.filePath)
}.value
```

#### `SessionNativeLog`

An index of a provider's own session file (Claude project files and Codex rollouts). It gives what `tools ai sessions tail --json` leaves out: token usage per model call, the model of each turn, the full input of every tool call and the full unclipped result. One scan stores only byte ranges and usage. `detail(for:)` reads one line from disk when a row asks. Scan and `detail` do file I/O, so call them off the main thread. A class.

Properties:

- `path: String`: the session file.
- `summary: SessionNativeSummary`: models per turn and usage totals.
- `toolCount: Int`: tool calls found in the scan.
- `retainedBytes: Int`: an estimate of the memory the index holds.
- `appendedBytesRead: Int`: bytes read past the first scan, for lines the live tail appended.

Methods:

- `static func scan(path: String) -> SessionNativeLog?`: one pass over the file. nil when it cannot be read.
- `func detail(for toolId: String) -> ToolCallDetail?`: the input and full result of one tool call, cached after the first read. A call written after the scan is found in the lines appended since.
- `func refreshSummarySnapshot() -> SessionNativeSummary`: indexes the appended region and returns the summary. Call it after coalesced tail updates.
- `static func shortModel(_ model: String) -> String`: the family word of a model id (`fable`, `opus`, `sonnet` or `haiku`), or the id itself, without a leading `claude-`, when no family matches.

```swift
if let log = SessionNativeLog.scan(path: envelope.filePath) {
    let detail = log.detail(for: "toolu_01A")
    let total = log.summary.total
}
```

#### `SessionNativeSummary`

The result of a scan of `SessionNativeLog`: which model made each turn and how many tokens each range of turns used. A host reads it from `SessionNativeLog.summary` and does not create it. Model names and per-call usage come from Claude files only.

- `models: [String: String]`: the short model name per transcript turn id, such as `opus` or `sonnet`.
- `total: SessionUsage`: usage of the whole file.
- `func model(forTurn id: String) -> String?`: the model of one turn.
- `func usage(fromTurn: String, untilTurn: String?) -> SessionUsage?`: usage of every model call from one turn up to, not including, another. nil `untilTurn` runs to the end of the file. The result is nil when either turn id is not in the file.

```swift
let summary = log.summary
let model = summary.model(forTurn: turnId)
let perPrompt = summary.usage(fromTurn: firstTurnId, untilTurn: nextPromptTurnId)
let whole = summary.total.compact
```

#### `SessionUsage`

Tokens and cost for a session, a prompt or a range of calls. Cost holds only what the session file or the provider reported. Nothing here prices tokens.

- `inputTokens: Int = 0`: fresh input tokens.
- `outputTokens: Int = 0`: output tokens.
- `cacheReadTokens: Int = 0`: tokens read from the prompt cache.
- `cacheWriteTokens: Int = 0`: tokens written to the prompt cache.
- `reasoningTokens: Int = 0`: reasoning tokens, for providers that report them.
- `modelCalls: Int = 0`: model calls counted.
- `costUsd: Double? = nil`: reported cost in US dollars. nil when none was reported.
- `costNote: String? = nil`: names the source of an estimated cost. The Cost tile's tooltip shows it.

Members:

- `isEmpty: Bool`: no calls, no tokens and no cost.
- `mutating func add(_ other: SessionUsage)`: adds another usage into this one.
- `compact: String`: a short line such as `in 1.2K · cache 88.4K · out 3.1K · $0.42`, for a prompt header.
- `detailed: String`: every figure, for a tooltip.

```swift
var usage = SessionUsage(inputTokens: 1_200, outputTokens: 3_100, cacheReadTokens: 88_400, modelCalls: 4, costUsd: 0.42)
usage.add(SessionUsage(outputTokens: 500, modelCalls: 1))
let line = usage.compact
```

#### `ToolCallDetail`

The parts of a tool call's input and result that the transcript envelope does not carry. `SessionNativeLog.detail(for:)` returns it. A host without a session file builds it in `TranscriptServices.detailLoader`. The type `ToolEditPair(old: String, new: String)` holds one replacement of an Edit.

- `filePath: String? = nil`: the file the call touched.
- `content: String? = nil`: for a Write, the whole file content.
- `edits: [ToolEditPair] = []`: for Edit and MultiEdit, every replacement in order.
- `patch: String? = nil`: for a Codex `apply_patch`, the patch text.
- `command: String? = nil`: the command of a shell call.
- `fullResult: String? = nil`: the result as the provider stored it, before clipping.
- `arguments: String? = nil`: the whole input as indented JSON with sorted keys, for a call whose transcript preview is one field of it (an Agent's prompt, a Grep's flags).

```swift
ToolCallDetail(
    filePath: "/Users/dev/projects/atlas/Sources/Parser.swift",
    edits: [ToolEditPair(old: "let limit = 10", new: "let limit = 20")]
)
```

#### `ToolLoaded`

A `ToolCallDetail` plus the file facts needed to draw an Edit with context. `TranscriptServices.load(toolId:finished:)` returns it.

- `detail: ToolCallDetail`: the call's input and full result.
- `editStart: Int? = nil`: the line of the first edit's new text in the file as it is now. nil when not found.
- `fileLines: [String]? = nil`: the file as it is now, for "show context" around an edit.

```swift
let detail = ToolCallDetail(
    filePath: path,
    edits: [ToolEditPair(old: "let limit = 10", new: "let limit = 20")]
)
let loaded = ToolLoaded(detail: detail, editStart: 12, fileLines: fileText.components(separatedBy: "\n"))
```

#### `ToolPresentation`

What a tool row shows, computed from a call without any view: the name, the main argument, a one-line summary and the code blocks. A host that draws its own tool row calls `make`. The type has no public init, so `make` is the only way to get a value.

- `static func make(line: TranscriptToolLine, loaded: ToolLoaded?, context: Int, cwd: String?, body: Bool = true) -> ToolPresentation`: builds the presentation. `context` is the number of file lines around an Edit's diff. `cwd` makes paths relative. `body: false` builds the header only.
- `static func relative(_ path: String, to cwd: String?) -> String`: the path relative to `cwd`, or with `~` for the home folder.
- `static let writeCap = 20`: lines of a Write's content shown before `... +N lines`.
- `static let editCap = 60`: lines of an Edit's diff shown before `... +N lines`.

Fields of the result:

- `name`, `argument`, `summary`: the call's display name, its main argument (the file path relative to `cwd` when the call has a file, else the first input line) and the status line (for example `Wrote 198 lines to ...`, `Running...`, `exit 1 · 4 lines`).
- `block: CodeBlock?`: the main body: the result, a Write's content or an Edit's diff.
- `input: CodeBlock?`: the full input when it does not fit the header.
- `inputRepeatsArgument: Bool`: the input block is the header's argument in full.
- `moreInputLines: Int`: input lines after the one `argument` shows.
- `failed: Bool`: the call failed.
- `filePath: String?`, `line: Int?`: the file and the line to open its diff at.
- `inputFirst: Bool`: the body is the call's input (an Edit's diff, a Write's content), so it comes before the status line.
- `bodyCap: Int?`: body lines shown before `... +N lines` at every level.

```swift
let loaded = await services.load(toolId: line.toolId, finished: line.status != .pending)
let presentation = ToolPresentation.make(line: line, loaded: loaded, context: 3, cwd: services.cwd)
let header = "\(presentation.name)(\(presentation.argument))  \(presentation.summary)"
let body = presentation.block.map { CodeBlockText(block: $0, limit: presentation.bodyCap, cacheKey: line.toolId) }
```

#### `ToolChangesView`

A summary under a Bash call that edited files: `N files changed`, with additions and deletions, opening to each file's colored hunks. A file with a before or after blob and no skip reason has a "More context" button. Every file has an "Open diff" button when `showChange` is set. The view asks the change source when it appears. It shows nothing while the source returns no files.

- `sessionId: String`: the session id.
- `toolId: String`: the tool call id.
- `source: ToolChangeSource`: where the changes come from.
- `cwd: String?`: the session folder, for relative paths.
- `showChange: ((String, Int?) -> Void)?`: the "Open diff" hook with a file path and line. nil hides the button.
- `startOpen: Bool`: whether the file list starts open.

```swift
ToolChangesView(
    sessionId: services.sessionId,
    toolId: line.toolId,
    source: changeSource,
    cwd: services.cwd,
    showChange: services.showChange,
    startOpen: false
)
```

#### `ToolChangeSource`

The protocol for a source of file changes behind a tool call. `TranscriptServices.changes` and `ToolChangesView` take any conforming type. It requires `Sendable`. Both requirements are async and have no default implementation.

- `func changes(sessionId: String, toolUseId: String) async -> [ToolFileChange]`: the files the call changed, with a diff each. An empty array when nothing was recorded or the source is not available.
- `func expandedDiff(for change: ToolFileChange, context: Int) async -> String?`: the same file's diff with `context` lines around each hunk. nil when it cannot be made.

```swift
struct FixedChangeSource: ToolChangeSource {
    let files: [String: [ToolFileChange]]
    func changes(sessionId: String, toolUseId: String) async -> [ToolFileChange] { files[toolUseId] ?? [] }
    func expandedDiff(for change: ToolFileChange, context: Int) async -> String? { nil }
}
```

#### `ToolFileChange`

One file that a tool call changed, with its diff or the blobs it can be rebuilt from.

- `path: String`: the file path.
- `status: String`: `modified`, `added`, `deleted`, or whatever the change log says.
- `unifiedDiff: String? = nil`: the diff text.
- `beforeBlob: String? = nil`: the object id of the content before the call.
- `afterBlob: String? = nil`: the object id of the content after the call.
- `skipReason: String? = nil`: why the log has no diff: `no-after-state`, `no-before-state`, `binary`, `large`, `missing-blob` or another text. When set, no diff is drawn from the blobs.

Members:

- `id: String`: the path, for `Identifiable`.
- `skipLabel: String?`: the skip reason in words, such as `no diff: binary or large file`.
- `counts: (additions: Int, deletions: Int)`: added and removed lines of the diff, file headers excluded.
- `firstLine: Int?`: the new-side line of the first hunk, for "open the diff at this line".

```swift
let change = ToolFileChange(
    path: "Sources/Parser.swift",
    status: "modified",
    unifiedDiff: diffText
)
let (added, removed) = change.counts
let label = change.skipLabel ?? "+\(added) -\(removed)"
```

#### `BatchedToolChangeSource`

The change source for a transcript. Every tool row that asks within 100 ms of the first shares one `tools agents changes <session> --tools a,b,c --json` run, and runs go one at a time. This keeps a transcript with many Bash calls from starting one process per row. Answers stay for the life of the source. When a resident `tools` server is given, it is asked first. Create one source per open session. A class that conforms to `ToolChangeSource`.

- `toolsBinary: String?`: the `tools` executable. nil searches PATH and the usual install places.
- `server: ToolsServerClient? = nil`: a resident `tools` server to ask before starting a process. A server answer carries every diff but stores no blobs, so the first "more context" on a file stores them with one process run.
- `trace: Trace? = nil`: called when a batch starts, with its call count. It returns a closure that ends the batch with a note. The type is `@Sendable (_ calls: Int) -> @Sendable (_ note: String) -> Void`. nil writes a `toolChanges.batch` perf mark.

Members:

- `func changes(sessionId: String, toolUseId: String) async -> [ToolFileChange]`: the changes of one call, through the shared batch.
- `func expandedDiff(for change: ToolFileChange, context: Int) async -> String?`: a diff with more context.
- `var runs: Int { get async }`: batch runs started so far, for tests and benches.
- `static func decode(_ text: String) -> [String: [ToolFileChange]]`: reads the CLI's `{ tools: [{ toolUseId, files }] }` output into changes per tool call id.

```swift
let source = BatchedToolChangeSource(
    toolsBinary: bridge.binaryPath,
    server: server,
    trace: { calls in { note in print("batch of \(calls): \(note)") } }
)
let files = await source.changes(sessionId: sessionId, toolUseId: "toolu_01A")
```

#### `CLIToolChangeSource`

The change source that starts one `tools agents changes --tool` process per tool call and caches a successful answer. Use it where only a few calls are asked, or when the batched source is not wanted. Prefer `BatchedToolChangeSource` for a full transcript. A class that conforms to `ToolChangeSource`.

- `toolsBinary: String? = nil`: the `tools` executable. nil searches PATH and the usual install places.
- `objectsDir: String = (NSHomeDirectory() as NSString).appendingPathComponent(".genesis-tools/agents/_objects")`: the bare git directory that holds the before and after blobs, used for `expandedDiff`.
- `timeout: TimeInterval = 10`: seconds before a process is stopped. A failed or timed-out run is not cached.

Members:

- `binaryPath: String?`: the `tools` executable in use. nil when none was found.
- `func changes(sessionId: String, toolUseId: String) async -> [ToolFileChange]`: the changes of one call.
- `func expandedDiff(for change: ToolFileChange, context: Int) async -> String?`: a diff with more context, from `git diff -U<n>` on the stored blobs.
- `static func decode(_ text: String) -> [ToolFileChange]`: reads the `{ files: [...] }` output. It accepts both spellings the change log has used (`beforeOid` and `beforeBlob`, `diff` and `unifiedDiff`).
- `static func run(_ executable: String, _ arguments: [String], timeout: TimeInterval) async -> String?`: runs a process the way `ToolsBridge` does and returns its stdout. nil on a launch failure, a non-zero exit or a timeout.

```swift
let source = CLIToolChangeSource(toolsBinary: bridge.binaryPath, timeout: 20)
let files = await source.changes(sessionId: sessionId, toolUseId: "toolu_01A")
if let change = files.first, let diff = await source.expandedDiff(for: change, context: 10) {
    print(diff)
}
```

#### `ToolChangeBatcher`

The queue behind `BatchedToolChangeSource`, usable with any fetch function. Callers wait on a key (session id and tool call id). Keys go out in batches of up to `maxBatch`, one batch at a time. A caller whose task is canceled stops waiting, and a key nobody waits for is not sent. A failed batch is not cached. An actor.

- `fetch: Fetch`: the batch function, `@Sendable (_ sessionId: String, _ toolIds: [String]) async -> [String: [ToolFileChange]]?`. It returns changes per tool call id, or nil when the fetch failed.
- `static let maxBatch = 40`: the most calls in one batch.
- `static let gather: Duration = .milliseconds(100)`: how long the first request waits for the rows that appear with it.
- `func request(sessionId: String, toolUseId: String) async -> [ToolFileChange]`: the changes of one call. An empty array on failure or cancellation.
- `runs: Int`: batches started so far. Read it with `await`.

```swift
let batcher = ToolChangeBatcher { sessionId, toolIds in
    await fetchChanges(sessionId: sessionId, toolIds: toolIds)
}
let files = await batcher.request(sessionId: sessionId, toolUseId: "toolu_01A")
```

#### `ToolChangeHeuristics`

A quick test for whether a shell command looks like it writes files. Only such rows ask a change source, so a session with 300 `rg` calls starts no processes. A miss hides a change. A false hit costs one short lookup.

- `static func mayEditFiles(_ command: String) -> Bool`: true when the command contains a marker such as `sed -i`, `python`, `git apply`, `>>`, ` tee ` or `--fix`.

```swift
if ToolChangeHeuristics.mayEditFiles("sed -i '' 's/a/b/' Sources/Parser.swift") {
    // Ask the change source for this call.
}
```

#### `CodeBlockText`

Draws one `CodeBlock`: the gutter (line numbers and diff marks) in its own column and the code beside it as selectable text, so a copy never carries the numbers. In the scrolling mode it draws an empty box of the final size first. Syntax coloring is computed off the main thread and swaps in, and a cache keeps the result for recycled rows. Long lines scroll sideways, or wrap when `wrap` is true.

- `block: CodeBlock`: the lines to draw.
- `limit: Int? = nil`: the lines to show. nil shows all.
- `cacheKey: String`: a stable identity for the block's content, such as a row id plus a variant. The cache also hashes the content.
- `wrap: Bool = false`: wrap long lines under their own number instead of scrolling sideways.

```swift
CodeBlockText(
    block: CodeBlockBuilder.numbered(excerpt, start: 40, language: .forPath(path), focus: 52),
    limit: 20,
    cacheKey: "excerpt-\(path):52"
)
```

#### `CodeBlock`

The model behind a code body: lines with a number, a mark and text, plus the language. It is immutable, so the values derived at init stay true.

- `lines: [CodeLine]`: the lines.
- `language: SyntaxLanguage`: the language used for coloring.
- `failed: Bool = false`: draw every line red, as for the output of a failed call.

Members:

- `isDiff: Bool`: true when any line is added or removed.
- `fingerprint: Int`: a hash of everything drawn, taken once at init, for cache keys.
- `lineColumns: [Int]`: each line's width in monospaced columns.
- `additions: Int`, `removals: Int`: counts of added and removed lines.
- `func size(limit: Int?) -> (code: CGSize, gutter: CGSize, hasGutter: Bool)`: the size the block will have without rendering it.

```swift
let block = CodeBlock(
    lines: [
        CodeLine(number: 11, mark: .removed, text: "let limit = 10"),
        CodeLine(number: 11, mark: .added, text: "let limit = 20"),
    ],
    language: .swift
)
```

#### `CodeLine`

One line of a `CodeBlock`.

- `number: Int? = nil`: the line number shown in the gutter. nil draws none.
- `mark: Mark`: how the line is drawn.
- `text: String`: the line's text.

`CodeLine.Mark` cases:

- `context`: an unchanged line.
- `added`: an added line, on a green band.
- `removed`: a removed line, on a red band.
- `gap`: a separator between hunks, such as `12 unchanged lines`.
- `focus`: the line a `file:line` reference points at, tinted so it stands out.

```swift
let lines = [
    CodeLine(number: 11, mark: .removed, text: "let limit = 10"),
    CodeLine(number: 11, mark: .added, text: "let limit = 20"),
    CodeLine(mark: .gap, text: "12 unchanged lines"),
    CodeLine(number: 24, mark: .focus, text: "return limit"),
]
```

#### `CodeBlockBuilder`

Static builders that make a `CodeBlock` from plain output, a Read result, an Edit, a unified diff or a Codex patch.

- `static func numbered(_ text: String, start: Int = 1, language: SyntaxLanguage, failed: Bool = false, focus: Int? = nil) -> CodeBlock`: numbers the lines from `start`. A Read result whose lines already start with a number and an arrow or a tab keeps those numbers. `focus` marks the line with that number.
- `static func edit(old: String, new: String, start: Int?, language: SyntaxLanguage) -> CodeBlock`: an Edit's replacement as a line diff. `start` is the line of `old` in the file when known. Unchanged lines more than 3 lines from a change fold into gap lines.
- `static func unifiedDiff(_ text: String, language: SyntaxLanguage) -> CodeBlock`: the hunks of `git diff` output. File headers are dropped. Each hunk header after the first becomes a gap line.
- `static func patch(_ text: String, language: SyntaxLanguage) -> CodeBlock`: a Codex `apply_patch` body.
- `static func lineDiff(_ a: [String], _ b: [String]) -> [Step]`: a longest-common-subsequence line diff. When the two line counts multiply to more than 160,000 (400 by 400), it lists all removals, then all additions. `Step` cases are `same(String)`, `removed(String)` and `added(String)`.
- `static func foldContext(_ lines: [CodeLine], keep: Int) -> [CodeLine]`: keeps `keep` context lines around each change and folds the rest into gap lines.

```swift
let read = CodeBlockBuilder.numbered(fileText, start: 40, language: .forPath("Sources/Parser.swift"), focus: 52)
let change = CodeBlockBuilder.edit(old: "let limit = 10", new: "let limit = 20", start: 11, language: .swift)
let diff = CodeBlockBuilder.unifiedDiff(gitDiffOutput, language: .swift)
```

#### `SyntaxLanguage`

The language of a code body, used to color it. A String enum.

- Cases: `swift`, `typescript`, `javascript`, `json`, `python`, `shell`, `go`, `rust`, `cLike`, `java`, `kotlin`, `ruby`, `php`, `css`, `html`, `yaml`, `markdown`, `sql`, `toml` and `plain` (no coloring).
- `static func forPath(_ path: String) -> SyntaxLanguage`: picks the language by file extension, or by a few well-known names such as `Dockerfile`, `Makefile` and `.zshrc`. An unknown extension gives `plain`.

```swift
let swift = SyntaxLanguage.forPath("Sources/Parser.swift")
let shell = SyntaxLanguage.forPath("Dockerfile")
let plain = SyntaxLanguage.forPath("notes.xyz")
let block = CodeBlockBuilder.numbered(fileText, language: swift)
```

#### `SyntaxHighlighter`

A small token scanner for code bodies. It needs no grammar files and is approximate on purpose. Use one instance per block, because it carries block-comment state from line to line.

- `language: SyntaxLanguage`: the language to scan.
- `init(language: SyntaxLanguage)`: creates a scanner.
- `mutating func runs(_ line: String) -> [(SyntaxToken, Int)]`: runs of a token and its length in Unicode scalars, covering the whole line in order.

`SyntaxToken` cases: `plain`, `comment`, `string`, `number`, `keyword`, `type`, `call`, `key`, `flag` and `heading`. Each has a `color: Color`.

```swift
var highlighter = SyntaxHighlighter(language: .swift)
for line in source.components(separatedBy: "\n") {
    for (token, length) in highlighter.runs(line) {
        // Color the next `length` scalars with token.color.
    }
}
```

#### `CodeBlockRenderer`

Turns a `CodeBlock` into attributed text for drawing. `CodeBlockText` uses it. A host calls it to draw a block in its own view. It keeps the gutter and the code in two strings, so selecting and copying code never takes the numbers.

- `static func attributed(_ block: CodeBlock, limit: Int?, highlight: Bool, drawn: Int? = nil) -> CodeBlockAttributed`: renders the first `limit` lines (all when nil). `highlight` turns syntax coloring on. With `drawn`, lines past the first `drawn` stay empty, so the block keeps its full height and the work stays bounded.
- `static func lines(of text: AttributedString) -> [AttributedString]`: splits a rendered column at its line breaks.
- `static func lines(of text: AttributedString, limit: Int) -> [AttributedString]`: the same, stopping after `limit` lines.
- `static let highlightLimit = 1500`: lines past this are never syntax-colored.
- `static let firstDrawLimit = 200`: lines the plain first draw gives text to.
- `static let maxBandColumns = 400`: the widest a diff band is padded.
- `static let font`: the code font, monospaced 11.5 pt.

`CodeBlockAttributed` fields: `gutter` and `body` (`AttributedString`), `hasGutter`, `spoken` (a `String?` for VoiceOver, with "added" and "removed" before changed lines of a diff, nil for a block that needs none), `wrapTail` (the lines past `firstDrawLimit` in wrap mode), `lineCount`, `columns` and `gutterColumns`.

```swift
let rendered = CodeBlockRenderer.attributed(block, limit: 50, highlight: true)

HStack(alignment: .top) {
    if rendered.hasGutter { Text(rendered.gutter) }
    Text(rendered.body)
}
.font(CodeBlockRenderer.font)
```

#### `CodeBlockMetrics`

Sizes a code block from its line and column counts, with no text layout. This avoids asking SwiftUI to measure a long block.

- `static let columnWidth: CGFloat`: the width of one monospaced cell.
- `static let lineHeight: CGFloat`: the height of one line.
- `static let lineSpacing: CGFloat = 1.5`: the space between lines.
- `static func size(lines: Int, columns: Int) -> CGSize`: the size of a block with one spare column.
- `static func columns(_ text: String) -> Int`: the width of a string in cells. A tab counts 8 and a character outside ASCII counts 2.

```swift
let columns = CodeBlockMetrics.columns("let limit = 20")
let size = CodeBlockMetrics.size(lines: 12, columns: columns)
Color.clear.frame(width: size.width, height: size.height)
```

#### `CodeBlockCache`

A shared cache of rendered code bodies, so a recycled row draws again without highlighting again. It holds up to 1500 entries. A class.

- `static let shared`: the process-wide cache.
- `func get(_ key: String) -> CodeBlockAttributed?`: the cached body for a key.
- `func set(_ key: String, _ value: CodeBlockAttributed)`: stores a body.

```swift
let key = "row-1#out"
let rendered = CodeBlockCache.shared.get(key) ?? CodeBlockRenderer.attributed(block, limit: nil, highlight: true)
CodeBlockCache.shared.set(key, rendered)
```

### Settings

The native settings window and the controls that fill it. A host describes its settings as `NativeSettingsPage` values (an id, a title, an SF Symbol, a tint and a SwiftUI view), groups them into `NativeSettingsSection`s that sort by `order`, and gives the sections to `FeatureSettingsWindowController`. The controller owns a `NativeSettingsStore` (the catalog and the selected page) and shows it in `FeatureSettingsView`; a host can also build the store and the view itself, or add sections later with `register(section:)`. Inside a page, the host builds its controls from `NativeSettingsCard`, `NativeSettingsRow`, `NativeSettingsToggle` and the pickers. Every page reads `NativeSettingsAppearance` (reduce motion, reduce transparency, theme) from the environment, and the glass and backdrop modifiers draw each surface for the chosen theme. The Hub pages and the notification client at the end are ready-made pieces for specific hosts. `ClientConfigFile`, `KitSettingsBackend` and `SettingsDocument` keep a feature's own settings: one Codable value per feature, in `~/.genesis/client.json` or a `UserDefaults` suite.

#### `FeatureSettingsWindowController`

Owns the settings window and its `NativeSettingsStore`. Use it when a host wants the standard settings window: it builds the window once, restores its saved frame and selects a page on request.

- `title: String = "Settings"`: the window title and the sidebar heading.
- `sections: [NativeSettingsSection]`: the pages to show. An invalid catalog (empty or duplicate ids) shows no pages, only its error message.
- `defaults: UserDefaults = .standard`: where the selected page is remembered.
- `selectionKey: String = "featureSettings.selectedPage"`: the defaults key for the selected page id.
- `initialPageID: String? = nil`: the page to open first. When nil, the remembered page, then the first page.
- `appearance: NativeSettingsAppearance? = nil`: the appearance model. When nil, `NativeSettingsAppearance.shared`.
- `frameAutosaveName: String = "FeatureSettings.window"`: the name the window frame is saved under.

Properties:

- `store: NativeSettingsStore`: the catalog behind the window.
- `window: NSWindow?`: the window, nil until `prepare(pageID:)` or `show(pageID:)` runs.

Methods:

- `register(section: NativeSettingsSection) -> Bool`: adds or replaces a section in the store. Returns false when the catalog would become invalid.
- `prepare(pageID: String? = nil) -> NSWindow`: selects the page and creates the window without showing it (960 by 760 points, content minimum 860 by 650, dark appearance, transparent title bar). A later call returns the same window. The frame is centered when no saved frame exists or its title bar is off every screen.
- `show(pageID: String? = nil)`: prepares the window, makes it key and frontmost and activates the app.
- `close()`: closes the window.

```swift
let general = NativeSettingsSection(id: "general", title: "", pages: [
    NativeSettingsPage(id: "general", title: "General", symbol: "gearshape.fill", tint: .gray) {
        NativeSettingsGeneralPage()
    },
], order: 0)
let settings = FeatureSettingsWindowController(
    title: "Acme Settings", sections: [general, syncSection], initialPageID: "general")
settings.show(pageID: "sync.schedule")
```

#### `NativeSettingsSection`

A titled group of pages in the sidebar. Ids must be non-empty and unique among sections.

- `id: String`: the section id.
- `title: String`: the heading above the pages. An empty title draws no heading.
- `pages: [NativeSettingsPage]`: the pages in the group, in order.
- `order: Int = 50`: sections sort by this value, lowest first.

```swift
let schedulePage = NativeSettingsPage(
    id: "sync.schedule", title: "Schedule", symbol: "clock", tint: .blue
) { SyncScheduleSettings(model: syncModel) }
let syncSection = NativeSettingsSection(
    id: "sync", title: "Sync", pages: [schedulePage], order: 20)
```

#### `NativeSettingsPage`

One page of the settings window. The sidebar row shows the symbol on a tinted tile and the title. The page header shows the title and subtitle, and the page body is the `content` view in a scroll view.

- `id: String`: the page id. It must be non-empty and unique across all pages in the catalog.
- `title: String`: the sidebar row and the page heading.
- `symbol: String`: the SF Symbol name.
- `tint: Color`: the color of the symbol tile.
- `subtitle: String = ""`: a line under the page heading. Empty draws nothing.
- `content: () -> Content`: the page body, a `@ViewBuilder` closure. It runs each time the page is built.

```swift
NativeSettingsPage(
    id: "sync.schedule", title: "Schedule", symbol: "clock", tint: .blue,
    subtitle: "Choose when the sync runs."
) {
    SyncScheduleSettings(model: syncModel)
}
```

#### `NativeSettingsStore`

The catalog of sections and the selected page. `FeatureSettingsWindowController` creates one; create your own to show settings inside a window you manage with `FeatureSettingsView`. Sections that fail validation are not accepted. The selected page is remembered in `UserDefaults`.

- `sections: [NativeSettingsSection]`: the starting catalog. An invalid catalog is dropped and `catalogError` says why.
- `defaults: UserDefaults = .standard`: where the selected page is saved.
- `selectionKey: String = "featureSettings.selectedPage"`: the defaults key.
- `initialPageID: String? = nil`: the page to select first. When nil, the saved page, then the first page.
- `appearance: NativeSettingsAppearance? = nil`: when nil, `NativeSettingsAppearance.shared`.

Properties (all read only):

- `sections: [NativeSettingsSection]`: the accepted sections in `order`.
- `selectedPageID: String?`: the selected page id.
- `selectedPage: NativeSettingsPage?`: the selected page.
- `catalogError: NativeSettingsCatalogError?`: the last validation failure, or nil. A `register(section:)` call that succeeds clears it. The cases are `emptySectionID`, `emptyPageID`, `duplicateSectionID(String)` and `duplicatePageID(String)`; its `description` is a readable message, and the settings view shows it in orange above the page.
- `pendingPageID: String?`: a requested page that does not exist yet. A later `register(section:)` that adds it selects it.
- `appearance: NativeSettingsAppearance`: the appearance model.

Methods:

- `select(pageID: String) -> Bool`: selects the page and saves it. Returns false and keeps the id as pending when no page has that id.
- `register(section: NativeSettingsSection) -> Bool`: adds the section, or replaces the one with the same id. Returns false and sets `catalogError` when the new catalog would be invalid; the catalog then stays as it was.
- `static func validate(_ sections: [NativeSettingsSection]) -> NativeSettingsCatalogError?`: checks for empty and duplicate ids.

```swift
let store = NativeSettingsStore(sections: sections, initialPageID: "general")
if !store.register(section: pluginSection) {
    print(store.catalogError?.description ?? "invalid catalog")
}
store.select(pageID: "sync.schedule")
```

#### `FeatureSettingsView`

The settings screen: a sidebar of sections and pages on the left and the selected page on the right. It draws the `NativeSettingsBackdrop` under the title bar, applies `titlebarZone()`, forces the dark color scheme and sets a minimum size of 860 by 650. It passes the store and the appearance model to the pages as environment objects, so a page can read `@EnvironmentObject var appearance: NativeSettingsAppearance`. Use it when you host the settings in your own window.

- `store: NativeSettingsStore`: the catalog to show.
- `title: String = "Settings"`: the heading above the sidebar.

```swift
let store = NativeSettingsStore(sections: sections, initialPageID: "general")
let view = FeatureSettingsView(store: store, title: "Acme Settings")
window.contentView = NSHostingView(rootView: view)
```

#### `NativeSettingsAppearance`

The shared appearance preferences: reduce motion, reduce transparency and theme. A change is saved under `<keyPrefix>.reduceMotion`, `<keyPrefix>.reduceTransparency` and `<keyPrefix>.theme` and announced to the other processes of the same app with a distributed notification, which makes them reload. The default theme is Glass.

- `defaults: UserDefaults = .standard`: where the values live.
- `notificationNamespace: String = Bundle.main.bundleIdentifier ?? "dev.genesis.native"`: names the change notification and the log subsystem.
- `keyPrefix: String = "featureSettings.appearance"`: the prefix of the three defaults keys.
- `observeExternalChanges: Bool = true`: reload when another process posts a change. Pass false for a scripted run.

Properties:

- `static let shared`: the instance hosts share by default.
- `reduceMotion: Bool`, `reduceTransparency: Bool`, `theme: NativeSettingsTheme`: settable. Each change is saved and announced.
- `notificationNamespace: String` and `notificationName: Notification.Name`: the notification this instance posts and observes.

Methods:

- `migrateIfNeeded(reduceMotion: Bool, reduceTransparency: Bool)`: copies old values into the new keys, only for a key that has no value yet.
- `reloadFromDefaults()`: reads the three values again without announcing them.

```swift
let appearance = NativeSettingsAppearance(defaults: defaults, notificationNamespace: "dev.example.acme")
appearance.theme = .midnight
let store = NativeSettingsStore(sections: sections, defaults: defaults, appearance: appearance)
```

#### `NativeSettingsTheme`

The look of native windows and widgets. It is `CaseIterable`, `Codable` and `Identifiable`, and its raw values are the lowercase case names.

- `glass`: the blurred desktop under a strong dark tint.
- `solid`: the system window background.
- `gradient`: the system window background under a purple-to-pink tint.
- `graphite`: solid near-black.
- `midnight`: solid blue-black with cool hairlines.
- `dusk`: the gradient's hues, darker and richer.
- `init?(stored: String?)`: reads a saved value. The retired name "smoked" reads as `glass`. Any other unknown value gives nil. Decoding an unknown value throws.
- `title: String`: the display name, such as "Glass".
- `isSeeThrough: Bool`: true only for `glass`.
- `effective(reduceTransparency: Bool, systemReduceTransparency: Bool) -> NativeSettingsTheme`: the theme to draw. If either flag is true, `glass` becomes `graphite`, `solid` and `gradient` become `solid`, and `midnight` and `dusk` stay.

```swift
let stored = NativeSettingsTheme(stored: defaults.string(forKey: "acme.theme")) ?? .glass
let drawn = stored.effective(reduceTransparency: true, systemReduceTransparency: false)
print(drawn.title, stored.isSeeThrough)
```

#### `NativeSettingsGeneralPage`

The standard General page: a Theme card with `NativeSettingsThemePicker`, an Appearance card with Reduce motion and Reduce transparency switches, and an accessibility note. It reads `NativeSettingsAppearance` from the environment, which `FeatureSettingsView` provides. It has no parameters.

```swift
NativeSettingsPage(id: "general", title: "General", symbol: "gearshape.fill", tint: .gray,
    subtitle: "Appearance and accessibility.") {
    NativeSettingsGeneralPage()
}
```

#### `NativeSettingsAboutPage`

The standard About page: the app name on a gradient banner, the version from `CFBundleShortVersionString` and a button that copies the app name, the version and the macOS version to the clipboard. Nothing is sent anywhere.

- `appName: String = "GenesisTools"`: the name shown and copied.
- `additionalInfo: [String] = []`: extra lines, each in the About card under a divider.

```swift
NativeSettingsPage(id: "about", title: "About", symbol: "info.circle.fill", tint: .gray) {
    NativeSettingsAboutPage(
        appName: "Acme",
        additionalInfo: ["Icons are drawn with SF Symbols."])
}
```

#### `NativeSettingsCard`

A glass card that groups related rows on a page, with an optional heading.

- `title: String? = nil` (unlabeled first argument): the heading.
- `subtitle: String? = nil`: a smaller line under the heading. Shown only when a title is set.
- `content: () -> Content`: the rows, a `@ViewBuilder` closure.

```swift
NativeSettingsCard("Schedule", subtitle: "When the sync runs.") {
    NativeSettingsToggle("Sync on launch", isOn: $model.syncOnLaunch)
    Divider()
    NativeSettingsToggle("Sync in the background", isOn: $model.background)
}
```

#### `NativeSettingsRow`

A row with a title and optional detail on the left and an accessory control on the right. A disabled row dims its title and keeps the detail readable.

- `title: String` (unlabeled): the row title.
- `detail: String? = nil`: a smaller line under the title.
- `accessory: () -> Accessory`: the control on the right, a `@ViewBuilder` closure.

```swift
NativeSettingsRow("Idle for at least", detail: "Shorter idle times are kept.") {
    NativeSettingsNumberPicker("Idle days", range: 0..<91, identifier: "acme.idle", value: $model.idleDays)
}
```

#### `NativeSettingsToggle`

A row with a switch on the right.

- `title: String` (unlabeled): the row title and the switch label.
- `detail: String? = nil`: a smaller line under the title.
- `identifier: String? = nil`: the accessibility identifier. When nil, `settings.toggle.<title>`.
- `isOn: Binding<Bool>`: the value.

```swift
NativeSettingsToggle(
    "Reduce motion",
    detail: "Keep transitions still.",
    identifier: "acme.reduceMotion",
    isOn: $model.reduceMotion)
```

#### `NativeSettingsPageIcon`

The rounded, tinted tile with a white SF Symbol that marks a page in the sidebar and the page header.

- `symbol: String`: the SF Symbol name.
- `tint: Color`: the tile color.
- `size: CGFloat = 28`: the tile edge in points.

```swift
HStack(spacing: 10) {
    NativeSettingsPageIcon(symbol: "clock", tint: .blue, size: 22)
    Text("Schedule")
}
```

#### `NativeSettingsDisclosure`

A folded section with a chevron row. It starts closed unless its identifier is listed in `NativeSettingsLaunch.expanded`. It honors reduce motion.

- `title: String` (unlabeled): the row text.
- `identifier: String`: the accessibility identifier, also the name `--expand` uses.
- `content: () -> Content`: the folded content, a `@ViewBuilder` closure.

```swift
NativeSettingsDisclosure("Manage folders", identifier: "acme.library.folders") {
    FolderList(model: model)
}
```

#### `NativeSettingsLaunch`

Reads the command line for `--expand <identifier>[,<identifier>...]`. A `--snapshot` run cannot click, so this is how a script opens folded content before it draws.

- `static let expanded: Set<String>`: the identifiers named after `--expand`. Empty when the flag is absent.

```swift
let identifier = "acme.library.folders"
let opensFolded = NativeSettingsLaunch.expanded.contains(identifier)
print("\(identifier) starts \(opensFolded ? "open" : "closed")")
```

#### `NativeSettingsNumberPicker`

An integer picker. A range of 60 values or fewer is a menu that lists zero-padded values. A larger range is a text field with a stepper, and an entry outside the range is clamped.

- `title: String` (unlabeled): the accessibility label.
- `range: Range<Int>`: the allowed values. The upper bound is excluded.
- `identifier: String`: the accessibility identifier. The stepper adds `.stepper`.
- `value: Binding<Int>`: the value.

```swift
NativeSettingsRow("Retries", detail: "Attempts before the sync gives up.") {
    NativeSettingsNumberPicker(
        "Retries", range: 0..<10,
        identifier: "acme.retries", value: $model.retries)
}
```

#### `NativeSettingsTimePicker`

A time of day as an hour menu and a minute menu in a small panel with a clock icon. The value is minutes since midnight. A value outside 0 through 1439 is shown clamped to that range.

- `title: String` (unlabeled): the panel label.
- `identifier: String`: the base accessibility identifier. The menus add `.hour` and `.minute`.
- `minutes: Binding<Int>`: minutes since midnight.

```swift
NativeSettingsCard("Quiet hours") {
    NativeSettingsTimePicker("Start", identifier: "acme.quiet.start", minutes: $model.quietStart)
    NativeSettingsTimePicker("End", identifier: "acme.quiet.end", minutes: $model.quietEnd)
}
```


#### `NativeSettingsSlider`

A row with a slider: the title and detail on the left, the track and its formatted value ("1.00×", "45 s") on the right. The value applies live while the knob moves; `onCommit` runs once at the end of each gesture that changed the value (mouse-up or a drag the system cancelled, each arrow-key step, each accessibility increment), so a host that persists with a synchronous file write does it once per gesture, never per drag tick or plain click. The track is drawn by the kit: it keeps the accent fill in every window, grows the knob under the pointer, shows the pointing hand, takes the arrow keys when focused through keyboard navigation (Shift for ten steps) and adjusts through VoiceOver and UI automation (AXIncrement).

- `title: String` (unlabeled), `detail: String? = nil`
- `identifier: String`: the slider's accessibility identifier.
- `value: Binding<Double>`
- `in range: ClosedRange<Double>`
- `step: Double? = nil`: snap to multiples of `step` from the lower bound; nil is continuous (keys then move a twentieth of the range).
- `ticks: [Double] = []`: values marked under the track.
- `width: CGFloat = 200`: the track width.
- `format: (Double) -> String`: the value label, also the accessibility value.
- `onCommit: ((Double) -> Void)? = nil`: the final value of each gesture.

```swift
NativeSettingsSlider(
    "Effect intensity", detail: "How strong the overlay should feel.", identifier: "posture.effects.intensity",
    value: $model.intensity, in: 0.25...2, step: 0.05, ticks: [0.5, 1, 1.5, 2],
    format: { String(format: "%.2f×", $0) },
    onCommit: { _ in model.save() })
```

#### `NativeSettingsSegmented`

A row whose choice is a few short words side by side, drawn with `GenSegmentedTabs` (accent pill in every window, hover fill, pointer). When the selected option has a `detail`, it shows under the row in a quiet note. Options are `NativeSettingsOption(value, title, detail:, symbol:)`, shared with `NativeSettingsPicker`; each segment's identifier is `<identifier>.<value>` (`GenAccessibilityID.suffix`).

- `title: String` (unlabeled), `detail: String? = nil`
- `identifier: String`
- `options: [NativeSettingsOption<Value>]`
- `selection: Binding<Value>`
- `minSegmentWidth: CGFloat = 64`

```swift
NativeSettingsSegmented(
    "Frame rate", identifier: "posture.detection.rate",
    options: [
        .init(.batterySaver, "Battery saver", detail: "Checks every 30 s, camera off in between."),
        .init(.balanced, "Balanced", detail: "4 fps, 10 fps while correcting."),
        .init(.responsive, "Responsive", detail: "10 fps."),
    ],
    selection: $model.rate)
```

#### `NativeSettingsPicker`

A row that picks one of several options, each with a title and a sentence that says what it does. The button shows the selected title (and its symbol); a click opens a list of every option with its description, built only while it is open (Up and Down move, Return picks, Escape closes). The selected option's description stays under the row. Each option's identifier is `<identifier>.option.<value>`.

- `title: String` (unlabeled), `detail: String? = nil`
- `identifier: String`: the button's identifier.
- `options: [NativeSettingsOption<Value>]`
- `selection: Binding<Value>`
- `width: CGFloat = 220`: the button width.

```swift
NativeSettingsPicker(
    "Effect style", detail: "The look of the screen while you slouch.", identifier: "posture.effects.style",
    options: ScreenEffectStyle.allCases.map { .init($0, $0.title, detail: $0.detail, symbol: $0.symbol) },
    selection: $model.style)
```

#### `NativeSettingsPathList`

A block for a list of folders ("Watch these folders", "Never scan"): the title and an Add button on top, then one row per folder with its home-relative path (the full path in a tooltip), Show in Finder and Remove. Add opens the system chooser (several at once) and never adds a folder twice. A folder that no longer exists keeps its row and says "Missing", so the user decides. A `~/` path from a config file is read as the home folder's (for "Missing", Show in Finder and duplicates), and a list that holds the same path twice still draws every row. Identifiers: `<identifier>.add`, and per row `.row.<index>`, `.reveal.<index>`, `.remove.<index>`.

- `title: String` (unlabeled), `detail: String? = nil`
- `identifier: String`
- `paths: Binding<[String]>`: absolute paths.
- `addTitle: String = "Add Folder…"`, `emptyText: String = "No folders yet."`
- `allowsFiles: Bool = false`: the chooser also takes files.
- `onCommit: (([String]) -> Void)? = nil`: the new list after each add or remove.

```swift
NativeSettingsPathList(
    "Watched folders", detail: "New big files here show in the radar.", identifier: "disk.radar.folders",
    paths: $model.watched, onCommit: { _ in model.save() })
```

#### `NativeSettingsByteThreshold`

A row for a size limit ("Warn below 10 GB"): a typed number and a unit menu. Bytes are decimal like `ByteFormat.file` and Finder (1 GB = 1,000,000,000). Typing changes nothing until Return or focus loss; then the text is read (a comma counts as the decimal point), multiplied by the unit, clamped to `range`, written once, and `onCommit` runs when the bytes changed. Text that was not edited is never read back, so tabbing through keeps the exact bytes (the field shows two decimals). Picking a unit converts the value when nothing was typed (10 GB shows as 10000 MB) and reads a typed number in the new unit ("2" with GB picked is 2 GB). Text that is not a number keeps the old value. A range up to `Int64.max` is safe. The field's tooltip names the range. Identifiers: `<identifier>` (field) and `<identifier>.unit`.

- `title: String` (unlabeled), `detail: String? = nil`
- `identifier: String`
- `bytes: Binding<Int64>`
- `range: ClosedRange<Int64>`
- `units: [Unit] = [.mb, .gb]`: from `.kb`, `.mb`, `.gb`, `.tb`. The field starts in the largest unit the value fills.
- `onCommit: ((Int64) -> Void)? = nil`

```swift
NativeSettingsByteThreshold(
    "Warn below", detail: "Free space that starts the warning tier.", identifier: "disk.alerts.watch",
    bytes: $model.watchFloor, range: 100_000_000...500_000_000_000, onCommit: { _ in model.save() })
```

#### `NativeSettingsChannelMatrix`

Which channels each tier uses: tiers down the left (`NativeSettingsMatrixTier(id:title:detail:tint:)`), channels across the top as symbols (`NativeSettingsMatrixChannel(id:title:symbol:)`, each named in an instant tooltip), one switch per cell that fills with its tier's colour. A click on a channel's symbol turns it on for every tier (off when all had it); a click on a tier's name does the same across its row. Identifiers: `<identifier>.<tier>.<channel>`, `<identifier>.channel.<channel>`, `<identifier>.tier.<tier>`, each id spelled by `GenAccessibilityID.suffix`.

- `identifier: String`
- `tiers: [NativeSettingsMatrixTier]`, `channels: [NativeSettingsMatrixChannel]`
- `selection: Binding<[String: Set<String>]>`: tier id to channel ids; a missing tier has none.
- `isAvailable: (String, String) -> Bool = { _, _ in true }`: false dims a cell and stops it switching (a channel that needs a grant).
- `onCommit: (([String: Set<String>]) -> Void)? = nil`: the new map after each click.

For an `AlertChannelMatrix`, use `init(identifier:tiers:channels:matrix: Binding<AlertChannelMatrix>, isAvailable:onCommit:)`: a tier missing from `routes` shows the `fallback` channels as on (as the dispatcher routes it), a click writes the tiers' channels into `routes`, and `onCommit` gets the new matrix. Binding `$matrix.routes` to `selection` instead shows routed fallback channels as off.

```swift
NativeSettingsChannelMatrix(
    identifier: "disk.alerts.channels",
    tiers: [.init(id: "watch", title: "Watch", detail: "Under 10 GB", tint: KitPalette.modified),
            .init(id: "critical", title: "Critical", detail: "Under 1 GB", tint: KitPalette.removed)],
    channels: [.init(id: "banner", title: "Banner", symbol: "bell.badge"),
               .init(id: "voice", title: "Voice", symbol: "waveform"),
               .init(id: "glow", title: "Edge glow", symbol: "rectangle.inset.filled")],
    selection: $model.channels, onCommit: { _ in model.save() })
```

#### `NativeSettingsActionRow`

A row that runs something ("Preview effect", "Benchmark engines", "Reset history"): one button on the right. While the async action runs, the button shows a small spinner and `progressTitle`, cannot be pressed again, and reads "In progress"; when it throws, the error's message stays under the row (in red) until the next run. The run belongs to the row's `identifier`, not to the view: leaving the page does not stop it, coming back shows it still running (or its error), and no second run starts while one goes, so each action needs its own identifier. With `confirmation`, a sheet asks first, its confirming button titled like the row's button (red for `.destructive`). Identifiers: `<identifier>`, `<identifier>.confirm`, `<identifier>.error`.

- `title: String` (unlabeled), `detail: String? = nil`
- `identifier: String`
- `buttonTitle: String`, `symbol: String? = nil`
- `role: Role = .normal`: `.normal`, `.prominent` (accent fill) or `.destructive` (red).
- `progressTitle: String? = nil`
- `confirmation: String? = nil`
- `action: () async throws -> Void`

```swift
NativeSettingsActionRow(
    "Clear history", detail: "Deletes every posture minute stored on this Mac.", identifier: "posture.user.clear",
    buttonTitle: "Clear", symbol: "trash", role: .destructive,
    confirmation: "Delete all posture history?") { try await model.clearHistory() }
```

#### `NativeSettingsApplicationRow`

A row for one application: its icon, its name and a remove button. The name is looked up from the bundle id. An application that is not installed shows "Unknown application" and a smaller line, "Application unavailable", followed by its bundle id.

- `bundleID: String`: the application's bundle identifier.
- `remove: () -> Void`: called when the minus button is pressed.

```swift
ForEach(model.excludedBundles, id: \.self) { bundleID in
    NativeSettingsApplicationRow(bundleID: bundleID) { model.removeExcluded(bundleID) }
}
```

#### `View.nativeSettingsDisabledLook()`

Draws a settings control at 0.4 opacity when it is disabled. Put it on the control itself; `.disabled` from any container above reaches it through the environment. Use it for AppKit-backed controls whose own disabled look is too faint over the backdrop.

```swift
Toggle("Glass", isOn: $model.glass)
    .toggleStyle(.switch)
    .nativeSettingsDisabledLook()
```

#### `View.nativeSettingsPointer()`

Shows the pointing-hand cursor over a clickable settings control. A disabled control keeps the arrow. Apply `.disabled` after this modifier.

```swift
Button("Open General") { store.select(pageID: "general") }
    .buttonStyle(.bordered)
    .nativeSettingsPointer()
    .disabled(!canOpen)
```

#### `NativeSettingsTilePicker`

A row of picture choices. Each option is a small window mock drawn over its own background, with its title under it and a check mark beside the title of the selected option. `Option` must be `Identifiable & Hashable`.

- `selection: Binding<Option>`: the chosen option.
- `options: [Option]`: the choices.
- `title: (Option) -> String`: the label under each tile.
- `accessibilityLabel: (Option) -> String`: the accessibility label of each tile.
- `identifier: (Option) -> String`: the accessibility identifier of each tile.
- `columns: Int? = nil`: tiles per row. When nil, all tiles sit in one row.
- `background: (Option) -> Background`: the picture behind the mock window, a `@ViewBuilder` closure.

```swift
NativeSettingsTilePicker(
    selection: $density, options: Density.allCases, title: \.label,
    accessibilityLabel: { "Density: \($0.label)" }, identifier: { "acme.density.\($0.id)" }, columns: 2
) { option in
    option.previewColor
}
```

#### `NativeSettingsThemePicker`

The tile picker for `NativeSettingsTheme`: six tiles in two rows of three. `NativeSettingsGeneralPage` uses it.

- `selection: Binding<NativeSettingsTheme>`: the chosen theme.
- `static func preview(_ theme: NativeSettingsTheme) -> some View`: the background a theme's tile shows. Other pickers can reuse it to preview the current theme.

```swift
NativeSettingsCard("Theme", subtitle: "Choose the background for native windows.") {
    NativeSettingsThemePicker(selection: $appearance.theme)
}
```

#### `EnvironmentValues.nativeSettingsTheme`

Three environment values carry the look to every view below `nativeSettingsAppearance(_:)`. The glass, backdrop and pane views read them.

- `nativeSettingsTheme: NativeSettingsTheme`: the theme. Default `.glass`.
- `nativeSettingsReduceMotion: Bool`: the app's reduce motion flag. Default `false`.
- `nativeSettingsReduceTransparency: Bool`: the app's reduce transparency flag. Default `false`.

```swift
@Environment(\.nativeSettingsTheme) private var theme
@Environment(\.nativeSettingsReduceMotion) private var reduceMotion
@Environment(\.nativeSettingsReduceTransparency) private var reduceTransparency
```

#### `View.nativeSettingsAppearance(_:)`

Puts an appearance model into the environment: the theme and the two accessibility flags. The form without an argument, `nativeSettingsAppearance()`, uses `NativeSettingsAppearance.shared`. `FeatureSettingsView` already applies it; use it on the root of any other native window or widget.

- `appearance: NativeSettingsAppearance` (unlabeled): the model to read.

```swift
RootView()
    .nativeSettingsAppearance(model.appearance)
SecondaryRoot()
    .nativeSettingsAppearance()
```

#### `View.nativeSettingsAccessibility(reduceMotion:reduceTransparency:)`

Sets only the two flags in the environment, without a theme. Use it when the flags come from somewhere other than `NativeSettingsAppearance`.

- `reduceMotion: Bool`: the value for `nativeSettingsReduceMotion`.
- `reduceTransparency: Bool`: the value for `nativeSettingsReduceTransparency`.

```swift
PreviewPane()
    .nativeSettingsAccessibility(
        reduceMotion: model.reduceMotion,
        reduceTransparency: model.reduceTransparency)
```

#### `View.nativeGlassSurface(radius:opaqueColor:)`

Draws a card surface behind the view with the corner radius you give, in the style of the current theme. `Solid` and `Gradient` use `opaqueColor`; the darker themes use their own palette colors. `Glass` uses real glass on macOS 26 and later and a material before that. The modifier type is `NativeGlassSurface`, whose initializer also takes `opaque: Bool = false` to force an opaque card.

- `radius: CGFloat = 22`: the corner radius.
- `opaqueColor: Color = Color(white: 0.17)`: the fill under Solid and Gradient.

```swift
VStack { content }
    .padding(16)
    .nativeGlassSurface(radius: 16)
```

#### `View.nativeGlassSurface(in:opaqueColor:)`

The same surface for any `Shape`. The modifier type is `NativeGlassShapeSurface`, whose initializer is `init(shape:opaqueColor:opaque:)`.

- `in shape: SurfaceShape`: the shape to fill.
- `opaqueColor: Color = Color(white: 0.17)`: the fill under Solid and Gradient.

```swift
Text("Beta")
    .padding(8)
    .nativeGlassSurface(in: Capsule(), opaqueColor: Color(white: 0.2))
```

#### `View.nativeGlassControl(radius:tint:)`

Draws a control surface for a button, a field or a badge. It is opaque for Solid, Graphite and Midnight, and for every theme under Reduce transparency. Otherwise it is glass, interactive unless reduce motion is on. Under the Glass theme it uses the dark card tint instead of `tint`. Before macOS 26 it falls back to the card surface. The modifier type is `NativeGlassControl`.

- `radius: CGFloat = 12`: the corner radius.
- `tint: Color = .white.opacity(0.045)`: the glass tint.

```swift
Image(systemName: "slider.horizontal.3")
    .frame(width: 82, height: 82)
    .nativeGlassControl(radius: 23)
```

#### `NativeSettingsBackdrop`

The window-sized background for the current theme: the system window color for Solid, `NativeSettingsGradient` for Gradient, the behind-window material under a dark tint for Glass, a flat color for Graphite and Midnight, and `NativeSettingsDusk` for Dusk. It follows the effective theme, so Reduce transparency changes it. Put it behind a window's content with `titlebarBackground(_:)`.

- `windowMaterial: Bool = true`: when false, the Glass theme adds only its dark tint. Use it when the window's content view already draws the behind-window material.

```swift
RootView()
    .titlebarBackground(NativeSettingsBackdrop())
    .nativeSettingsAppearance(appearance)
```

#### `NativeSettingsGradient`

The Gradient theme's background: the system window color under a faint purple-to-pink tint. It has no parameters.

- `static var tint: LinearGradient`: the tint alone, to lay over another fill.

```swift
ZStack {
    Color.black
    NativeSettingsGradient.tint
}
.frame(width: 120, height: 80)
```

#### `NativeSettingsDusk`

The Dusk theme's background: a plum base under a stronger purple-to-pink tint. It has no parameters.

- `static var tint: LinearGradient`: the tint alone.

```swift
ZStack {
    NativeSettingsDusk()
    Text("Dusk").foregroundStyle(.white)
}
.frame(width: 120, height: 80)
```

#### `NativeThemePalette`

The fixed colors of the darker themes. "Base" is the backdrop, "raised" is bars and drawers, and "card" is a card fill one step lighter.

- `graphiteBase`, `graphiteRaised`, `graphiteCard`: near-black grays.
- `midnightBase`, `midnightRaised`, `midnightCard`: blue-black.
- `midnightHairline`: a pale blue line at 16 percent opacity.
- `glassTint`: black at 50 percent, over the window material.
- `glassCardTint`: black at 35 percent, over a card's glass.
- `duskBase`, `duskRaised`, `duskCard`: plum.

```swift
RoundedRectangle(cornerRadius: 12)
    .fill(NativeThemePalette.midnightCard)
    .overlay(
        RoundedRectangle(cornerRadius: 12)
            .stroke(NativeThemePalette.midnightHairline, lineWidth: 1))
```

#### `NativePaneLevel`

The role of a pane drawn over a `NativeSettingsBackdrop`.

- `chrome`: sidebars, rails and headers. A faint lift over the backdrop.
- `content`: reading columns. The backdrop itself.
- `bar`: sticky headers over scrolling rows and drawers over other panes. Frosted, or solid under Solid and Reduce transparency.

```swift
let level: NativePaneLevel = .bar
let fill = NativePaneFill(level)
Header().background(fill)
```

#### `NativePaneFill`

The fill of one pane in the native look, for the theme in the environment.

- `level: NativePaneLevel` (unlabeled): the pane role.

```swift
HStack(spacing: 0) {
    Sidebar().background(NativePaneFill(.chrome))
    Detail().background(NativePaneFill(.content))
}
```

#### `NativePaneBackground`

A pane background that is your own fill normally and `NativePaneFill` when the host draws native panes (`EnvironmentValues.nativePanes` is true). Use it in a pane that must look right in both modes.

- `level: NativePaneLevel` (unlabeled): the pane role, used in native mode.
- `standard: () -> Standard`: the fill to use otherwise, a `@ViewBuilder` closure.

```swift
Header()
    .background(NativePaneBackground(.bar) {
        Color(white: 0.1)
    })
```

#### `EnvironmentValues.nativePanes`

A flag a host turns on when it draws its panes in the native settings look over a `NativeSettingsBackdrop`. Panes that use `NativePaneBackground` then draw `NativePaneFill`.

- `nativePanes: Bool`: default `false`.

```swift
HubRoot()
    .titlebarBackground(NativeSettingsBackdrop())
    .nativeSettingsAppearance(appearance)
    .environment(\.nativePanes, true)
```

#### `HubPreferences`

The hub window's user preferences, shared by the hub window and the Hub pages of the settings window. Both run from one app and read one defaults domain. A write posts a distributed notification, and every other process reloads. Remembered view state (panel widths, filters, sort orders) is not stored here.

- `defaults: UserDefaults = .standard`: where the values live.
- `notificationNamespace: String = Bundle.main.bundleIdentifier ?? "dev.genesis.native"`: names the change notification.
- `broadcasts: Bool = true`: post a notification on every change. Pass false for a scripted run.
- `observeExternalChanges: Bool = true`: reload when another process changes a value. Pass false for a scripted run.

Properties:

- `static let shared`: the shared instance.
- `style: HubWindowStyle`: `hub` (the hub's own dark look) or `native` (the look of the settings window, which follows the theme). `HubWindowStyle` also has `title` ("Hub" or "Native") and is `CaseIterable`.
- `glass: Bool`: the desktop shows through the hub, blurred. Applies to the `hub` style only.
- `processEnergy: Bool`: the Agent processes pane adds macOS energy impact, at the cost of one `top` sample per refresh.
- `cleanupIdleDays: Int`: idle days a worktree needs before cleanup counts it as removable. A value outside `cleanupIdleDaysRange` is clamped when it is saved and when it is read back.
- `static let cleanupIdleDaysRange = 0...90`.
- `Key`: the defaults key names: `style` is "hub.style", `glass` is "hub.glass", `processEnergy` is "hub.procs.energy", `cleanupIdleDays` is "hub.worktreeCleanup.olderThanDays".
- `notificationNamespace: String` and `notificationName: Notification.Name`: the change notification.

Methods:

- `reloadFromDefaults()`: reads every value again, without announcing them. An unknown style reads as `hub`, a missing flag reads as off, and an idle time outside the range is clamped.

```swift
let preferences = HubPreferences.shared
preferences.style = .native
preferences.cleanupIdleDays = 14
```

#### `HubSettingsPages`

The Hub section of the settings window: an Appearance page (window style tiles, a Glass switch that is disabled in the native style, and an Open General button) and a Panes page (energy impact switch and the worktree idle days picker). The Open General button selects the page with the id `general`, so register your General page under that id.

- `static let appearancePageID = "hub.appearance"`: the Appearance page id.
- `static let panesPageID = "hub.panes"`: the Panes page id.
- `static func section(preferences: HubPreferences? = nil) -> NativeSettingsSection`: the section, with id `hub`, title "Hub" and order 35. When `preferences` is nil, `HubPreferences.shared`.

```swift
let settings = FeatureSettingsWindowController(
    sections: [generalSection, HubSettingsPages.section()],
    initialPageID: HubSettingsPages.appearancePageID)
```

#### `NativeNotificationClient`

A small seam over the notification permission of the app. A model that needs the permission takes one so tests can replace the system calls. `ClickyModel` accepts it as `notificationClient`.

- `status: () async -> UNAuthorizationStatus`: reads the current authorization.
- `request: () async throws -> Bool`: asks for the permission and returns whether it was granted.
- `openSettings: () -> Bool`: opens the system settings for this app's notifications. Returns false when it cannot.
- `init(status:request:openSettings:)`: takes the three closures.
- `static var system: NativeNotificationClient`: the real client. It requests alert and sound, and opens the Notifications pane for the app's bundle id.

```swift
let stub = NativeNotificationClient(
    status: { .authorized }, request: { true }, openSettings: { true })
let model = ClickyModel(notificationClient: stub)
```

#### `ClientConfigFile`

`~/.genesis/client.json`, the settings file the Genesis app, its CLI and the kit share. A write takes the same `client.json.lock` (an `O_EXCL` file) as the app's ConfigStore and the TypeScript client, reads the file again inside the lock, and lands through a 0600 temporary file that is renamed over `client.json`. The temporary file is created 0600 with `O_EXCL` and synced to disk before the rename, so a reader never sees half a write, a crash leaves the old file or the new one, and the file never exists under the process umask. Reads are lenient, for display. A write reads strictly: a malformed or unreadable `client.json` throws and stays byte-for-byte intact until the user repairs it. A missing `client.json` falls back to the legacy `config.json`, of which only the client keys (`app`, `obsidian`, `server`, `auth.sessionToken`) are carried over. Every call does file I/O on the calling task, so call it off the main actor. `FlowFocusConfiguration` writes through this type with its deep merge.

- `directory: URL = ClientConfigFile.defaultDirectory`: the folder with `client.json` (`~/.genesis`).
- `lockTimeout: TimeInterval = 5`: how long a write waits for another writer's lock (it retries every 100 ms and suspends instead of holding a thread), then throws.
- `staleLockAge: TimeInterval? = 10`: a lock without this code's pid marker (ConfigStore, the CLI) that is older than this is a crashed writer's and is removed, as ConfigStore and the TypeScript client do. nil never removes a lock by age. A lock with this code's marker (`genesis-kit pid=<pid>`) is removed only when its pid no longer runs, never by age.
- `fileURL: URL`, `lockURL: URL`: `client.json` and `client.json.lock`.
- `read() -> [String: Any]`, `readApp() -> [String: Any]`, `readAppValue(_ key: String) -> Any?`: lenient reads of the whole file, the `app` object and one `app.<key>`. A malformed `client.json` reads as empty; only a missing one falls back to `config.json`.
- `readForWrite() throws -> [String: Any]`: the strict read a write uses.
- `replaceAppValue(_ value: Any?, forKey key: String) async throws`: replaces `app.<key>` as a whole (no merge, so a removed nested key really goes); nil removes the key. Nothing is written when the stored value is already equal. A value JSON cannot hold (a `Date`, a `URL`) throws before the lock is taken.
- `mutate(_ body: (inout [String: Any]) throws -> Void) async throws -> Bool`: a locked read-modify-write of the whole file. It returns whether it wrote; an unchanged object is not written.
- `clientKeys(fromLegacy:) -> [String: Any]` (static): the client part of a legacy `config.json`.

```swift
let file = ClientConfigFile()
// Deleting a calibration slot: a deep merge could not remove it.
try await file.replaceAppValue(["sensitivity": 4, "slots": ["home": ["pitch": 1]]], forKey: "posture")
let posture = file.readAppValue("posture") as? [String: Any]
```

#### `KitSettingsBackend`

Where a `SettingsDocument` keeps its value: JSON bytes under one key, stored and replaced as a whole. The methods run off the main actor and may block on file I/O or a cross-process lock, so an implementation does its I/O where it is called and never hops to the main actor for it. The Genesis app passes a backend over its own config store; the kit ships two.

- `loadData(forKey:) async throws -> Data?`: the stored JSON, or nil when nothing is stored.
- `saveData(_ data: Data?, forKey:) async throws`: stores the JSON value as a whole; nil removes the key.
- `observeChanges(forKey:_ onChange: @escaping @Sendable () -> Void) -> SettingsObservation?`: calls `onChange` on any thread when the stored value may have changed outside this backend (also after its own writes; the caller reads again and compares). nil when the backend cannot observe. `SettingsObservation` stops on `cancel()` or when it is released.

The two backends:

- `ClientConfigBackend(file: ClientConfigFile = ClientConfigFile(), coalesce: TimeInterval = 0.25)`: `app.<key>` in `client.json` through `ClientConfigFile.replaceAppValue`. It observes the folder with one kqueue source (no polling) and merges the events of one write (lock, temporary file, rename) into one call. Writes of other files in the folder do not reach `onChange`: it runs only when `client.json`'s inode, size or modification time moved. A missing folder is created (0700), so a document made before the first write still sees later ones.
- `UserDefaultsSettingsBackend(defaults: UserDefaults = .standard, suite: String? = nil)`: one `Data` value of a defaults suite. Changes from another process sharing the suite arrive through key-value observing, which needs a key without dots; a dotted key observes nothing.

```swift
struct ConfigStoreBackend: KitSettingsBackend {          // in an app
    func loadData(forKey key: String) async throws -> Data? { /* read app.<key> */ nil }
    func saveData(_ data: Data?, forKey key: String) async throws { /* write app.<key> off the main actor */ }
    func observeChanges(forKey key: String, _ onChange: @escaping @Sendable () -> Void) -> SettingsObservation? { nil }
}
```

#### `SettingsDocument`

One feature's settings as a Codable value under one backend key, as an `ObservableObject` on the main actor. A change applies in memory at once; the save waits `debounce` after the last change and then runs off the main actor in order, so a slider drag or a burst of toggles costs one write and the UI never waits for a lock or the disk. Every `@Published` property is assigned only when its value changed.

- `key: String`: the backend key (`disk`, `posture`).
- `backend: KitSettingsBackend`.
- `defaultValue: Value`: the value while nothing is stored. `Value` is `Codable & Equatable & Sendable`; give new fields a default in a custom `init(from:)` so an older stored value still decodes.
- `debounce: Duration = .milliseconds(400)`.
- `observesExternalChanges: Bool = true`: reads the value again when the backend reports a change.
- `value: Value` (published): the current value.
- `state: State` (published): `.loading` until the first load lands, `.ready`, or `.unreadable(String)` when the stored value could not be read or decoded. Nothing is saved while unreadable, so the original bytes survive.
- `lastError: String?` (published): the last load or save failure, nil after the next success. A failed save (a full disk, a lock held past its timeout) keeps the edit pending: it is retried after 5, 15, 30, 60 and 60 s, then on the next edit or `flush()`, and an outside change waits for it instead of reverting it.
- `hasPendingChanges: Bool`: an edit has not reached the backend yet.
- `load() async`: waits for the first load, which starts in `init` off the main actor. An edit made before it lands is replayed on top of the stored value.
- `update(_ change: @escaping (inout Value) -> Void)`, `set(_ newValue: Value)`: change the value now and save after the debounce.
- `binding(_ keyPath:) -> Binding<Field>`: a binding to one field for a settings control.
- `flush() async -> Bool`: saves a pending edit now (also one whose save failed before) and waits for every save made before the call. Call it when a window closes, and at quit: `applicationWillTerminate` cannot await, so return `.terminateLater` from `applicationShouldTerminate`, await `flush()` with a bounded wait (5 s), then call `NSApp.reply(toApplicationShouldTerminate: true)`. False when unreadable or a save failed.
- `reload() async`: reads the stored value again; a pending edit is saved first.
- `overwriteUnreadableValue()`: leaves `.unreadable` and saves the in-memory value over the stored one. Call it only when the user chose to replace what could not be read. It replaces an undecodable value under this key; when the whole `client.json` is malformed the save fails with the same error, and the file needs a repair first.

An external change is read back after the backend reports it. A pending local edit wins: the read waits until that edit is saved, and a read whose value equals the current one publishes nothing. The value is stored as a whole, so a build that does not know a field drops it on its next save: two builds that write the same key (an installed app and a worktree build) remove each other's newer fields.

```swift
struct DiskSettings: Codable, Equatable, Sendable { var floorGB = 10; var radarRoots: [String] = [] }

let settings = SettingsDocument(key: "disk", backend: ClientConfigBackend(), defaultValue: DiskSettings())
Stepper("Floor", value: settings.binding(\.floorGB), in: 1 ... 100)   // in a page
settings.update { $0.floorGB = 3 }
_ = await settings.flush()                                  // when the window closes
```

### Style

Style holds the pieces every Genesis surface shares. `GenesisKitHost` is how an app lends the kit its log, terminal, panel find, perf file and markdown vault. The rest is the look and feel: `.instantTooltip`, the `.genHover*` button styles, `.rowButton`, `GenDisclosure` with its `GenMotion` animation family, the `KitPalette` and `KitTheme` tokens, and small formatters (`Plural`, `ByteFormat`). A view reaches for these instead of building its own hover, tooltip or expand behavior.

#### `GenesisKitHost`

The protocol an app implements to plug its own behavior into the kit. Every requirement has a default implementation, so an app implements only what it has. The protocol is class-bound (`AnyObject`).

The kit finds the host by class name. Declare it as `@objc(GenesisKitHostAdapter) final class …: NSObject, GenesisKitHost`, and no launch code has to call anything. `GenesisKit.install(_:)` sets a host by hand (tests).

- `func log(_ line: String)`: receives one diagnostic line from the kit. Default: does nothing.
- `var opensTerminal: Bool { get }`: whether "Open in a new cmux workspace" is offered for a path. Default: `false`.
- `func openTerminal(folder: String)`: opens a shell in `folder`. The kit calls it on the main thread, so move slow work off it. Default: does nothing.
- `func findText(_ text: String, field: String) -> AnyView?`: returns text that the app's panel find can mark. `field` is the key the panel find lists the text under (`PathLabel` uses `"path"`). Default: `nil`, which draws a plain `Text`.
- `var perf: PerfConfiguration { get }`: where the perf log, hang captures and stall stacks go, and whether they are on. The kit reads it once. Default: `PerfConfiguration.fallback`.
- `func transcriptMarkdown(_ text: String, style: TranscriptMarkdownStyle) -> AnyView?`: renders the markdown of session transcripts (replies, prompt parts) and widget inbox cards in the app's own renderer. Default: `nil`, which draws inline markdown in one `Text` (the widget card draws the kit's own block renderer).
- `func freshPermissionStatus(_ kind: PermissionKind) async -> PermissionStatus?`: what a new process of this app reads for `kind`. macOS caches Input Monitoring and Screen Recording per process, so a grant given while the app runs shows only in a new one. Return `nil` when the app has no probe. Default: `nil`.

Markdown viewer hooks (the viewer itself is described under Markdown):

- `var markdownVaultRoot: String? { get }`: the notes vault, as a folder path. The viewer resolves vault links and `[[wikilinks]]` against it, opens the vault's index from it for completion, and builds the "Open in Obsidian" link from it. Default: `nil` (no vault).
- `var markdownConfiguredVault: String? { get }`: the vault the app's config names. When it is not empty, "Open in Obsidian" uses it as the vault name. Otherwise the viewer uses the folder name of `markdownVaultRoot`. Default: `nil`.
- `func markdownCompletions(_ request: MarkdownCompletion.Request) -> [String]?`: the values for `[[` and `#` completion. `request.kind` is `.wikilink` or `.tag`, `request.query` is the text typed so far, and `request.range` is the typed part that the chosen value replaces. Return `nil` to let the kit read the vault's own index (read-only, at `markdownVaultRoot`). With no vault or no index yet, the kit offers nothing. Default: `nil`.
- `func markdownPropertyVocabularyJSON() -> String?`: property keys and their values as JSON, for the Properties block. The shape is an object that maps a key to a list of values. The kit asks at most once a minute. Return `nil` to use the vault index (`{}` when there is none). Default: `nil`.
- `var markdownDefaultAppBundleID: String? { get }`: the bundle id that the viewer offers, once, as the default app for the file types it reads. It also adds "Set as Default App…" to the viewer's app menu. Default: `nil`, which never offers it.
- `var toolsBinaryPath: String? { get }`: the `tools` binary the viewer runs for the dev-dashboard share of a note. Default: `nil`, which resolves the binary the usual way.

```swift
@objc(GenesisKitHostAdapter)
final class GenesisKitHostAdapter: NSObject, GenesisKitHost {
    func log(_ line: String) { NSLog("%@", line) }
    var opensTerminal: Bool { true }
    func openTerminal(folder: String) {
        _ = try? Process.run(URL(fileURLWithPath: "/usr/bin/open"), arguments: ["-a", "Terminal", folder])
    }
    var markdownVaultRoot: String? { NSString(string: "~/Notes").expandingTildeInPath }
}
```

#### `GenesisKit`

The namespace that holds the installed `GenesisKitHost`. A host rarely touches it, because the kit finds `GenesisKitHostAdapter` by class name. Use `install(_:)` to set a host by hand, mostly in tests.

- `static func install(_ host: GenesisKitHost?)`: sets the host and skips the class-name lookup. Pass `nil` to run with no host.
- `static var host: GenesisKitHost? { get }`: the app's host, found once by class name. It is `nil` in an app that declares none.

```swift
final class TestHost: GenesisKitHost {
    var markdownVaultRoot: String? { "/tmp/test-vault" }
}
GenesisKit.install(TestHost())
let vault = GenesisKit.host?.markdownVaultRoot   // "/tmp/test-vault"
```

#### `View.instantTooltip(_:monospaced:below:)`

A hover label for any control. A floating panel shows the text after a 0.18 s pause, instead of the long system delay of `.help`. Use it on every control that is not self-explanatory, and on every icon-only button.

- `_ text: String`: the text. With several lines, the first is a bold title and a line that starts with "• " is a bullet.
- `monospaced: Bool = false`: show the text as it is, in a monospaced font. For a command or a path.
- `below: Bool = true`: put the bubble under the control. `false` puts it above.

```swift
Image(systemName: "folder")
    .instantTooltip("Open in Finder")
Text("Blocked")
    .instantTooltip("Why blocked\n• It is a draft\n• Checks are pending")
Text("bun run app")
    .instantTooltip("bun run app", monospaced: true, below: false)
```

#### `View.instantTooltip(title:bullets:below:)`

A tooltip made of a title over a bulleted list.

- `title: String?`: the bold first line. `nil` shows only the bullets.
- `bullets: [String]`: one bullet per entry.
- `below: Bool = true`: put the bubble under the control.

```swift
Text("Blocked")
    .instantTooltip(
        title: "Why it is blocked",
        bullets: ["It is a draft", "Checks are pending"],
        below: false
    )
```

#### `View.instantTooltip(_:below:)`

A tooltip from a `TooltipContent` value, for text built in code.

- `_ content: TooltipContent`: the title, lines and font.
- `below: Bool = true`: put the bubble under the control.

```swift
let content = TooltipContent(title: "Build", bullets: ["Passed in 42 s"], footer: ["Click to open the log"])
Circle().frame(width: 8, height: 8)
    .instantTooltip(content, below: false)
```

#### `TooltipContent`

What a tooltip says: an optional bold title, then paragraphs and bullets. `Equatable` and `Sendable`.

- `title: String?`: the bold first line.
- `lines: [TooltipContent.Line]`: the body. `Line` has the cases `text(String)` for a paragraph and `bullet(String)` for a bullet with a hanging indent.
- `monospaced: Bool`: show the body in a monospaced font.
- `init(title: String? = nil, lines: [Line] = [], monospaced: Bool = false)`: builds it from parts.
- `init(title: String?, bullets: [String], footer: [String] = [])`: a title, bullets, then plain lines after them.
- `init(_ text: String, monospaced: Bool = false)`: reads a plain string. With several lines, the first is the title (unless it starts with "• "), and lines that start with "• " are bullets. A monospaced string keeps its text as it is.
- `static let bulletPrefix = "• "`: the prefix that marks a bullet in a plain string.
- `var isEmpty: Bool`: true when there is no title and no line. An empty tooltip is never shown.

```swift
let content = TooltipContent(
    title: "Sync",
    lines: [.text("Last run 2 min ago"), .bullet("3 files changed")]
)
Text("Sync").instantTooltip(content)
Text("Run").instantTooltip(TooltipContent("bun run app", monospaced: true))
```

#### `InstantTooltipStyle`

The look of the tooltip bubble. The bubble itself is the system tooltip material, forced dark, so there is no background color. An app sets the style once at launch. The kit default is a neutral dark bubble.

- `fontSize: CGFloat = 11`: the text size.
- `textColor: Color = Color.white.opacity(0.92)`: the text color.
- `border: Color = Color.white.opacity(0.14)`: the hairline around the bubble.
- `@MainActor static var current`: the style every tooltip uses. Assign it to change the look.

```swift
InstantTooltipStyle.current = InstantTooltipStyle(
    fontSize: 12,
    textColor: Color.white.opacity(0.95),
    border: Color.white.opacity(0.2)
)
```

#### `InstantTooltip`

The view modifier behind the `.instantTooltip` calls. Public so an app target can forward its own `.instantTooltip` extension to it without a duplicate extension. The hover sensor exists only while the pointer is over the view.

- `init(text: String, monospaced: Bool = false, below: Bool = true)`: a tooltip from a string.
- `init(content: TooltipContent, below: Bool = true)`: a tooltip from a `TooltipContent`.

```swift
Text("Status")
    .modifier(InstantTooltip(text: "Everything is up to date"))
Text("Logs")
    .modifier(InstantTooltip(text: "~/Library/Logs", monospaced: true, below: false))
```

#### `GenHoverButtonStyle`

The hover and press treatment for buttons. Apply it through one of the four factories below, and stop deciding per button. It has three states. At rest nothing is drawn. On hover it shows a soft accent fill, a 1 pt accent border and a small scale lift. While pressed the fill deepens and the scale shrinks. A disabled control dims to 40 percent and ignores hover. The pointing-hand cursor comes with it. Reduce Motion drops the scale and keeps the color change.

The style has no public init. Create it with `.genHover(...)`, `.genHoverPlain(...)`, `.genHoverIcon(...)` or `.genHoverRow(...)`.

```swift
Button("Retry") { retry() }
    .buttonStyle(.genHover())
Button { close() } label: { Image(systemName: "xmark") }
    .buttonStyle(.genHoverIcon())
```

#### `ButtonStyle.genHover(accent:cornerRadius:padding:drawsBackground:scale:)`

The default hover style for a text-like button.

- `accent: Color = KitTheme.accent`: the fill and border color.
- `cornerRadius: CGFloat = KitTheme.radiusSmall`: the corner radius of the fill and the hit shape.
- `padding: EdgeInsets = EdgeInsets(top: 4, leading: 6, bottom: 4, trailing: 6)`: padding added around the label, so a small glyph still has a comfortable target.
- `drawsBackground: Bool = true`: set `false` for a label that draws its own container.
- `scale: CGFloat = 1.04`: the scale on hover. The pressed scale is 0.97.

```swift
Button("Open") { open() }
    .buttonStyle(.genHover(
        accent: .blue,
        cornerRadius: 8,
        padding: EdgeInsets(top: 6, leading: 10, bottom: 6, trailing: 10),
        scale: 1.02
    ))
```

#### `ButtonStyle.genHoverPlain(scale:brighten:)`

A style that draws nothing of its own and adds no padding, so no layout moves. The label lightens on hover. Use it on a button whose label already paints a capsule, a card or a glyph background, and for link-like buttons. It replaces `.plain` on a clickable control, because it adds the pointer reaction that `.plain` lacks.

- `scale: CGFloat = 1`: the scale on hover. Keep 1 for rows and full-width cards, since a growing row clips.
- `brighten: Double = 0.22`: how much the label lightens on hover.

```swift
Button { openDocs() } label: { Text("docs.example.org").underline() }
    .buttonStyle(.genHoverPlain())
Button { select(card) } label: { HStack { Text(card.title); Spacer() } }
    .buttonStyle(.genHoverPlain(scale: 1, brighten: 0.3))
```

#### `ButtonStyle.genHoverIcon(accent:diameter:)`

A style for a glyph-only button: circular feedback and a small padding of 3 pt.

- `accent: Color = KitTheme.accent`: the fill and border color.
- `diameter: CGFloat = 22`: the diameter, which sets the corner radius to half of it. The hover scale is 1.08.

```swift
Button { close() } label: { Image(systemName: "xmark") }
    .buttonStyle(.genHoverIcon(diameter: 20))
    .instantTooltip("Close")
```

#### `ButtonStyle.genHoverRow(accent:cornerRadius:)`

A style for a full-width row or card: the fill and the border, with no scale and no padding.

- `accent: Color = KitTheme.accent`: the fill and border color.
- `cornerRadius: CGFloat = KitTheme.radiusMedium`: the corner radius.

```swift
Button { select(item) } label: {
    HStack { Text(item.title); Spacer(); Text(item.detail) }
        .frame(maxWidth: .infinity, minHeight: 28)
}
.buttonStyle(.genHoverRow(cornerRadius: 8))
```

#### `View.genHoverEffect(accent:cornerRadius:scale:)`

The same hover fill, border, lift and pointing-hand cursor as a modifier, for a control that cannot be a `Button`, such as a `Menu` label or a tappable row. It has no pressed state.

- `accent: Color = KitTheme.accent`: the fill and border color.
- `cornerRadius: CGFloat = KitTheme.radiusSmall`: the corner radius.
- `scale: CGFloat = 1.04`: the scale on hover.

```swift
Menu("Sort") {
    Button("Name") { sort = .name }
    Button("Date") { sort = .date }
}
.genHoverEffect(accent: .blue, cornerRadius: 6)
```

#### `RowButtonStyle`

The hover for list rows: a soft fill in the row's own shape, with no outline and no lift. The shape is the row's full frame, so the hover box and the selection box are the same. Keep gaps and insets outside the button. The hover resets when the row scrolls away.

- `init(cornerRadius: CGFloat = 6)`: the corner radius of the fill.

```swift
Button { select(row) } label: {
    Text(row.title).frame(maxWidth: .infinity, alignment: .leading)
}
.buttonStyle(RowButtonStyle(cornerRadius: 6))
.padding(.horizontal, 8)
```

#### `View.rowButton(cornerRadius:_:)`

Makes a view a clickable list row. It is a real `Button` (keyboard, VoiceOver, automation can reach it) with `RowButtonStyle`, instead of an `onTapGesture` that none of them see.

- `cornerRadius: CGFloat = 8`: the corner radius of the hover fill.
- `_ action: @escaping () -> Void`: runs on click.

```swift
HStack { Text(file.name); Spacer(); Text(file.size) }
    .frame(height: 26)
    .rowButton(cornerRadius: 6) { open(file) }
```

#### `View.hoverHighlight(color:cornerRadius:fillOpacity:borderOpacity:)`

A soft fill and a 1 pt border on hover, for a view that is not a button (buttons use the `.genHover*` styles). The change fades in over 0.14 s.

- `color: Color = Color(red: 0.35, green: 0.85, blue: 0.55)`: the fill and border color. The default is a green.
- `cornerRadius: CGFloat = 8`: the corner radius.
- `fillOpacity: Double = 0.08`: the fill opacity while hovered.
- `borderOpacity: Double = 0.7`: the border opacity while hovered.

```swift
Text("Drop files here")
    .padding(10)
    .hoverHighlight(color: .blue, cornerRadius: 10)
```

#### `View.axMarker(_:)`

Sets an accessibility identifier on a 1 by 1 leaf overlay instead of on the view. On a container, `.accessibilityIdentifier` spreads to the children and replaces their own ids. A leaf has no children to overwrite.

- `_ id: String`: the identifier.

```swift
VStack {
    header.axMarker("settings.header")
    list
}
.axMarker("settings.panel")
```

#### `View.pointerCursor(_:)`

Shows the pointing-hand cursor while the pointer is over a clickable view. The `genHover*` styles, `RowButtonStyle` and `GenDisclosure` already apply it. Call it directly on a clickable thing that has none of them, such as a `Menu` label, a `Picker` or a system-styled `Button`. It uses the system pointer style on macOS 15 and sets the cursor by hand on macOS 14.

- `_ active: Bool = true`: `false` keeps the arrow, for a disabled control.

```swift
Menu("Export") {
    Button("PDF") { exportPDF() }
}
.pointerCursor(canExport)
```

#### `GenDisclosure`

A disclosure whose whole header row toggles: the chevron, the label and the empty space after it. SwiftUI's `DisclosureGroup` reacts to its chevron only. This header is one `Button` with a full-width hit shape, the row hover, the pointing-hand cursor and a minimum height. Opening and closing animate with `GenMotion` and are instant under Reduce Motion. A container that fits its content (`FittedScroll`) grows or shrinks in the same transaction, and `onGenExpansion` tells it which way.

- `isExpanded: Binding<Bool>`: the open state.
- `minHeight: CGFloat = 26`: the minimum height of the header row.
- `spacing: CGFloat = 6`: the gap between the header and the content.
- `identifier: String? = nil`: an accessibility identifier for the header button.
- `accessibilityTitle: String? = nil`: the VoiceOver label of the header button.
- `@ViewBuilder content: () -> Content`: the revealed content.
- `@ViewBuilder label: () -> Label`: the header label.
- Convenience init for a text header: `init(_ title: String, isExpanded: Binding<Bool>, minHeight: CGFloat = 26, spacing: CGFloat = 6, identifier: String? = nil, @ViewBuilder content: () -> Content)`. The title also becomes the accessibility title.

```swift
GenDisclosure("Details", isExpanded: $showDetails) {
    Text("Branch: feature/login")
}
GenDisclosure(isExpanded: $showLog) { LogView() } label: { Label("Log", systemImage: "doc.text") }
```

#### `GenMotion`

The one motion family for expanding and collapsing: disclosures, inbox cards and the panels that fit them. The curve starts fast and settles without overshoot. Opening is a little longer than closing, and both stay under 300 ms. Under Reduce Motion every change is instant. `GenMotion` is an enum of constants and functions.

- `static let curve: (Float, Float, Float, Float) = (0.32, 0.72, 0, 1)`: the cubic Bézier control points, shared with the edge panels.
- `static let expandDuration: Double = 0.24`: seconds to open.
- `static let collapseDuration: Double = 0.2`: seconds to close.
- `static let removalFadeDuration: Double = 0.1`: seconds that removed content takes to fade, so it never sits under rows that move up.
- `static let maxAnimatedRows = 24`: the most rows one change should add to or take from a non-lazy stack with an animation. A longer "Show N more" should appear at once.
- `static func duration(expanding: Bool) -> Double`: the duration for one direction.
- `static func animation(expanding: Bool, reduceMotion: Bool, scale: Double = 1) -> Animation?`: the SwiftUI animation, or `nil` for an instant change. `scale` multiplies the duration.
- `static func perform(expanding: Bool, reduceMotion: Bool, _ change: () -> Void)`: runs `change` inside one expand or collapse animation, or with animations off under Reduce Motion.
- `@MainActor static var systemReduceMotion: Bool`: the system's Reduce Motion, for code with no SwiftUI environment (window controllers).

```swift
@GenReduceMotion private var reduceMotion
@State private var isOpen = false

var body: some View {
    Button("Toggle") {
        GenMotion.perform(expanding: !isOpen, reduceMotion: reduceMotion) { isOpen.toggle() }
    }
}
```

#### `AnyTransition.genReveal`

The transition for content that a disclosure or a card reveals. It fades in a few points above its place while the container makes room, and fades out quickly while the container closes over it. Pair it with a clipped container.

```swift
if isOpen {
    DetailsView().transition(.genReveal)
}
```

#### `GenReduceMotion`

A property wrapper that reads Reduce Motion the way every kit surface does. Its value is `true` when the system setting, the app's own setting (settings window, hub) or the widget's setting is on.

- `init()`: takes no parameters.
- `wrappedValue: Bool`: whether to skip animation.

```swift
@GenReduceMotion private var reduceMotion

var body: some View {
    Panel().animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: isOpen)
}
```

#### `GenExpansionHost`

What a container that fits its content learns from a disclosure inside it. Before a change runs, the disclosure tells the container that content is about to open (`true`) or close (`false`). A container whose height is a measured value (`FittedScroll`) then animates its next height change. A typed character or new data does not announce itself, so those changes stay instant. A custom expanding view reads the host from the `genExpansionHost` environment value and calls `willChange(_:)` before it changes.

- `init()`: creates a host. Use `onGenExpansion` rather than creating one by hand.
- `func willChange(_ expanding: Bool)`: tells this container and every fitted container around it.
- `EnvironmentValues.genExpansionHost: GenExpansionHost?`: the nearest fitted container around a view, or `nil`.

```swift
@Environment(\.genExpansionHost) private var host

func toggle() {
    host?.willChange(!isOpen)
    GenMotion.perform(expanding: !isOpen, reduceMotion: reduceMotion) { isOpen.toggle() }
}
```

#### `View.onGenExpansion(_:)`

Runs a closure when a `GenDisclosure` (or another expanding view) inside this view is about to open or close. A container that sizes itself to its content uses it to animate the next resize.

- `_ action: @escaping (Bool) -> Void`: receives `true` when content opens and `false` when it closes.

```swift
@State private var animateNextResize = false

ScrollView { content }
    .onGenExpansion { expanding in animateNextResize = expanding }
```

#### `KitPalette`

The colors that both apps draw the kit components in: the GenesisTools hub palette, which the Genesis session screens match. Dark only. `KitPalette` is an enum of static constants.

- `static let background: NSColor`: the near-black window background (sRGB 0.075, 0.075, 0.08).
- `static let hairline: Color`: a white hairline at 8 percent opacity.
- `static let added: Color`: green, the "added" color.
- `static let removed: Color`: red, the "removed" color.
- `static let modified: Color`: orange, the "modified" color.
- `static let renamed: Color`: blue, the "renamed" color.
- `static let dim: Color`: white at 50 percent.
- `static let faint: Color`: white at 32 percent, for hints and secondary labels in dense rows.
- `static let text: Color`: white at 90 percent, the main text color.

```swift
VStack(alignment: .leading) {
    Text("+12").foregroundStyle(KitPalette.added)
    Text("-3").foregroundStyle(KitPalette.removed)
    Divider().overlay(KitPalette.hairline)
}
.background(Color(nsColor: KitPalette.background))
```

#### `KitTheme`

The tokens of the hover styles, kept apart from the apps' own accent and radius values so the two never collide. `KitTheme` is an enum of static constants.

- `static let accent: Color`: the amber accent (1.0, 0.76, 0.28) that the `genHover*` styles use by default.
- `static let radiusSmall: CGFloat = 6`: the small corner radius.
- `static let radiusMedium: CGFloat = 10`: the medium corner radius.
- `static let quick = Animation.easeOut(duration: 0.15)`: the hover animation.

```swift
RoundedRectangle(cornerRadius: KitTheme.radiusMedium)
    .fill(KitTheme.accent.opacity(hovering ? 0.12 : 0))
    .animation(KitTheme.quick, value: hovering)
    .onHover { hovering = $0 }
```

#### `SWR`

Stale-while-revalidate on screen. A view paints the last answer (from `DiskCache`), marks it as refreshing (`RefreshingMark`), always asks again, slides new rows in, and flashes the rows that the fresh answer changed, once. It covers the read path only: a destructive action never trusts a cached row. `SWR` is an enum of helpers.

- `static let animation: Animation`: a spring (response 0.35, damping 0.85) for the swap.
- `static let rowTransition: AnyTransition`: new rows slide in from the top and fade in. Gone rows fade out.
- `static func changed<ID: Hashable>(before: [ID: String], after: [(ID, String)]) -> Set<ID>`: the ids that are new or whose signature changed. The result is empty when nothing was on screen before, so a first paint slides in and does not flash.
- `static func animates<ID: Hashable>(before: [ID: String], after: [(ID, String)], limit: Int = 12) -> Bool`: whether a refresh is small enough to slide and flash, meaning at most `limit` rows were added, changed or removed. A bigger one should swap with no animation. It is `false` when nothing was on screen before.
- `@MainActor static func fade<ID: Hashable>(_ flashed: Set<ID>, current: @escaping @MainActor () -> Set<ID>?, clear: @escaping @MainActor () -> Void)`: calls `clear` 1.6 s later with a 0.6 s fade, unless a newer refresh replaced the flashed set.

```swift
let moved = SWR.changed(before: shown, after: fresh.map { ($0.id, $0.signature) })
withAnimation(SWR.animation) { rows = fresh; changed = moved }
SWR.fade(moved, current: { changed }, clear: { changed = [] })
```

#### `View.swrFlash(_:cornerRadius:color:)`

The once-per-refresh flash behind a row that the last refresh changed. Pair it with `SWR.rowTransition`.

- `_ on: Bool`: true while the row is flashed.
- `cornerRadius: CGFloat = 8`: the corner radius of the flash.
- `color: Color = SessionPalette.blue`: the flash color, drawn at 16 percent opacity.

```swift
RowView(row: row)
    .swrFlash(changed.contains(row.id))
    .transition(SWR.rowTransition)
```

#### `Plural`

A count with its noun, so no view prints "1 files" again. `Plural` is an enum of two helpers.

- `static func count(_ count: Int, _ singular: String, _ plural: String? = nil) -> String`: the count and the noun, for example "1 file" or "4 files". Pass `plural` for an irregular noun.
- `static func word(_ count: Int, _ singular: String, _ plural: String? = nil) -> String`: the noun alone, for text such as "\(n) sub-\(word)".

The regular plural handles a consonant plus "y" ("reply" to "replies"), and endings in "s", "x", "z", "ch" and "sh" (add "es").

```swift
Text(Plural.count(files.count, "file"))
Text(Plural.count(people.count, "person", "people"))
Text("\(agents.count) sub-\(Plural.word(agents.count, "agent"))")
```

#### `ByteFormat`

File and memory sizes in one locale (`en_US`), so a Czech Mac does not print "3,21 GB" next to English text. `ByteFormat` is an enum of two helpers. Every size label goes through here instead of `ByteCountFormatter`.

- `static func file(_ bytes: Int64) -> String`: a file size, for example "655.1 MB".
- `static func memory(_ bytes: Int64) -> String`: a memory size.

```swift
let size = ByteFormat.file(3_210_000_000)       // "3.21 GB"
let footprint = ByteFormat.memory(residentBytes)
Text("\(size) on disk, \(footprint) in memory")
```

#### `GenAccessibilityID`

How a kit control spells a value inside an accessibility identifier, so a UI scenario can name a segment, an option or a matrix cell without knowing the Swift type.

- `static func suffix(_ value: some Hashable) -> String`: the value as text (an enum case's name, a string as it is), the first letter lowercased, spaces and dots as `-`; `none` for an empty string. The spelling is lossy ("a b" and "a.b" both give "a-b", "Foo" and "foo" both give "foo"), so keep one control's values distinct after it.

```swift
let id = "posture.effects.style.option.\(GenAccessibilityID.suffix(ScreenEffectStyle.edgeGlow))"   // ...option.edgeGlow
```

### Time

Relative-time labels that keep themselves current. `LiveTime` is the main entry point: it shows a date in one of eight wordings (`LiveTimeStyle`) and redraws only itself, on the second or the minute when its text changes. `LiveAgo` wraps it for an optional date with a fallback text. `LiveTimeFormat` is the formatter behind both, and `LiveTimeSchedule` is the clock they share. Use the formatter and the schedule directly when you need the same wording outside a `LiveTime` label.

#### `LiveTime`

A label that shows a date as a relative time and updates itself. Its clock is its own `TimelineView`, so nothing above it re-renders per tick. The label reserves its width from a hidden copy of the text with every digit set to zero, and it uses tabular digits, so a tick that changes only digits does not change the layout.

- `date: Date`: the moment the label counts from or toward.
- `style: LiveTimeStyle = .ago`: the wording (see `LiveTimeStyle`).
- `alignment: Alignment = .leading`: where the text sits inside the reserved width.
- `format: (String) -> String = { $0 }`: wraps the time text into the whole label. For `.until`, the time text is empty once the date has passed, and `format` still runs with an empty string.

```swift
HStack {
    Text(turn.title)
    Spacer()
    LiveTime(date: turn.startedAt, style: .elapsed, alignment: .trailing) { "running \($0)" }
}
```

#### `LiveTimeStyle`

The wording a `LiveTime`, `LiveAgo` or `LiveTimeFormat.text` call uses. Each case keeps the wording of the screen it came from.

- `ago`: `just now`, `45s ago`, `12m ago`, `7h 14m ago`, `3d ago`.
- `elapsed`: time since the date, for a running turn: `12s`, `4m 12s`, `2h 05m`.
- `compact`: `just now`, `4m`, `2h 05m`, `3d`.
- `until`: time left: `in 12m`, `in 2h 05m`. Nothing once the date has passed.
- `brief`: `now`, `5m ago`, `2h ago`, `3d ago`, `2w ago`.
- `briefCompact`: `now`, `5m`, `2h`, `3d`, `2w`, `1y`.
- `spelled`: `now` under a minute and a half, then the system's abbreviated words: `5m ago`, `2h ago`, `2d ago`.
- `short`: the system's short words: `20 sec. ago`, `5 min. ago`, `2 hr. ago`, `2 days ago`.

```swift
let style: LiveTimeStyle = isSidebar ? .briefCompact : .short
HStack {
    LiveTime(date: reply.createdAt, style: style) { "sent \($0)" }
    LiveAgo(date: reply.editedAt, fallback: "not edited", style: style)
}
```

#### `LiveAgo`

A `LiveTime` for a date that may be missing. It uses the system's short words by default. Without a date it shows `fallback`, still passed through `format`.

- `date: Date?`: the moment to show; nil shows the fallback.
- `fallback: String = ""`: the text for a nil date.
- `style: LiveTimeStyle = .short`: the wording.
- `format: (String) -> String = { $0 }`: builds the whole text around the time.

```swift
LiveAgo(
    date: thread.readAt,
    fallback: "never",
    style: .brief
) { "read \($0)" }
```

#### `LiveTimeSchedule`

A `TimelineSchedule` that fires only at the moments a `LiveTime` text can change: every second while the text shows seconds, then once per minute or hour. Use it to drive your own `TimelineView` with `LiveTimeFormat`.

- `date: Date`: the moment the text counts from or toward.
- `style: LiveTimeStyle`: the wording whose change points are used.

```swift
TimelineView(LiveTimeSchedule(date: sentAt, style: .brief)) { context in
    Text(verbatim: LiveTimeFormat.text(.brief, sentAt, now: context.date) ?? "")
}
```

#### `LiveTimeFormat`

The one formatter for every relative time, plus the rule for when a text next changes. All methods are static.

- `text(_ style: LiveTimeStyle, _ date: Date, now: Date) -> String?`: the date in the style as seen at `now`. nil for `.until` once the date has passed.
- `nextChange(_ style: LiveTimeStyle, _ date: Date, after now: Date) -> Date?`: the first moment after `now` when the text can read differently; nil when it never will.
- `widthTemplate(_ text: String) -> String`: the text with every digit replaced by zero, for reserving width.
- `ago(_ seconds: TimeInterval) -> String`: `just now`, `45s ago`, `12m ago`, `7h 14m ago`, `3d ago`.
- `elapsed(_ seconds: TimeInterval) -> String`: `850ms`, `12s`, `4m 12s`, `2h 05m`.
- `compact(_ seconds: TimeInterval) -> String`: `just now`, `4m`, `2h 05m`, `3d`.
- `until(_ seconds: TimeInterval) -> String?`: `in 12m`, `in 2h 05m`. `seconds` is the time left; nil when it is not positive.
- `brief(_ seconds: TimeInterval) -> String`: `now`, `5m ago`, `2h ago`, `3d ago`, `2w ago`.
- `briefCompact(_ seconds: TimeInterval) -> String`: `now`, `5m`, `2h`, `3d`, `2w`, `1y`.
- `spelled(_ date: Date, now: Date) -> String`: `now` under 90 seconds, then the system's abbreviated words.

```swift
let age = LiveTimeFormat.brief(Date().timeIntervalSince(commit.date))
let label = LiveTimeFormat.text(.compact, commit.date, now: Date()) ?? "n/a"
if let nextTick = LiveTimeFormat.nextChange(.compact, commit.date, after: Date()) {
    scheduleRefresh(at: nextTick)
}
```

### Tools

Tools holds the clients for the `tools` CLI and the small helpers its callers share. `ToolsBridge` runs `tools <subcommand>` as a scrubbed child process, or asks a resident `ToolsServerClient` first. `ToolsLineStream` follows a long-running `--live` command line by line. `MonitorJSON` reads their output, and `SessionTranscriptClient` with `SessionTranscriptCache` fetch and keep session transcripts. `DiskCache`, `DirectoryWatcher`, `StickyOrder`, `ShellWords`, `TitleFormatter` and `ToolsCallTrace` are supporting pieces.

#### `ToolsBridge`

A scrubbed `tools <sub> ...` runner. It passes an argv array and never uses a shell. Logging goes to `os.Logger` (subsystem `dev.foltyn.genesis`, category `monitor`), and a host that wants the output on disk passes an `outputSink`. When a `server` is set, `run` asks it first and starts a process only when the server cannot answer. The type is a `Sendable` struct.

Initializers:

- `binaryPath: String`, `outputSink: OutputSink? = nil`, `server: ToolsServerClient? = nil`: a fixed path to the `tools` binary.
- `resolveBinaryPath: @escaping @Sendable () -> String`, `outputSink: OutputSink? = nil`, `server: ToolsServerClient? = nil`: a closure asked at each run, so a changed setting applies without a restart.

`OutputSink` is `@Sendable (ToolsRunResult, _ turnId: String, _ callId: String, _ argv: [String]) -> Void`. It is called after each finished call.

Properties:

- `binaryPath: String`: the path as resolved now.
- `binaryExists: Bool`: true when that path is an executable file.
- `outputSink: OutputSink?` and `server: ToolsServerClient?`: as passed in.

Static members:

- `envAllowlist: Set<String>`: the only environment names a child receives: HOME, PATH, SHELL, LANG, USER, LOGNAME, TERM, TZ, the SSH agent and certificate variables, a few credential variables, PROFILE, three `GENESIS_TOOLS_*` switches and the trace id.
- `isExecutableFile(_ path: String) -> Bool`: true for an executable regular file. A folder is false.
- `defaultBinaryPath(home: URL = FileManager.default.homeDirectoryForCurrentUser, isExecutable: (String) -> Bool = ToolsBridge.isExecutableFile) -> String`: the first executable of: the preview bundle's CLI (when the bundle is a preview build), the `GENESIS_TOOLS_BIN` override, `~/.bun/bin/tools`, `~/.local/bin/tools`, the repository's `tools` script and `/usr/local/bin/tools`. When none is executable it returns `~/.bun/bin/tools`.
- `resolveBinaryPath(configured: String?, home: URL = FileManager.default.homeDirectoryForCurrentUser, isExecutable: (String) -> Bool = ToolsBridge.isExecutableFile) -> String`: the configured path when it is executable, else the default.
- `workingDirectory(forBinary path: String) -> URL`: the binary's folder after following symlinks, so Bun finds the repository's `node_modules`.
- `launchPlan(binaryPath: String, argv: [String], bunExecutable: String? = nil) -> ProcessLaunchPlan`: how to start the binary. A script with a bun or node shebang starts as `bun <script> ...`. `ProcessLaunchPlan` has `executable: URL`, `arguments: [String]` and `workingDirectory: URL`.
- `scrubbedEnvironment(from env: [String: String] = ProcessInfo.processInfo.environment) -> [String: String]`: the environment filtered by `envAllowlist`, with `PATH` extended by the Bun, Homebrew and `/usr/local/bin` folders.

Method:

- `run(subcommand: String, args: [String], timeoutSeconds: Int = 30, turnId: String = "adhoc", callId: String = UUID().uuidString, extraEnv: [String: String] = [:]) async throws -> ToolsRunResult`: runs `tools <subcommand> <args>`. `extraEnv` keys outside `envAllowlist` are dropped. A call that includes `--readme` is refused. A timeout terminates the child. A canceled task terminates it too. A call that finishes (through the server or as a process) or times out writes one `ToolsCallTrace` line. Throws `ToolsBridgeError`, or `CancellationError` when the task is canceled.

```swift
let bridge = ToolsBridge(binaryPath: ToolsBridge.defaultBinaryPath())
let result = try await bridge.run(
    subcommand: "ai", args: ["sessions", "tail", "abc123", "--json", "--limit", "20"],
    timeoutSeconds: 20)
print(result.exitCode, result.wallMs)
```

#### `ToolsRunResult`

The outcome of one `tools` call, from `ToolsBridge.run` or `ToolsServerClient.call`. A non-zero `exitCode` is a result, not a thrown error.

- `stdout: String`: standard output.
- `stderr: String`: standard error.
- `exitCode: Int32`: the exit status.
- `wallMs: Int`: elapsed time in milliseconds.

```swift
let result = try await bridge.run(subcommand: "ai", args: ["sessions", "tail", "abc123", "--json"])
guard result.exitCode == 0 else { throw ToolsBridgeError.refused(result.stderr) }
print(result.stdout.count, "bytes in", result.wallMs, "ms")
```

#### `ToolsBridgeError`

The error `ToolsBridge` and the readers in this folder throw. It conforms to `LocalizedError` and `Equatable`, so `errorDescription` is a sentence fit for a banner.

- `binaryNotFound(String)`: no executable at that path.
- `timeout(seconds: Int)`: the call ran longer than its limit and was killed.
- `refused(String)`: the call was refused or its output was unusable. The text says why.

```swift
do {
    _ = try await bridge.run(subcommand: "ai", args: ["sessions", "tail", "abc123", "--json"])
} catch ToolsBridgeError.timeout(let seconds) {
    print("gave up after", seconds)
}
```

#### `ToolsServerClient`

A client for a resident `tools` server: line-delimited JSON over a Unix socket, where the request is the same argv the CLI takes. Every method answers nil when the server cannot serve the request (not running, an argv it has no handler for, a dropped connection). The caller then runs the same argv as a process, so the client only makes a call cheaper, never different. One connection opens on first use and again after a drop. Reads are event-driven. Pass it to `ToolsBridge(server:)` to get this behavior in `run`.

Initializer:

- `socketPath: String = ToolsServerClient.defaultSocketPath()`: the socket to connect to.
- `startEvery: TimeInterval = 60`: the least seconds between two calls of `startServer`.
- `startServer: (@Sendable () -> Void)? = nil`: run on a background queue when the socket does not answer.

Properties and static members:

- `socketPath: String`: the socket in use.
- `isConnected: Bool`: true while a connection to the server is open. It does not connect and does not start a server.
- `static func defaultSocketPath(home: URL = FileManager.default.homeDirectoryForCurrentUser) -> String`: the hub server socket under `~/.genesis-tools/hub/server/`.

Methods:

- `call(argv: [String], timeoutSeconds: Int, traceId: String? = nil) async -> ToolsRunResult?`: the server's answer to `tools <argv>`, or nil. A canceled task gets nil at once, and the server is told to stop the call.
- `callSync(argv: [String], timeout: TimeInterval, traceId: String? = nil) -> ToolsRunResult?`: the same, blocking the calling thread for at most `timeout` seconds. Never call it on the main thread.
- `subscribe(argv: [String], traceId: String? = nil, onLines: @escaping @MainActor ([String]) -> Void, onEnd: @escaping @MainActor (End) -> Void) -> Subscription?`: follows a `--live` command. Lines arrive on the main actor, a burst in one call. `onEnd` runs once. Nil means the server cannot follow it, so start the process.

Result types:

- `End`: `exit: Int32`, `stderr: String` and `reason: String`. The reason is "done", "cancelled", "restart" (the server is going away, subscribe again), "error", "disconnected", or the server's refusal code.
- `Subscription`: `stop()` cancels the follow. It is idempotent.

```swift
let server = ToolsServerClient()
if let result = await server.call(argv: ["hub", "agents", "counts"], timeoutSeconds: 10) {
    print(result.stdout)
}
```

#### `ToolsLineStream`

One long-running `tools` child whose standard output arrives as whole lines on the main actor: a `tools ... --live` follow, which prints a line per change until it is stopped. Nothing polls. A chunk's complete lines go to `onLines` in one call. The child's standard input is a pipe this object holds open. When this process quits, the kernel closes the pipe, and a child that watches its stdin ends. `onExit` runs once, after both the exit and the end of output, so the last lines arrive before `onExit` runs.

Initializer (throws when the binary is missing or the child cannot start). It starts the child the way `ToolsBridge.run` does:

- `bridge: ToolsBridge`: supplies the binary path.
- `subcommand: String`: the `tools` subcommand.
- `args: [String]`: its arguments.
- `extraEnv: [String: String] = [:]`: extra environment, filtered by `ToolsBridge.envAllowlist`.
- `priority: Priority = .utility`: `.background` for work that must never compete with the user (an index build): background quality of service, the Darwin background policy from the first instruction (`taskpolicy -b`, which throttles disk and network I/O and is inherited by every child), and nice 15. The pid stays the command's own, so `stop()` and the exit report are unchanged.
- `onLines: @escaping @MainActor ([String]) -> Void`: complete lines of one chunk.
- `onExit: @escaping @MainActor (Exit) -> Void`: the end report.

Properties:

- `traceId: String`: the id the child gets in its environment. One `ToolsCallTrace` line is written when the follow ends.
- `processIdentifier: Int32`: the child's process id.
- `static let stderrLimit = 8192`: how many bytes of standard error are kept for the exit report.
- `Exit`: `status: Int32`, `stopped: Bool` (true after our own `stop()`) and `stderr: String` (the last `stderrLimit` bytes).

Methods:

- `sendInput(_ text: String) throws`: writes a small control message (1 to 512 bytes) to the child without blocking. Throws a `POSIXError` when the text is empty or too long, or when the input is closed or the child has ended.
- `finishInput()`: closes the child's standard input, which asks it to finish.
- `stop()`: closes the input and sends SIGTERM. `onExit` still runs, with `stopped` true.
- `kill()`: `stop()`, then SIGKILL for a child that ignored SIGTERM.

```swift
let stream = try ToolsLineStream(
    bridge: bridge, subcommand: "ai",
    args: ["sessions", "tail", "abc123", "--live", "--offset", "0"],
    onLines: { lines in print(lines.count, "new lines") },
    onExit: { exit in print("exit", exit.status, "stopped:", exit.stopped) })
// later
stream.stop()
```

#### `MonitorJSON`

Helpers for reading the JSON a `tools` child prints, and for turning a failure into a sentence that names what arrived. Every `tools` JSON reader goes through it.

- `static func dataByDroppingPreamble(_ data: Data) throws -> Data`: returns the data unchanged when it is already JSON. Otherwise it drops a leading banner, warning or `[profile:...]` line and returns the first `{` tail that parses (it tries up to eight starts). Throws `ToolsBridgeError.refused` when the output is empty or holds no JSON object.
- `static func failureDetail(_ error: Error, stdout: String, stderr: String) -> String`: one sentence for the error, with a short quote of stdout and stderr attached.
- `static func describe(_ error: DecodingError) -> String`: keeps which key or type broke and where.
- `static func failureReason(_ stderr: String, limit: Int = 200) -> String`: why a child failed, from stderr. It leaves out `[profile:...]` timing lines unless nothing else was printed.
- `static func preview(_ text: String, limit: Int = 200) -> String`: a short single-line quote. Lines are trimmed and joined with a visible line-break mark, and the text is cut at `limit` characters.

```swift
let noisy = Data("warning: slow disk\n{\"ok\": true}".utf8)
let json = try MonitorJSON.dataByDroppingPreamble(noisy)   // {"ok": true}
let reason = MonitorJSON.failureReason("[profile:ai] 12ms\nboom: disk full")   // "boom: disk full"
```

#### `ToolsCallTrace`

One line per `tools` call in `app-perf.log`, whichever way the call ran, so any call can be traced later. The trace id also goes to the CLI (the `GENESIS_TOOLS_TRACE_ID` environment variable for a process, `traceId` in a server request). `ToolsBridge` and `ToolsLineStream` write the line themselves, so a host rarely calls `record`.

- `static let environmentKey = "GENESIS_TOOLS_TRACE_ID"`: the environment variable name.
- `static func newId() -> String`: 8 hex characters.
- `static func redacted(_ argv: [String]) -> [String]`: replaces the value after a flag that names a credential (a flag containing token, secret, password, key or auth, and the header flags), and the value in a `--flag=value` form.
- `static func record(traceId: String, via: String, argv: [String], started: Date, exit: Int32, outBytes: Int, stderr: String)`: writes the line. It does nothing when `PerfLog` is off. The argv is redacted and cut to 300 characters. For a failed child only the size of its stderr is written.

```swift
let argv = ["service", "call", "--token", "abc123"]
let safe = ToolsCallTrace.redacted(argv)   // ["service", "call", "--token", "***"]
let started = Date()
ToolsCallTrace.record(
    traceId: ToolsCallTrace.newId(), via: "process", argv: argv, started: started,
    exit: 0, outBytes: 128, stderr: "")
```

#### `SessionTranscriptClient`

Fetches one session's transcript through `tools ai sessions tail`. `offset` is a turn index. A nil offset asks for the last `limit` turns, which is what a first open wants. A "load earlier" page passes the window start minus the page size.

- `static func arguments(sessionId: String, limit: Int = 80, offset: Int? = nil) -> [String]`: the argv after `ai`: `sessions tail <id> --json --limit <n>` and `--offset <n>` when given.
- `static func decode(_ data: Data) throws -> TranscriptEnvelope`: drops any preamble with `MonitorJSON`, then decodes.
- `static func fetch(using bridge: ToolsBridge, sessionId: String, limit: Int = 80, offset: Int? = nil) async throws -> TranscriptEnvelope`: runs the command with a 30 second limit and `PROFILE=ai-transcript`. Throws `ToolsBridgeError.refused` with a readable reason when the command exits non-zero or its output cannot be read.

```swift
let args = SessionTranscriptClient.arguments(sessionId: "abc123", limit: 40, offset: 80)
// ["sessions", "tail", "abc123", "--json", "--limit", "40", "--offset", "80"]
let envelope = try await SessionTranscriptClient.fetch(
    using: bridge, sessionId: "abc123", limit: 40)
print(envelope.turns.count, envelope.windowStart)
```

#### `SessionTranscriptCache`

A small in-memory cache of transcript windows, so opening a session row paints at once. It keeps the most recently used windows, drops one after `lifetime` seconds, and runs one load at a time: a load for a new query cancels the pending one. It is `@MainActor`.

Initializers:

- `capacity: Int = 3`, `lifetime: TimeInterval = 15`, `now: @escaping () -> Date = Date.init`, `load: @escaping @Sendable (Query) async throws -> TranscriptEnvelope`: with your own loader. `capacity` is at least 1.
- `init(bridge: ToolsBridge)`: loads with `tools ai sessions tail <query> --json --limit <n> --provider <p>`.

`Query` is hashable and has this initializer:

- `identity: String`: names the row, for the log.
- `query: String`: the session id, passed as the `<query>` argument of `sessions tail`.
- `provider: String`: the provider the session belongs to.
- `limit: Int = 30`: how many turns to fetch, clamped to 1 through 80.

Methods:

- `prefetch(_ query: Query)`: starts a load in the background unless the window is cached or already loading.
- `value(for query: Query) async throws -> TranscriptEnvelope`: the cached window, or a fresh load.
- `cancelPending()`: cancels the load in flight.

```swift
let cache = SessionTranscriptCache(bridge: bridge)
let query = SessionTranscriptCache.Query(identity: "row-1", query: "abc123", provider: "claude", limit: 40)
cache.prefetch(query)
let envelope = try await cache.value(for: query)
```

#### `TranscriptEnvelope`

One window of a session's transcript, as `tools ai sessions tail --json` prints it. It is `Codable`. Decode it with `SessionTranscriptClient.decode(_:)`. The memberwise initializer is not public.

- `provider: String`, `sessionId: String`, `filePath: String`: which session and where its file is.
- `byteSize: Int`: the byte size the CLI reports for the session file.
- `truncated: Bool`: the CLI's flag that the transcript was cut.
- `nextOffset: Int`: the turn index after the last turn in this window.
- `turns: [TranscriptTurn]`: the turns of the window.
- `totals: TranscriptTotals?`: the summed cost of the window. Absent for a provider that reports no usage.
- `terminated: String?`: how the session ended. Nil means it is still open, which is a real answer.
- `turnCount: Int?`: turns in the whole transcript. Absent from an older `tools`.
- `windowStart: Int`: the turn index of the first turn in this window.
- `liveFollowOffset: Int`: where a live follow of this window starts: the oldest turn that can still change (one with a tool still waiting for its result), else the last turn.

```swift
let envelope = try SessionTranscriptClient.decode(data)
let earlier = SessionTranscriptClient.arguments(
    sessionId: envelope.sessionId, limit: 40, offset: max(0, envelope.windowStart - 40))
let followOffset = envelope.liveFollowOffset
```

#### `TranscriptTurn`

One turn of a transcript. It is `Codable` and `Identifiable`.

- `id: String`: the turn's id.
- `role: String`: who spoke, such as `user` or `assistant`.
- `at: String? = nil`: the time, as printed by the CLI.
- `text: String`: the turn's text.
- `tools: [TranscriptTool] = []`: tool calls made in the turn.
- `reasoning: String? = nil`: the model's own reasoning, when the provider records it.
- `usage: TranscriptUsage? = nil`: this call's token cost. Absent on a user turn.
- `index: Int? = nil`: the session-wide 0-based index, set by `tail --turns` and by a host that merges search hits with its window.
- `parts: [TranscriptPromptPart]? = nil`: a user turn split into its parts (peer messages, task results, an Esc marker, reminders). Absent on an ordinary prompt.

```swift
let tool = TranscriptTool(id: "c1", name: "Bash", inputPreview: "swift build", result: "done", exitCode: 0)
let usage = TranscriptUsage(inputTokens: 2300, outputTokens: 911)
let turn = TranscriptTurn(
    id: "t1", role: "assistant", text: "Built it.", tools: [tool], usage: usage, index: 1)
```

#### `TranscriptTool`

One tool call inside a turn. It is `Codable` and `Identifiable`.

- `id: String`: the call's id.
- `name: String`: the tool's name.
- `inputPreview: String`: a short preview of the input.
- `result: String? = nil`: the result. Nil while the call still waits for it.
- `isError: Bool = false`: the call failed.
- `exitCode: Int? = nil`: the exit status when the tool ran a command.
- `resultChars: Int? = nil`: the length of the full result before it was clipped.

```swift
let running = TranscriptTool(id: "c1", name: "Bash", inputPreview: "swift build")
let finished = TranscriptTool(
    id: "c2", name: "Bash", inputPreview: "swift test", result: "done", exitCode: 0)
let stillWaiting = [running, finished].filter { $0.result == nil }.count   // 1
```

#### `TranscriptUsage`

What one model call cost. All fields are optional and default to nil. It is `Codable`.

- `inputTokens: Int? = nil`, `cacheReadTokens: Int? = nil`, `outputTokens: Int? = nil`, `reasoningTokens: Int? = nil`: the token counts.
- `summary: String?`: one line such as `in 2.3K · cache 81.8K · out 911`. A zero or missing count is left out, and the result is nil when nothing is left.

```swift
let usage = TranscriptUsage(inputTokens: 2300, cacheReadTokens: 81_800, outputTokens: 911)
let line = usage.summary   // "in 2.3K · cache 81.8K · out 911"
let none = TranscriptUsage(reasoningTokens: 0).summary   // nil
```

#### `TranscriptTotals`

Every model call in a window, summed. It is `Codable`.

- `modelCalls: Int? = nil`: the number of calls, not a token figure.
- `inputTokens`, `cacheReadTokens`, `outputTokens`, `reasoningTokens: Int? = nil`: summed token counts.
- `costUsd: Double? = nil`: the booked cost in US dollars, when the provider reports one. It is never derived here.
- `summary: String?`: one line such as `12 calls · in 51.6K · cache 2.4M · out 12.7K`. A zero or missing count is left out.
- `static func tokens(_ value: Int) -> String`: a token count as `911`, `1.2K` or `2.4M`. It is not `TitleFormatter.formatCtx`, whose `ctx` suffix means a context size.

```swift
let totals = TranscriptTotals(modelCalls: 12, inputTokens: 51_600, costUsd: 1.2)
let line = totals.summary   // "12 calls · in 51.6K"
let count = TranscriptTotals.tokens(2_400_000)   // "2.4M"
```

#### `TranscriptPromptPart`

One part of a user turn that holds more than the user's own words. Every field except `kind` is optional, so a kind this build does not know still decodes and shows as plain text. It is `Codable`.

- `kind: String`: `user`, `teammate`, `task`, `interrupt` or `system`.
- `text: String? = nil`: the text, for `user`, `interrupt` and `system`.
- `midTurn: Bool? = nil`: for `user`, typed while the agent was working.
- `from: String? = nil`, `color: String? = nil`, `summary: String? = nil`, `type: String? = nil`, `body: String? = nil`: for `teammate`: the sender's name and color, the summary it gave, the payload type and the markdown body.
- `id: String? = nil`, `status: String? = nil`, `outputFile: String? = nil`, `result: String? = nil`: for `task`: the task id, its status, the output file and a sub-agent's report.

```swift
let typed = TranscriptPromptPart(kind: "user", text: "Also run the tests", midTurn: true)
let message = TranscriptPromptPart(
    kind: "teammate", from: "reviewer", summary: "Found a bug", body: "See line 12")
let turn = TranscriptTurn(id: "t2", role: "user", text: "", parts: [typed, message])
```

#### `DiskCache`

The last answer of a slow read (a `tools` call, a git scan), kept on disk so a view paints it at once and refreshes behind it. A view always asks again. The cache only decides what shows while it waits. Files are `<namespace>-<hash>.json`, and a key is hashed (SHA-256), so any text works as a key. A write failure is logged and never thrown. A file that cannot be decoded, such as one written by an older build, is ignored and logged. The type is a `Sendable` struct.

Initializers:

- `folder: String`, `namespace: String`: files go in `~/.genesis-tools/<folder>/cache`.
- `directory: URL`, `namespace: String`: files go in that directory.

Members:

- `directory: URL` and `namespace: String`: as passed in.
- `url(for key: String) -> URL`: the file for a key.
- `read<Value: Decodable>(_ type: Value.Type, key: String) -> Value?` and `readData(key: String) -> Data?`: read on the calling thread.
- `load<Value: Decodable & Sendable>(_ type: Value.Type, key: String) async -> Value?` and `loadData(key: String) async -> Data?`: the same, off the main thread.
- `modified(key: String) -> Date?`: when the key was last written, or nil.
- `write<Value: Encodable>(_ value: Value, key: String)` and `writeData(_ data: Data, key: String)`: write atomically, creating the folder when needed.

```swift
let cache = DiskCache(folder: "demo", namespace: "pr")
if let shown = cache.read([String].self, key: "pr-42") { print(shown) }   // paint at once
cache.write(["fresh", "answer"], key: "pr-42")                             // then refresh
```

#### `DirectoryWatcher`

One FSEvents stream over a set of folders, delivered on the main queue. The stream's latency merges a burst of writes into one callback, and `accepts` drops paths that do not matter. A folder that does not exist yet is fine: the watcher reports it once something creates it. It watches from the moment it is created, and it stops when it is released. With no paths it watches nothing.

- `paths: [String]`: the watched folders.
- `latency: TimeInterval = 0.5`: seconds FSEvents holds events before it hands them over as one batch. The least value used is 0.1.
- `accepts: (String) -> Bool = { _ in true }`: filters the event paths. `/private/var` and `/private/tmp` paths are written without the `/private` prefix before the filter sees them.
- `onChange: ([String]) -> Void`: gets the accepted paths of one batch.
- `stop()`: ends the stream. It is safe to call twice.

```swift
let watcher = DirectoryWatcher(paths: ["/tmp/demo/inbox"], latency: 0.2, accepts: { $0.hasSuffix(".json") }) { changed in
    print("changed:", changed)
}
// later
watcher.stop()
```

#### `StickyOrder`

A list order that does not jump on refresh. Rows sit in two buckets, active first. A refresh keeps the previous order as the base. It puts new rows at the top of their bucket and moves a row that changed bucket to the top of its new one. Inside a bucket nothing is sorted again by recency. A row turns active at once but leaves the active bucket only `hold` seconds after it was last seen active, so a turn boundary does not bounce it. The type is generic over the row id.

Initializer:

- `hold: TimeInterval = 120`: seconds a row stays in the active bucket after it was last active.

Members:

- `hold: TimeInterval`: as passed in.
- `order: [ID]`: the current order. Read-only.
- `isActive(_ id: ID) -> Bool`: true when the row is in the active bucket.
- `update(_ items: [Item], now: Date = Date(), resort: Bool = false, hold holding: Bool = false) -> [ID]`: applies a refresh and returns the new order. The result may be ignored. `resort: true` sorts everything again (an explicit action). `hold: true` freezes every move while the pointer is over the list: known rows keep their places and new rows go to the end.
- `Item`: `init(id: ID, active: Bool, lastAt: Date)`. `lastAt` ranks rows within a bucket.

```swift
var rail = StickyOrder<String>(hold: 60)
let order = rail.update([
    .init(id: "a", active: true, lastAt: Date()),
    .init(id: "b", active: false, lastAt: Date().addingTimeInterval(-300)),
])
```

#### `ShellWords`

Text as POSIX shell words, for a command line a person copies or a terminal runs (a resume command, a launch command, a generated script). It is one place, so every copy quotes the same way.

- `static func quoted(_ text: String) -> String`: always one word, in single quotes, with a `'` inside written as `'\''`. Use it for a path or any text that is data.
- `static func word(_ text: String) -> String`: a command word as typed: bare when no character in it means anything to a shell, else quoted. A leading `=` is quoted too, because zsh would turn `=cat` into the path of `cat`.

```swift
let file = ShellWords.quoted("/tmp/demo/my file.txt")   // '/tmp/demo/my file.txt'
let tool = ShellWords.word("ls")                         // ls
let command = "\(tool) -l \(file)"                       // ls -l '/tmp/demo/my file.txt'
```

#### `TitleFormatter`

An enum of formatting functions for menu-bar titles, usage rows and session titles. All are static.

Money and counts:

- `formatCost(_ value: Double) -> String`: US dollars with two decimals, such as `$3.00`.
- `formatMoney(_ value: Double, currency: String, fractionDigits: Int? = nil, grouping: Bool = true) -> String`: money in its own currency (`$3.00`, `€3.00`, `¥300`). The ISO 4217 code picks the symbol and, unless `fractionDigits` is set, the usual decimals. An empty code means USD.
- `formatCostCompact(_ value: Double, currency: String = "USD") -> String`: `$3` instead of `$3.00`. Real cents stay. There is no digit grouping.
- `formatMTok(_ tokens: Int) -> String`: millions of tokens, such as `1.25 MTok`.
- `formatCtx(_ tokens: Int) -> String`: a context size such as `950 ctx`, `12k ctx` or `3.10M ctx`.

Time:

- `formatTimeRemaining(until: Date, now: Date, template: String) -> String`: expands `{h}` (whole hours), `{m}` (remaining minutes), `{M}` (total minutes) and `{h.f}` (hours with two decimals) in the template. Empty when the window has lapsed.
- `formatShortCountdown(until: Date?, now: Date = Date()) -> String?`: `32m`, `1h32m` or `2d4h`. Nil when the date is missing or past.

Menu-bar title:

- `title(mode: MenuBarTitleMode, alias: String?, fiveHourLeftPct: Double?, todayCost: Double?, todayTokens: Int?, weekCost: Double?, monthCost: Double?, timeRemaining: String?, sevenDayLeftPct: Double? = nil) -> String?`: the title for the mode, with `timeRemaining` appended after ` · `. The percents are the headroom left. When the data the mode needs is missing, only `timeRemaining` is returned, or nil when that is empty too.
- `providerChips(_ chips: [ProviderChip]) -> String?`: chips joined as `C 41% · X 12% · G $3`. Nil for an empty list. `ProviderChip` has `init(glyph: String, value: String)`.

Session titles:

- `slashInvocations(in text: String) -> [SlashInvocation]`: every `<command-name>` in the text, paired with the `<command-args>` that follows it. The name gets a leading `/`. `SlashInvocation` has `init(name: String, args: String)`.
- `cleanSessionTitle(_ raw: String?) -> String?`: a session title as the user typed it. It drops harness tags and `[Image #n]` placeholders. A slash command with no arguments (`/clear`) is dropped. When no text is left, the commands that have arguments are joined. Nil when nothing is left.

```swift
let cost = TitleFormatter.formatCostCompact(3)   // "$3"
let title = TitleFormatter.title(
    mode: .quotaAndSpend, alias: "work", fiveHourLeftPct: 72, todayCost: 3.5,
    todayTokens: 1_250_000, weekCost: nil, monthCost: nil, timeRemaining: "1h32m")
// "work 72% · $3.50 · 1.25 MTok · 1h32m"
```

#### `MenuBarTitleMode`

What the menu-bar title shows. It is a `String` enum that conforms to `CaseIterable`, `Equatable` and `Sendable`. Pass it to `TitleFormatter.title(mode:...)`.

- `quotaAndSpend`: the alias, the five-hour percent left, today's cost and today's tokens.
- `todayUsage`: today's cost and tokens.
- `todayCost`, `weeklyCost`, `monthlyCost`: one cost.
- `todayTokens`: today's tokens.
- `fiveHour`, `sevenDay`: the percent left in that window.
- `utilization`: the smaller of the two percents left, the most depleted window.
- `none`: no mode text. Only the `timeRemaining` text shows, when one is given.

```swift
let mode = MenuBarTitleMode(rawValue: "todayCost") ?? .quotaAndSpend
let title = TitleFormatter.title(
    mode: mode, alias: nil, fiveHourLeftPct: nil, todayCost: 3.5, todayTokens: nil,
    weekCost: nil, monthCost: nil, timeRemaining: nil)   // "$3.50"
```

### Widgets

Widgets is the notch and side-edge widget: panels pinned to the top and side of a screen that show local agent sessions, an inbox of questions, answers and results, and small modules (capture, file shelf, tasks, voice notes, Flow). `WidgetCoordinator` is the entry point a host creates: it builds a `WidgetModel` and the shelf, tasks and voice-notes stores, registers their modules in a `WidgetModuleRegistry`, and owns the edge panels and the settings and media windows. `WidgetModel` holds the observable state and the actions, following a `tools hub widget watch` stream into a `WidgetSnapshot` that every view reads. `LiveWidgetView` is the agents pane drawn inside a panel, `AgentWidgetView` is the strip-and-rail frame around it, and a `WidgetModuleDescriptor` adds a module with a compact, a preview and an expanded view. `WidgetLayoutConfiguration` decides which module ids appear at the top and in the three side groups, and the wire types (`WidgetSnapshot`, `WidgetSession`, `WidgetCard`, `WidgetPreferences`, `WidgetOutgoing`) mirror the hub's JSON, while the stores in `Widgets/Shelf/`, `Widgets/Tasks/` and `Widgets/VoiceNotes/` each talk to one `tools hub widget` subcommand.

#### `WidgetCoordinator`

The object a host creates to run the whole widget. It builds the model, the Capture, File Shelf, Tasks, Flow and Voice Notes modules (plus the Agents module), creates the edge panels for the chosen display, installs the mouse and keyboard monitors that collapse a panel on an outside click or Escape, and opens the settings and media windows. It creates no panels and no monitors while "Show the widget" is off. It rebuilds the panels when the screen setup changes. It is `@MainActor`.

- `binaryPath: String`: path of the `tools` executable. Every `hub widget` command runs through it.
- `stateRoot: String? = nil`: an alternate widget state folder. It is passed to the hub as `--state-root`.
- `flowRuntime: FlowFocusRuntime? = nil`: the Flow and Focus runtime. `FlowFocusRuntime.shared` when nil.
- `micLauncher: String? = nil`: path of the executable that records the microphone for Voice Notes. When nil, recording from the microphone is refused.
- `openHub: @escaping (WidgetSession?) -> Void`: called when the user asks to open the hub, with the selected session when there is one.
- `openDestination: ((WidgetSession, String, String?) -> Void)? = nil`: called with the session, a mode (`"resume"` or `"new"`) and an optional handoff file path. When nil, the coordinator starts the running app's executable with the `--hub --mode sessions` arguments.
- `model injected: WidgetModel? = nil`: pass a ready model (tests do this). Written as `model:` at the call site. When nil, the coordinator creates one from `binaryPath` and `stateRoot`.

Properties:

- `model: WidgetModel`: the shared widget model.
- `modules: WidgetModuleRegistry`: the registry holding the built-in modules and any you add.
- `flowRuntime: FlowFocusRuntime`: the runtime in use.
- `transforms: FlowTransformTools`: the text-transform tools built on the model's bridge.
- `settingsPresenter: ((String) -> Void)?`: when set, `showSettings(pageID:)` calls it with the page id instead of opening its own window. Use it to show the pages inside the host's own settings.
- `passivePanels: Bool = false`: when true, expanded panels do not take the keyboard and stay open through clicks elsewhere. Scripted motion checks use this.
- `panelsEnabled: Bool`: whether "Show the widget" is on. It is false until the first snapshot arrives.

Methods:

- `start(showSettings: Bool = false, settingsWhenOff: Bool = true)`: builds the panels and starts the model and Flow runtime. With `showSettings: false`, a widget that is off opens the settings once the first snapshot arrives, so the user sees why no panel appeared. `settingsWhenOff: false` (a background relaunch) never does.
- `openSession(_ key: String)`: selects a session and expands the agents module. While the widget is off it opens the settings. A call before the first snapshot waits for it.
- `registerModule(_ module: WidgetModuleDescriptor) throws`: adds a module and rebuilds the panels. Throws `WidgetRegistryError`.
- `showSettings(pageID: String = "widgets.general")`: collapses the panels and shows the feature settings on that page.
- `stop()`: stops the stores and the model, hides the panels, removes the monitors and closes the settings and media windows.
- `shutdown() async`: `stop()`, then waits for voice notes and the Flow runtime to finish. Safe to call more than once.
- `static func id(_ screen: NSScreen) -> String`: the stable id of a screen, as stored in `WidgetPreferences.display`.

```swift
let widget = WidgetCoordinator(
    binaryPath: "/usr/local/bin/tools",
    micLauncher: Bundle.main.executableURL?.path,
    openHub: { session in print("open the hub for", session?.title ?? "all sessions") }
)
widget.start()
widget.openSession("example-session-key")
```

#### `WidgetModel`

The observable state and action surface of the widget. It runs a long-lived `tools hub widget watch` stream, decodes each snapshot off the main thread, and publishes it. Views read the derived values below, and the user's intent goes back through the action methods. It is `@MainActor`. `WidgetCoordinator` creates one, so a host rarely calls the init itself.

- `binaryPath: String`: path of the `tools` executable.
- `stateRoot: String? = nil`: alternate state folder. It is passed as `--state-root` and holds the local submission journal.
- `defaults: UserDefaults = .standard`: where view state is kept (module selections, unsent form answers, reduce motion).
- `appearance: NativeSettingsAppearance? = nil`: the shared reduce motion and reduce transparency settings. `NativeSettingsAppearance.shared` when nil.
- `transcriptCache: SessionTranscriptCache? = nil`: the conversation cache. A new one on the model's bridge when nil.

Data the views read:

- `snapshot: WidgetSnapshot?`: the last snapshot. Nil before the first one. `connectionLost: Bool` is true when the watch process stopped on its own.
- `sessions`, `previewSessions`, `railSessions`, `railActivitySessions: [WidgetSession]`: the visible sessions, the four most urgent for the hover preview (waiting first, then working), the side rail order, and the rail sessions that are working or hold unread items.
- `selected: WidgetSession?`, `cards: [WidgetCard]`, `card: WidgetCard?`, `answerCard: WidgetCard?`: the selected session, its cards, the open card, and the unanswered, unfolded decision the composer answers.
- `draft: WidgetDraft`, `outgoing: [WidgetOutgoing]`: the selected session's draft and its queued messages.
- `inbox: WidgetInboxSummary`, `inboxCount: Int`, `inboxPulse: Int`: unread and waiting counts. `inboxPulse` grows with each arrival.
- `inboxLoading: Bool`: true while a session is selected and its cards have not arrived yet.
- `waitingSessionCount`, `activeSessionCount: Int`, `hasActivity: Bool`: how many sessions wait for an answer, how many top-level sessions work or wait, and whether any visible session works or waits.
- `layout: WidgetLayoutConfiguration`, `placement: String`, `side: EdgePanelPlacement`, `sidePosition: Double`, `activeModuleID: String`: the layout from the stored preferences.
- `preferredHeight: CGFloat`, `agentFitHeight: CGFloat?`, `previewHeight: CGFloat`, `previewFitHeight: CGFloat?`: panel heights.
- `effectiveReduceMotion: Bool`, `settingsLoaded: Bool`, `cardPending: Bool`, `voiceActionLabel: String`: small derived flags and labels.
- `bridge: ToolsBridge`, `appearance: NativeSettingsAppearance`, `openedAt: TimeInterval`: the bridge in use, the appearance settings, and the uptime at which the last panel opened.

State a host or view may set:

- `selectedKey: String`, `selectedCardID: String?`: the selected session and card. Prefer `select(_:edge:)` for the session.
- `section: String = "Inbox"`: the open tab. The tabs are `"Inbox"`, `"Sessions"`, `"Conversation"` and, when `showChanges` is on, `"Changes"`.
- `expanded: EdgePanelPlacement?`, `activeSideGroup: Int = 0`, `hoveredSurface: WidgetSurfaceID?`, `moduleSelections: [String: String]`: which panel is open, which side group is active, what the pointer is over, and the module chosen for each surface key.
- `drafts: [String: WidgetDraft]`, `formAnswers: [String: [String: WidgetFormAnswer]]`, `foldedCardIDs: Set<String>`: drafts by session key, unsent form answers by card then item, and the inbox cards the user folded.
- `error: String?`, `notice: String?`: messages the views show.
- `dialogOpen: Bool`, `sessionChooserOpen: Bool = false`: set while a window or picker is open. Hover previews and the outside-click collapse stay off meanwhile.
- `reduceMotion: Bool`, `reduceTransparency: Bool`: the widget's own accessibility switches. They are stored in `defaults` and mirrored to `appearance`.
- `transcript: [TranscriptTurn]`, `transcriptError: String?`, `transcriptLoading: Bool`, `importing: Int`, `voiceText: String`, `voiceLevel: Double`, `voiceActive: Bool`, `reading: Bool`: the conversation view, the count of running imports, and the dictation and read-aloud state.
- `sideClusterHeight: CGFloat = 300`, `draggedSidePosition: Double?`, `draggingSide: Bool`: the side cluster height and the live state of a side-position drag.

Callbacks the host assigns:

- `presentationChanged: (() -> Void)?`: something that affects panel size or visibility changed.
- `pointerChanged: ((WidgetSurfaceID, Bool) -> Void)?`: the pointer entered or left a panel, before any hover delay.
- `showSettings: (() -> Void)?`, `showMedia: ((WidgetMediaSelection) -> Void)?`: open the settings or the media window.
- `openHub: ((WidgetSession?) -> Void)?`, `openDestination: ((WidgetSession, String, String?) -> Void)?`: open the hub, or a session destination (see `WidgetCoordinator`).
- `recordVoiceNote: ((String) -> Void)?`: when set, the composer's voice button calls it with the session key instead of dictating.
- `preferencesSaved: (([String: WidgetJSON]) -> Void)?`: called with each preferences patch once the hub stored it.

Methods:

- `start()` and `stop()`: start or stop the watch stream. `stop()` also flushes pending preference writes. `start()` is the Reconnect action.
- `startSettings()`, `refreshSettings()`: the settings-only mode. It loads one snapshot and reloads when the state file changes. A load already running is not restarted.
- `select(_ key: String, edge: EdgePanelPlacement? = nil)`: selects a session and optionally opens that edge.
- `next(_ direction: Int = 1)`: selects the next or previous session. `unpinSelected()` unpins the selected session and selects another.
- `open(_ edge: EdgePanelPlacement)`, `collapse()`: expand a panel or close it.
- `presentation(for surface: WidgetSurfaceID) -> WidgetModulePresentation`: `.expanded`, `.preview` (hovered) or `.compact`.
- `openModule(_ moduleID: String, on surface: WidgetSurfaceID)`: choose a module for a surface and expand it.
- `hover(_ surface: WidgetSurfaceID, inside: Bool)`, `hoverSession(_ key: String, on surface: WidgetSurfaceID, inside: Bool)`: drive the hover preview with its delays, and warm the transcript for the hovered session.
- `moveSide(position: Double, finished: Bool)`: move the side cluster. The final call stores `sidePosition`.
- `setText(_ text: String)`: sets the selected session's draft text. The hub copy is saved after a 350 ms pause. Text is cut at 64,000 characters.
- `send()`: the composer's Send. It answers the open decision when there is one, otherwise it sends a follow-up.
- `submit(choice: String? = nil, answering: Bool = false)`: queues the draft. With `choice`, it answers the open decision with that option id. With `answering: true`, it answers with the draft text. A form card sends its collected answers.
- `importFile(_ url: URL, ownsFile: Bool = false)`: imports an image or video into the selected draft. `ownsFile: true` deletes the file afterwards.
- `chooseFiles()`, `pasteMedia() -> Bool`: pick files with an open panel, or import file URLs or an image from the pasteboard. `pasteMedia` returns false when nothing could be pasted.
- `attachShelfItem(_ id: String, to key: String) async throws`, `attachVoiceNote(_ note: WidgetVoiceNote, to key: String) async throws`: add a shelf item or a voice note's text to a session's draft. Neither sends anything.
- `capture()`: takes a screenshot of a selected area and adds it to the draft. It asks for the Screen Recording permission first.
- `toggleVoice()`, `toggleRead()`: start or stop dictation into the draft, or read the open card aloud.
- `editOutgoing(_ message: WidgetOutgoing)`: takes a queued message back and restores its text and attachments as the draft. It refuses while the current draft holds text or attachments.
- `ledger(_ card: WidgetCard, state: String)`: sets the ledger state of a decision card. `"drafted"` also stores the draft text.
- `destination(_ mode: String)`: `"resume"` opens the session through `openDestination`. `"new"` writes a handoff file and passes its path to `openDestination`. Any other mode saves the handoff and opens the file.
- `openCard(_ card: WidgetCard)`, `markAllRead()`, `openInboxNotification(on surface: WidgetSurfaceID, key: String? = nil, needsAnswer: Bool? = nil)`: open an inbox card, clear the badges, or jump to the newest waiting or unread item.
- `inboxFor(_ key: String) -> WidgetInboxSession?`, `inboxPulseFor(_ key: String) -> Int`: the inbox entry and arrival count of one session.
- `updatePreferences(_ patch: [String: WidgetJSON], saved: (() -> Void)? = nil, failed: (() -> Void)? = nil)`: shows the patch at once and writes it after a short pause, merged with later patches. `saved` or `failed` runs when the write that carries it ends.
- `action(_ value: WidgetJSON, failed: (() -> Void)? = nil, completed: (() -> Void)? = nil)`: sends one raw `hub widget call` action. Actions run in order.
- `receiptContext(for card: WidgetCard) async throws -> WidgetReceiptContext`: the transcript window around a card's source. Results are cached for 15 seconds.

```swift
let model = WidgetModel(binaryPath: "/usr/local/bin/tools")
model.start()
if let key = model.sessions.first?.key {
    model.select(key)
    model.setText("Please rebase onto master.")
    model.send()
}
```

#### `LiveWidgetView`

The agents pane: a header with notices and errors, a View tab bar (Inbox, Sessions, Conversation, Changes), the inbox cards with choices and forms, the queued messages with Retry, Edit and Cancel, and the composer with attach, screenshot and voice buttons. It also accepts dropped files. Use it inside an edge panel or any host that owns a `WidgetModel`.

- `model: WidgetModel`: the model it reads and writes.
- `edge: EdgePanelPlacement`: the edge the pane belongs to (`top`, `right` or `left`).
- `cutout: CGFloat = 0`: width of a hardware cutout at the top center, used by the legacy frame.
- `compactHeight: CGFloat = 36`: height of the compact strip of the legacy frame.
- `embedded: Bool = false`: when true, draws only the pane content. When false, wraps it in `AgentWidgetView`.

```swift
LiveWidgetView(
    model: model,
    edge: .right,
    embedded: true
)
.frame(width: 432, height: 540)
```

#### `WidgetModuleDescriptor`

One widget module: an id, a title, an icon, a tint, two sizes and a view for each presentation. Register it with `WidgetCoordinator.registerModule(_:)` or `WidgetModuleRegistry.register(_:)`. The id must match `^[a-z][a-z0-9-]{0,47}$` and be unique.

`WidgetModulePresentation` has three cases, ordered from smallest to largest (it is `Comparable`): `compact` (the small bubble or top button), `preview` (the hover preview) and `expanded` (the open panel). The content closure receives it.

- `id: String`: the module id, also used in `WidgetLayoutConfiguration`.
- `title: String`: the display name.
- `symbol: String`: an SF Symbol name.
- `tint: Color`: the module's accent color.
- `expandedSize: CGSize = CGSize(width: 432, height: 540)`: size of the open panel.
- `previewSize: CGSize = CGSize(width: 324, height: 310)`: size of the hover preview.
- `summary: () -> String`: one line of text for the module's current state, such as a count. The built-in modules return text like "3 items".
- `visibilityChanged: (WidgetModulePresentation?) -> Void = { _ in }`: called with the largest presentation showing the module, or nil when no surface shows it.
- `content: (WidgetModulePresentation) -> Content`: a `@ViewBuilder` closure, passed last.

```swift
let clock = WidgetModuleDescriptor(
    id: "clock", title: "Clock", symbol: "clock", tint: .teal,
    summary: { "Local time" }
) { presentation in
    Text(presentation == .compact ? "Clock" : Date.now.formatted())
}
try widget.registerModule(clock)
```

#### `WidgetModuleRegistry`

The list of registered modules, and the record of which module each surface shows. It tells a module when it becomes visible or hidden. `WidgetCoordinator.modules` is one. It is `@MainActor` and an `ObservableObject`.

- `init()`: creates an empty registry.
- `modules: [WidgetModuleDescriptor]`: the registered modules, in registration order.
- `register(_ module: WidgetModuleDescriptor) throws`: adds a module. Throws `WidgetRegistryError.invalidIdentifier(String)` for a bad id and `.duplicateIdentifier(String)` for a repeated one.
- `module(_ id: String) -> WidgetModuleDescriptor?`: looks a module up by id.
- `update(surface: WidgetSurfaceID, moduleID: String?, presentation: WidgetModulePresentation = .compact)`: records what a surface shows. Nil or an unknown id clears it. Modules whose visibility changed get their `visibilityChanged` call.
- `removeAllSurfaces()`: clears every surface.

```swift
let registry = WidgetModuleRegistry()
try registry.register(clock)
registry.update(surface: WidgetSurfaceID(edge: .right, group: 1), moduleID: "clock", presentation: .preview)
```

#### `WidgetSurfaceID`

Names one panel: an edge plus a side group. The top edge uses group 0.

- `edge: EdgePanelPlacement`: `top`, `right` or `left`.
- `group: Int = 0`: the side group index. Negative values become 0 (init parameter).
- `key: String`: a string such as `"right.1"`, used as the key in `WidgetModel.moduleSelections`.

```swift
let surface = WidgetSurfaceID(edge: .right, group: 2)
model.openModule("tasks", on: surface)
let presentation = model.presentation(for: surface)  // .expanded
let chosen = model.moduleSelections[surface.key]  // "tasks"
```

#### `WidgetLayoutConfiguration`

Which module ids show in the top bar and in the side groups. The model builds one from the stored preferences (`WidgetPreferences.layout`). The init removes duplicate and empty ids, keeps at most three side groups, pads to three, and clamps `sidePosition` to 0 through 1 (a non-finite value becomes 0.5).

- `topModules: [String] = ["agents"]`: module ids in the top bar.
- `sideGroups: [[String]] = [["agents"], ["capture", "shelf"], ["focus", "voice", "tasks"]]`: module ids per side group.
- `separated: Bool = false`: true shows three separate bubbles. False joins the groups into one.
- `sidePosition: Double = 0.5`: vertical position of the side cluster, 0 (top) to 1 (bottom).
- `hoverPreviews: Bool = true`: whether hovering opens a preview.
- `groups(available: Set<String>) -> [[String]]`: the side groups, keeping only registered ids. When not `separated`, one merged group.
- `top(available: Set<String>) -> [String]`: the top ids that are registered.
- `static func unique(_ ids: [String]) -> [String]`: removes empty and repeated ids, keeping order.

```swift
let layout = WidgetLayoutConfiguration(
    topModules: ["agents"],
    sideGroups: [["agents"], ["capture", "shelf"], ["tasks"]],
    separated: true, sidePosition: 0.4, hoverPreviews: false)
let shown = layout.groups(available: ["agents", "shelf", "tasks"])
```

#### `WidgetClusterGeometry`

Pure layout math for the panels. A host that draws its own cluster can reuse it. All three functions are static.

- `topWidth(cutout: CGFloat, moduleCount: Int) -> CGFloat`: width of the top bar for a cutout width and a module count. Never below 360.
- `centers(heights: [CGFloat], position: Double, visible: CGRect, gap: CGFloat = 12) -> [CGFloat]`: the vertical center of each stacked rail, top first, in screen coordinates. `position` runs from 0 to 1 through the free space.
- `position(starting: Double, translationDown: CGFloat, clusterHeight: CGFloat, visibleHeight: CGFloat) -> Double`: the new 0 to 1 position after a drag of `translationDown` points.

```swift
let visible = NSScreen.main?.visibleFrame ?? .zero
let width = WidgetClusterGeometry.topWidth(cutout: 200, moduleCount: 3)
let centers = WidgetClusterGeometry.centers(heights: [120, 90], position: 0.5, visible: visible)
```

#### `WidgetFeatureSettings`

Builds the widget's settings sections for the native settings window. It returns pages for Widgets (General, Projects / Sessions, Providers, Widgets), Dictation (Voice Notes, plus Dictation and Text transforms when the Flow arguments are given) and, with a Flow runtime, Focus. The page ids are `widgets.general`, `widgets.sessions`, `widgets.providers`, `widgets.modules`, `dictation.voice`, `dictation.flow`, `dictation.transforms` and `focus.general`. It is `@MainActor`.

- `static let hiddenNotice: String`: the text shown when "Show the widget" is off.
- `static func sections(model: WidgetModel, modules: [WidgetModuleChoice], flowRuntime: FlowFocusRuntime? = nil, transforms: FlowTransformTools? = nil, openSession: @escaping (WidgetSession) -> Void) -> [NativeSettingsSection]`: the sections. `openSession` runs when the user clicks a session in the browser.

`WidgetModuleChoice` describes one module the settings can offer: `id: String`, `title: String`, `symbol: String`, `detail: String`, with a public `init(id:title:symbol:detail:)`. `WidgetModuleChoice.agents` is the Agent Inbox. `WidgetModuleChoice.builtins` lists exactly the modules the coordinator registers (agents, capture, shelf, tasks, focus, voice). Offer only those, because the layout drops ids that no registered module has.

```swift
let sections = WidgetFeatureSettings.sections(
    model: widget.model, modules: WidgetModuleChoice.builtins,
    flowRuntime: widget.flowRuntime, transforms: widget.transforms,
    openSession: { session in widget.openSession(session.key) })
```

#### `WidgetSessionFilter`

Helpers for the "show only these sessions" filter, which is the `sessions` list in the preferences. An empty list means every session may appear.

- `adding(_ key: String, to keys: [String]) -> [String]`: the list with the key appended, unless it is already there.
- `removing(_ key: String, from keys: [String]) -> [String]`: the list without the key.
- `patch(_ keys: [String]) -> [String: WidgetJSON]`: the preferences patch that stores the list.
- `candidates(_ sessions: [WidgetSession], excluding keys: [String], query: String, limit: Int = 8) -> [WidgetSession]`: sessions that can still be added, newest first. With no query only top-level sessions appear. A query also matches sub-agents by title, project or provider.

```swift
let keys = WidgetSessionFilter.adding("example-session-key", to: [])
model.updatePreferences(WidgetSessionFilter.patch(keys))
let more = WidgetSessionFilter.candidates(model.sessions, excluding: keys, query: "api")
```

#### `WidgetSessionBrowser`

A searchable tree of sessions with their sub-agents: a search field, a project filter menu, a "Pinned only" toggle, and expandable groups. Use it in a settings page or a widget tab.

- `model: WidgetModel`: the model that supplies the sessions.
- `onOpen: ((WidgetSession) -> Void)? = nil`: called when a row is clicked. When nil, the row selects the session and switches the model to the Inbox tab.

```swift
WidgetSessionBrowser(
    model: model,
    onOpen: { session in widget.openSession(session.key) }
)
```

#### `WidgetRecipientPicker`

A button that opens a popover list of sessions to choose a recipient. Rows are created only when the popover opens, which is cheaper than a native `Picker` for a long roster.

- `sessions: [WidgetSession]`: the sessions to offer.
- `selection: Binding<String>`: the key of the chosen session. An empty string means none.
- `presentationChanged: (Bool) -> Void = { _ in }`: called when the popover opens or closes. Use it to set `WidgetModel.dialogOpen`.

```swift
// Inside a view that has @State private var recipient = ""
WidgetRecipientPicker(
    sessions: model.sessions, selection: $recipient,
    presentationChanged: { open in model.dialogOpen = open })
```

#### `AgentWidgetView`

The frame of the widget as a strip at the top or a rail at the side: a Genesis mark and agent dots, an expanding card, and a reply composer. `LiveWidgetView` uses it as its legacy frame and passes the live pane as `liveContent`. Without `liveContent` it draws a static card from an `AgentWidgetItem`, which is how a preview shows sample data.

- `placement: EdgePanelPlacement`: `top`, `left` or `right`.
- `items: [AgentWidgetItem]`: the agents shown as dots. The strip shows three and the rail six, then a "+N" button.
- `selectedID: String`: the id of the selected item.
- `expanded: Bool`: whether the card is open.
- `isPreview: Bool = false`: marks the card as a preview.
- `animationsActive: Bool = true`: whether working dots animate.
- `cutoutWidth: CGFloat = 0`: width of a hardware cutout in the strip. When above 0, the strip leaves a gap and drops the "Agents" label.
- `compactHeight: CGFloat = 36`: height of the top strip.
- `receipt: String? = nil`: the footer text after a send.
- `sending: Bool = false`: shows the sending state and disables the choices.
- `selectedChoice: String? = nil`: the id of the highlighted choice.
- `draft: Binding<String>`: the reply text.
- `actions: AgentWidgetActions`: the callbacks (listed below).
- `liveContent: AnyView? = nil`: replaces the static card.

`AgentWidgetActions` holds seven closures and its init takes all of them, in this order: `expand: () -> Void`, `collapse: () -> Void`, `select: (String) -> Void`, `choose: (String) -> Void`, `submit: () -> Void`, `settings: () -> Void`, `next: () -> Void`.

```swift
AgentWidgetView(
    placement: .right,
    items: [AgentWidgetItem(
        id: "a", provider: "claude", project: "api", title: "Fix the tests",
        request: "Make the suite pass.", context: "Two tests fail.", question: "Skip the flaky one?",
        status: .waiting, choices: [AgentWidgetChoice(id: "yes", title: "Skip it")])],
    selectedID: "a", expanded: true, draft: $draft,
    actions: AgentWidgetActions(
        expand: {}, collapse: {}, select: { _ in }, choose: { _ in }, submit: {}, settings: {}, next: {}))
```

#### `AgentWidgetItem`

One agent in `AgentWidgetView`: who it is, what it was asked, and what it asks now.

- `id: String`: the item id.
- `provider: String`: the provider name, for example `"claude"`.
- `project: String`: the project name.
- `title: String`: the session title.
- `request: String`: the user's request, shown as a bubble.
- `context: String`: the agent's context text.
- `question: String`: the question the agent asks.
- `status: AgentWidgetStatus`: the item's status.
- `choices: [AgentWidgetChoice] = []`: the answer options.

`AgentWidgetStatus` has the cases `working` ("Working", blue), `waiting` ("Needs your answer", amber), `finished` ("Finished", green) and `recent` ("Recent activity", gray). It has `label: String` and `color: Color`. `AgentWidgetChoice` has `id: String`, `title: String`, `detail: String = ""` and `recommended: Bool = false`.

```swift
let item = AgentWidgetItem(
    id: "a", provider: "codex", project: "web", title: "Add a login page",
    request: "", context: "", question: "Use OAuth?", status: .waiting,
    choices: [AgentWidgetChoice(id: "oauth", title: "OAuth", recommended: true)])
```

#### `WidgetKeymap`

The agent widget's keys (`widget.json`). `choiceNumber(in:)` returns 1 through 9 when the press matched an answer command. The number row is a position, so it works where the unshifted key is not a digit. A saved chord keeps its Command, Control and Option. `plainStroke` drops Shift, so Shift J still reaches J, and the same for k, Escape and the number row. Paste Media is ⌘V with Shift and Option too.

```swift
let number = WidgetKeymap.choiceNumber(in: ["widget.choice.1"])  // 1
let other = WidgetKeymap.choiceNumber(in: ["widget.message.next"])  // nil
```

#### `SessionsKeymap`

The session screen's keys. `EnvironmentValues.sessionHostOwnsCommandKeys` (default false) is set by a host that uses Command on the two keys right of P for itself, such as the hub's Back and Forward. The prompts then register Option-Command. Reload stays the transcript's in either case.

#### `ClickyKeymap`

Clicky's keys, in the same library shape.

#### `ImageViewerKeymap` and `ImageViewerAction`

The image viewer's keys. `ImageViewerAction.close` closes the window. `ImageViewerAction.dismiss` steps back one layer: the picker, then the compare, then the window (`ImageViewerKeymap.back`, Escape). Copy is ⌘C by character and by the C key's position.

#### `GenesisWidgetMark`

The widget's three-dot mark, drawn as a merged blob. It is 23 by 23 points and hidden from accessibility.

```swift
HStack(spacing: 8) {
    GenesisWidgetMark()
    Text("Nothing needs you.")
}
```

#### `WidgetThumbnail`

A small image thumbnail for a frame in a video frame grid. It decodes off the main thread, caches by identity, and shows a named placeholder with Retry on failure.

- `path: String`: path of the image file.

```swift
let framePaths = ["/tmp/frames/frame-001.png", "/tmp/frames/frame-002.png"]
LazyVGrid(columns: [GridItem(.adaptive(minimum: 80))], spacing: 6) {
    ForEach(framePaths, id: \.self) { path in
        WidgetThumbnail(path: path).frame(height: 50)
    }
}
```

#### `WidgetMediaSelection`

Says what the media window should show. `WidgetModel.showMedia` receives it. The enum is `Identifiable`; its `id` is the asset or image id.

- `video(String)`: a video asset, by asset id.
- `asset(String)`: an image asset, by asset id.
- `images([WidgetImageReference], String)`: a group of card images and the id of the one to open first.

```swift
model.showMedia = { selection in
    switch selection {
    case .video(let id), .asset(let id): print("open asset", id)
    case .images(let images, let first): print("open", images.count, "images, first", first)
    }
}
```

#### `WidgetCaptureError`

Recognizes the "Screen Recording is off" outcome of a screenshot. An Escape is a result (`cancelled: true`), not an error. A missing grant is an error whose text contains `[screen-recording-denied]`.

- `static let screenRecordingDenied = "screen-recording-denied"`: the marker text.
- `static func isScreenRecordingDenied(_ error: Error) -> Bool`: true when the error text carries the marker.
- `static func isScreenRecordingDenied(message: String) -> Bool`: the same check on a plain message.

```swift
let message = "[screen-recording-denied] Screen Recording is off for this app."
let denied = WidgetCaptureError.isScreenRecordingDenied(message: message)  // true
let other = WidgetCaptureError.isScreenRecordingDenied(message: "Capture cancelled")  // false
```

#### `View.widgetAccessibility(reduceMotion:reduceTransparency:)`

Puts the widget's own reduce motion and reduce transparency choices into the environment of a view. The system accessibility settings still win: a widget view reduces motion when either the system or this switch asks for it.

- `reduceMotion: Bool`: the widget's reduce motion switch.
- `reduceTransparency: Bool`: the widget's reduce transparency switch.

```swift
AgentWidgetView(
    placement: .right, items: items, selectedID: selectedID, expanded: true,
    draft: $draft, actions: actions
)
.widgetAccessibility(
    reduceMotion: model.reduceMotion,
    reduceTransparency: model.reduceTransparency
)
```

#### `EnvironmentValues.widgetReduceMotion`

Environment values that carry the widget's own switches. Both are `Bool` and default to false. `widgetReduceTransparency` works the same way. A custom module reads them to follow the widget's setting.

```swift
@Environment(\.widgetReduceMotion) private var widgetReduceMotion
@Environment(\.accessibilityReduceMotion) private var systemReduceMotion
private var animated: Bool { !(widgetReduceMotion || systemReduceMotion) }
```

#### `WidgetSnapshot`

One full state of the widget as the hub reports it. `WidgetModel.snapshot` holds the latest. The wire types in this section are `Codable` and decoded from hub JSON. Apart from `WidgetDraft` and `WidgetJSON`, none has a public init.

- `version: Int`: the snapshot format version.
- `state: WidgetState`: the stored state (below).
- `sessions: [WidgetSession]`: every known session.
- `cards: [WidgetCard]`: inbox cards for all sessions.
- `activity: [WidgetActivityEvent]?`: recent activity events (`id`, `sourceId`, `at`, `title`, `body`).
- `manifests: [String: WidgetVideoManifest]`: sampled-video manifests by asset id.
- `changes: Changes?`: when present, `available: Bool` and `files` (each with `path`, `at`, `source`).
- `errors: [String]`: sources that failed to load.
- `selectedKey: String?`: the selected session key.
- `notifications: WidgetInboxSummary? = nil`: the inbox summary.
- `rosterLoading: Bool? = nil`: true while the session roster is still loading.

```swift
if let snapshot = model.snapshot {
    let waiting = snapshot.cards.filter(\.needsAnswer)
    print(snapshot.sessions.count, waiting.count, snapshot.errors)
}
```

#### `WidgetState`

The persisted part of a snapshot.

- `version: Int`, `revision: Int`: the state version and its revision counter.
- `selectedKey: String?`: the selected session key.
- `preferences: WidgetPreferences`: the user's settings.
- `assets: [String: WidgetAsset]`: imported images and videos by id.
- `drafts: [String: WidgetDraft]`: drafts by session key.
- `outgoing: [WidgetOutgoing]`: queued and sent messages.

```swift
if let state = model.snapshot?.state {
    let preferences = state.preferences
    print(state.revision, preferences.placement, state.outgoing.count, state.drafts.count)
}
```

#### `WidgetSession`

One agent session. It is `Identifiable` by `key`.

- `key: String`: the unique session key.
- `target: WidgetTarget`: where the session lives: `hostId`, `provider`, `sessionId`, `sourceHome`, `cwd`. `hasSameIdentity(as:)` compares two targets.
- `title: String`, `project: String`: display names.
- `activityAt: Double`: last activity, in milliseconds since 1970.
- `status: String`: `"working"`, `"waiting"`, `"finished"` or any other value for recent. `visualStatus: AgentWidgetStatus` maps it.
- `pinned: Bool`, `visible: Bool`, `hiddenByFilter: Bool`: roster flags.
- `parentSessionId`, `agentId`, `transcriptPath`, `parentKey`, `role`, `model`, `account`: optional sub-agent and detail fields (`String?`).
- `startedAt: Double?`, `toolCalls: Int?`, `agentStatus: String?`: optional run details.

```swift
let working = model.sessions.filter { $0.visualStatus == .working }
for session in working {
    print(session.title, session.target.provider, session.project)
}
```

#### `WidgetCard`

One inbox item of a session: a decision, a form, an answer or a result. It is `Identifiable`.

- `id: String`, `kind: String`, `sessionKey: String`, `sourceId: String`: the card id, its kind (`"decision"`, `"form"`, `"answer"`, `"result"`), the owning session and the source record id.
- `at: Double`: arrival time in milliseconds since 1970.
- `title: String`, `body: String`, `status: String`: the text and the status. A decision is open or drafted while it needs an answer.
- `revision: Int?`, `number: Int?`: the ledger revision and the decision number.
- `choices: [WidgetChoice]`: decision options (`id`, `title`, `recommended`).
- `formItems: [WidgetFormItem]?`: form questions (`id`, `promptMarkdown`, optional `choices` of `WidgetFormChoice(id, label)`, and the flags `allowMultiple`, `allowFreeText`, `allowFileTags`, `allowImagePaste`, `required`).
- `formAnswers: [String: WidgetFormAnswer]?`: answers by item id (`itemId`, `freeText`, `selectedChoices`, `fileTags`, `mediaContext`).
- `attachments: [WidgetImageReference]`: images (`id`, `path`, `name`, `width`, `height`, `label`, and `comparison` with `group` and `role`).
- `refs: [WidgetReference]`: typed references (`type`, `value`).
- `read: Bool`, `entryId: String?`: read state and the transcript entry id.
- `sourceContext: WidgetSourceContext?`, `transcriptAnchor: WidgetTranscriptAnchor?`: where the card came from (session, agent, project, repo, branch, commit, worktree) and where it sits in the transcript.
- `needsAnswer: Bool`: true for an open or drafted decision and for a pending form.

```swift
let unanswered = model.cards.filter(\.needsAnswer)
for card in unanswered {
    print(card.kind, card.title, card.choices.map(\.title))
}
```

#### `WidgetPreferences`

The user's stored widget settings. Change them with `WidgetModel.updatePreferences(_:)`.

- `excludedKeys: [String]`, `projects: [String]`, `sessions: [String]`: session and project filters. A non-empty `sessions` list is an allowlist. The Swift views do not read `excludedKeys`.
- `showChanges: Bool`: shows the Changes tab.
- `showWidget: Bool?`: "Show the widget". Nil means off.
- `placement: String`: `"both"`, `"top"` or `"side"`. `side: String`: `"left"` or `"right"`.
- `topModules: [String]?`, `sideGroups: [[String]]?`, `sideLayout: String?`, `sidePosition: Double?`, `hoverPreviews: Bool?`: the layout inputs. `layout` returns them as a `WidgetLayoutConfiguration` with defaults filled in. `sideLayout` is `"joined"` or `"separated"`.
- `sideStyle: String?`, `joinedEdges: Bool?`, `glassEffect: Bool?`: look of the side strip (`"classic"` is a known style).
- `display: String?`: the screen id (see `WidgetCoordinator.id(_:)`). Empty or nil means the main display.
- `providers: [String]?`: which sources appear (`"claude"`, `"codex"`, `"grok"`, `"unknown"`). Nil or empty shows every source.
- `quietSeconds: Int`: seconds an open Agents panel waits, with no activity and an empty draft, before it collapses. The model uses at least 5.
- `voiceProvider: String`, `voiceAccount: String?`, `voiceModel: String?`, `voiceLanguage: String`: the speech settings for voice notes.

```swift
let preferences = model.snapshot?.state.preferences
let side = preferences?.side ?? "right"
let layout = preferences?.layout ?? WidgetLayoutConfiguration()
model.updatePreferences(["placement": "top"])
```

#### `WidgetOutgoing`

A message the user queued to a session, with its delivery state. It is `Identifiable`.

- `id: String`, `target: WidgetTarget`, `payload: WidgetJSON`, `assetIds: [String]`: the message and its attachments.
- `createdAt: Double`, `dispatchedAt: Double?`, `sequence: Int`: timing and order.
- `state: String`: for example `"preparing"`, `"review"`, `"queued"`, `"dispatching"`, `"sent"`, `"unknown"`, `"failed"`, `"waiting-route"` or `"cancelled"`.
- `error: String?`, `receipt: Receipt?`: the failure, or the delivery receipt (`channel`, `delivered`, `at`, `detail`, `entryId`).
- `text: String`: the composer text. A form sent with no text reads "Form answer".
- `isSettled`, `isWithdrawable`, `needsRecovery`, `freezesAssets`: flags for sent or canceled, still editable or cancelable, needing Retry, and locked attachments.
- `static let shownHistory = 20` and `static func shown(_ messages: [WidgetOutgoing]) -> [WidgetOutgoing]`: the last 20 messages plus every older unsettled one.

```swift
let cancellable = model.outgoing.filter(\.isWithdrawable)
let stuck = model.outgoing.filter(\.needsRecovery)
for message in stuck {
    print(message.state, message.text)
}
```

#### `WidgetDraft`

The unsent text and attached assets of one session.

- `text: String = ""`: the draft text.
- `assetIds: [String] = []`: ids of attached assets in `WidgetState.assets`.

```swift
let draft = WidgetDraft(text: "Looks good.", assetIds: ["example-asset-id"])
model.setText(draft.text)
let attached = model.draft.assetIds.count
```

#### `WidgetJSON`

A small JSON value type for the hub protocol. It is `Codable`, `Equatable`, and can be written with string, boolean, integer, dictionary and array literals. It has no float literal, so write fractions as `.number(_:)`.

- `string(String)`, `number(Double)`, `bool(Bool)`, `object([String: WidgetJSON])`, `array([WidgetJSON])`, `null`: the cases.
- `static func value<T: Encodable>(_ value: T) throws -> WidgetJSON`: encodes any `Encodable` into a `WidgetJSON`.

```swift
let patch: [String: WidgetJSON] = [
    "hoverPreviews": false, "sidePosition": .number(0.4), "topModules": ["agents"],
]
model.updatePreferences(patch)
```

#### `WidgetAsset`

An image or video imported into a draft. Stored in `WidgetState.assets`, `Identifiable` by `id`.

- `id: String`, `type: String`, `name: String`, `path: String`, `sha256: String`: identity and file.
- `width: Int`, `height: Int`: pixel size.
- `bytes: Int?`, `mimeType: String?`, `durationUs: Double?`: file details. `durationUs` is for video.
- `settings: WidgetVideoSettings?`: video sampling: `fps: Int`, `framesPerImage: Int`, `minimumDifferencePct: Double`, and optional `startUs: Double?` and `endUs: Double?`.
- `revision: Int?`, `confirmedRevision: Int?`, `status: String?`, `manifestPath: String?`, `error: String?`: processing state.
- `progress: Progress?`: `phase: String`, `completed: Int`, `total: Int`.

```swift
if let asset = model.snapshot?.state.assets["example-asset-id"] {
    print(asset.name, asset.width, asset.height, asset.mimeType ?? "unknown")
}
```

#### `WidgetVideoManifest`

The result of sampling a video into frames and contact sheets. Find one in `WidgetSnapshot.manifests` by asset id.

- `id: String`: the manifest id.
- `frames: [Frame]`: each has `id`, `requestedUs`, `actualUs`, `path`, `kept`, `differencePct`, `comparedToId`.
- `sheets: [Sheet]`: each has `path`, `frameIds`, `firstUs`, `lastUs`.
- `counts: WidgetCounts`: `candidates`, `kept`, `skipped`, `images`, `lastImageFrames`.
- `settings: WidgetVideoSettings`: the sampling settings used.

```swift
if let manifest = model.snapshot?.manifests["example-asset-id"] {
    let kept = manifest.frames.filter(\.kept)
    print(kept.count, manifest.counts.skipped, manifest.sheets.count)
}
```

#### `WidgetInboxSummary`

The inbox counts the badges show. `WidgetModel.inbox` holds it.

- `unread: Int`, `needsAnswer: Int`: totals.
- `complete: Bool`, `truncated: Bool`: whether the counts cover everything. An incomplete summary shows `+`.
- `sessions: [WidgetInboxSession]`: per session `key`, `unread`, `needsAnswer`, and the items `latest`, `unreadItem`, `pendingItem` (`WidgetInboxItem`: `id`, `sourceId`, `kind`, `key`, `at`, `needsAnswer`).
- `profile: Profile?`: `hostId`.
- `static let empty`: an empty, incomplete summary.

```swift
let inbox = model.inbox
let badge = inbox.unread + inbox.needsAnswer
let label = inbox.complete ? "\(badge)" : "\(badge)+"
```

#### `WidgetSelection`

Chooses the session to select on launch.

- `static func initial(persisted: String?, visibleKeys: [String]) -> String`: the persisted key when it is not empty, otherwise the first visible key, otherwise an empty string.

```swift
let saved = UserDefaults.standard.string(forKey: "lastSession")
let keys = model.sessions.map(\.key)
model.selectedKey = WidgetSelection.initial(persisted: saved, visibleKeys: keys)
```

#### `WidgetReceiptContext`

The transcript around the place a card came from. `WidgetModel.receiptContext(for:)` returns it.

- `id: String`: the card id.
- `sourceContext: WidgetSourceContext?`: the session, agent, project, repository, branch, commit and worktree.
- `transcriptAnchor: WidgetTranscriptAnchor`: the position in the transcript (`kind`, `provider`, `sessionId`, `receivedAt`, `messageId`, `turnId`, `toolCallId`).
- `transcript: Window?`: `status`, `detail`, the turns `before`, `around` and `after` (`TranscriptTurn`), plus `bytesRead`, `fileSize`, `truncated`, `skippedLines`, `anchorOffset`.
- `error: String?`: set when the context could not be read.

```swift
if let card = model.card {
    let context = try await model.receiptContext(for: card)
    let around = context.transcript?.around ?? []
}
```

#### `WidgetShelfStore`

Lives in `Widgets/Shelf/`. The one inventory behind the Capture and File Shelf modules: staged files and screenshots, with import, paste, capture, remove and attach. Both modules and every edge surface share one store. It is `@MainActor`. It watches the shelf state while a module is visible.

- `binaryPath: String`: path of the `tools` executable.
- `stateRoot: String? = nil`: alternate state folder.
- `recipients: @escaping () -> [WidgetSession]`: the sessions an item can be attached to.
- `didAttach: @escaping (WidgetSession) -> Void`: called after an item is attached to a session.
- `onCaptureWillBegin: @escaping () -> Void = {}`: called before the screenshot selection starts.
- `onCaptureStaged: @escaping () -> Void = {}`: called after a capture was staged, so the host can reopen the shelf.
- `onDialogVisibilityChanged: @escaping (Bool) -> Void = { _ in }`: called when a file dialog opens or closes.
- `attachToDraft: ((WidgetShelfItem, WidgetSession) async throws -> Void)? = nil`: replaces the default attach. `WidgetCoordinator` uses it to go through the model.

Properties:

- `items: [WidgetShelfItem]`, `captures: [WidgetShelfItem]`: all staged items, and the screenshots among them. An item has `id`, `kind` (`.file` or `.capture`), `name`, `path`, `sourcePath`, `sha256`, `bytes`, `createdAt` and `assetId`.
- `isBusy: Bool`, `isCapturing: Bool`, `loaded: Bool`: activity and first-load flags.
- `captureAccessGranted: Bool?`, `error: String?`, `notice: String?`: the Screen Recording result, the last error and the last confirmation.
- `recipients: [WidgetSession]`: the current recipients.

Methods:

- `refresh()`: reloads the inventory.
- `capture()`, `cancelCapture()`: start or cancel a screenshot selection.
- `importFiles(_ urls: [URL], asImages: Bool = false)`, `chooseFiles(asImages: Bool = false)`, `paste(asImages: Bool = false)`: stage files from URLs, an open panel, or the pasteboard. Only local files are accepted.
- `remove(_ item: WidgetShelfItem)`: removes the item from the shelf. The file and existing drafts stay.
- `attach(_ item: WidgetShelfItem, to recipient: WidgetSession)`: adds the item to the recipient's draft. Nothing is sent.
- `captureModule()`, `shelfModule()`: return the `WidgetModuleDescriptor` for Capture (`"capture"`) or File Shelf (`"shelf"`).
- `stop()`: ends the store for good.

```swift
let shelf = WidgetShelfStore(
    binaryPath: "/usr/local/bin/tools",
    recipients: { model.sessions },
    didAttach: { session in widget.openSession(session.key) })
try registry.register(shelf.shelfModule())
shelf.importFiles([URL(fileURLWithPath: "/tmp/example.png")], asImages: true)
```

#### `WidgetTasksStore`

Lives in `Widgets/Tasks/`. The cache, watcher and edit owner behind the Tasks module: a list of tasks from the hub's task ledger that you can tick, create, edit, dismiss and undo, with filters. It is `@MainActor`. It loads only while its module is visible, and a tick shows at once and is confirmed by the ledger.

- `binaryPath: String`: path of the `tools` executable.
- `sessions: @escaping () -> [WidgetSession]`: the live session roster, used for session choices.
- `openSession: @escaping (WidgetSession, String) -> Void`: called by `openSource(_:)` with the source session and the card id to select (`"decision:<task id>"`).

Properties:

- `tasks: [WidgetTask]`, `activeCount: Int`, `projects: [String]`, `sessionFilters: [(id: String, title: String)]`: the shown tasks, the active count, and the filter choices.
- `scope: String = "active"`: `"active"`, `"completed"`, `"dismissed"` or `"all"`.
- `project: String = ""`, `session: String = ""`: filters (`session` is `provider:sessionId`). A change reloads.
- `draft: WidgetTaskDraft`: the create form: `title`, `details`, `session`, `sessionTitle`, `project`, `cwd`, all `String` and empty by default.
- `isLoading`, `isCreating`, `isMutating: Bool`, `mutatingIDs: Set<String>`, `pendingStates: [String: String]`: activity and the optimistic states of tasks being changed.
- `recent: [WidgetTask]`, `undo: WidgetTaskUndo?`: tasks just moved out of the view, and the last change with the move that undoes it (`task`, `action`, optional `then`).
- `error: String?`, `receipt: String?`: the last failure and confirmation.

Methods:

- `refresh(force: Bool = false)`: loads the current view. A cached view is shown without a reload unless `force` is true.
- `toggle(_ task: WidgetTask)`: the checkbox: complete an unfinished task, reopen a finished one.
- `perform(_ action: WidgetTaskAction, on task: WidgetTask, then next: WidgetTaskAction? = nil)`: applies one action. `next` is a second step run on the result.
- `edit(_ task: WidgetTask, title: String, details: String, onSaved: @escaping (WidgetTask) -> Void = { _ in })`: changes an open task. `onSaved` runs only after the ledger confirms.
- `create()`: adds the drafted task. The title and details clear on success.
- `chooseSession(_ choice: WidgetTaskSessionChoice)`, `sessionChoices(limit: Int = 30) -> [WidgetTaskSessionChoice]`: pick and list the sessions a new task can belong to (`id`, `title`, `project`, `cwd`).
- `shownState(_ task: WidgetTask) -> String`: the state to draw, including a pending one.
- `sourceSession(for task: WidgetTask) -> WidgetSession?`, `openSource(_ task: WidgetTask)`: find and open the task's session.
- `cancelUpdate()`, `clearFeedback()`, `stop()`: cancel running changes, clear the messages, end the store.
- `taskModule() -> WidgetModuleDescriptor`: the Tasks module (`"tasks"`).

```swift
let tasks = WidgetTasksStore(
    binaryPath: "/usr/local/bin/tools",
    sessions: { model.sessions },
    openSession: { session, cardID in widget.openSession(session.key) })
tasks.draft.title = "Check the flaky test"
tasks.create()
```

#### `WidgetTask`

One task from the ledger. It is `Identifiable`, `Codable` and `Equatable`.

- `id: String`, `number: Int`, `title: String`, `summary: String`: identity and text.
- `truncated: Bool`: the summary is an excerpt.
- `revision: Int`, `state: String`, `updatedTs: String`, `createdTs: String?`: version and time.
- `blocking: Bool`, `owner: String?`: whether it blocks, and who owns it.
- `sessionId: String`, `provider: String`, `sessionTitle: String?`, `sourceContext: WidgetSourceContext`: the session it came from.
- `statusLabel: String`: `"To do"` for `open`, `"In progress"` for `acknowledged`, `"Completed"` for `implemented`, `"Dismissed"` for `dismissed`. `static func label(for:)` does the same for any state.
- `actions: [WidgetTaskAction]`, `toggleAction: WidgetTaskAction?`: the actions that fit the state, and the checkbox action.
- `editable: Bool`: true for an open task that is not an excerpt.
- `isLocal: Bool`, `static let localSession = "local"`: a task written without a session.

```swift
let done = tasks.tasks.filter { $0.state == "implemented" }
for task in done {
    print(task.number, task.statusLabel, task.editable)
}
```

#### `WidgetTaskAction`

A change to a task's state. It is `CaseIterable`, with raw string values.

- `acknowledge`: move to `acknowledged` (In progress).
- `complete`: move to `implemented`.
- `reopen`: move back to `open`.
- `dismiss`: move to `dismissed`.
- `title: String`: the button label, such as "Acknowledge".
- `targetState: String`: the state the action leads to.

```swift
if let task = tasks.tasks.first, task.actions.contains(.complete) {
    tasks.perform(.complete, on: task)
}
```

#### `WidgetVoiceNotesStore`

Lives in `Widgets/VoiceNotes/`. The state behind the Voice Notes module: record a clip from the microphone, transcribe it, edit the text, and attach it to a session's draft. Clips stay local until the user chooses Transcribe. It handles the microphone permission and runs one operation at a time. It is `@MainActor`.

- `binaryPath: String`: path of the `tools` executable.
- `stateRoot: String? = nil`: alternate state folder.
- `micLauncher: String`: path of the executable that records the microphone.
- `acquireAudio: @escaping () async throws -> any VoiceRecordingLease`: gets exclusive audio access (the Flow runtime's `acquireExternalAudio()`).
- `settings: @escaping () -> WidgetVoiceNoteSettings`: the speech settings to use. `WidgetVoiceNoteSettings` has `provider: String`, `account: String? = nil`, `model: String? = nil`, `language: String? = nil`.
- `sessions: @escaping () -> [WidgetSession]`: the live roster.
- `attachDraft: @escaping (WidgetSession, WidgetVoiceNote) async throws -> String`: adds the note to a draft and returns the confirmation text.

Properties:

- `notes: [WidgetVoiceNote]`, `selectedID: String?`, `selected: WidgetVoiceNote?`: the notes and the selected one.
- `text: String`: the selected note's text, with unsaved edits. Set it to edit.
- `phase: String?`, `isBusy: Bool`: the running step, such as "Recording" or "Transcribing". Nil when idle.
- `error: String?`, `receipt: String?`: the last failure and confirmation.
- `microphonePermission: VoiceMicrophonePermission`, `microphoneGuidance: String?`: the permission (`notDetermined`, `authorized`, `denied`, `restricted`, `unknown`) and help text.
- `recipientKey: String = ""`, `sessions: [WidgetSession]`: the chosen recipient and the sessions it can be (Claude, Codex and Grok only).
- `providerLabel: String`: the speech provider in use.
- `meter: WidgetVoiceRecordingMeter`: `rms` and `durationMs` while recording.
- `recipientPickerVisibilityChanged: (Bool) -> Void`: assign it to follow the recipient picker, for example to set `WidgetModel.dialogOpen`.

Methods:

- `refresh(force: Bool = false)`: reloads the notes.
- `record(input: String = "mic")`: starts a recording. `"mic"` uses the microphone; another value is passed on as the input name.
- `finishRecording()`, `cancel()`: stop and save the recording, or stop the running operation.
- `transcribe()`, `saveText()`, `attach()`, `discard()`: transcribe the selected note, save the edited text, attach it to the `recipientKey` session, or delete the local note.
- `refreshMicrophonePermission()`, `reviewMicrophoneAccess()`: reread the permission, or show the permission dialog.
- `voiceNotesModule() -> WidgetModuleDescriptor`: the Voice Notes module (`"voice"`).
- `stop()`, `shutdown() async`: end the store, and wait for running work.

```swift
let voice = WidgetVoiceNotesStore(
    binaryPath: "/usr/local/bin/tools",
    micLauncher: "/Applications/Example.app/Contents/MacOS/Example",
    acquireAudio: { try await FlowFocusRuntime.shared.acquireExternalAudio() },
    settings: { WidgetVoiceNoteSettings(provider: "xai") }, sessions: { model.sessions },
    attachDraft: { session, note in
        try await model.attachVoiceNote(note, to: session.key)
        return "Added to the draft."
    })
voice.record()
```

#### `WidgetVoiceNote`

One recorded note. It is `Decodable`, `Identifiable` and `Equatable`, with read-only fields.

- `id: String`, `revision: Int`, `createdAt: Double`: identity, version and creation time in milliseconds since 1970.
- `clip: Clip`: the audio file: `path: String`, `bytes: Int`, `durationMs: Double`.
- `text: String`: the current text. `recognizedText: String` and `transcription: String` are the recognized and transcribed texts.
- `error: String?`, `provider: String?`: the last failure, and the provider that transcribed it.

```swift
let longest = voice.notes.max { $0.clip.durationMs < $1.clip.durationMs }
if let note = longest {
    print(note.id, note.clip.durationMs, note.text)
}
```

### Window

Helpers for the app's AppKit windows. `titlebarZone(below:onDropFiles:)`, `titlebarBackground(_:)`, `titlebarRow(minHeight:)` and `titlebarLabel()` make the title bar of a window whose content runs under it zoom, drag and let controls keep their clicks. `WindowTitlebar.audit` checks that in a snapshot run. `HostWindow` finds the window a view is in, `WindowRaise` brings one window forward, `WindowSnapshot` captures a window as the window server draws it, and `SingleInstance` keeps one process of a kind per login session. The edge panel types at the end are the floating panel that the notch and side widgets use.

#### `View.titlebarZone(below:onDropFiles:)`

Put this on the root view of a window that uses `.fullSizeContentView` with a transparent title bar. The SwiftUI hosting view covers the title bar strip and takes its clicks, so without this a double-click on the strip does not zoom the window. With it, the empty strip zooms, minimizes or does nothing on a double-click (as System Settings says) and drags the window on a single click. A control placed in the strip keeps its own clicks and drags. The modifier also publishes `TitlebarMetrics` to its descendants. Behind it sit the public AppKit views `TitlebarZoneHost` and `TitlebarZoneView`.

- `below: CGFloat = 0`: points of chrome drawn right under the title bar that belong to the strip too, such as a custom toolbar row. Its fill must take no clicks.
- `onDropFiles: (([URL]) -> Bool)? = nil`: called with the file URLs dropped on the empty strip. Pass the window's open path so a drop there still opens the file. Return true when the files were taken.

```swift
RootView(model: model)
    .titlebarZone(
        below: 40,
        onDropFiles: { urls in
            model.open(urls: urls)
            return true
        })
```

#### `View.titlebarBackground(_:)`

A background that also paints the title bar strip above the view and leaves the strip's clicks to `titlebarZone()`. A plain `.background` that ignores the top safe area takes those clicks before the zone sees them. In the view's own frame it still takes clicks.

- `_ fill: Fill`: any view used as the fill.

```swift
Sidebar()
    .frame(width: 238)
    .titlebarBackground(Color.white.opacity(0.025))
```

#### `View.titlebarRow(minHeight:)`

Marks a row of controls that belongs in the title bar strip. Put it first in a view that starts right under the title bar. The row moves up into the strip, as tall as the strip, and takes no height below it. It is pushed right when it would start under the traffic lights or the window title. In full screen, where there is no strip, it stays in place and is `minHeight` tall. It needs `titlebarZone()` above it.

- `minHeight: CGFloat = 28`: the least row height. It is the whole height when there is no strip.

```swift
VStack(spacing: 0) {
    HStack {
        Text("Library").titlebarLabel()
        Spacer()
        Button("Add") { addItem() }
    }
    .titlebarRow()
    ItemList(items: items)
}
```

#### `View.titlebarLabel()`

Makes plain text or an icon in a title bar row transparent to the pointer, so a double-click on it zooms the window and a drag moves it, as on the real title. Do not use it on text with a tooltip, a link or a selection.

```swift
HStack {
    Text("Library").titlebarLabel()
    Image(systemName: "books.vertical").titlebarLabel()
    Spacer()
}
.titlebarRow()
```

#### `TitlebarMetrics`

The size of the title bar strip as the zone last measured it. Descendants of `titlebarZone()` read it from the environment as `titlebarMetrics`, for example to inset their own content.

- `height: CGFloat = 0`: the strip height. It is 0 in full screen.
- `leadingReserve: CGFloat = 0`: the window x where the traffic lights and the title end, plus a gap. 0 when there is nothing to reserve.

```swift
@Environment(\.titlebarMetrics) private var metrics
// ...
Toolbar().padding(.leading, metrics.leadingReserve)
```

#### `WindowTitlebar`

The helpers the title bar modifiers are built on. A host calls them directly for chrome the zone does not cover, such as a tab bar under a custom toolbar.

`Action` is the result of a click on the empty strip:

- `drag`: start a window drag.
- `zoom`: zoom the window.
- `minimize`: minimize the window.
- `none`: do nothing.

Properties and constants:

- `static let preferenceKey = "AppleActionOnDoubleClick"`: the System Settings defaults key for the double-click action.
- `static var preference: String?`: the user's value for that key.
- `static let reserveGap: CGFloat = 12`: the gap added after the traffic lights and the title.

Methods:

- `action(clickCount: Int, preference: String?) -> Action`: a single click drags. A double-click minimizes for "Minimize" or "Miniaturize", does nothing for "None" and zooms otherwise (a missing value zooms). Other counts do nothing.
- `perform(_ action: Action, on window: NSWindow)`: zooms or minimizes. `drag` needs the mouse-down event, so only the zone performs it.
- `performDoubleClick(on window: NSWindow)`: performs the action System Settings names for a double-click.
- `fileURLs(on pasteboard: NSPasteboard) -> [URL]`: the file URLs a drag carries, or none.
- `stripHeight(of window: NSWindow) -> CGFloat`: the title bar height, such as 32 points on macOS 26 without a toolbar, 28 points before, and 0 in full screen.
- `contains(_ point: CGPoint, window: NSWindow, below: CGFloat = 0) -> Bool`: true for a point in window coordinates inside the strip plus `below` points of chrome under it.
- `leadingReserve(of window: NSWindow) -> CGFloat`: the window x where the traffic lights and a visible title end, plus `reserveGap`. 0 when there is nothing to reserve.
- `flatColumns(under window: NSWindow, columnWidth: CGFloat, depth: CGFloat = 120) -> [Audit.Band.Column]`: for each column of the window, how far down from the strip it stays one color. `audit` uses it. An `Audit.Band.Column` has `height: CGFloat`, `color: UInt32` (packed RGBA) and `edge: Bool` (a line or an edge crosses the column).
- `audit(_:expectsRow:step:)`: see the next entry.

```swift
let action = WindowTitlebar.action(clickCount: 2, preference: WindowTitlebar.preference)
if WindowTitlebar.contains(point, window: window, below: 40) {
    WindowTitlebar.perform(action, on: window)
}
```

#### `WindowTitlebar.audit(_:expectsRow:step:)`

Checks a window's title bar the way a click would land, for a `--snapshot` run. It hit-tests the strip's center line every `step` points and reports what it finds, left to right: the window's own buttons, the empty strip (the zone) or content (a control, or a view that took the strip's clicks). It also looks for an empty flat band right under the strip.

- `_ window: NSWindow`: the window to check.
- `expectsRow: Bool = false`: the window has a `titlebarRow()` on screen, so the strip must hold some content.
- `step: CGFloat = 2`: the distance between samples in points.

It returns a `WindowTitlebar.Audit`:

- `stripHeight: CGFloat` and `leadingReserve: CGFloat`: the measured strip height and reserve.
- `runs: [Run]`: consecutive samples of one kind. Each run has `kind` (`window`, `zone` or `content`), `minX` and `maxX`.
- `expectsRow: Bool` and `width: CGFloat`: the input flag and the window width.
- `band: Band?`: the widest flat stretch right under the strip, with `minX`, `maxX` and `height`. `Band.widest(columns:columnWidth:)` computes it.
- `emptyBand: Band?`: the band, only when it spans at least 40 percent of the width and the window expects a row.
- `problems: [String]`: content over the strip with no zone left, an expected row that is not there, an empty band, or content under the traffic lights or the title.
- `line: String`: one line with the measurements and either "ok" or the problems.
- `width(of kind: Kind) -> CGFloat`: the total width of one kind of run.

```swift
let audit = WindowTitlebar.audit(window, expectsRow: true)
print(audit.line)
if !audit.problems.isEmpty { exit(1) }
```

#### `HostWindow`

A box that holds the window a view is in, without SwiftUI state, so setting it re-renders nothing. A session screen uses it to pause a live tail while its own window is minimized. It holds the window weakly.

- `init()`: an empty box.
- `window: NSWindow?`: the window, nil until a `HostWindowReader` fills it.

```swift
@State private var host = HostWindow()
// later, in an action:
if host.window?.isMiniaturized == true { pauseTail() }
```

#### `HostWindowReader`

A view that draws nothing and stores its window in a `HostWindow` each time the view moves into a window (once per move, not per update). Put it in a `.background`.

- `host: HostWindow`: the box to fill.

```swift
let host = HostWindow()
let reader = HostWindowReader(host: host)
SessionScreen().background(reader)
```

#### `WindowRaise.raise(_:)`

Brings one window to the front and makes it key without raising the app's other windows. `NSApp.activate(ignoringOtherApps:)` orders every visible window of the app forward; this does not. It activates the app only when another app is active.

- `_ window: NSWindow`: the window to raise.

```swift
let window = settings.prepare(pageID: "general")
window.delegate = self
WindowRaise.raise(window)
```

#### `WindowSnapshot`

Draws a window for a `--snapshot` run as the window server composes it, Liquid Glass included. `cacheDisplay` skips the layers a glass effect is made of, so a page with glass came out transparent. `capture` lowers the window to the minimum level and, once an opaque desktop picture covers all of it, makes it opaque and captures it with ScreenCaptureKit. The window never shows on screen. Without a Screen Recording grant, without a desktop picture behind the window, or when the window server does not answer within 10 seconds, it falls back to `cacheDisplay` and says so in `method`.

- `static func capture(_ window: NSWindow) async -> Capture?`: captures the window. Returns nil only when the fallback has no content view to draw.
- `Capture.image: NSBitmapImageRep`: the picture.
- `Capture.method: String`: "window server", or "cacheDisplay" followed by the reason and a note that Liquid Glass stays transparent.
- `static func coveredByDesktopPicture(_ bounds: CGRect, above: [ListedWindow], desktopLevel: Int) -> Bool`: whether an opaque window at or below the desktop level covers all of `bounds`. `ListedWindow(number:layer:alpha:bounds:)` is one row of the window list, reduced to what decides this.

```swift
if let capture = await WindowSnapshot.capture(window),
   let png = capture.image.representation(using: .png, properties: [:]) {
    try png.write(to: URL(fileURLWithPath: "/tmp/shot.png"))
    print(capture.method)
}
```

#### `SingleInstance`

Keeps one process of a kind per login session, such as one hub or one markdown viewer. The holder keeps an exclusive `flock` on a lock file for its whole life, and the kernel drops it when the process ends, even in a crash. A later launch that cannot take the lock hands its arguments to the holder through a distributed notification and waits for the answer. The caller then exits, so two launches never open two windows.

- `name: String`: the kind of process, used in log lines and messages.
- `lockFile: URL`: the lock file. Its folder is created when needed.
- `notificationPrefix: String`: names the two distributed notifications, `<prefix>.request` and `<prefix>.ack`.
- `retryHint: String`: what the user does when the holder never answers, printed to standard error.
- `log: (String) -> Void`: receives log lines.

Methods and properties:

- `claim() -> Bool`: true when this process is now the one. Call it once, before building the window. When the lock file cannot be opened, it logs that and returns true.
- `isRunningElsewhere: Bool`: true when another process holds the lock.
- `forward(_ args: [String]) -> Bool`: hands `args` to the holder, up to three attempts of 1.5 seconds each. Returns false when it never answers; the caller should still exit, and a message with the `retryHint` has been printed.
- `handOff(_ args: [String])`: posts the request without waiting. Use it from a window that is already running, since waiting for the answer blocks its run loop.
- `serve(_ apply: @escaping ([String]) -> Void)`: called by the holder. Runs `apply` on the main queue with the arguments of every later launch, then sends the answer.

```swift
let instance = SingleInstance(
    name: "viewer",
    lockFile: URL(fileURLWithPath: NSHomeDirectory() + "/.acme/viewer.lock"),
    notificationPrefix: "dev.example.acme.viewer",
    retryHint: "quit that one, then open the file again.",
    log: { print($0) })
if !instance.claim() {
    exit(instance.forward(CommandLine.arguments) ? 0 : 1)
}
instance.serve { args in openFiles(args) }
```

#### `EdgePanelController`

Owns one floating `NSPanel` that sits on a screen edge: the top notch or the left or right side. The panel moves between three sizes (`compact`, `preview` and `expanded`, the cases of `WidgetModulePresentation`). While it changes size, a shape layer masks the content to an animated outline, so the window itself changes size at most once at each end. The host owns the content and its actions. `Content` is the SwiftUI view the panel shows.

- `placement: EdgePanelPlacement`: the edge.
- `screen: NSScreen`: the screen the panel lives on.
- `compactSize: CGSize`: the size in the compact presentation.
- `expandedSize: CGSize`: the size in the expanded presentation.
- `title: String`: the panel title.
- `motion: EdgePanelMotion? = nil`: shared state for the content. When nil, the controller makes one.
- `shape: ((WidgetModulePresentation) -> EdgePanelShape)? = nil`: the outline of each presentation. When nil, a plain rectangle with no rounding.
- `content: () -> Content`: the hosted view, a `@ViewBuilder` closure.

Properties:

- `panel: NSPanel`, `placement: EdgePanelPlacement` and `motion: EdgePanelMotion`: the panel, the edge and the shared state.
- `shape: (WidgetModulePresentation) -> EdgePanelShape`: settable.
- `isExpanded: Bool`: whether the last requested presentation was `expanded`.
- `becomesKeyOnExpand: Bool = true`: an expanded panel takes the keyboard. Set it to false for scripted motion checks that must not take the keyboard from another app.
- `visibleFrame: CGRect`: the outline the user sees, in screen coordinates. During a transition it is the animated shape.
- `lastTransitionTiming: AnimationTiming.Summary?`: timing of the last transition's display callbacks.

Methods:

- `updateContent(_ content: () -> Content)`: replaces the hosted view.
- `setCompactSize(_:)`, `setExpandedSize(_:)`, `setPreviewSize(_:)`: change the size of a presentation. The preview size starts at 300 by 240. Call `setPresentation` afterward to apply it.
- `setSideCenterY(_ value: CGFloat)`: the screen y a side panel centers on. By default, the visible frame's middle plus 55 points.
- `show()`: orders the panel front if it is not visible.
- `hide()`: stops any transition and orders the panel out.
- `setExpanded(_ expanded: Bool, reduceMotion: Bool)`: shorthand for `setPresentation` with `expanded` or `compact`.
- `setPresentation(_ presentation: WidgetModulePresentation, reduceMotion: Bool)`: moves to the size of the presentation. With `reduceMotion` true, or while the panel is hidden, it settles at once. The environment variable `GENESIS_WIDGET_MOTION_SCALE` (a number up to 20) slows every transition for frame-by-frame review.

```swift
let motion = EdgePanelMotion()
let controller = EdgePanelController(
    placement: .right, screen: screen, compactSize: CGSize(width: 56, height: 220),
    expandedSize: CGSize(width: 380, height: 520), title: "Inbox", motion: motion
) {
    InboxView(motion: motion)
}
controller.show()
controller.setPresentation(.expanded, reduceMotion: false)
```

#### `EdgePanelMotion`

Shared state between an `EdgePanelController` and the view it hosts. A growing panel switches `presentation` at the start of its transition and a shrinking one at the end, so a closing panel keeps its content until the outline is small.

- `presentation: WidgetModulePresentation = .compact`: the starting presentation (init parameter).

Properties:

- `presentation: WidgetModulePresentation`: what the content should show. The host reads it. The controller sets it.
- `pointerInside: Bool`: the host sets it while the pointer is on the panel, so it can build larger content ahead of a click.
- `contentFrame: CGRect?`: where the content sits in the window (top-left origin) while the outline changes size around it. Nil when the content fills the window. The host reads it. The controller sets it.

```swift
Group {
    if motion.presentation == .compact { CompactRail() } else { ExpandedList() }
}
.onHover { motion.pointerInside = $0 }
```

#### `EdgePanelPlacement`

The edge a panel is attached to. It is `CaseIterable` and `Identifiable`.

- `top`: the top of the screen, centered. The panel sits at the status bar level.
- `right`: the right edge, centered on `sideCenterY`.
- `left`: the left edge, centered on `sideCenterY`.

```swift
let placement: EdgePanelPlacement = .left
let shape = EdgePanelShape(placement: placement)
let outline = shape.path(in: CGRect(x: 0, y: 0, width: 380, height: 520))
```

#### `EdgePanelShape`

The outline of an edge panel. When `joined` is true, concave shoulders meet the screen edge and only the inward side has rounded corners. When false, it is a rounded rectangle. Both `shoulder` and `corner` animate.

- `placement: EdgePanelPlacement`: the edge the shape joins.
- `shoulder: CGFloat = 10`: the size of the concave shoulder.
- `corner: CGFloat = 18`: the corner radius.
- `joined: Bool = true`: draw the shoulders. False gives a plain rounded rectangle.

```swift
EdgePanelShape(placement: .top, shoulder: 12, corner: 20)
    .fill(.black)
    .frame(width: 320, height: 120)
```

#### `EdgePanelGeometry`

Pure frame and motion calculations for edge panels. The controller uses them; a host calls them to place a related window.

- `frame(placement: EdgePanelPlacement, size: CGSize, screen: CGRect, visible: CGRect, sideCenterY: CGFloat) -> CGRect`: the panel frame. The size is clamped to the screen. A top panel is centered on the top edge. A side panel is centered on `sideCenterY` and kept inside `visible`.
- `mediaFrame(anchor: CGRect, visible: CGRect) -> CGRect`: a window of up to 740 by 650 points centered on `anchor` and kept 12 points inside `visible`.
- `interpolate(from: CGRect, to: CGRect, progress: CGFloat) -> CGRect`: a frame between two frames. Width and height stay at least 1.
- `motion(to: WidgetModulePresentation, shrinking: Bool) -> (duration: Double, curve: (Float, Float, Float, Float))`: duration (0.22 seconds, or 0.30 when growing to `expanded`) and the Bezier control points of one transition.
- `reshape(from visible: CGRect, to target: CGRect, window current: CGRect) -> ReshapePlan`: how a size change around the same content runs. A `ReshapePlan` has `window` (the window the motion runs in), `resizesAtStart`, `resizesAtEnd`, `growing`, `startContent` and `endContent` (where the content sits in that window).
- `localRect(_ visible: CGRect, in window: CGRect) -> CGRect`: a screen rectangle (y up) in the top-left coordinates SwiftUI uses inside the window.
- `bezier(_ t: Double, _ curve: (Float, Float, Float, Float)) -> Double`: the eased progress of a timing curve at linear time `t` from 0 to 1.
- `maskPath(shape: EdgePanelShape, visible: CGRect, window: CGRect) -> CGPath`: the outline as a mask path for a window.

```swift
let frame = EdgePanelGeometry.frame(
    placement: .right, size: CGSize(width: 380, height: 520),
    screen: screen.frame, visible: screen.visibleFrame, sideCenterY: screen.visibleFrame.midY)
```

#### `EnvironmentValues.edgePanelMoving`

True while the hosted content moves with the panel's outline (`EdgePanelMotion.contentFrame` is set). An AppKit control that moves every frame costs a layout per frame; a text field in a moving pane cut the reshape to 40 to 55 frames a second. Such a control shows a drawn stand-in of the same size while this is true, unless the user is typing in it.

- `edgePanelMoving: Bool`: default `false`.

```swift
@Environment(\.edgePanelMoving) private var moving
@FocusState private var typing: Bool

var body: some View {
    if moving && !typing { DrawnStandIn() } else { TextField("Reply", text: $draft).focused($typing) }
}
```

## API rules

- Views take values and closures, never an app's model. What an app does differently is a hook or an option,
  never a second copy and never an `#if`:
  - `GenesisKitHost` (one class per app, `@objc(GenesisKitHostAdapter)`, found by name): the log line, the perf
    configuration, the transcript's markdown renderer, text a panel find can mark, opening a terminal, and for the
    markdown viewer the notes vault, its `[[` / `#` completion, the default-app offer and the `tools` binary.
  - `TranscriptServices` (per loaded session): the session file, the change log, "Open diff", a detail loader,
    row actions, notice buttons, the search query.
  - `SessionDetailActions` (per screen): refresh, copy, Finder, Cursor, focus, wake, the alert and hub actions.
  - `TranscriptBus` / `TranscriptFilters`: a host that wants to reveal a row or filter to one tool posts there.
  - Options on the view: `followsLatest` (a live chat), `emptyMessage`, `sidebarExtraFirst`, `showsSidebar`.
- A public struct a host builds gets an explicit `public init` (the synthesized one is internal).
- Keep a component small and composed: a row, a strip, a panel. A new need is a parameter or a new component here,
  not a local copy in an app.

## The visibility rule

A type an app declares shadows the package's public type of the same name. An extension member (`.instantTooltip`,
`.genHoverPlain()`, `.rowButton`) declared in both is "ambiguous use" in every file of the app, and breaks the
build. So never add an app copy of anything that lives here.

## Tests

`swift test` here covers the shared code, including `SessionTranscriptScrollTests` (the transcript's scroll,
streaming and resize cost; `SESSION_SCROLL_PERF=1` for the timing runs; the image viewer's frame and build limits
likewise only with `IMAGE_VIEWER_PERF=1`) and `WindowTitlebarTests`, which open
windows at alpha 0, below the desktop, never activated. Then build both apps (`bun run app` in GenesisTools,
`bun scripts/install.ts --debug` in `Genesis/apps/Genesis`) and run their suites: GenesisTools `swift test`,
GenesisAIMonitorKit `swift test`, Genesis `bun run test:scope`.
