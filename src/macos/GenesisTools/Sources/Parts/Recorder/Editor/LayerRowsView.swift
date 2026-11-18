import AppKit
import CoreTransferable
import SwiftUI
import UniformTypeIdentifiers

struct EditorLayerRow: Identifiable {
    let layer: EditProject.LayerRef
    let stackIndex: Int
    let spans: [Range<Int64>]
    let hidden: Bool
    var id: String { layer.id }
    var name: String { layer.displayName }
    var media: EditProject.MediaLayer? {
        if case let .media(media) = layer { return media }
        return nil
    }
    var icon: String {
        guard let media else { return "video" }
        return media.kind == .image ? "photo" : "film"
    }

    static func rows(in project: EditProject, clips: [TimelineMap.Placed]) -> [Self] {
        return project.layerOrder().enumerated().reversed().map { index, layer in
            let ranges: [Range<Int64>]
            let hidden: Bool
            switch layer {
            case let .media(media):
                ranges = [media.startUs..<media.endUs]
                hidden = media.hidden
            case .camera:
                var visible: [Range<Int64>] = []
                var from: Int64 = 0
                let end = project.source.durationUs
                for gap in (project.camera?.hidden ?? []).sorted(by: { $0.startUs < $1.startUs }) {
                    let start = min(end, gap.startUs)
                    if from < start { visible.append(from..<start) }
                    from = max(from, gap.endUs)
                }
                if from < end { visible.append(from..<end) }
                ranges = visible
                hidden = project.camera?.show == false
            }
            let spans = ranges.flatMap { range in
                TimelineMap.outputSpans(fromUs: range.lowerBound, toUs: range.upperBound, placed: clips)
                    .map { $0.fromUs..<$0.toUs }
            }
            return Self(layer: layer, stackIndex: index, spans: spans, hidden: hidden)
        }
    }
}

enum LayerOrderCommand: String, CaseIterable {
    case front = "Bring to Front", forward = "Bring Forward", backward = "Send Backward", back = "Send to Back"
    var move: EditProject.LayerMove {
        switch self {
        case .front: .top
        case .forward: .up
        case .backward: .down
        case .back: .bottom
        }
    }
}

enum LayerRowDrop: Codable, Transferable {
    case row(window: String, id: String)
    case file(URL)
    static var transferRepresentation: some TransferRepresentation {
        CodableRepresentation(contentType: UTType(exportedAs: "tools.genesis.recorder.layer-row"))
        ProxyRepresentation(importing: { (url: URL) in Self.file(url) })
    }
}

struct LayerRowsView: View {
    let model: EditorModel
    let scale: TimelineScale
    @FocusState private var focus: String?
    @State private var target: String?
    @State private var renaming: EditorLayerRow?
    @State private var name = ""
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        LazyVStack(spacing: 0) {
            ForEach(model.layerRows) { row in
                let id = "recorder.timeline.layer." + row.id
                let selected = model.selection == .layer(row.id)
                HStack(spacing: 6) {
                    Button { model.toggleVisibility(row) } label: {
                        Image(systemName: row.hidden ? "eye.slash" : "eye").frame(width: 26, height: 26)
                    }
                    .buttonStyle(.genHoverPlain())
                    .accessibilityLabel("\(row.hidden ? "Show" : "Hide") \(row.name)")
                    .instantTooltip("\(row.hidden ? "Show" : "Hide") \(row.name) (H)")
                    Label(row.name, systemImage: row.icon).lineLimit(1)
                    Spacer()
                }
                .font(.system(size: 11.5, weight: selected ? .semibold : .regular))
                .padding(.horizontal, 6)
                .padding(.bottom, 4)
                .frame(height: TimelineView.sourceRowHeight)
                .background(alignment: .bottom) {
                    Canvas { context, size in
                        var path = Path()
                        for span in row.spans {
                            path.addRect(CGRect(x: scale.x(span.lowerBound), y: size.height - 4,
                                                width: max(1, scale.width(span.upperBound - span.lowerBound)), height: 3))
                        }
                        context.fill(path, with: .color(.accentColor.opacity(row.hidden ? 0.3 : 0.9)))
                    }
                }
                .background(selected || target == row.id ? Color.accentColor.opacity(0.16) : Color.clear)
                .contentShape(Rectangle())
                .onTapGesture { model.selectLayer(row.id); focus = row.id }
                .focusable()
                .focused($focus, equals: row.id)
                .onKeyPress(phases: .down) { key in handle(key, row: row) }
                .draggable(LayerRowDrop.row(window: model.session.holder, id: row.id))
                .dropDestination(for: LayerRowDrop.self) { items, _ in
                    guard items.count == 1, let item = items.first else { return false }
                    return model.dropLayer(item, on: row)
                } isTargeted: { over in
                    if over { target = row.id } else if target == row.id { target = nil }
                }
                .contextMenu { actions(row) }
                .accessibilityElement(children: .contain)
                .accessibilityLabel(row.name)
                .accessibilityValue(row.hidden ? "hidden" : "visible")
                .accessibilityAddTraits(selected ? .isSelected : [])
                .accessibilityIdentifier(id)
                .accessibilityActions { actions(row) }
                .frameProbe(id)
                .id(row.id)
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: model.layerRowIDs)
        .onChange(of: focus) { _, id in
            if let id {
                model.focusedEditorRow = .init(area: .layers, id: id)
                model.requestedRowFocus = model.focusedEditorRow
                model.selectLayer(id)
            } else if model.focusedEditorRow?.isLayer == true { model.focusedEditorRow = nil }
        }
        .onChange(of: model.requestedRowFocus) { _, next in
            if next?.isLayer == true { focus = next?.id }
        }
        .onDisappear { if model.focusedEditorRow?.isLayer == true { model.focusedEditorRow = nil } }
        .sheet(item: $renaming) { row in
            VStack(alignment: .leading, spacing: 12) {
                Text("Rename Layer").font(.headline)
                TextField("Layer name", text: $name).frame(minWidth: 240)
                HStack {
                    Spacer()
                    Button("Cancel", role: .cancel) { renaming = nil }.keyboardShortcut(.cancelAction)
                    Button("Rename") {
                        model.edit([.layer(.init(id: row.id, name: name))])
                        renaming = nil
                    }.keyboardShortcut(.defaultAction).disabled(name.utf16.count > 40)
                }
            }.padding()
        }
    }

