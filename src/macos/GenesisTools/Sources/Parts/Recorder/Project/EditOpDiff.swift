import Foundation

/// The ops that take an edit from `old` to `new` when they differ only in settings and in the fields of items that
/// exist: the window's controls change a copy of the project (a slider sets `frame.padding`, a drag moves a text),
/// and this names that change as ops for the recorder service, which owns every rule (ranges, clamps, defaults).
/// A change it cannot name (clips, an added or deleted item, a lens among them) returns nil: those actions send their
/// own op.
enum EditOpDiff {
    static func ops(from old: EditProject, to new: EditProject) -> [EditOp]? {
        // Items are matched by id, never by place: the service sorts some lists (a hidden part moved past another), so
        // the same items in another order are the same items.
        guard old.clips == new.clips, old.markers == new.markers, old.lanes == new.lanes,
              sameItems(old.zooms, new.zooms, \.id), sameItems(old.redactions ?? [], new.redactions ?? [], \.id),
              sameItems(old.texts ?? [], new.texts ?? [], \.id), sameItems(old.shapes ?? [], new.shapes ?? [], \.id),
              (new.camera == nil || sameItems(old.camera?.hidden ?? [], new.camera?.hidden ?? [], \.id)),
              (old.camera == nil) == (new.camera == nil) || new.camera == nil,
              // A voiceover clip added here has no file length yet; the window adds one with its own op.
              Set(ids(new.audio.voiceovers)).isSubset(of: ids(old.audio.voiceovers)),
              // A lens added or deleted sends its own `lens` or `unlens` op (the service names a new lens).
              ids(old.lens?.items) == ids(new.lens?.items) else { return nil }
        var ops: [EditOp] = []
        for (a, b) in pairs(old.zooms, new.zooms, \.id) where a != b { ops += zoom(a, b) }
        for (a, b) in pairs(old.redactions ?? [], new.redactions ?? [], \.id) where a != b { ops += redaction(a, b) }
        for (a, b) in pairs(old.texts ?? [], new.texts ?? [], \.id) where a != b { ops += text(a, b) }
        for (a, b) in pairs(old.shapes ?? [], new.shapes ?? [], \.id) where a != b { ops += shape(a, b) }
        for (a, b) in pairs(old.camera?.hidden ?? [], new.camera?.hidden ?? [], \.id) where a != b {
            ops += retime(a.id, from: (a.startUs, a.endUs), to: (b.startUs, b.endUs))
        }
        if old.audio != new.audio { ops += audio(old.audio, new.audio) }
        if old.audio.lanes != new.audio.lanes {
            guard let changes = audioLaneOps(from: old, to: new) else { return nil }
            ops += changes
        }
        // Reorder indices refer to the surviving stack. Remove a camera before applying those moves.
        if old.camera != nil, new.camera == nil, let op = camera(old.camera, nil) {
            ops.append(.camera(op))
        }
        if old.layers != new.layers {
            guard let changes = layerOps(from: old, to: new) else { return nil }
            ops += changes
        }
        if old.export != new.export { ops.append(.exportSettings(export(old.export, new.export))) }
        if old.clicks != new.clicks { ops.append(.clicks(clicks(new.clicks))) }
        if old.frame != new.frame { ops.append(.frame(frame(new.frame))) }
        if old.cursor != new.cursor { ops.append(.cursor(cursor(new.cursor ?? EditProject.Cursor()))) }
        if old.captions != new.captions { ops.append(.captions(captions(new.captions))) }
        if old.keys != new.keys { ops.append(.keys(keys(new.keys))) }
        if old.motion != new.motion { ops.append(.motion(EditOp.Motion(blur: (new.motion ?? EditProject.Motion()).blur))) }
        if new.camera != nil, old.camera != new.camera, let op = camera(old.camera, new.camera) {
            ops.append(cameraOp(op, in: new))
        }
        if old.transcript != new.transcript { ops += fixes(old.transcript?.fixes ?? [:], new.transcript?.fixes ?? [:]) }
        // R4 6 animated captions
        if old.captionsStyle != new.captionsStyle {
            ops.append(.captionsStyle(new.captionsStyle.map { EditOp.CaptionsStyle(kind: $0.kind, color: $0.color, enabled: true) }
                ?? EditOp.CaptionsStyle(enabled: false)))
        }
        // R4 10 progress bar
        if old.progress != new.progress {
            ops.append(.progress(new.progress.map {
                EditOp.ProgressBar(show: $0.show, color: $0.color, height: $0.height, chapters: $0.chapters, chapterMs: $0.chapterMs, enabled: true,
                                   chapterPlace: $0.chapterPlace ?? .auto)
            } ?? EditOp.ProgressBar(enabled: false)))
        }
        // R4 9 intro and end cards
        if old.cards?.intro != new.cards?.intro {
            ops.append(.introCard(new.cards?.intro.map {
                EditOp.IntroCard(title: $0.title, subtitle: $0.subtitle ?? "", logo: $0.logo ?? "", date: $0.date ?? "", seconds: $0.seconds)
            } ?? EditOp.IntroCard(enabled: false)))
        }
        if old.cards?.end != new.cards?.end {
            ops.append(.endCard(new.cards?.end.map {
                EditOp.EndCard(text: $0.text, link: $0.link ?? "", qr: $0.qr, seconds: $0.seconds)
            } ?? EditOp.EndCard(enabled: false)))
        }
        // fx B (round 4): the smooth cursor and the speed badge (nil is off; the badge has no op that removes it).
        if old.cursorSmooth != new.cursorSmooth {
            ops.append(.cursorSmooth(new.cursorSmooth.map {
                EditOp.CursorSmooth(enabled: true, strength: $0.strength, jitterPx: $0.jitterPx, idleFadeSeconds: $0.idleFadeSeconds)
            } ?? EditOp.CursorSmooth(enabled: false)))
        }
        if old.autoSpeed != new.autoSpeed {
            let speed = new.autoSpeed ?? EditProject.AutoSpeed(badge: false)
            ops.append(.autoSpeed(EditOp.AutoSpeed(badge: speed.badge, position: speed.position)))
        }
        // R5 5 redaction edges
        if old.redactionJoins != new.redactionJoins {
            ops.append(.redactionJoins(EditOp.RedactionJoins(snapMs: (new.redactionJoins ?? .init()).snapMs)))
        }
        // Round 4 fx-render: the transitions at cuts, the 3D tilt and the fields of each lens that stays.
        if old.transitions != new.transitions { ops += transitions(old.transitions, new.transitions) }
        if old.tilt != new.tilt { ops.append(.tilt(tilt(new.tilt))) }
        for (a, b) in zip(old.lens?.items ?? [], new.lens?.items ?? []) where a != b { ops += lens(a, b) }
        return ops
    }

