import SwiftUI

/// One edit that another process (the CLI, the REPL, an agent) wrote to the edit file, said in words: when it came,
/// who wrote it, one line per change, and the items it touched, so the window can show and flash what happened.
struct EditChange: Identifiable, Equatable {
    let id = UUID()
    let at: Date
    let by: String
    let revision: Int
    let lines: [Line]
    /// The zooms, hidden parts, texts and shapes the edit added or changed (flashed on the timeline).
    let itemIDs: [String]
    /// The earliest output time the edit touched, where the playhead goes; nil for a change of the whole movie.
    let startUs: Int64?
    /// The edit changed the whole picture (the frame, the cursor, captions, clicks), so the preview flashes.
    let touchesPicture: Bool
    /// "undo" or "redo" when the change took one back or made it again (the service's `project.changed`); nil for an edit.
    var action: String?

    struct Line: Equatable {
        let symbol: String
        let text: String
    }

    /// Who did what, for the banner's head: "Undo by agent", or the writer alone for an edit.
    var title: String {
        switch action {
        case "undo": "Undo by \(by)"
        case "redo": "Redo by \(by)"
        default: by
        }
    }

    /// The key that takes it back in this window: ⌘Z undoes the step on the service, ⇧⌘Z makes an undone one again.
    var hint: String {
        switch action {
        case "undo": "⇧⌘Z in this window does it again"
        case "redo": "⌘Z in this window undoes it again"
        default: "⌘Z puts it back"
        }
    }
}