    @ViewBuilder private func actions(_ row: EditorLayerRow) -> some View {
        ForEach(LayerOrderCommand.allCases, id: \.self) { command in
            Button(command.rawValue) { model.moveLayer(row.id, to: command.move) }
                .disabled(command == .front || command == .forward
                          ? row.stackIndex == model.layerRows.count - 1 : row.stackIndex == 0)
        }
        Divider()
        Button(row.hidden ? "Show" : row.media == nil ? "Hide Camera" : "Hide") { model.toggleVisibility(row) }
        if let media = row.media {
            Button("Rename…") { name = row.name; renaming = row }
            Button("Replace File…") { model.chooseLayerFile(replacing: media) }
            Divider()
            Button("Delete", role: .destructive) { model.edit([.layerRemove(.init(id: row.id))]) }
        }
    }

    private func handle(_ key: KeyPress, row: EditorLayerRow) -> KeyPress.Result {
        if key.modifiers.isEmpty, key.characters.lowercased() == "h", EditorMenuTarget.singleKeysOn {
            model.toggleVisibility(row)
            return .handled
        }
        guard key.modifiers == .command || key.modifiers == [.command, .shift] else { return .ignored }
        let shift = key.modifiers.contains(.shift)
        switch key.characters {
        case "[", "{": model.moveLayer(row.id, to: shift ? .bottom : .down)
        case "]", "}": model.moveLayer(row.id, to: shift ? .top : .up)
        default: return .ignored
        }
        return .handled
    }
}

extension EditorModel {
    static let addLayerTitle = "Add Image or Video…"
    nonisolated static let soundLanesShownKey = "recorder.editor.soundLanesShown"
    nonisolated static let layerDropDefaultsKey = "recorder.editor.layerDropDefaults"

    struct DropDefaults {
        var width: Double
        var atPointer: Bool

        init(defaults: UserDefaults = .standard) {
            let saved = defaults.dictionary(forKey: EditorModel.layerDropDefaultsKey)
            width = min(1, max(0.05, saved?["width"] as? Double ?? 0.35))
            atPointer = saved?["at"] as? String == "pointer"
        }

        func save() {
            UserDefaults.standard.set(["width": width, "at": atPointer ? "pointer" : "centre"] as [String: Any],
                                      forKey: EditorModel.layerDropDefaultsKey)
        }
    }

