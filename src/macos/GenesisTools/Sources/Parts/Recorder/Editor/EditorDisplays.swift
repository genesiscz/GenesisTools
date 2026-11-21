import AVFoundation
import Foundation

/// The display plan's actions: show another display over a range of a frames recording's proxy movie (the REPL's
/// switchDisplay() on the recorder service, else `tools recorder proxy --keep-plan --switch`), then load the new movie.
/// Each switch is one undo step; its undo and redo are the recorder's (proxy.undo.json), so the CLI and the REPL take
/// back the same switch.
extension EditorModel {
    /// The switch lines run through every lane of the timeline (true, the default) or only through the display rows.
    nonisolated static let displaySwitchLinesKey = "recorder.editor.displaySwitchLinesEverywhere"

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

    /// Clips `displayId` out of `fromUs..<toUs` (source microseconds): its neighbour shows there instead (the REPL's
    /// hideDisplay(), else the op hideDisplay in `tools recorder apply`). One undo step, as a switch.
    func hideDisplay(fromUs: Int64, toUs: Int64, displayId: Int) {
        guard let plan = displayPlan, toUs > fromUs else { return }
        let name = plan.name(of: displayId)
        let op: [String: Any] = ["op": "hideDisplay", "display": displayId, "from": EditOpDiff.seconds(fromUs), "to": EditOpDiff.seconds(toUs)]
        runDisplayOp(op, doing: "Hiding \(name) from \(formatClock(fromUs, tenths: true))…",
                     done: "Hid \(name) from \(formatClock(fromUs, tenths: true)) to \(formatClock(toUs, tenths: true)). ⌘Z shows it again.") {
            self.movie("hideDisplay", $0, recording: $1, argv: $2, timeout: 30 * 60, done: $3)
        }
    }

    /// Moves the switch at `atUs` to `toUs` (source microseconds): a drag of a switch line (the REPL's
    /// moveDisplaySwitch(), else the op moveDisplaySwitch in `tools recorder apply`). One undo step.
    func moveDisplaySwitch(atUs: Int64, toUs: Int64) {
        guard displayPlan != nil, atUs != toUs else { return }
        let op: [String: Any] = ["op": "moveDisplaySwitch", "at": EditOpDiff.seconds(atUs), "to": EditOpDiff.seconds(toUs)]
        runDisplayOp(op, doing: "Moving the display switch to \(formatClock(toUs, tenths: true))…",
                     done: "Moved the display switch to \(formatClock(toUs, tenths: true)). ⌘Z moves it back.") {
            self.movie("moveDisplaySwitch", $0, recording: $1, argv: $2, timeout: 30 * 60, done: $3)
        }
    }

    /// One display op through the service (`movie.<method>` with the op's fields), else `tools recorder apply`; the
    /// movie is made again and the change is one undo step, read back from the plan before and after.
    private func runDisplayOp(_ op: [String: Any], doing: String, done: String,
                              send: (_ params: [String: Any], _ recording: String, _ argv: [String],
                                     _ done: @escaping @MainActor (Result<Any?, ApplyFailure>, _ stdout: String) -> Void) -> Void) {
        guard let plan = displayPlan, !isSwitchingDisplay else { return }
        let folder = URL(fileURLWithPath: project.source.video).deletingLastPathComponent()
        isSwitchingDisplay = true
        show(doing, error: false)
        HubPerf.log("recorder.editor.display: \(op["op"] ?? "") in \(folder.path)")
        send(op.filter { $0.key != "op" }, folder.path, DisplayPlan.applyArguments(folder: folder, op: op)) { [weak self] result, _ in
            guard let self else { return }
            self.isSwitchingDisplay = false
            if case let .failure(failure) = result {
                self.show("The displays did not change: \(failure.reason)", error: true)
                return
            }
            self.displayPlan = DisplayPlan.read(video: self.project.source.video)
            if let after = self.displayPlan { self.recordDisplaySwitch(before: plan, after: after) }
            self.reloadMovie()
            self.show(done, error: false)
        }
    }

    /// The segment of `plan` that shows at the playhead, in source microseconds.
    var displaySegmentAtPlayhead: DisplayPlan.Range? {
        guard let plan = displayPlan else { return nil }
        let at = TimelineMap.sourceTime(atOutput: clock.outUs, in: project)
        return plan.rangeIndex(atSource: at).map { plan.ranges[$0] }
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
