import Foundation

/// What an effect lane can hold. Every item over the picture for a time is one of these; a clip played at another
/// speed shows as a `speed` item on a lane that holds speed. A new kind is a case here and a row in each `switch` of
/// this file (the compiler names every one).
enum EffectKind: String, Codable, CaseIterable, Identifiable {
    case zoom, hide, spotlight, text, shape, speed, cameraHide
    var id: String { rawValue }

    var title: String {
        switch self {
        case .zoom: "Zoom"
        case .hide: "Hidden Part"
        case .spotlight: "Spotlight"
        case .text: "Text"
        case .shape: "Arrow or Box"
        case .speed: "Speed"
        case .cameraHide: "Camera Hidden"
        }
    }

    var symbol: String {
        switch self {
        case .zoom: "plus.magnifyingglass"
        case .hide: "eye.slash"
        case .spotlight: "light.max"
        case .text: "textformat"
        case .shape: "arrow.up.right"
        case .speed: "gauge.with.dots.needle.67percent"
        case .cameraHide: "video.slash"
        }
    }

    /// The kinds a lane made for this kind holds as well (a hidden part and a spotlight share a lane by default).
    var family: [EffectKind] {
        switch self {
        case .zoom: [.zoom]
        case .hide, .spotlight: [.hide, .spotlight]
        case .text, .shape: [.text, .shape]
        case .speed: [.speed]
        case .cameraHide: [.cameraHide]
        }
    }
}

/// One lane of the timeline's effects area. `kinds` is what it holds, in the order its right-click menu offers to add
/// them (a click on an empty spot adds the first); nil holds every kind.
struct EffectLane: Codable, Equatable, Identifiable {
    var id: String
    var kinds: [EffectKind]?
    var name: String?

    func holds(_ kind: EffectKind) -> Bool { kinds?.contains(kind) ?? true }

    /// The lane's own name, else what it holds ("Zooms", "Hidden Parts and Spotlights", "Effects").
    var title: String {
        if let name, !name.isEmpty { return name }
        guard let kinds, !kinds.isEmpty else { return "Effects" }
        return EffectLanes.title(of: kinds)
    }
}

/// One item on an effect lane, in SOURCE microseconds like everything in the edit.
struct EffectItem: Equatable, Identifiable {
    let id: String
    let kind: EffectKind
    let startUs: Int64
    let endUs: Int64
    /// What the segment says ("Zoom 150%", "Blur", the text).
    let label: String
    /// The lane the item asked for (`lane` in edit.json); nil goes to the first lane that holds its kind.
    let lane: String?
    /// A zoom's ease in and out, drawn as lighter ramps.
    var easeInMs = 0
    var easeOutMs = 0
}

enum EffectLanes {
    /// The lanes of an edit that never saved its own: the zoom lane. The others appear when they get an item.
    static let defaults = [EffectLane(id: "zooms", kinds: [.zoom])]

    /// A lane on screen: its items and the row of each (overlapping items take a row each).
    struct Resolved: Equatable, Identifiable {
        var lane: EffectLane
        var items: [EffectItem]
        /// Not in edit.json: made because an item had no lane that holds its kind.
        var automatic = false
        var id: String { lane.id }

        var rows: [String: Int] { EffectLanes.rows(items) }
        var rowCount: Int { items.isEmpty ? 1 : (rows.values.max() ?? 0) + 1 }
    }

    static func title(of kinds: [EffectKind]) -> String {
        switch Set(kinds) {
        case [.zoom]: "Zooms"
        case [.hide]: "Hidden Parts"
        case [.spotlight]: "Spotlights"
        case [.hide, .spotlight]: "Hidden Parts and Spotlights"
        case [.text]: "Texts"
        case [.shape]: "Arrows and Boxes"
        case [.text, .shape]: "Texts and Shapes"
        case [.speed]: "Speed"
        case [.cameraHide]: "Camera Bubble"
        default: kinds.map(\.title).joined(separator: ", ")
        }
    }