    /// The recorder builds its AppKit menu before hosting the editor. The library can reinstall the bar.
    static func addLayerCommand(to bar: NSMenu?) {
        guard bar?.item(withTitle: "Timeline") != nil, let edit = bar?.item(withTitle: "Edit")?.submenu,
              edit.item(withTitle: addLayerTitle) == nil else { return }
        let command = EditorCommand(title: addLayerTitle, key: "", label: "") { $0.chooseLayerFile() }
        let item = edit.addItem(withTitle: command.title, action: #selector(EditorMenuTarget.run(_:)), keyEquivalent: "")
        item.target = EditorMenuTarget.shared
        item.representedObject = CommandBox(command)
    }

    func chooseLayerFile(replacing media: EditProject.MediaLayer? = nil) {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = media.map { $0.kind == .image ? [UTType.image] : [UTType.movie] } ?? [.image, .movie]
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.prompt = media == nil ? "Add" : "Replace"
        panel.begin { [weak self] response in
            guard response == .OK, let url = panel.url else { return }
            _ = self?.acceptLayerFile(url, replacing: media)
        }
    }

    @discardableResult
    func acceptLayerFile(_ url: URL, pointer: CGPoint? = nil, replacing media: EditProject.MediaLayer? = nil) -> Bool {
        guard url.isFileURL, let type = UTType(filenameExtension: url.pathExtension),
              type.conforms(to: .image) || type.conforms(to: .movie) else {
            show("Choose an image or video file.", error: true)
            return false
        }
        let kind: EditProject.MediaLayer.Kind = type.conforms(to: .image) ? .image : .video
        guard media == nil || media?.kind == kind else {
            show("Choose a replacement of the same media type.", error: true)
            return false
        }
        let start = TimelineMap.sourceTime(atOutput: clock.outUs, in: project)
        guard media != nil || start < project.source.durationUs else {
            show("Move the playhead before the end to add a layer.", error: true)
            return false
        }
        let folder = URL(fileURLWithPath: project.source.video).deletingLastPathComponent()
        let defaults = DropDefaults()
        let position = defaults.atPointer ? pointer : nil
        show("Importing \(url.lastPathComponent)…", error: false)
        Task {
            do {
                let copied = try await Task.detached(priority: .userInitiated) {
                    try Self.copyLayerFile(url, to: folder)
                }.value
                if let media {
                    // One layer op changes only the file, preserving its identity, order, settings and undo.
                    let data = try JSONSerialization.data(withJSONObject: ["op": "layer", "id": media.id,
                                                                           "file": copied.lastPathComponent])
                    applyOps(String(decoding: data, as: UTF8.self)) { result in
                        switch result {
                        case .success: self.show("Replaced \(media.displayName).", error: false)
                        case let .failure(error):
                            self.show("Could not replace \(media.displayName). \(copied.lastPathComponent) is in the recording folder. \(error.reason)",
                                      error: true)
                        }
                    }
                } else {
                    let op = EditOp.LayerAdd(kind: kind, file: copied.lastPathComponent, startUs: start,
                                             x: position?.x ?? 0.5, y: position?.y ?? 0.5, width: defaults.width)
                    edit([.layerAdd(op)], then: { before, after in
                        let oldIDs = Set((before.layers?.media ?? []).map(\.id))
                        if let added = after.layers?.media.first(where: {
                            $0.file == copied.lastPathComponent && !oldIDs.contains($0.id)
                        }) {
                            self.selectLayer(added.id)
                        }
                        self.show("Added \(copied.lastPathComponent).", error: false)
                    }, failed: { reason in
                        self.show("Could not add the layer. \(copied.lastPathComponent) is in the recording folder. \(reason)", error: true)
                    })
                }
            } catch { show("Could not import \(url.lastPathComponent). \(error.localizedDescription)", error: true) }
        }
        return true
    }

    /// copyItem refuses to overwrite. Retry only a name collision, including one with another simultaneous import.
    nonisolated static func copyLayerFile(_ source: URL, to folder: URL) throws -> URL {
        let scoped = source.startAccessingSecurityScopedResource()
        defer { if scoped { source.stopAccessingSecurityScopedResource() } }
        let file = source.resolvingSymlinksInPath()
        guard try file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true else {
            throw CocoaError(.fileReadUnsupportedScheme, userInfo: [NSLocalizedDescriptionKey: "Choose a regular image or video file."])
        }
        let name = source.deletingPathExtension().lastPathComponent
        var suffix = 1
        while true {
            let filename = suffix == 1 ? source.lastPathComponent : "\(name) \(suffix).\(source.pathExtension)"
            let target = folder.appendingPathComponent(filename)
            do {
                try FileManager.default.copyItem(at: file, to: target)
                return target
            } catch let error as CocoaError where error.code == .fileWriteFileExists {
                suffix += 1
            }
        }
    }

    func moveLayer(_ id: String, to move: EditProject.LayerMove) {
        edit([.layerMove(.init(id: id, to: move))])
    }

    func toggleVisibility(_ row: EditorLayerRow) {
        edit([.layer(.init(id: row.id, hidden: !row.hidden))])
    }

    func dropLayer(_ item: LayerRowDrop, on target: EditorLayerRow) -> Bool {
        switch item {
        case let .row(window, id):
            guard window == session.holder, layersByID[id] != nil, id != target.id,
                  let current = layersByID[target.id] else { return false }
            moveLayer(id, to: .index(current.stackIndex))
            return true
        case let .file(url): return acceptLayerFile(url)
        }
    }
}