    static func seconds(_ us: Int64) -> Double { Double(us) / 1_000_000 }

    private static func cameraOp(_ op: EditOp.Camera, in project: EditProject) -> EditOp {
        // A size drag in the layer stack speaks canvas width, even for a small bubble on an ultrawide canvas.
        guard project.layers != nil, let size = op.size, op == EditOp.Camera(size: size) else { return .camera(op) }
        let source = project.source
        let canvas = project.frame?.aspect?.ratio.map { CGSize(width: $0, height: 1) }
            ?? CGSize(width: source.width > 0 ? source.width : 16, height: source.height > 0 ? source.height : 9)
        let width = EditProject.layerWidth(forCameraSize: size, canvas: canvas)
        guard width > 0, width <= 1 else { return .camera(op) }
        return .layer(.init(id: EditProject.cameraLayerID, width: width))
    }

    /// When the first lane edit materializes the list, its files and track indices tell us what the old list was
    /// derived from. Its saved mute, name and volume belong only to the new revision.
    private static func comparableAudioLanes(_ project: EditProject, counterpart: EditProject) -> [EditProject.AudioLane] {
        if let lanes = project.audio.lanes { return lanes }
        return (counterpart.audio.lanes ?? []).map { saved in
            var base = saved
            base.volume = 1
            base.name = nil
            switch base.source {
            case .music: base.muted = false
            case .voiceover:
                base.muted = false
                base.name = EditProject.voiceover(forLaneID: base.id, in: project.audio.voiceovers ?? [])
                    .flatMap(EditProject.voiceoverLaneName)
            case .mic, .system, .movie:
                base.muted = project.audio.mutedTracks.contains(base.track ?? 0)
            }
            return base
        }
    }