    /// Every item of the edit as a lane item, in time order.
    static func items(_ project: EditProject) -> [EffectItem] {
        var items: [EffectItem] = project.zooms.map {
            EffectItem(id: $0.id, kind: .zoom, startUs: $0.startUs, endUs: $0.endUs,
                       label: "Zoom \(Int(($0.scale * 100).rounded()))%", lane: $0.lane,
                       easeInMs: $0.easeInMs, easeOutMs: $0.easeOutMs)
        }
        items += (project.redactions ?? []).map {
            EffectItem(id: $0.id, kind: $0.style == .spotlight ? .spotlight : .hide, startUs: $0.startUs, endUs: $0.endUs,
                       label: $0.label ?? ($0.style == .spotlight ? "Spotlight" : $0.style.rawValue.capitalized), lane: $0.lane)
        }
        items += (project.texts ?? []).map {
            EffectItem(id: $0.id, kind: .text, startUs: $0.startUs, endUs: $0.endUs, label: $0.text, lane: $0.lane)
        }
        items += (project.shapes ?? []).map {
            EffectItem(id: $0.id, kind: .shape, startUs: $0.startUs, endUs: $0.endUs, label: $0.kind.rawValue.capitalized, lane: $0.lane)
        }
        items += (project.camera?.hidden ?? []).map {
            EffectItem(id: $0.id, kind: .cameraHide, startUs: $0.startUs, endUs: $0.endUs, label: "Camera hidden", lane: $0.lane)
        }
        items += project.clips.filter { $0.speed != 1 }.map {
            EffectItem(id: $0.id, kind: .speed, startUs: $0.fromUs, endUs: $0.toUs, label: speedLabel($0.speed), lane: nil)
        }
        return items.sorted { ($0.startUs, $0.id) < ($1.startUs, $1.id) }
    }

    /// The lanes in order with their items. An item goes to the lane it names when that lane holds its kind, else to
    /// the first lane that does; with none, a lane for its family is added at the end (a speed item has the clip
    /// lane's badge, so it never makes one).
    static func resolve(_ project: EditProject) -> [Resolved] {
        var resolved = (project.lanes ?? defaults).map { Resolved(lane: $0, items: []) }
        for item in items(project) {
            let index = resolved.firstIndex { $0.lane.id == item.lane && $0.lane.holds(item.kind) }
                ?? resolved.firstIndex { $0.lane.holds(item.kind) }
            if let index {
                resolved[index].items.append(item)
            } else if item.kind != .speed {
                let family = item.kind.family
                resolved.append(Resolved(lane: EffectLane(id: "auto-\(family[0].rawValue)", kinds: family), items: [item], automatic: true))
            }
        }
        return resolved
    }

    /// The edit with its lanes saved as they show (automatic ones included) and every item pinned to the lane it
    /// shows on, so that adding or moving a lane never moves an item that only followed "the first that holds it".
    static func pinned(_ project: EditProject) -> EditProject {
        let resolved = resolve(project)
        var next = project
        next.lanes = resolved.map(\.lane)
        for entry in resolved {
            next = withLane(next, ids: Set(entry.items.filter { $0.kind != .speed }.map(\.id)), lane: entry.lane.id)
        }
        return next
    }

    /// The edit with this lane list; an item whose lane is gone goes back to the first lane that holds its kind.
    static func setLanes(_ project: EditProject, _ lanes: [EffectLane]) -> EditProject {
        let known = Set(lanes.map(\.id))
        var next = project
        next.lanes = lanes
        for index in next.zooms.indices where next.zooms[index].lane.map({ !known.contains($0) }) == true { next.zooms[index].lane = nil }
        next.redactions = next.redactions?.map { var item = $0; if let lane = item.lane, !known.contains(lane) { item.lane = nil }; return item }
        next.texts = next.texts?.map { var item = $0; if let lane = item.lane, !known.contains(lane) { item.lane = nil }; return item }
        next.shapes = next.shapes?.map { var item = $0; if let lane = item.lane, !known.contains(lane) { item.lane = nil }; return item }
        if let hidden = next.camera?.hidden {
            next.camera?.hidden = hidden.map { var item = $0; if let lane = item.lane, !known.contains(lane) { item.lane = nil }; return item }
        }
        return next
    }

