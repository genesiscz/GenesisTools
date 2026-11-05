import AVFoundation
import Foundation

/// The display plan's actions: show another display over a range of a frames recording's proxy movie (the REPL's
/// switchDisplay() on the recorder service, else `tools recorder proxy --keep-plan --switch`), then load the new movie.
/// Each switch is one undo step; its undo and redo are the recorder's (proxy.undo.json), so the CLI and the REPL take
/// back the same switch.
extension EditorModel {
    /// Shows `displayId` from `fromUs` to `toUs` (source microseconds) and makes the proxy movie again.
    func switchDisplay(fromUs: Int64, toUs: Int64, displayId: Int) {
        guard let plan = displayPlan, !isSwitchingDisplay, toUs > fromUs else { return }
        let folder = URL(fileURLWithPath: project.source.video).deletingLastPathComponent()
        isSwitchingDisplay = true
        show("Making the movie with \(plan.name(of: displayId)) from \(formatClock(fromUs, tenths: true))…", error: false)
        HubPerf.log("recorder.editor.display: \(folder.path) \(fromUs)-\(toUs)=\(displayId)")
        let params: [String: Any] = ["from": EditOpDiff.seconds(fromUs), "to": EditOpDiff.seconds(toUs), "display": displayId]
        movie("switchDisplay", params, recording: folder.path,
              argv: DisplayPlan.switchArguments(folder: folder, fromUs: fromUs, toUs: toUs, displayId: displayId), timeout: 30 * 60) { [weak self] result, _ in
            guard let self else { return }
            self.isSwitchingDisplay = false
            if case let .failure(failure) = result {
                self.show("The display did not change: \(failure.reason)", error: true)
                return
            }
            self.displayPlan = DisplayPlan.read(video: self.project.source.video)
            if let after = self.displayPlan { self.recordDisplaySwitch(before: plan, after: after) }
            self.reloadMovie()
            self.show("Showing \(plan.name(of: displayId)) from \(formatClock(fromUs, tenths: true)). ⌘Z switches it back.", error: false)
        }
    }

    /// The range popover's display switch: what plays from the range's start to its end, mapped to the recording.
    func switchDisplay(_ range: TimelineRange, to displayId: Int) {
        timelineRange = nil
        switchDisplay(fromUs: TimelineMap.sourceTime(atOutput: range.fromUs, in: project),
                      toUs: TimelineMap.sourceTime(atOutput: range.toUs, in: project), displayId: displayId)
    }

    /// Takes the last display switch back (`undo`) or makes it again: the REPL's undoDisplaySwitch() or
    /// redoDisplaySwitch() on the service, else `tools recorder proxy --undo-switch` or `--redo-switch`. `done` says
    /// whether the movie was made.
    func stepDisplaySwitch(undo: Bool, doing: String, done: @escaping @MainActor (Bool) -> Void) {
        let folder = URL(fileURLWithPath: project.source.video).deletingLastPathComponent()
        isSwitchingDisplay = true
        show("\(doing): making the movie again…", error: false)
        HubPerf.log("recorder.editor.display: \(undo ? "undo" : "redo") a switch in \(folder.path)")
        movie(undo ? "undoDisplaySwitch" : "redoDisplaySwitch", recording: folder.path,
              argv: ["recorder", "proxy", folder.path, undo ? "--undo-switch" : "--redo-switch"], timeout: 30 * 60) { [weak self] result, _ in
            guard let self else { return }
            self.isSwitchingDisplay = false
            if case let .failure(failure) = result {
                self.show("\(doing) did not work: \(failure.reason)", error: true)
                done(false)
                return
            }
            self.displayPlan = DisplayPlan.read(video: self.project.source.video)
            self.reloadMovie()
            done(true)
        }
    }
}