    private static func audioLaneOps(from old: EditProject, to new: EditProject) -> [EditOp]? {
        let before = comparableAudioLanes(old, counterpart: new)
        guard let after = new.audio.lanes, before.map(\.id) == after.map(\.id) else { return nil }
        var result: [EditOp] = []
        for (a, b) in zip(before, after) where a != b {
            var expected = a
            expected.muted = b.muted
            expected.volume = b.volume
            expected.name = b.name
            guard expected == b else { return nil }
            result.append(.audioLane(.init(id: b.id, muted: a.muted == b.muted ? nil : b.muted,
                                           volume: a.volume == b.volume ? nil : b.volume,
                                           name: a.name == b.name ? nil : (b.name ?? ""))))
        }
        return result
    }

    private static func layerOps(from old: EditProject, to new: EditProject) -> [EditOp]? {
        let before = old.layers?.media ?? [], after = new.layers?.media ?? []
        // Only the service can issue a new id. Send layerAdd directly, then select its returned layer.
        let oldIDs = Set(before.map(\.id)), newIDs = Set(after.map(\.id))
        guard newIDs.isSubset(of: oldIDs) else { return nil }
        var result: [EditOp] = before.filter { !newIDs.contains($0.id) }.map { .layerRemove(.init(id: $0.id)) }
        for (a, b) in pairs(before, after, \.id) where a != b {
            guard a.file == b.file, a.kind == b.kind else { return nil }
            var op = EditOp.Layer(id: b.id)
            if a.x != b.x { op.x = b.x }
            if a.y != b.y { op.y = b.y }
            if a.width != b.width { op.width = b.width }
            if a.opacity != b.opacity { op.opacity = b.opacity }
            if a.shape != b.shape { op.shape = .some(b.shape) }
            if a.hidden != b.hidden { op.hidden = b.hidden }
            if a.name != b.name { op.name = b.name ?? "" }
            if a.startUs != b.startUs { op.startUs = b.startUs }
            if a.endUs != b.endUs { op.endUs = b.endUs }
            if a.videoStartMs != b.videoStartMs { op.videoStartMs = b.videoStartMs }
            if a.videoSound != b.videoSound { op.videoSound = b.videoSound }
            if a.loop != b.loop { op.loop = b.loop }
            result.append(.layer(op))
        }
        result += reorderedLayers(from: old, to: new).map(EditOp.layerMove)
        return result
    }

    /// Compare only surviving ids: adding or removing a layer never moves its neighbours. Emit moves using the
    /// current positions after each preceding move, so the op list can be applied in order.
    private static func reorderedLayers(from old: EditProject, to new: EditProject) -> [EditOp.LayerMove] {
        let before = old.layerOrder().map(\.id), after = new.layerOrder().map(\.id)
        let common = Set(before).intersection(after)
        var order = before.filter(common.contains)
        let target = after.filter(common.contains)
        guard let first = order.indices.first(where: { order[$0] != target[$0] }) else { return [] }
        // A drop toward the top shifts several neighbours down. Name the one drop.
        if let to = target.firstIndex(of: order[first]) {
            let id = order.remove(at: first)
            order.insert(id, at: to)
            if order == target { return [.init(id: id, to: .index(to))] }
            order.remove(at: to)
            order.insert(id, at: first)
        }
        var moves: [EditOp.LayerMove] = []
        for (to, id) in target.enumerated() where order[to] != id {
            guard let from = order.firstIndex(of: id) else { continue }
            order.remove(at: from)
            order.insert(id, at: to)
            moves.append(.init(id: id, to: .index(to)))
        }
        return moves
    }

