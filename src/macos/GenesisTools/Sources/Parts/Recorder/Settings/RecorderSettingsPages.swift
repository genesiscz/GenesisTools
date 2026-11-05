import GenesisKit
import SwiftUI

/// Settings → Recorder: what a new recording records, the camera bubble, the global shortcuts and the menu bar item on
/// one page; the editor and the library on the other. Each row edits the key its reader already reads.
@MainActor
enum RecorderSettingsPages {
    static func section(model: RecorderSettingsModel) -> NativeSettingsSection {
        NativeSettingsSection(
            id: "recorder", title: "Recorder",
            pages: [
                NativeSettingsPage(
                    id: RecorderSettingsPlugin.recordingPageID, title: "Recording", symbol: "record.circle", tint: .red,
                    subtitle: "What a new recording records, the camera bubble, the shortcuts and the menu bar item."
                ) {
                    RecorderRecordingSettings(model: model)
                },
                NativeSettingsPage(
                    id: RecorderSettingsPlugin.editorPageID, title: "Recording editor", symbol: "film", tint: .orange,
                    subtitle: "How the editor's timeline, its tabs and the recordings library behave."
                ) {
                    RecorderEditorSettings(model: model)
                },
            ], order: 38)
    }
}

// MARK: - Recording

private struct RecorderRecordingSettings: View {
    @ObservedObject var model: RecorderSettingsModel