    /// `lane` set on the zooms, hidden parts, texts and shapes with these ids.
    static func withLane(_ project: EditProject, ids: Set<String>, lane: String) -> EditProject {
        guard !ids.isEmpty else { return project }
        var next = project
        for index in next.zooms.indices where ids.contains(next.zooms[index].id) { next.zooms[index].lane = lane }
        next.redactions = next.redactions?.map { var item = $0; if ids.contains(item.id) { item.lane = lane }; return item }
        next.texts = next.texts?.map { var item = $0; if ids.contains(item.id) { item.lane = lane }; return item }
        next.shapes = next.shapes?.map { var item = $0; if ids.contains(item.id) { item.lane = lane }; return item }
        if let hidden = next.camera?.hidden {
            next.camera?.hidden = hidden.map { var item = $0; if ids.contains(item.id) { item.lane = lane }; return item }
        }
        return next
    }

    /// A new lane at the bottom; `lane1`, `lane2`… by default.
    static func addLane(_ project: EditProject, kinds: [EffectKind]?, name: String? = nil) -> (EditProject, String) {
        let base = pinned(project)
        let lanes = base.lanes ?? []
        var number = lanes.count + 1
        while lanes.contains(where: { $0.id == "lane\(number)" }) { number += 1 }
        let id = "lane\(number)"
        return (setLanes(base, lanes + [EffectLane(id: id, kinds: kinds, name: name)]), id)
    }

    /// Removes a lane; its items go to the next lane that holds their kind (or a new automatic one).
    static func removeLane(_ project: EditProject, id: String) -> EditProject {
        let base = pinned(project)
        return setLanes(base, (base.lanes ?? []).filter { $0.id != id })
    }

    /// Moves a lane `by` places (negative is up), held inside the list.
    static func moveLane(_ project: EditProject, id: String, by offset: Int) -> EditProject {
        let base = pinned(project)
        var lanes = base.lanes ?? []
        guard let index = lanes.firstIndex(where: { $0.id == id }) else { return project }
        let lane = lanes.remove(at: index)
        lanes.insert(lane, at: min(max(0, index + offset), lanes.count))
        return setLanes(base, lanes)
    }

    static func renameLane(_ project: EditProject, id: String, name: String?) -> EditProject {
        let base = pinned(project)
        var lanes = base.lanes ?? []
        guard let index = lanes.firstIndex(where: { $0.id == id }) else { return project }
        let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        lanes[index].name = trimmed.isEmpty ? nil : String(trimmed.prefix(40))
        return setLanes(base, lanes)
    }

    /// Puts an item on a lane that holds its kind; nil when the lane does not (or the item is a speed).
    static func moveToLane(_ project: EditProject, item id: String, lane laneID: String) -> EditProject? {
        let base = pinned(project)
        guard let lane = base.lanes?.first(where: { $0.id == laneID }),
              let item = items(base).first(where: { $0.id == id }), item.kind != .speed, lane.holds(item.kind) else { return nil }
        return withLane(base, ids: [id], lane: laneID)
    }

    /// The ids of the zooms, hidden parts, texts and shapes in `after` that `before` did not have.
    static func addedIDs(before: EditProject, after: EditProject) -> Set<String> {
        let had = Set(items(before).map(\.id))
        return Set(items(after).filter { $0.kind != .speed && !had.contains($0.id) }.map(\.id))
    }

    /// A row per item: the first row whose last item ended before this one starts.
    static func rows(_ items: [EffectItem]) -> [String: Int] {
        var ends: [Int64] = []
        var rows: [String: Int] = [:]
        for item in items.sorted(by: { ($0.startUs, $0.id) < ($1.startUs, $1.id) }) {
            if let row = ends.firstIndex(where: { $0 <= item.startUs }) {
                ends[row] = item.endUs
                rows[item.id] = row
            } else {
                ends.append(item.endUs)
                rows[item.id] = ends.count - 1
            }
        }
        return rows
    }
}