    private struct LaneOrLayerChange {
        let name: String
        let line: String
        let symbol: String
        let layerID: String?
    }

    private static func laneOrLayerChanges(from old: EditProject, to new: EditProject) -> [LaneOrLayerChange] {
        var changes: [LaneOrLayerChange] = []
        func add(_ name: String, _ line: String, _ symbol: String, _ id: String? = nil) {
            changes.append(.init(name: name, line: line, symbol: symbol, layerID: id))
        }
        if old.audio.lanes != new.audio.lanes {
            let before = comparableAudioLanes(old, counterpart: new), after = comparableAudioLanes(new, counterpart: old)
            for (a, b) in pairs(before, after, \.id) where a != b {
                let name = b.displayName
                if a.muted != b.muted {
                    add(b.muted ? "Mute \(name)" : "Unmute \(name)", b.muted ? "Muted \(name)" : "Unmuted \(name)", "speaker.wave.2")
                }
                if a.volume != b.volume {
                    add("Change \(name) Volume", "Changed \(name) volume to \(b.volume.formatted(.percent))", "speaker.wave.2")
                }
                if a.name != b.name { add("Rename \(a.displayName)", "Renamed \(a.displayName) to \(name)", "pencil") }
            }
        }
        guard old.layers != new.layers else { return changes }
        let before = old.layers?.media ?? [], after = new.layers?.media ?? []
        let oldIDs = Set(before.map(\.id)), newIDs = Set(after.map(\.id))
        for layer in after where !oldIDs.contains(layer.id) {
            add("Add \(layer.displayName)", "Added \(layer.displayName)", "square.stack.3d.up", layer.id)
        }
        for layer in before where !newIDs.contains(layer.id) {
            add("Remove \(layer.displayName)", "Removed \(layer.displayName)", "trash", layer.id)
        }
        for (a, b) in pairs(before, after, \.id) where a != b {
            let name = b.displayName
            if a.hidden != b.hidden {
                add(b.hidden ? "Hide \(name)" : "Show \(name)", b.hidden ? "Hid \(name)" : "Showed \(name)", "eye", b.id)
            } else if a.x != b.x || a.y != b.y {
                add("Move \(name)", "Moved \(name)", "arrow.up.and.down.and.arrow.left.and.right", b.id)
            } else {
                add("Change \(name)", "Changed \(name)", "square.stack.3d.up", b.id)
            }
        }
        let stack = new.layerOrder()
        for move in reorderedLayers(from: old, to: new) {
            guard let index = stack.firstIndex(where: { $0.id == move.id }) else { continue }
            let name = stack[index].displayName
            let other = stack[index > 0 ? index - 1 : index + 1].displayName
            // Swapping neighbours gives the same order whichever one was dragged. Report their new relation.
            add("Reorder \(name) and \(other)", "\(name) is now \(index > 0 ? "above" : "below") \(other)", "square.3.layers.3d", move.id)
        }
        return changes
    }

    static func laneOrLayerUndoName(from old: EditProject, to new: EditProject, parts: [String]) -> (name: String, tab: InspectorTab?)? {
        if parts == ["camera"], old.layers == new.layers, var before = old.camera, let after = new.camera,
           before.show != after.show {
            before.show = after.show
            if before == after { return (after.show ? "Show Camera" : "Hide Camera", .style) }
        }
        guard parts.allSatisfy({ $0 == "audio" }), old.audio.lanes != new.audio.lanes || old.layers != new.layers else { return nil }
        var oldAudio = old.audio
        oldAudio.lanes = new.audio.lanes
        guard oldAudio == new.audio else { return nil }
        let changes = laneOrLayerChanges(from: old, to: new)
        guard changes.count == 1, let change = changes.first else { return nil }
        return (change.name, change.layerID == nil ? .audio : nil)
    }