/// What changed between two versions of an edit, in words. Pure, so a test can read it without a window.
enum EditDiff {
    nonisolated static func describe(old: EditProject, new: EditProject, by: String, at: Date, action: String? = nil) -> EditChange? {
        guard old != new else { return nil }
        var lines: [EditChange.Line] = []
        var ids: [String] = []
        var starts: [Int64] = []
        var picture = false

        func clock(_ sourceUs: Int64) -> String {
            formatClock(TimelineMap.outputTime(ofSource: sourceUs, in: new) ?? sourceUs, tenths: true)
        }
        func span(_ start: Int64, _ end: Int64) -> String { "\(clock(start)) to \(clock(end))" }

        /// One line per item, or "Added 2 spotlights" for two or more of one kind (an undo brings several back at once).
        func grouped<Item>(_ items: [Item], verb: String, symbol: String, noun: (Item) -> String, one: (Item) -> String) {
            var kinds: [(noun: String, items: [Item])] = []
            for item in items {
                if let at = kinds.firstIndex(where: { $0.noun == noun(item) }) {
                    kinds[at].items.append(item)
                } else {
                    kinds.append((noun(item), [item]))
                }
            }
            for kind in kinds {
                let text = kind.items.count == 1 ? one(kind.items[0]) : "\(verb) \(Plural.count(kind.items.count, kind.noun))"
                lines.append(.init(symbol: symbol, text: text))
            }
        }

        /// Added, removed and changed items of one list, by id.
        func walk<Item: Identifiable & Equatable>(
            _ before: [Item], _ after: [Item], symbol: String,
            name: (Item) -> String, noun: (Item) -> String, times: (Item) -> (Int64, Int64)
        ) where Item.ID == String {
            let previous = Dictionary(before.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            let next = Set(after.map(\.id))
            var added: [Item] = []
            for item in after {
                let (start, end) = times(item)
                guard let was = previous[item.id] else {
                    added.append(item)
                    ids.append(item.id)
                    starts.append(TimelineMap.outputTime(ofSource: start, in: new) ?? start)
                    continue
                }
                guard was != item else { continue }
                let (oldStart, oldEnd) = times(was)
                let verb: String
                if (oldStart, oldEnd) == (start, end) {
                    verb = "Changed \(name(item))"
                } else if oldEnd - oldStart == end - start {
                    verb = "Moved \(name(item)) to \(span(start, end))"
                } else {
                    verb = "Trimmed \(name(item)) to \(span(start, end))"
                }
                lines.append(.init(symbol: symbol, text: verb))
                ids.append(item.id)
                starts.append(TimelineMap.outputTime(ofSource: start, in: new) ?? start)
            }
            grouped(added, verb: "Added", symbol: symbol, noun: noun) { item in
                let (start, end) = times(item)
                return "Added \(name(item)), \(span(start, end))"
            }
            grouped(before.filter { !next.contains($0.id) }, verb: "Removed", symbol: "trash", noun: noun) { "Removed \(name($0))" }
        }

        walk(old.zooms, new.zooms, symbol: "plus.magnifyingglass",
             name: { "a \(String(format: "%.1f", $0.scale))× zoom" }, noun: { _ in "zoom" }, times: { ($0.startUs, $0.endUs) })
        walk(old.redactions ?? [], new.redactions ?? [], symbol: "eye.slash",
             name: { $0.style == .spotlight ? "a spotlight" : "a \($0.style.rawValue) over part of the picture" },
             noun: { $0.style == .spotlight ? "spotlight" : "hidden part" }, times: { ($0.startUs, $0.endUs) })
        walk(old.texts ?? [], new.texts ?? [], symbol: "textformat",
             name: { "the text “\($0.text)”" }, noun: { _ in "text" }, times: { ($0.startUs, $0.endUs) })
        walk(old.shapes ?? [], new.shapes ?? [], symbol: "scribble",
             name: { "a \($0.kind.rawValue)" }, noun: { $0.kind.rawValue }, times: { ($0.startUs, $0.endUs) })

        // A marker is a point: its time, not a span.
        let oldMarkers = old.markers ?? []
        let newMarkers = new.markers ?? []
        let markerIDs = Set(oldMarkers.map(\.id))
        let addedMarkers = newMarkers.filter { !markerIDs.contains($0.id) }
        grouped(addedMarkers, verb: "Added", symbol: "flag", noun: { _ in "marker" }) { "Added the marker “\($0.label)” at \(clock($0.atUs))" }
        starts += addedMarkers.map { TimelineMap.outputTime(ofSource: $0.atUs, in: new) ?? $0.atUs }
        grouped(oldMarkers.filter { marker in !newMarkers.contains { $0.id == marker.id } }, verb: "Removed", symbol: "trash",
                noun: { _ in "marker" }) { "Removed the marker “\($0.label)”" }
        for marker in newMarkers {
            guard let was = oldMarkers.first(where: { $0.id == marker.id }), was != marker else { continue }
            lines.append(.init(symbol: "flag", text: was.atUs == marker.atUs
                ? "Renamed the marker “\(was.label)” to “\(marker.label)”" : "Moved the marker “\(marker.label)” to \(clock(marker.atUs))"))
        }

        if old.clips != new.clips {
            lines.append(.init(symbol: "scissors", text: "Changed the cuts: \(Plural.count(new.clips.count, "clip")), \(formatClock(new.outputDurationUs, tenths: true)) long"))
        }

        /// A setting of the whole movie: turned on, turned off, shown or hidden (its `show`), or changed.
        func setting<Value: Equatable>(_ before: Value?, _ after: Value?, symbol: String, name: String,
                                       shown: ((Value) -> Bool)? = nil, detail: (Value) -> String = { _ in "" }) {
            guard before != after else { return }
            picture = true
            switch (before, after) {
            case (nil, let value?): lines.append(.init(symbol: symbol, text: "Turned \(name) on\(detail(value))"))
            case (_?, nil): lines.append(.init(symbol: symbol, text: "Turned \(name) off"))
            case (let was?, let value?):
                if let shown, shown(was) != shown(value) {
                    lines.append(.init(symbol: symbol, text: "\(shown(value) ? "Showed" : "Hid") \(name)"))
                } else {
                    lines.append(.init(symbol: symbol, text: "Changed \(name)\(detail(value))"))
                }
            default: break
            }
        }

        setting(old.frame, new.frame, symbol: "rectangle.inset.filled", name: "the frame") { frame in
            let aspect = frame.aspect.map { " (\($0.rawValue), \(frame.background.kind.rawValue))" } ?? " (\(frame.background.kind.rawValue))"
            return aspect
        }
        setting(old.captions, new.captions, symbol: "captions.bubble", name: "the captions", shown: { $0.show })
        setting(old.clicks, new.clicks, symbol: "cursorarrow.click", name: "the click rings")
        setting(old.cursor, new.cursor, symbol: "cursorarrow", name: "the cursor", shown: { $0.show }) { cursor in
            " (\(String(format: "%.1f", cursor.size))× size, \(Int((cursor.smoothing * 100).rounded())) % smoothing)"
        }
        setting(old.keys, new.keys, symbol: "command", name: "the shortcut keys", shown: { $0.show })
        setting(old.motion, new.motion, symbol: "wind", name: "the zoom motion")
        setting(old.transcript, new.transcript, symbol: "text.quote", name: "the transcript fixes")
        if old.audio != new.audio {
            lines.append(.init(symbol: "speaker.wave.2", text: "Changed the sound"))
        }
        if old.export != new.export {
            lines.append(.init(symbol: "square.and.arrow.up", text: "Changed the export settings"))
        }
        if lines.isEmpty {
            lines.append(.init(symbol: "pencil", text: "Changed the edit"))
        }
        return EditChange(at: at, by: by, revision: new.revision, lines: lines, itemIDs: ids,
                          startUs: starts.min(), touchesPicture: picture, action: action)
    }
}

extension EditorModel {
    /// On by default: an edit from outside the window shows a banner that says what changed and when.
    static let agentEditBannerKey = "recorder.editor.agentEdits.banner"
    /// How long that banner stays, in seconds (6 by default).
    static let agentEditSecondsKey = "recorder.editor.agentEdits.seconds"
    /// On by default: the items the edit touched flash on the timeline, the preview for a change of the whole movie.
    static let agentEditFlashKey = "recorder.editor.agentEdits.flash"
    /// On by default: the playhead moves to where the edit starts, unless the movie is playing.
    static let agentEditSeekKey = "recorder.editor.agentEdits.seek"
    static let agentEditSecondsChoices: [Double] = [3, 6, 10, 20]

