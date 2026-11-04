import AVFoundation
import Foundation

/// The display plan's actions: show another display over a range of a frames recording's proxy movie, through
/// `tools recorder proxy --keep-plan --switch`, then load the new movie.
extension EditorModel {
    /// Shows `displayId` from `fromUs` to `toUs` (source microseconds) and makes the proxy movie again.
    func switchDisplay(fromUs: Int64, toUs: Int64, displayId: Int) {
        guard let plan = displayPlan, !isSwitchingDisplay, toUs > fromUs else { return }
        let folder = URL(fileURLWithPath: project.source.video).deletingLastPathComponent()
        isSwitchingDisplay = true
        show("Making the movie with \(plan.name(of: displayId)) from \(formatClock(fromUs, tenths: true))…", error: false)
        HubPerf.log("recorder.editor.display: \(folder.path) \(fromUs)-\(toUs)=\(displayId)")
        ToolsRunner.run(DisplayPlan.switchArguments(folder: folder, fromUs: fromUs, toUs: toUs, displayId: displayId)) { [weak self] status, _, stderr in
            guard let self else { return }
            self.isSwitchingDisplay = false
            guard status == 0 else {
                self.show("The display did not change: \(stderr.split(separator: "\n").last.map(String.init) ?? "exit \(status)")", error: true)
                return
            }
            self.displayPlan = DisplayPlan.read(video: self.project.source.video)
            self.reloadMovie()
            self.show("Showing \(plan.name(of: displayId)) from \(formatClock(fromUs, tenths: true)).", error: false)
        }
    }

    /// The range popover's display switch: what plays from the range's start to its end, mapped to the recording.
    func switchDisplay(_ range: TimelineRange, to displayId: Int) {
        timelineRange = nil
        switchDisplay(fromUs: TimelineMap.sourceTime(atOutput: range.fromUs, in: project),
                      toUs: TimelineMap.sourceTime(atOutput: range.toUs, in: project), displayId: displayId)
    }
}