    /// Adds the named changes and returns whether a separate sound change still needs the feed's audio line.
    static func appendLaneAndLayerChanges(from old: EditProject, to new: EditProject, lines: inout [EditChange.Line],
                                          itemIDs: inout [String], touchesPicture: inout Bool) -> Bool {
        guard old.audio.lanes != new.audio.lanes || old.layers != new.layers else { return old.audio != new.audio }
        let changes = laneOrLayerChanges(from: old, to: new)
        for change in changes {
            lines.append(.init(symbol: change.symbol, text: change.line))
            if let id = change.layerID {
                itemIDs.append(id)
                touchesPicture = true
            }
        }
        var oldAudio = old.audio
        if changes.contains(where: { $0.layerID == nil }) { oldAudio.lanes = new.audio.lanes }
        return oldAudio != new.audio
    }

    private static func ids<T: Identifiable>(_ list: [T]?) -> [T.ID] { (list ?? []).map(\.id) }

    /// The two lists hold the same ids, each once, in any order.
    private static func sameItems<T, ID: Hashable>(_ old: [T], _ new: [T], _ id: KeyPath<T, ID>) -> Bool {
        let ids = Set(old.map { $0[keyPath: id] })
        return old.count == new.count && ids.count == old.count && ids == Set(new.map { $0[keyPath: id] })
    }

    /// Each old item with the new item of its id, in the old list's order.
    private static func pairs<T, ID: Hashable>(_ old: [T], _ new: [T], _ id: KeyPath<T, ID>) -> [(T, T)] {
        let byID = Dictionary(new.map { ($0[keyPath: id], $0) }, uniquingKeysWith: { first, _ in first })
        return old.compactMap { item in byID[item[keyPath: id]].map { (item, $0) } }
    }

    /// A move that keeps the length is `at`; a change of either edge sends the edges that changed.
    static func retime(_ id: String, from old: (Int64, Int64), to new: (Int64, Int64)) -> [EditOp] {
        guard old != new else { return [] }
        if new.1 - new.0 == old.1 - old.0 { return [.retime(EditOp.Retime(id: id, at: seconds(new.0)))] }
        return [.retime(EditOp.Retime(id: id, from: old.0 == new.0 ? nil : seconds(new.0), to: old.1 == new.1 ? nil : seconds(new.1)))]
    }

    private static func zoom(_ a: EditProject.Zoom, _ b: EditProject.Zoom) -> [EditOp] {
        var op = EditOp.SetZoom(id: b.id)
        if a.scale != b.scale { op.scale = b.scale }
        if a.mode != b.mode { op.mode = b.mode }
        if a.focusX != b.focusX || a.focusY != b.focusY { op.focus = EditOp.Point(x: b.focusX, y: b.focusY) }
        if a.easeInMs != b.easeInMs { op.easeInMs = b.easeInMs }
        if a.easeOutMs != b.easeOutMs { op.easeOutMs = b.easeOutMs }
        let set: [EditOp] = op == EditOp.SetZoom(id: b.id) ? [] : [.setZoom(op)]
        return set + retime(b.id, from: (a.startUs, a.endUs), to: (b.startUs, b.endUs))
    }

    private static func redaction(_ a: EditProject.Redaction, _ b: EditProject.Redaction) -> [EditOp] {
        var op = EditOp.SetRedaction(id: b.id)
        if (a.x, a.y, a.width, a.height) != (b.x, b.y, b.width, b.height) {
            op.rect = EditOp.Rect(x: b.x, y: b.y, width: b.width, height: b.height)
        }
        if a.style != b.style { op.style = b.style }
        if a.label != b.label { op.label = b.label ?? "" }
        if a.follow != b.follow { op.follow = b.follow ?? false }
        if a.cutout != b.cutout { op.cutout = b.cutout ?? .rounded }
        if a.dim != b.dim { op.dim = b.dim ?? Looks.spotlightDim }
        // R5 5 redaction edges
        if a.fadeMs != b.fadeMs { op.fadeMs = b.fadeMs ?? -1 }
        if a.cell != b.cell { op.cell = b.cell ?? 0 }
        // R8 11
        if a.dimAround != b.dimAround { op.dimAround = b.dimAround ?? 0 }
        // A part with keyframes moves them with its rectangle (RedactionTrack.moved): the window sends the keys it drew.
        if (a.track ?? []) != (b.track ?? []) {
            op.track = (b.track ?? []).map {
                EditOp.Redact.Key(at: Double($0.atUs) / 1_000_000, x: $0.x, y: $0.y, width: $0.width, height: $0.height)
            }
        }
        let set: [EditOp] = op == EditOp.SetRedaction(id: b.id) ? [] : [.setRedaction(op)]
        return set + retime(b.id, from: (a.startUs, a.endUs), to: (b.startUs, b.endUs))
    }

