import Foundation

/// The ops that take an edit from `old` to `new` when they differ only in settings and in the fields of items that
/// exist: the window's controls change a copy of the project (a slider sets `frame.padding`, a drag moves a text),
/// and this names that change as ops for the recorder service, which owns every rule (ranges, clamps, defaults).
/// A change it cannot name (clips, an added or deleted item) returns nil: those actions send their own op.
enum EditOpDiff {
    static func ops(from old: EditProject, to new: EditProject) -> [EditOp]? {
        guard old.clips == new.clips, old.markers == new.markers, old.lanes == new.lanes,
              old.zooms.map(\.id) == new.zooms.map(\.id), ids(old.redactions) == ids(new.redactions),
              ids(old.texts) == ids(new.texts), ids(old.shapes) == ids(new.shapes),
              (old.camera?.hidden ?? []).map(\.id) == (new.camera?.hidden ?? []).map(\.id),
              (old.camera == nil) == (new.camera == nil) || new.camera == nil else { return nil }
        var ops: [EditOp] = []
        for (a, b) in zip(old.zooms, new.zooms) where a != b { ops += zoom(a, b) }
        for (a, b) in zip(old.redactions ?? [], new.redactions ?? []) where a != b { ops += redaction(a, b) }
        for (a, b) in zip(old.texts ?? [], new.texts ?? []) where a != b { ops += text(a, b) }
        for (a, b) in zip(old.shapes ?? [], new.shapes ?? []) where a != b { ops += shape(a, b) }
        for (a, b) in zip(old.camera?.hidden ?? [], new.camera?.hidden ?? []) where a != b {
            ops += retime(a.id, from: (a.startUs, a.endUs), to: (b.startUs, b.endUs))
        }
        if old.audio != new.audio { ops += audio(old.audio, new.audio) }
        if old.export != new.export { ops.append(.exportSettings(export(old.export, new.export))) }
        if old.clicks != new.clicks { ops.append(.clicks(clicks(new.clicks))) }
        if old.frame != new.frame { ops.append(.frame(frame(new.frame))) }
        if old.cursor != new.cursor { ops.append(.cursor(cursor(new.cursor ?? EditProject.Cursor()))) }
        if old.captions != new.captions { ops.append(.captions(captions(new.captions))) }
        if old.keys != new.keys { ops.append(.keys(keys(new.keys))) }
        if old.motion != new.motion { ops.append(.motion(EditOp.Motion(blur: (new.motion ?? EditProject.Motion()).blur))) }
        if old.camera != new.camera, let op = camera(old.camera, new.camera) { ops.append(.camera(op)) }
        if old.transcript != new.transcript { ops += fixes(old.transcript?.fixes ?? [:], new.transcript?.fixes ?? [:]) }
        // R4 6 animated captions
        if old.captionsStyle != new.captionsStyle {
            ops.append(.captionsStyle(new.captionsStyle.map { EditOp.CaptionsStyle(kind: $0.kind, color: $0.color, enabled: true) }
                ?? EditOp.CaptionsStyle(enabled: false)))
        }
        // R4 10 progress bar
        if old.progress != new.progress {
            ops.append(.progress(new.progress.map {
                EditOp.ProgressBar(show: $0.show, color: $0.color, height: $0.height, chapters: $0.chapters, chapterMs: $0.chapterMs, enabled: true)
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
        return ops
    }

    static func seconds(_ us: Int64) -> Double { Double(us) / 1_000_000 }

    private static func ids<T: Identifiable>(_ list: [T]?) -> [T.ID] { (list ?? []).map(\.id) }

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
        // R4 voiceover clips: the window moves a clip or changes its volume; adding or removing one sends its own op.
        if a.voiceovers != b.voiceovers {
            let before = a.voiceovers ?? []
            for clip in b.voiceovers ?? [] {
                guard let old = before.first(where: { $0.id == clip.id }), old != clip else { continue }
                var op = EditOp.Voiceover(id: clip.id)
                if old.atUs != clip.atUs { op.at = seconds(clip.atUs) }
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
        return EditOp.Frame(enabled: true, aspect: frame.aspect ?? .source, fit: frame.fit ?? .contain, background: background,
                            padding: frame.padding, cornerRadius: frame.cornerRadius, shadow: frame.shadow)
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

    private static func fixes(_ a: [String: String], _ b: [String: String]) -> [EditOp] {
        Set(a.keys).union(b.keys).sorted().compactMap { key -> EditOp? in
            guard a[key] != b[key], let ms = Double(key) else { return nil }
            if let text = b[key] { return .fixLine(EditOp.FixLine(from: ms / 1000, text: text)) }
            return .unfixLine(EditOp.UnfixLine(from: ms / 1000))
        }
    }
}
