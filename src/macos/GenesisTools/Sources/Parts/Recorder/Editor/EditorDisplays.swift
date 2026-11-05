import AVFoundation
import Foundation

/// The display plan's actions: show another display over a range of a frames recording's proxy movie, through
/// `tools recorder proxy --keep-plan --switch`, then load the new movie. Each switch is one undo step; its undo and
/// redo make the movie again with the plan from before or after it (`tools recorder proxy --plan <file>`).
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

    /// Makes the proxy movie again with exactly `plan` (an undo or a redo of a switch); `done` says whether it was made.
    func remakeProxy(plan: DisplayPlan, doing: String, done: @escaping @MainActor (Bool) -> Void) {
        let folder = URL(fileURLWithPath: project.source.video).deletingLastPathComponent()
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("genesis-recorder-plan-\(UUID().uuidString).json")
        do {
            try plan.fileData().write(to: file, options: .atomic)
        } catch {
            show("\(doing) did not start: \(error.localizedDescription)", error: true)
            done(false)
            return
        }
        isSwitchingDisplay = true
        show("\(doing): making the movie again…", error: false)
        HubPerf.log("recorder.editor.display: \(folder.path) plan of \(plan.ranges.count) ranges")
        runTools(["recorder", "proxy", folder.path, "--plan", file.path]) { [weak self] status, _, stderr in
            try? FileManager.default.removeItem(at: file)
            guard let self else { return }
            self.isSwitchingDisplay = false
            guard status == 0 else {
                self.show("\(doing) did not work: \(stderr.split(separator: "\n").last.map(String.init) ?? "exit \(status)")", error: true)
                done(false)
                return
            }
            self.displayPlan = DisplayPlan.read(video: self.project.source.video)
            self.reloadMovie()
            done(true)
        }
    }
}