    private static func text(_ a: EditProject.TextNote, _ b: EditProject.TextNote) -> [EditOp] {
        var op = EditOp.SetText(id: b.id)
        if a.text != b.text { op.text = b.text }
        if a.x != b.x { op.x = b.x }
        if a.y != b.y { op.y = b.y }
        if a.size != b.size { op.size = b.size }
        if a.style != b.style { op.style = b.style }
        // R4 6 animated texts: no animation is the fade.
        if a.animate != b.animate { op.animate = EditOp.Animate(kind: b.animate?.kind ?? .fade, ms: b.animate?.ms) }
        // R5 10 multi-line texts: both fields, so a block taken away goes back to the defaults.
        if a.block != b.block { op.block = EditProject.TextBlock(width: b.block?.width ?? 0.8, align: b.block?.align ?? .center) }
        let set: [EditOp] = op == EditOp.SetText(id: b.id) ? [] : [.setText(op)]
        return set + retime(b.id, from: (a.startUs, a.endUs), to: (b.startUs, b.endUs))
    }

    private static func shape(_ a: EditProject.Shape, _ b: EditProject.Shape) -> [EditOp] {
        var op = EditOp.SetShape(id: b.id)
        if a.kind != b.kind { op.kind = b.kind }
        if (a.x1, a.y1) != (b.x1, b.y1) { op.start = EditOp.Point(x: b.x1, y: b.y1) }
        if (a.x2, a.y2) != (b.x2, b.y2) { op.end = EditOp.Point(x: b.x2, y: b.y2) }
        if a.color != b.color { op.color = b.color }
        if a.width != b.width { op.width = b.width }
        if a.appear != b.appear { op.appear = b.appear ?? .draw }
        let set: [EditOp] = op == EditOp.SetShape(id: b.id) ? [] : [.setShape(op)]
        return set + retime(b.id, from: (a.startUs, a.endUs), to: (b.startUs, b.endUs))
    }

    private static func audio(_ a: EditProject.AudioSettings, _ b: EditProject.AudioSettings) -> [EditOp] {
        var ops: [EditOp] = []
        if a.include != b.include { ops.append(.audio(EditOp.Audio(include: b.include))) }
        if a.volume != b.volume { ops.append(.volume(EditOp.Volume(volume: b.volume))) }
        for track in Set(a.mutedTracks).symmetricDifference(b.mutedTracks).sorted() {
            ops.append(.mute(EditOp.Mute(track: track, muted: b.mutedTracks.contains(track))))
        }
        if a.music != b.music {
            if let music = b.music {
                ops.append(.music(EditOp.Music(file: music.file, volume: music.volume, duck: music.duck, fadeMs: music.fadeMs,
                                               startMs: music.startMs ?? 0, loop: music.loop ?? true, enabled: true)))
            } else {
                ops.append(.music(EditOp.Music(enabled: false)))
            }
        }
        // R4 voiceover clips: the window moves a clip or changes its volume; a removed clip is an unvoiceover, so a
        // change that drops one never leaves it in the service's edit (an added one returns nil above).
        if a.voiceovers != b.voiceovers {
            let before = a.voiceovers ?? []
            let kept = Set(ids(b.voiceovers))
            for clip in before where !kept.contains(clip.id) {
                ops.append(.unvoiceover(EditOp.Unvoiceover(id: clip.id)))
            }
            for clip in b.voiceovers ?? [] {
                guard let old = before.first(where: { $0.id == clip.id }), old != clip else { continue }
                var op = EditOp.Voiceover(id: clip.id)
                if old.atUs != clip.atUs { op.at = seconds(clip.atUs) }
                if old.card != clip.card, let card = clip.card { op.card = card }
                if old.file != clip.file { op.file = clip.file }
                if old.volume != clip.volume { op.volume = clip.volume }
                if old.label != clip.label { op.label = clip.label ?? "" }
                ops.append(.voiceover(op))
            }
        }
        // R4 8 music ducking
        if a.ducking != b.ducking {
            if let ducking = b.ducking {
                ops.append(.ducking(EditOp.Ducking(db: ducking.db, fadeMs: ducking.fadeMs, transcript: ducking.transcript,
                                                   voiceovers: ducking.voiceovers, enabled: true)))
            } else {
                ops.append(.ducking(EditOp.Ducking(enabled: false)))
            }
        }
        if a.denoise != b.denoise {
            if let denoise = b.denoise {
                ops.append(.denoise(EditOp.Denoise(enabled: true, method: denoise.method, reductionDb: denoise.reductionDb,
                                                   tracks: denoise.tracks, trackReductionDb: denoise.trackReductionDb ?? [:])))
            } else {
                ops.append(.denoise(EditOp.Denoise(enabled: false)))
            }
        }
        return ops
    }

