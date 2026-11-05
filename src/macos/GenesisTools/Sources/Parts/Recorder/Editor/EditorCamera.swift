import Foundation

/// The camera bubble's hidden parts as effect-lane items: add one, move or trim it, delete it (the bubble shows there
/// again). Each change is an op on the recorder service, and the next preview frame reads it from `ZoomState`.
extension EditorModel {
    /// A hidden part from an output time, 3 s long by default, on `lane` when given.
    func addCameraHidden(atOutput outUs: Int64? = nil, durationUs: Int64 = 3_000_000, lane: String? = nil) {
        guard project.camera != nil else {
            show("This recording has no camera bubble. Record with Camera bubble on in the capture picker.", error: false)
            return
        }
        let start = TimelineMap.sourceTime(atOutput: outUs ?? clock.outUs, in: project)
        let op = EditOp.CameraHide(from: EditOpDiff.seconds(start), to: EditOpDiff.seconds(start + durationUs), lane: lane)
        edit([.cameraHide(op)]) { [weak self] before, after in
            guard let self, let id = Self.addedID(before, after, { ($0.camera?.hidden ?? []).map(\.id) }) else { return }
            self.selection = .cameraHide(id)
        }
    }

    /// Moves or trims one hidden part (the service holds it inside the recording, at least 0.1 s long).
    func updateCameraHidden(_ id: String, _ change: (inout EditProject.Camera.Hidden) -> Void) {
        self.change { project in
            guard var hidden = project.camera?.hidden, let index = hidden.firstIndex(where: { $0.id == id }) else { return }
            change(&hidden[index])
            project.camera?.hidden = hidden
        }
    }

    func deleteCameraHidden(_ id: String) {
        if selection == .cameraHide(id) { selection = .none }
        edit([.cameraShow(EditOp.CameraShow(id: id))])
    }
}

extension EditorModel {
    /// The bubble's place, size, shape or visibility through the camera op, one undo step per drag or slider move. An
    /// edit without a camera says how to get one instead.
    func changeCamera(_ change: EditProject.CameraChange) {
        guard project.camera != nil || change.file != nil else {
            show("This recording has no camera bubble. Record with Camera bubble on in the capture picker.", error: false)
            return
        }
        let op = EditOp.Camera(file: change.file, show: change.show, corner: change.corner, x: change.x, y: change.y, size: change.size,
                               shape: change.shape, mirror: change.mirror, offsetMs: change.offsetMs, enabled: change.enabled)
        let fields = EditOp.objects([.camera(op)]).first?.keys.filter { $0 != "op" }.sorted() ?? []
        continuous("camera:" + fields.joined(separator: ","), [.camera(op)])
    }
}