    var body: some View {
        VStack(spacing: 18) {
            recordingCard
            movieCard
            cameraCard
            shortcutsCard
            menuBarCard
            Text("The capture picker, the menu bar menu and this page change the same settings. A running recorder follows a change at once.")
                .font(.system(size: 11)).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var recordingCard: some View {
        let countdown = model.capture(\.countdown)
        return NativeSettingsCard("Recording", subtitle: "The capture picker's options. They apply to the next recording, also one started from the menu bar or a shortcut.") {
            NativeSettingsToggle("Countdown", detail: "A few seconds to switch to what is recorded after a choice.",
                                 identifier: "recorder.settings.countdown", isOn: countdown)
            Divider()
            NativeSettingsRow("Countdown length",
                              detail: countdown.wrappedValue ? "Seconds before the recording starts." : "Turn Countdown on to use it.") {
                Stepper(value: model.capture(\.countdownSeconds), in: 1...10) {
                    Text(verbatim: "\(model.capture(\.countdownSeconds).wrappedValue) s")
                        .font(.system(size: 12)).monospacedDigit()
                }
                .accessibilityIdentifier("recorder.settings.countdownSeconds")
            }
            .disabled(!countdown.wrappedValue)
            Divider()
            NativeSettingsSegmented(
                "Frame rate", detail: "Frames per second while something moves.", identifier: "recorder.settings.fps",
                options: CaptureOptions.frameRates.map { NativeSettingsOption($0, "\($0) fps") },
                selection: model.capture(\.fps), minSegmentWidth: 52)
            Divider()
            NativeSettingsSegmented(
                "While still", detail: "Frames per second while nothing moves. Same keeps one rate.",
                identifier: "recorder.settings.idleFps",
                options: CaptureOptions.idleRates.map { NativeSettingsOption($0, $0 == 0 ? "Same" : "\(Self.number($0)) fps") },
                selection: model.capture(\.idleFps), minSegmentWidth: 52)
            Divider()
            NativeSettingsSegmented(
                "Change needed", detail: "How much of the picture must change to leave the still rate.",
                identifier: "recorder.settings.threshold",
                options: CaptureOptions.thresholds.map { NativeSettingsOption($0, "\(Self.number($0)) %") },
                selection: model.capture(\.threshold), minSegmentWidth: 52)
        }
    }

    private var movieCard: some View {
        NativeSettingsCard("What the movie keeps", subtitle: "Record Screen with Audio in the menu bar turns both sound tracks on for that recording.") {
            NativeSettingsToggle("System audio", detail: "What the Mac plays, as its own track.",
                                 identifier: "recorder.settings.systemAudio", isOn: model.capture(\.systemAudio))
            Divider()
            NativeSettingsToggle("Microphone", detail: "Your voice, as its own track.",
                                 identifier: "recorder.settings.microphone", isOn: model.capture(\.microphone))
            Divider()
            NativeSettingsToggle("Draw the cursor in the editor",
                                 detail: "Records without the system cursor; the editor draws it smoothed and at any size. Off keeps the system cursor in the movie.",
                                 identifier: "recorder.settings.drawCursor", isOn: model.capture(\.drawCursor))
            Divider()
            NativeSettingsToggle("Record ⌘ and ⌃ shortcuts",
                                 detail: "Keeps the shortcuts pressed with ⌘ or ⌃ for the editor's shortcut overlay. Plain typing is never kept.",
                                 identifier: "recorder.settings.shortcutsOverlay", isOn: model.capture(\.shortcutsOverlay))
        }
    }

    private var cameraCard: some View {
        let camera = model.capture(\.camera)
        return NativeSettingsCard("Camera", subtitle: "The camera bubble beside the screen recording. The editor can move, resize and hide it later.") {
            NativeSettingsToggle("Camera bubble", detail: "Records the camera beside the screen. Drag the preview to place the bubble.",
                                 identifier: "recorder.settings.camera", isOn: camera)
            Divider()
            NativeSettingsSegmented(
                "Bubble size", detail: camera.wrappedValue ? "The preview's side on screen." : "Turn Camera bubble on to use it.",
                identifier: "recorder.settings.cameraSize",
                options: [NativeSettingsOption(140, "Small"), NativeSettingsOption(200, "Medium"), NativeSettingsOption(260, "Large")],
                selection: model.int(CameraBubble.Key.size, 200, allowed: CameraBubble.sizes), minSegmentWidth: 64)
                .disabled(!camera.wrappedValue)
            Divider()
            NativeSettingsSegmented(
                "Bubble shape", detail: camera.wrappedValue ? "The preview's shape, and the bubble's in a new edit." : "Turn Camera bubble on to use it.",
                identifier: "recorder.settings.cameraShape",
                options: [NativeSettingsOption(EditProject.CameraShape.circle, "Circle"),
                          NativeSettingsOption(EditProject.CameraShape.rounded, "Rounded"),
                          NativeSettingsOption(EditProject.CameraShape.square, "Square")],
                selection: model.choice(CameraBubble.Key.shape, EditProject.CameraShape.circle), minSegmentWidth: 64)
                .disabled(!camera.wrappedValue)
            Divider()
            NativeSettingsPicker(
                "Show the camera preview", detail: "When the live preview of the camera floats on screen while it records.",
                identifier: "recorder.settings.cameraPreview",
                options: [
                    NativeSettingsOption(CameraPreviewPolicy.everyCameraRecording, "Every recording with the camera",
                                         detail: "Also a recording the CLI or an agent started. Such a recording did not leave the preview out, so its screen movie shows the preview too, under the bubble the editor draws.",
                                         symbol: "video"),
                    NativeSettingsOption(CameraPreviewPolicy.pickerRecordings, "Picker recordings",
                                         detail: "Only a recording the capture picker started; its movie leaves the preview out. Others record the camera with no preview.",
                                         symbol: "rectangle.dashed.badge.record"),
                    NativeSettingsOption(CameraPreviewPolicy.never, "Never",
                                         detail: "No preview, not even in the picker. The camera still records, and the editor places the bubble.",
                                         symbol: "video.slash"),
                ],
                selection: model.choice(CameraPreviewPolicy.key, CameraPreviewPolicy.everyCameraRecording), width: 260)
        }
        .nativeSettingsAnchor("camera")
    }

    private var shortcutsCard: some View {
        NativeSettingsCard("Shortcuts", subtitle: "Global shortcuts that work in any app while the recorder's menu bar item runs. Click a shortcut to record a new one.") {
            ForEach(RecorderShortcutAction.allCases) { action in
                shortcutRow(action)
                Divider()
            }
            NativeSettingsToggle("Hold stop, pause and mark keys",
                                 detail: "On: those keys belong to the recorder all the time. Off: they reach other apps while nothing records.",
                                 identifier: "recorder.settings.alwaysHeld", isOn: model.bool(RecorderShortcuts.alwaysHeldKey, false))
            Divider()
            NativeSettingsSegmented(
                "When a shortcut has nothing to act on", detail: "Stop, pause or mark pressed while no recording runs.",
                identifier: "recorder.settings.idleFeedback",
                options: [
                    NativeSettingsOption(IdleShortcutFeedback.note, "Note",
                                         detail: "No sound. A short note by the pointer says that no recording runs, then fades. It takes no focus."),
                    NativeSettingsOption(IdleShortcutFeedback.beep, "Beep", detail: "The system alert sound, and nothing on screen."),
                    NativeSettingsOption(IdleShortcutFeedback.nothing, "Nothing", detail: "No sound and nothing on screen."),
                ],
                selection: model.choice(IdleShortcutFeedback.key, IdleShortcutFeedback.note), minSegmentWidth: 64)
        }
        .nativeSettingsAnchor("shortcuts")
    }

    private func shortcutRow(_ action: RecorderShortcutAction) -> some View {
        let binding = model.shortcut(action)
        return NativeSettingsRow(action.title, detail: binding.enabled ? action.detail : "Off: the keys reach other apps. Recording a new shortcut turns it on.") {
            HStack(spacing: 10) {
                HotkeyRecorder(
                    chord: Binding(get: { binding.chord }, set: { chord in
                        model.setShortcut(action, RecorderShortcutBinding(chord: chord, enabled: true))
                    }),
                    defaultChord: action.defaultChord, identifier: "recorder.settings.shortcut.\(action.rawValue)",
                    onListening: { listening in model.listening(listening ? action : nil) })
                Toggle(action.title, isOn: Binding(get: { binding.enabled }, set: { on in
                    model.setShortcut(action, RecorderShortcutBinding(chord: binding.chord, enabled: on))
                }))
                .labelsHidden().toggleStyle(.switch).controlSize(.small)
                .instantTooltip(binding.enabled ? "Turn this shortcut off" : "Turn this shortcut on")
                .accessibilityIdentifier("recorder.settings.shortcut.\(action.rawValue).enabled")
            }
        }
    }

    private var menuBarCard: some View {
        NativeSettingsCard("Menu bar", subtitle: "The recorder's item in the menu bar, and where its messages go.") {
            NativeSettingsToggle("Quick actions in Recent",
                                 detail: "Each recent recording opens a menu: open, copy the movie or a GIF, show in Finder, rename, its meeting, Trash. Off: a click opens the editor.",
                                 identifier: "recorder.settings.recentActions", isOn: model.bool(RecorderMenu.recentActionsKey, true))
            Divider()
            NativeSettingsSegmented(
                "Recorder failures", detail: "A failure no editor window shows (a quick action, a recording that did not open or start), and the Rename prompt.",
                identifier: "recorder.settings.failureStyle",
                options: [
                    NativeSettingsOption(RecorderFailureStyle.notice, "Notice",
                                         detail: "A note under the menu bar item that stays until you close it, with the details behind a click. Rename asks in a small panel. Neither brings the recorder's windows to the front."),
                    NativeSettingsOption(RecorderFailureStyle.alert, "Alert",
                                         detail: "A dialog that brings the recorder and its windows to the front and waits for you."),
                ],
                selection: model.choice(RecorderFailureStyle.key, RecorderFailureStyle.notice), minSegmentWidth: 72)
        }
        .nativeSettingsAnchor("menu-bar")
    }

    private static func number(_ value: Double) -> String {
        value == value.rounded() ? String(Int(value)) : String(value)
    }
}

// MARK: - Editor

private struct RecorderEditorSettings: View {
    @ObservedObject var model: RecorderSettingsModel

    var body: some View {
        VStack(spacing: 18) {
            timelineCard
            outsideEditsCard
            tabsCard
            libraryCard
            Text("The editor's View menu and its tabs change the same settings. An open editor follows a change at once.")
                .font(.system(size: 11)).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var timelineCard: some View {
        let snap = model.bool(EditorModel.snapKey, true)
        return NativeSettingsCard("Timeline", subtitle: "Dragging, keys and the lanes. The editor's View menu has the same switches.") {
            NativeSettingsToggle("Snap while dragging", detail: "Edges snap to the playhead and to other edges. Hold ⌘ while dragging to place an edge freely.",
                                 identifier: "recorder.settings.snap", isOn: snap)
            Divider()
            NativeSettingsToggle("Tap when snapping", detail: snap.wrappedValue ? "A trackpad tap when an edge snaps." : "Turn Snap while dragging on to use it.",
                                 identifier: "recorder.settings.snapHaptic", isOn: model.bool(EditorModel.snapHapticKey, true))
                .disabled(!snap.wrappedValue)
            Divider()
            NativeSettingsToggle("Single-key shortcuts", detail: "S, Z, T, A, B, C, I, O, J, K, L and Space without ⌘. Off: only the ⌘ keys work.",
                                 identifier: "recorder.settings.singleKeys", isOn: model.bool(EditorMenuTarget.singleKeysKey, true))
            Divider()
            NativeSettingsToggle("Ask what to do with a dragged range",
                                 detail: "A drag on the frames lane opens a popover (cut, speed, zoom, hide, text, export). Off: the drag marks the export part.",
                                 identifier: "recorder.settings.rangePopover", isOn: model.bool(EditorModel.rangePopoverKey, true))
            Divider()
            NativeSettingsSegmented(
                "Effect lanes before scrolling", detail: "Past this many effect lanes the lanes area scrolls, with a fade at the cut edge.",
                identifier: "recorder.settings.lanesShown",
                options: EditorModel.lanesShownChoices.map { NativeSettingsOption($0, $0 == 0 ? "All" : "\($0)") },
                selection: model.int(EditorModel.lanesShownKey, 4, allowed: EditorModel.lanesShownChoices), minSegmentWidth: 44)
        }
    }

    private var outsideEditsCard: some View {
        let banner = model.bool(EditorModel.agentEditBannerKey, true)
        return NativeSettingsCard("Edits from outside the window", subtitle: "What an open editor does when the CLI, an agent or another window changes the edit.") {
            NativeSettingsToggle("Show a banner of what changed", detail: "The time, who wrote it, and one line per change, on the preview.",
                                 identifier: "recorder.settings.agentBanner", isOn: banner)
            Divider()
            NativeSettingsSegmented(
                "Keep the banner", detail: banner.wrappedValue ? "Seconds the banner stays." : "Turn the banner on to use it.",
                identifier: "recorder.settings.agentSeconds",
                options: EditorModel.agentEditSecondsChoices.map { NativeSettingsOption($0, "\(Int($0)) s") },
                selection: model.double(EditorModel.agentEditSecondsKey, 6, allowed: EditorModel.agentEditSecondsChoices),
                minSegmentWidth: 48)
                .disabled(!banner.wrappedValue)
            Divider()
            NativeSettingsToggle("Flash the changed items", detail: "The timeline segments it touched; the preview for the frame, cursor, captions or clicks.",
                                 identifier: "recorder.settings.agentFlash", isOn: model.bool(EditorModel.agentEditFlashKey, true))
            Divider()
            NativeSettingsToggle("Move the playhead to the change", detail: "Not while the movie plays.",
                                 identifier: "recorder.settings.agentSeek", isOn: model.bool(EditorModel.agentEditSeekKey, true))
        }
    }

    private var tabsCard: some View {
        NativeSettingsCard("Clip, captions and export", subtitle: "Choices the editor's tabs keep for the next time.") {
            NativeSettingsSegmented(
                "Still parts longer than", detail: "The Clip tab's Cut Still Parts takes stretches where nothing moves and nothing is heard for this long.",
                identifier: "recorder.settings.idleMin",
                options: [NativeSettingsOption(1.0, "1 s"), NativeSettingsOption(2.0, "2 s"), NativeSettingsOption(5.0, "5 s")],
                selection: model.double(EditorModel.idleMinKey, 2), minSegmentWidth: 48)
            Divider()
            NativeSettingsSegmented(
                "Then", detail: "Cut them, or play them that much faster so the viewer sees time pass.",
                identifier: "recorder.settings.idleSpeed",
                options: [NativeSettingsOption(0, "Cut"), NativeSettingsOption(4, "4×"), NativeSettingsOption(8, "8×"),
                          NativeSettingsOption(16, "16×")],
                selection: model.int(EditorModel.idleSpeedKey, 0), minSegmentWidth: 48)
            Divider()
            NativeSettingsSegmented(
                "Cut Fillers takes", detail: "The Captions tab's Cut Fillers. Words such as \"like\" are also real words, so they are not cut by default.",
                identifier: "recorder.settings.fillerLevel",
                options: FillerLevel.allCases.map { NativeSettingsOption($0, $0.title) },
                selection: model.choice(EditorModel.fillerLevelKey, FillerLevel.sounds), minSegmentWidth: 72)
            Divider()
            NativeSettingsToggle("Show the export in Finder", detail: "Finder comes to the front with the new file selected.",
                                 identifier: "recorder.settings.revealAfterExport", isOn: model.bool(EditorModel.revealAfterExportKey, true))
            Divider()
            NativeSettingsToggle("Copy the export to the clipboard", detail: "The file, ready to paste into a chat or a mail.",
                                 identifier: "recorder.settings.copyAfterExport", isOn: model.bool(EditorModel.copyAfterExportKey, false))
        }
    }

    private var libraryCard: some View {
        NativeSettingsCard("Recordings library") {
            NativeSettingsToggle("Scrub cards on hover", detail: "Moving the pointer across a card plays through the recording.",
                                 identifier: "recorder.settings.hoverScrub", isOn: model.bool(LibraryModel.hoverScrubKey, true))
        }
    }
}