    private static func export(_ a: EditProject.ExportSettings, _ b: EditProject.ExportSettings) -> EditOp.ExportSettings {
        var op = EditOp.ExportSettings()
        if a.codec != b.codec { op.codec = b.codec }
        if a.maxHeight != b.maxHeight { op.maxHeight = b.maxHeight }
        if a.output != b.output { op.output = b.output }
        if a.format != b.format { op.format = b.format ?? .mp4 }
        if a.subtitles != b.subtitles { op.subtitles = b.subtitles?.rawValue ?? "none" }
        if a.chapters != b.chapters { op.chapters = b.chapters ?? true }
        // R5 3 export size
        if a.size != b.size { op.size = b.size ?? EditProject.OutputSize() }
        return op
    }

    private static func clicks(_ clicks: EditProject.Clicks?) -> EditOp.Clicks {
        guard let clicks else { return EditOp.Clicks(highlight: false) }
        return EditOp.Clicks(highlight: clicks.highlight, color: clicks.color, radius: clicks.radius, durationMs: clicks.durationMs,
                             sound: clicks.sound ?? false)
    }

    private static func frame(_ frame: EditProject.Frame?) -> EditOp.Frame {
        guard let frame else { return EditOp.Frame(enabled: false) }
        let background = EditOp.Frame.Background(kind: frame.background.kind, colors: frame.background.colors,
                                                 image: frame.background.image, blur: frame.background.blur)
        // R5 4 frame layouts: always sent, so a layout taken away goes back to centred at the fitted size.
        let layout = frame.layout ?? .init()
        return EditOp.Frame(enabled: true, aspect: frame.aspect ?? .source, fit: frame.fit ?? .contain, background: background,
                            padding: frame.padding, cornerRadius: frame.cornerRadius, shadow: frame.shadow,
                            layout: EditOp.Frame.Layout(align: layout.align, scale: layout.scale, focus: layout.focus))
    }

    private static func cursor(_ cursor: EditProject.Cursor) -> EditOp.Cursor {
        EditOp.Cursor(show: cursor.show, size: cursor.size, smoothing: cursor.smoothing, hideAfterMs: cursor.hideAfterMs)
    }

    private static func captions(_ captions: EditProject.Captions?) -> EditOp.Captions {
        guard let captions else { return EditOp.Captions(show: false) }
        return EditOp.Captions(show: captions.show, size: captions.size, position: captions.position)
    }

    private static func keys(_ keys: EditProject.Keys?) -> EditOp.Keys {
        guard let keys else { return EditOp.Keys(show: false) }
        return EditOp.Keys(show: keys.show, size: keys.size, position: keys.position, durationMs: keys.durationMs)
    }

