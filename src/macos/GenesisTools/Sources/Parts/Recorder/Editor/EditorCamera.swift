import Foundation

/// The camera bubble's hidden parts as effect-lane items: add one, move or trim it, delete it (the bubble shows there
/// again). Each change applies with undo, and the next preview frame reads it from `ZoomState`.
extension EditorModel {
    /// A hidden part from an output time, 3 s long by default, on `lane` when given.
    func addCameraHidden(atOutput outUs: Int64? = nil, durationUs: Int64 = 3_000_000, lane: String? = nil) {
        guard project.camera != nil else {
            show("This recording has no camera bubble. Record with Camera bubble on in the capture picker.", error: false)
            return
        }
        let start = TimelineMap.sourceTime(atOutput: outUs ?? clock.outUs, in: project)
        let end = min(project.source.durationUs, start + durationUs)
        guard end - start >= 100_000 else {
            show("The playhead is at the end of the recording; move it back to hide the camera there.", error: false)
            return
        }
        var next = project
        let part = EditProject.Camera.Hidden(startUs: start, endUs: end, lane: lane)
        let hidden = (project.camera?.hidden ?? []) + [part]
        next.camera?.hidden = hidden.sorted { $0.startUs < $1.startUs }
        selection = .cameraHide(part.id)
        apply(next, rebuildMovie: false)
    }

    /// Changes one hidden part, held inside the recording and at least 0.1 s long.
    func updateCameraHidden(_ id: String, _ change: (inout EditProject.Camera.Hidden) -> Void) {
        guard var hidden = project.camera?.hidden, let index = hidden.firstIndex(where: { $0.id == id }) else { return }
        change(&hidden[index])
        hidden[index].startUs = min(max(0, hidden[index].startUs), max(0, project.source.durationUs - 100_000))
        hidden[index].endUs = max(hidden[index].startUs + 100_000, min(project.source.durationUs, hidden[index].endUs))
        var next = project
        next.camera?.hidden = hidden.sorted { $0.startUs < $1.startUs }
        apply(next, rebuildMovie: false)
    }

    func deleteCameraHidden(_ id: String) {
        var next = project
        next.camera?.hidden.removeAll { $0.id == id }
        if selection == .cameraHide(id) { selection = .none }
        apply(next, rebuildMovie: false)
    }

    /// A copy of the hidden part right after it, the same length.
    func duplicateCameraHidden(_ id: String) {
        guard let part = project.camera?.hidden.first(where: { $0.id == id }) else { return }
        let length = part.endUs - part.startUs
        let start = min(part.endUs, project.source.durationUs - 100_000)
        let copy = EditProject.Camera.Hidden(startUs: start, endUs: min(project.source.durationUs, start + length), lane: part.lane)
        var next = project
        let hidden = (project.camera?.hidden ?? []) + [copy]
        next.camera?.hidden = hidden.sorted { $0.startUs < $1.startUs }
        selection = .cameraHide(copy.id)
        apply(next, rebuildMovie: false)
    }
}