    static func agentEditSetting(_ key: String) -> Bool {
        UserDefaults.standard.object(forKey: key) as? Bool ?? true
    }

    static var agentEditSeconds: Double {
        let value = UserDefaults.standard.double(forKey: agentEditSecondsKey)
        return value > 0 ? value : 6
    }

    /// The flash counter of one item; a segment blinks each time it rises.
    func flashToken(_ id: String) -> Int { flashes[id] ?? 0 }

    /// Shows, flashes and goes to an edit written from outside the window. Returns false when the banner is off, so
    /// the caller says it in the short notice instead.
    func announceExternal(old: EditProject, new: EditProject, action: String? = nil) -> Bool {
        guard let change = EditDiff.describe(old: old, new: new, by: new.updatedBy ?? "another process", at: Date(), action: action) else { return true }
        HubPerf.log("recorder.editor.external rev \(change.revision) by \(change.by): \(change.lines.map(\.text).joined(separator: "; "))")
        if Self.agentEditSetting(Self.agentEditFlashKey) {
            for id in change.itemIDs { flashes[id, default: 0] += 1 }
            if change.touchesPicture || change.itemIDs.isEmpty { previewFlash += 1 }
        }
        if Self.agentEditSetting(Self.agentEditSeekKey), !isPlaying, let start = change.startUs {
            seek(start)
        }
        guard Self.agentEditSetting(Self.agentEditBannerKey) else { return false }
        changes.append(change)
        if changes.count > 3 { changes.removeFirst(changes.count - 3) }
        scheduleBannerRemoval(change.id)
        return true
    }

    /// Takes a banner away after `agentEditSeconds`.
    func scheduleBannerRemoval(_ id: UUID) {
        bannerTimers[id]?.cancel()
        bannerTimers[id] = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(Self.agentEditSeconds))
            guard !Task.isCancelled, let self else { return }
            self.changes.removeAll { $0.id == id }
            self.bannerTimers[id] = nil
        }
    }

    /// The pointer on a banner keeps it; once the pointer leaves, it stays its whole time again.
    func holdBanner(_ id: UUID, hovering: Bool) {
        if hovering {
            bannerTimers.removeValue(forKey: id)?.cancel()
        } else if changes.contains(where: { $0.id == id }) {
            scheduleBannerRemoval(id)
        }
    }
}

/// The banners of the last outside edits, on the preview's top edge: the time, who wrote it, one line per change.
struct ChangeBanners: View {
    @Bindable var model: EditorModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let time: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return formatter
    }()

    var body: some View {
        VStack(alignment: .trailing, spacing: 8) {
            ForEach(model.changes) { change in
                banner(change)
                    .transition(reduceMotion ? .opacity : .move(edge: .top).combined(with: .opacity))
            }
        }
        .padding(12)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.24), value: model.changes)
    }

    private func banner(_ change: EditChange) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "sparkles").foregroundStyle(RecorderPalette.zoom)
                Text(verbatim: "\(Self.time.string(from: change.at)) · \(change.title) · revision \(change.revision)")
                    .font(.system(size: 11, weight: .medium).monospacedDigit())
                    .foregroundStyle(.secondary)
                Spacer(minLength: 8)
                IconButton(systemName: "xmark", tooltip: "Hide this banner", size: 10) {
                    model.changes.removeAll { $0.id == change.id }
                }
            }
            ForEach(Array(change.lines.enumerated()), id: \.offset) { _, line in
                Label {
                    Text(verbatim: line.text).font(.system(size: 13, weight: .semibold))
                } icon: {
                    Image(systemName: line.symbol).frame(width: 16)
                }
                .foregroundStyle(.white)
            }
            Text(verbatim: change.hint).font(.system(size: 10)).foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(width: 360, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(RecorderPalette.panel.opacity(0.96)))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(RecorderPalette.zoom.opacity(0.7), lineWidth: 1))
        .shadow(color: .black.opacity(0.35), radius: 10, y: 4)
        // The pointer on it keeps it up to be read; it goes its whole time after the pointer leaves.
        .onHover { model.holdBanner(change.id, hovering: $0) }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(change.action == nil ? "Edit from \(change.by)" : change.title): \(change.lines.map(\.text).joined(separator: ". "))")
    }
}