    /// The bubble's changed fields; nil when only hidden parts changed (they go by `retime`).
    private static func camera(_ a: EditProject.Camera?, _ b: EditProject.Camera?) -> EditOp.Camera? {
        guard let b else { return EditOp.Camera(enabled: false) }
        guard let a else { return nil }
        var op = EditOp.Camera()
        if a.show != b.show { op.show = b.show }
        if a.corner != b.corner { op.corner = b.corner }
        if a.x != b.x { op.x = b.x }
        if a.y != b.y { op.y = b.y }
        if a.size != b.size { op.size = b.size }
        if a.shape != b.shape { op.shape = b.shape }
        if a.mirror != b.mirror { op.mirror = b.mirror }
        if a.offsetMs != b.offsetMs { op.offsetMs = b.offsetMs }
        return op == EditOp.Camera() ? nil : op
    }

    /// The edit-wide transition when it changed, and one op per join whose own transition changed; a join that lost
    /// its own takes the default back. No settings are a hard cut everywhere, as the service reads them.
    private static func transitions(_ a: EditProject.Transitions?, _ b: EditProject.Transitions?) -> [EditOp] {
        let before = a ?? EditProject.Transitions(), after = b ?? EditProject.Transitions()
        var ops: [EditOp] = []
        if before.default != after.default {
            ops.append(.transition(EditOp.Transition(kind: choice(after.default.kind), ms: after.default.ms)))
        }
        let old = before.joins ?? [:], new = after.joins ?? [:]
        for clip in Set(old.keys).union(new.keys).sorted() where old[clip] != new[clip] {
            if let join = new[clip] {
                ops.append(.transition(EditOp.Transition(kind: choice(join.kind), ms: join.ms, clip: clip)))
            } else {
                ops.append(.transition(EditOp.Transition(kind: .default, clip: clip)))
            }
        }
        return ops
    }

    private static func choice(_ kind: EditProject.TransitionKind) -> EditOp.TransitionChoice {
        switch kind {
        case .none: .none
        case .crossfade: .crossfade
        case .zoom: .zoom
        case .blur: .blur
        }
    }

    /// Every field, so the service's tilt is the window's; nil turns it off.
    private static func tilt(_ tilt: EditProject.Tilt?) -> EditOp.Tilt {
        guard let tilt else { return EditOp.Tilt(enabled: false) }
        return EditOp.Tilt(enabled: true, strength: tilt.strength, drift: tilt.drift, tiltIn: tilt.tiltIn, tiltOut: tilt.tiltOut,
                           inMs: tilt.inMs, outMs: tilt.outMs)
    }

    private static func lens(_ a: EditProject.LensItem, _ b: EditProject.LensItem) -> [EditOp] {
        var op = EditOp.SetLens(id: b.id)
        if a.startUs != b.startUs { op.from = seconds(b.startUs) }
        if a.endUs != b.endUs { op.to = seconds(b.endUs) }
        if a.radius != b.radius { op.radius = b.radius }
        if a.magnification != b.magnification { op.magnification = b.magnification }
        // `at` also stops the lens following the cursor unless `follow` says, so a moved lens sends both.
        if (a.x, a.y) != (b.x, b.y) {
            op.at = EditOp.Point(x: b.x, y: b.y)
            op.follow = b.follow
        }
        if a.follow != b.follow { op.follow = b.follow }
        if a.ring != b.ring { op.ring = b.ring }
        return op == EditOp.SetLens(id: b.id) ? [] : [.setLens(op)]
    }

    private static func fixes(_ a: [String: String], _ b: [String: String]) -> [EditOp] {
        Set(a.keys).union(b.keys).sorted().compactMap { key -> EditOp? in
            guard a[key] != b[key], let ms = Double(key) else { return nil }
            if let text = b[key] { return .fixLine(EditOp.FixLine(from: ms / 1000, text: text)) }
            return .unfixLine(EditOp.UnfixLine(from: ms / 1000))
        }
    }
}
