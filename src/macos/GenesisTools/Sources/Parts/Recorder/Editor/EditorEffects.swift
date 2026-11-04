import AppKit

/// The effect lanes' actions: one entry per kind for selecting, moving, deleting and adding an item, and the lane
/// list itself (add, move, rename, remove). The pure edits live in `EffectLanes`; these apply them with undo.
extension EditorModel {
    /// How many effect lanes show before the area scrolls (0 shows them all); View → Effect Lanes Shown.
    nonisolated static let lanesShownKey = "recorder.timeline.lanesShown"
    nonisolated static let lanesShownChoices = [2, 3, 4, 6, 0]

    nonisolated static var lanesShown: Int {
        UserDefaults.standard.object(forKey: lanesShownKey) as? Int ?? 4
    }

    var effectLanes: [EffectLanes.Resolved] { EffectLanes.resolve(project) }

    func isSelected(_ item: EffectItem) -> Bool {
        selection == Self.selection(of: item)
    }

    nonisolated static func selection(of item: EffectItem) -> EditorSelection {
        switch item.kind {
        case .zoom: .zoom(item.id)
        case .hide, .spotlight: .redaction(item.id)
        case .text: .text(item.id)
        case .shape: .shape(item.id)
        case .speed: .clip(item.id)
        case .cameraHide: .cameraHide(item.id)
        }
    }

    /// Selects the item and opens its panel. A zoom selected while the playhead is outside it moves the playhead to
    /// its first fully zoomed frame, so the preview shows what the panel changes.
    func selectEffect(_ item: EffectItem, seek moveHead: Bool = true) {
        selection = Self.selection(of: item)
        switch item.kind {
        case .zoom: tab = .zoom
        case .hide, .spotlight: tab = .hide
        case .text, .shape: tab = .text
        case .speed: tab = .clip
        case .cameraHide: tab = .style
        }
        guard moveHead, item.kind == .zoom, let zoom = project.zooms.first(where: { $0.id == item.id }) else { return }
        let now = TimelineMap.sourceTime(atOutput: clock.outUs, in: project)
        guard now < zoom.startUs || now >= zoom.endUs else { return }
        let settled = min(zoom.endUs - 1, zoom.startUs + Int64(zoom.easeInMs) * 1000)
        if let at = TimelineMap.outputTime(ofSource: settled, in: project) ?? TimelineMap.outputTime(ofSource: zoom.startUs, in: project) {
            seek(at)
        }
    }

    /// Moves or trims an item in source time. A speed item is its clip and does not move.
    func moveEffect(_ item: EffectItem, startUs: Int64, endUs: Int64) {
        switch item.kind {
        case .zoom: moveZoom(item.id, startUs: startUs, endUs: endUs)
        case .hide, .spotlight: updateRedaction(item.id) { $0.startUs = startUs; $0.endUs = endUs }
        case .text: updateText(item.id) { $0.startUs = startUs; $0.endUs = endUs }
        case .shape: updateShape(item.id) { $0.startUs = startUs; $0.endUs = endUs }
        case .speed: break
        case .cameraHide: updateCameraHidden(item.id) { $0.startUs = startUs; $0.endUs = endUs }
        }
    }

    /// Deletes an item; a speed item plays its clip at normal speed again.
    func deleteEffect(_ item: EffectItem) {
        switch item.kind {
        case .zoom:
            selection = .zoom(item.id)
            deleteSelection()
        case .hide, .spotlight: deleteRedaction(item.id)
        case .text: deleteText(item.id)
        case .shape: deleteShape(item.id)
        case .speed: setSpeed(item.id, 1)
        case .cameraHide: deleteCameraHidden(item.id)
        }
    }

    /// Adds an item of `kind` from an output time on a lane: a 2 s zoom, or a 3 s hidden part, spotlight, text or box
    /// unless `toOut` ends it (through a speed change the source length is what plays there). A speed plays the range
    /// twice as fast (2 s from the time on a click).
    func addEffect(_ kind: EffectKind, fromOut: Int64, toOut: Int64?, lane: String?) {
        let length = toOut.map { TimelineMap.sourceTime(atOutput: $0, in: project) - TimelineMap.sourceTime(atOutput: fromOut, in: project) }
        switch kind {
        case .zoom: addZoom(atOutput: fromOut, durationUs: max(500_000, length ?? 2_000_000), lane: lane)
        case .hide: addRedaction(atOutput: fromOut, durationUs: max(100_000, length ?? 3_000_000), lane: lane)
        case .spotlight: addSpotlight(atOutput: fromOut, durationUs: max(100_000, length ?? 3_000_000), lane: lane)
        case .text: addText(atOutput: fromOut, durationUs: max(100_000, length ?? 3_000_000), lane: lane)
        case .shape: addShape(.box, atOutput: fromOut, durationUs: max(100_000, length ?? 3_000_000), lane: lane)
        case .speed: speedRange(fromOut: fromOut, toOut: toOut ?? fromOut + 2_000_000, speed: 2)
        case .cameraHide: addCameraHidden(atOutput: fromOut, durationUs: max(100_000, length ?? 3_000_000), lane: lane)
        }
    }

    /// What plays from `fromOut` to `toOut` at `speed` (the `speed` op).
    func speedRange(fromOut: Int64, toOut: Int64, speed: Double) {
        guard let next = TimelineMap.speed(project, fromOut: fromOut, toOut: toOut, speed: speed) else {
            show("Nothing plays there to speed up.", error: false)
            return
        }
        apply(next, rebuildMovie: true)
    }

    func moveEffect(_ item: EffectItem, toLane lane: String) {
        guard let next = EffectLanes.moveToLane(project, item: item.id, lane: lane) else { return }
        apply(next, rebuildMovie: false)
    }

    /// A new lane at the bottom of the effects area; nil kinds holds every kind.
    func addLane(kinds: [EffectKind]?) {
        let (next, _) = EffectLanes.addLane(project, kinds: kinds)
        apply(next, rebuildMovie: false)
    }

    func removeLane(_ id: String) {
        apply(EffectLanes.removeLane(project, id: id), rebuildMovie: false)
    }

    func moveLane(_ id: String, by offset: Int) {
        apply(EffectLanes.moveLane(project, id: id, by: offset), rebuildMovie: false)
    }

    func renameLane(_ id: String, name: String?) {
        apply(EffectLanes.renameLane(project, id: id, name: name), rebuildMovie: false)
    }

    /// Asks for the lane's name in a sheet-like alert; an empty name goes back to what it holds.
    func renameLanePrompt(_ id: String, current: String) {
        let alert = NSAlert()
        alert.messageText = "Rename the lane"
        alert.informativeText = "An empty name shows what the lane holds."
        let field = NSTextField(string: current)
        field.frame = NSRect(x: 0, y: 0, width: 260, height: 24)
        alert.accessoryView = field
        alert.addButton(withTitle: "Rename")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        renameLane(id, name: field.stringValue)
    }

    /// The choices of "Add Lane": one per family of kinds, speed, and a lane for any effect.
    static let laneChoices: [(title: String, kinds: [EffectKind]?)] = [
        ("Zooms", [.zoom]),
        ("Hidden Parts and Spotlights", [.hide, .spotlight]),
        ("Texts and Shapes", [.text, .shape]),
        ("Speed", [.speed]),
        ("Camera Bubble", [.cameraHide]),
        ("Any Effect", nil),
    ]
}
