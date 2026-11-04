import AVFoundation
import AppKit
import SwiftUI

struct EditorView: View {
    @Bindable var model: EditorModel
    /// A `--snapshot` run draws a still frame instead of the player layer, which an off-screen window never paints.
    var stillPreview: CGImage?

    var body: some View {
        GeometryReader { geometry in
            VStack(spacing: 0) {
                HStack(spacing: 0) {
                    IconRail(model: model)
                    Divider().overlay(RecorderPalette.hairline)
                    InspectorView(model: model)
                        .frame(width: InspectorView.width)
                        .background(RecorderPalette.panel)
                    Divider().overlay(RecorderPalette.hairline)
                    VStack(spacing: 0) {
                        PreviewView(model: model, still: stillPreview)
                            // On the preview's bottom edge: over the transport bar it covered the play buttons.
                            .overlay(alignment: .bottom) {
                                if let notice = model.notice {
                                    NoticePill(text: notice, isError: model.noticeIsError, dismiss: { model.notice = nil })
                                        .padding(.bottom, 12)
                                        .id(notice)
                                }
                            }
                        Divider().overlay(RecorderPalette.hairline)
                        TransportBar(model: model)
                    }
                }
                Divider().overlay(RecorderPalette.hairline)
                TimelineView(model: model, viewportWidth: geometry.size.width)
                    .frame(height: TimelineView.totalHeight)
            }
            .background(RecorderPalette.window)
        }
        .preferredColorScheme(.dark)
    }
}

// MARK: - Rail

private struct IconRail: View {
    @Bindable var model: EditorModel

    var body: some View {
        VStack(spacing: 10) {
            ForEach(InspectorTab.allCases) { tab in
                Button {
                    model.tab = tab
                } label: {
                    Image(systemName: tab.symbol)
                        .font(.system(size: 14, weight: .medium))
                        .frame(width: 34, height: 34)
                        .foregroundStyle(model.tab == tab ? Color.white : RecorderPalette.dim)
                        .background(RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(model.tab == tab ? RecorderPalette.zoom : Color.clear))
                }
                .buttonStyle(.genHoverPlain())
                .instantTooltip(tab.title)
                .accessibilityLabel(tab.title)
                .accessibilityIdentifier("recorder.tab.\(tab.rawValue)")
            }
            Spacer()
        }
        .padding(.top, 12)
        .frame(width: 54)
        .background(RecorderPalette.panel)
    }
}

// MARK: - Inspector

private struct InspectorView: View {
    @Bindable var model: EditorModel
    static let width: CGFloat = 300
    static let padding: CGFloat = 18

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                switch model.tab {
                case .zoom: ZoomInspector(model: model)
                case .clip: ClipInspector(model: model)
                case .style: StyleInspector(model: model)
                case .cursor: CursorInspector(model: model)
                case .captions: CaptionsInspector(model: model)
                case .audio: AudioInspector(model: model)
                case .export: ExportInspector(model: model)
                case .hide: HideInspector(model: model)
                case .text: TextInspector(model: model)
                }
            }
            // A fixed width, so a wide row wraps or truncates instead of moving the column's left edge.
            .frame(width: Self.width - 2 * Self.padding, alignment: .leading)
            .padding(Self.padding)
        }
    }
}

private struct SectionLabel: View {
    let text: String
    var value: String?

    var body: some View {
        HStack {
            Text(text).font(.system(size: 12.5, weight: .medium)).foregroundStyle(RecorderPalette.dim)
            Spacer()
            if let value { Text(verbatim: value).font(.system(size: 12.5, weight: .semibold).monospacedDigit()) }
        }
    }
}

/// A switch at the right edge of the inspector with its label on the left, like the rows of System Settings.
private struct SwitchRow: View {
    let title: String
    @Binding var isOn: Bool

    init(_ title: String, isOn: Binding<Bool>) {
        self.title = title
        _isOn = isOn
    }

    var body: some View {
        Toggle(isOn: $isOn) {
            Text(title).frame(maxWidth: .infinity, alignment: .leading)
        }
        .toggleStyle(.switch)
    }
}

private struct WideButton: View {
    let title: String
    var systemImage: String?
    var role: ButtonRole?
    let action: () -> Void

    var body: some View {
        Button(role: role, action: action) {
            HStack(spacing: 6) {
                if let systemImage { Image(systemName: systemImage) }
                Text(title)
            }
            .font(.system(size: 13, weight: .medium))
            .frame(maxWidth: .infinity, minHeight: 30)
            .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(Color.white.opacity(0.08)))
            .foregroundStyle(role == .destructive ? Color(red: 1, green: 0.45, blue: 0.42) : RecorderPalette.text)
        }
        .buttonStyle(.genHoverPlain())
    }
}

private struct ZoomInspector: View {
    @Bindable var model: EditorModel

    var body: some View {
        if case let .zoom(id) = model.selection, let zoom = model.project.zooms.first(where: { $0.id == id }) {
            let index = (model.project.zooms.firstIndex(where: { $0.id == id }) ?? 0) + 1
            VStack(alignment: .leading, spacing: 3) {
                Text(verbatim: "Zoom \(index) of \(model.project.zooms.count)").font(.system(size: 15, weight: .semibold))
                let range = editRange(model.project, fromUs: zoom.startUs, toUs: zoom.endUs)
                Text(verbatim: [range.edit, range.recording].compactMap { $0 }.joined(separator: " · "))
                    .font(.system(size: 12).monospacedDigit()).foregroundStyle(RecorderPalette.dim)
            }
            VStack(alignment: .leading, spacing: 8) {
                SectionLabel(text: "Zoom level", value: "\(Int((zoom.scale * 100).rounded()))%")
                Slider(value: Binding(get: { zoom.scale }, set: { value in model.updateZoom(id) { $0.scale = (value * 20).rounded() / 20 } }),
                       in: 1.1...4)
                    .accessibilityIdentifier("recorder.zoom.level")
                if model.project.zooms.count > 1 {
                    WideButton(title: "Apply Zoom Level to All") { model.applyScaleToAll(zoom.scale) }
                }
            }
            VStack(alignment: .leading, spacing: 8) {
                SectionLabel(text: "Zoom mode")
                GenSegmentedTabs("Zoom mode", items: [.init(EditProject.ZoomMode.follow, "Follow Cursor"), .init(.manual, "Manual")],
                                 selection: Binding(get: { zoom.mode }, set: { mode in model.updateZoom(id) { $0.mode = mode } }),
                                 minSegmentWidth: 110, identifier: "recorder.zoom.mode")
                if zoom.mode == .follow && model.cursor == nil {
                    Text("This recording has no cursor track, so the zoom holds the focus below.")
                        .font(.system(size: 11.5)).foregroundStyle(RecorderPalette.dim)
                }
                FocusPicker(model: model, zoom: zoom)
            }
            VStack(alignment: .leading, spacing: 8) {
                SectionLabel(text: "Zoom in", value: "\(zoom.easeInMs) ms")
                Slider(value: Binding(get: { Double(zoom.easeInMs) }, set: { value in model.updateZoom(id) { $0.easeInMs = Int((value / 50).rounded()) * 50 } }), in: 0...1500)
                    .accessibilityLabel("Zoom in time")
                SectionLabel(text: "Zoom out", value: "\(zoom.easeOutMs) ms")
                Slider(value: Binding(get: { Double(zoom.easeOutMs) }, set: { value in model.updateZoom(id) { $0.easeOutMs = Int((value / 50).rounded()) * 50 } }), in: 0...1500)
                    .accessibilityLabel("Zoom out time")
            }
            WideButton(title: "Delete Zoom", systemImage: "trash", role: .destructive) { model.deleteSelection() }
        } else {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .firstTextBaseline) {
                    Text("Zoom").font(.system(size: 15, weight: .semibold))
                    if !model.project.zooms.isEmpty {
                        Text(verbatim: Plural.count(model.project.zooms.count, "zoom"))
                            .font(.system(size: 12)).foregroundStyle(RecorderPalette.dim)
                    }
                }
                Text("Click or drag in the zoom lane to add a zoom, or select one to change it. Z adds one at the playhead.")
                    .font(.system(size: 12.5)).foregroundStyle(RecorderPalette.dim)
                    .fixedSize(horizontal: false, vertical: true)
                WideButton(title: "Add Zoom at Playhead", systemImage: "plus.magnifyingglass") { model.addZoom() }
                    .instantTooltip("A 2 s zoom from the playhead (Z)")
                WideButton(title: "Auto Zoom from Clicks", systemImage: "cursorarrow.click.2") { model.autoZoom() }
                    .disabled(model.cursor == nil)
                    .instantTooltip(model.cursor == nil ? "This recording has no cursor track" : "One zoom per group of clicks, following the cursor")
                if model.cursor == nil {
                    Text("Needs a cursor track. A recording made with the recorder has one.")
                        .font(.system(size: 11.5)).foregroundStyle(RecorderPalette.dim)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

/// The frame under the zoom with the zoomed rectangle on it; dragging moves the focus.
private struct FocusPicker: View {
    @Bindable var model: EditorModel
    let zoom: EditProject.Zoom

    var body: some View {
        let aspect = CGFloat(model.project.source.width) / CGFloat(max(1, model.project.source.height))
        GeometryReader { geometry in
            let size = geometry.size
            let side = 1 / zoom.scale
            let rect = CGRect(x: (min(max(zoom.focusX, side / 2), 1 - side / 2) - side / 2) * size.width,
                              y: (min(max(zoom.focusY, side / 2), 1 - side / 2) - side / 2) * size.height,
                              width: side * size.width, height: side * size.height)
            ZStack(alignment: .topLeading) {
                if let tile = model.filmstrip.tile(atSource: zoom.startUs) {
                    Image(decorative: tile.image, scale: 1).resizable().aspectRatio(contentMode: .fill)
                        .frame(width: size.width, height: size.height).clipped()
                } else {
                    Color.black
                }
                Color.black.opacity(0.35)
                RoundedRectangle(cornerRadius: 4).strokeBorder(Color.white, lineWidth: 1.5)
                    .frame(width: rect.width, height: rect.height)
                    .offset(x: rect.minX, y: rect.minY)
                Circle().fill(Color.white).frame(width: 12, height: 12)
                    .offset(x: rect.midX - 6, y: rect.midY - 6)
            }
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0).onChanged { value in
                model.updateZoom(zoom.id) {
                    $0.focusX = Double(value.location.x / size.width)
                    $0.focusY = Double(value.location.y / size.height)
                    if $0.mode == .follow, model.cursor != nil { $0.mode = .manual }
                }
            })
        }
        .aspectRatio(aspect, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .accessibilityLabel("Zoom focus")
        .accessibilityIdentifier("recorder.zoom.focus")
    }
}

private struct ClipInspector: View {
    @Bindable var model: EditorModel
    private let speeds: [Double] = [0.5, 1, 1.5, 2, 4]

    var body: some View {
        let placed = TimelineMap.placed(model.project)
        if case let .clip(id) = model.selection, let current = placed.first(where: { $0.clip.id == id }) {
            let clip = current.clip
            VStack(alignment: .leading, spacing: 8) {
                Text("Clip \(current.index + 1) of \(placed.count)").font(.system(size: 15, weight: .semibold))
                SectionLabel(text: "In the edit", value: "\(formatClock(current.outStartUs, tenths: true)) – \(formatClock(current.outEndUs, tenths: true))")
                SectionLabel(text: "In the recording", value: "\(formatClock(clip.fromUs, tenths: true)) – \(formatClock(clip.toUs, tenths: true))")
                SectionLabel(text: "Plays for", value: formatClock(clip.outputDurationUs, tenths: true))
            }
            VStack(alignment: .leading, spacing: 8) {
                SectionLabel(text: "Speed", value: speedLabel(clip.speed))
                GenSegmentedTabs("Speed", items: speeds.map { .init($0, speedLabel($0)) },
                                 selection: Binding(get: { speeds.contains(clip.speed) ? clip.speed : 1 }, set: { model.setSpeed(id, $0) }),
                                 minSegmentWidth: 44, identifier: "recorder.clip.speed")
            }
            WideButton(title: "Split at Playhead", systemImage: "scissors") { model.splitAtPlayhead() }
                .instantTooltip("Splits the clip under the playhead in two (S)")
            WideButton(title: "Delete Clip", systemImage: "trash", role: .destructive) { model.deleteSelection() }
                .disabled(placed.count < 2)
        } else {
            VStack(alignment: .leading, spacing: 10) {
                Text("Clips").font(.system(size: 15, weight: .semibold))
                Text("S splits the clip at the playhead. Select a clip to change its speed or delete it; drag its edges to trim.")
                    .font(.system(size: 12.5)).foregroundStyle(RecorderPalette.dim)
                    .fixedSize(horizontal: false, vertical: true)
                SectionLabel(text: Plural.count(placed.count, "clip"), value: formatClock(model.durationUs, tenths: true))
                WideButton(title: "Split at Playhead", systemImage: "scissors") { model.splitAtPlayhead() }
                    .instantTooltip("Splits the clip under the playhead in two (S)")
                WideButton(title: model.isRemovingIdle ? "Looking for Still Parts…" : "Remove Still Parts", systemImage: "wand.and.stars") {
                    model.removeIdle()
                }
                .disabled(model.isRemovingIdle)
                .instantTooltip("Cuts every stretch of 2 s or more where the picture does not change and nothing is heard")
                WideButton(title: "Speed Up Still Parts (8×)", systemImage: "forward.fill") { model.removeIdle(speed: 8) }
                    .disabled(model.isRemovingIdle)
                    .instantTooltip("Plays those stretches 8× faster instead of cutting them, so the viewer sees time pass")
                    .accessibilityIdentifier("recorder.clip.speedIdle")
            }
        }
    }
}

private struct StyleInspector: View {
    @Bindable var model: EditorModel

    /// Background presets: two colors are a gradient from the top left, one is a flat color.
    private static let backgrounds: [(name: String, colors: [String])] = [
        ("Indigo", ["#4F46E5", "#DB2777"]),
        ("Ocean", ["#0EA5E9", "#14B8A6"]),
        ("Sunset", ["#F97316", "#E11D48"]),
        ("Forest", ["#16A34A", "#0F766E"]),
        ("Graphite", ["#27272A"]),
        ("Paper", ["#F4F4F5"]),
    ]
    var body: some View {
        let frame = model.project.frame
        VStack(alignment: .leading, spacing: 10) {
            Text("Style").font(.system(size: 15, weight: .semibold))
            SwitchRow("Background", isOn: Binding(get: { frame != nil }, set: { on in
                model.setLooks { $0.frame = on ? ($0.frame ?? EditProject.Frame()) : nil }
            }))
            .accessibilityIdentifier("recorder.style.frame")
            if let frame {
                SectionLabel(text: "Canvas")
                GenSegmentedTabs("Canvas", items: EditProject.CanvasAspect.allCases.map { .init($0, $0 == .source ? "Original" : $0.rawValue) },
                                 selection: Binding(get: { frame.aspect ?? .source }, set: { value in
                                     model.setLooks { $0.frame?.aspect = value == .source ? nil : value }
                                 }),
                                 minSegmentWidth: 40, identifier: "recorder.style.canvas")
                if (frame.aspect ?? .source) != .source {
                    SwitchRow("Crop to fill", isOn: Binding(get: { frame.fit == .cover }, set: { on in
                        model.setLooks { $0.frame?.fit = on ? .cover : nil }
                    }))
                    .instantTooltip("Crops the movie to the canvas's shape; the crop follows the cursor")
                    .accessibilityIdentifier("recorder.style.fill")
                }
                LazyVGrid(columns: Array(repeating: GridItem(.fixed(38), spacing: 8), count: 6), spacing: 8) {
                    ForEach(Self.backgrounds, id: \.name) { preset in
                        let selected = frame.background.kind != .image && frame.background.colors == preset.colors
                        Button {
                            model.setLooks {
                                $0.frame?.background = EditProject.Background(kind: preset.colors.count > 1 ? .gradient : .color,
                                                                              colors: preset.colors)
                            }
                        } label: {
                            RoundedRectangle(cornerRadius: 7, style: .continuous)
                                .fill(LinearGradient(colors: preset.colors.map(swiftColor), startPoint: .topLeading, endPoint: .bottomTrailing))
                                .frame(width: 38, height: 26)
                                .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous)
                                    .strokeBorder(Color.white.opacity(selected ? 0.95 : 0.15), lineWidth: selected ? 2 : 1))
                        }
                        .buttonStyle(.genHoverPlain())
                        .instantTooltip(preset.name)
                        .accessibilityLabel("\(preset.name) background")
                    }
                }
                HStack(spacing: 8) {
                    GhostButton("Desktop Picture", symbol: "photo", tooltip: "The picture of the main display's desktop",
                                identifier: "recorder.style.desktopPicture") { model.useDesktopPicture() }
                    GhostButton("Choose Image…", symbol: "folder", tooltip: "A picture file for the frame's background",
                                identifier: "recorder.style.chooseImage") { model.chooseBackgroundImage() }
                }
                if frame.background.kind == .image {
                    if let image = frame.background.image {
                        PathLabel(path: image)
                    }
                    SectionLabel(text: "Picture blur", value: "\(Int(((frame.background.blur ?? 0) * 100).rounded()))%")
                    Slider(value: Binding(get: { frame.background.blur ?? 0 }, set: { value in
                        model.setLooks { $0.frame?.background.blur = (value * 20).rounded() / 20 }
                    }), in: 0...1)
                        .accessibilityIdentifier("recorder.style.pictureBlur")
                }
                SectionLabel(text: "Padding", value: "\(Int((frame.padding * 100).rounded()))%")
                Slider(value: Binding(get: { frame.padding }, set: { value in model.setLooks { $0.frame?.padding = (value * 200).rounded() / 200 } }),
                       in: 0...0.2)
                    .accessibilityIdentifier("recorder.style.padding")
                SectionLabel(text: "Corners", value: String(format: "%.1f%%", frame.cornerRadius * 100))
                Slider(value: Binding(get: { frame.cornerRadius }, set: { value in model.setLooks { $0.frame?.cornerRadius = (value * 1000).rounded() / 1000 } }),
                       in: 0...0.05)
                    .accessibilityIdentifier("recorder.style.corners")
                SwitchRow("Shadow", isOn: Binding(get: { frame.shadow }, set: { on in model.setLooks { $0.frame?.shadow = on } }))
            }
        }
    }
}

private struct CursorInspector: View {
    @Bindable var model: EditorModel
    private static let clickColors = ["#FFD60A", "#FF453A", "#0A84FF", "#FFFFFF"]

    var body: some View {
        let clicks = model.project.clicks
        Text("Cursor and Clicks").font(.system(size: 15, weight: .semibold))
        VStack(alignment: .leading, spacing: 10) {
            SwitchRow("Highlight clicks", isOn: Binding(get: { clicks?.highlight == true }, set: { on in
                model.setLooks { project in
                    var next = project.clicks ?? EditProject.Clicks()
                    next.highlight = on
                    project.clicks = next
                }
            }))
            .accessibilityIdentifier("recorder.style.clicks")
            if model.cursor == nil {
                Text("This recording has no cursor track, so there are no clicks to draw.")
                    .font(.system(size: 11.5)).foregroundStyle(RecorderPalette.dim)
                    .fixedSize(horizontal: false, vertical: true)
            } else if let clicks, clicks.highlight {
                HStack(spacing: 8) {
                    ForEach(Self.clickColors, id: \.self) { hex in
                        Button {
                            model.setLooks { $0.clicks?.color = hex }
                        } label: {
                            Circle().fill(swiftColor(hex)).frame(width: 20, height: 20)
                                .overlay(Circle().strokeBorder(Color.white.opacity(clicks.color == hex ? 0.95 : 0.2), lineWidth: clicks.color == hex ? 2 : 1))
                        }
                        .buttonStyle(.genHoverPlain())
                        .accessibilityLabel("Click color \(hex)")
                    }
                }
                SectionLabel(text: "Size", value: String(format: "%.1f%%", clicks.radius * 100))
                Slider(value: Binding(get: { clicks.radius }, set: { value in model.setLooks { $0.clicks?.radius = (value * 1000).rounded() / 1000 } }),
                       in: 0.01...0.1)
                    .accessibilityIdentifier("recorder.style.clickSize")
            }
        }
        VStack(alignment: .leading, spacing: 10) {
            let cursor = model.project.cursor ?? EditProject.Cursor()
            if model.cursor?.drawsCursor == true {
                SwitchRow("Show cursor", isOn: Binding(get: { cursor.show }, set: { on in
                    model.setCursor { $0.show = on }
                }))
                .accessibilityIdentifier("recorder.style.cursor")
                if cursor.show {
                    SectionLabel(text: "Cursor size", value: String(format: "%.1f×", cursor.size))
                    Slider(value: Binding(get: { cursor.size }, set: { value in
                        model.setCursor { $0.size = (value * 10).rounded() / 10 }
                    }), in: 0.5...3)
                        .accessibilityIdentifier("recorder.style.cursorSize")
                    SectionLabel(text: "Smoothing", value: "\(Int((cursor.smoothing * 100).rounded()))%")
                    Slider(value: Binding(get: { cursor.smoothing }, set: { value in
                        model.setCursor { $0.smoothing = (value * 20).rounded() / 20 }
                    }), in: 0...1)
                        .accessibilityIdentifier("recorder.style.cursorSmoothing")
                    SwitchRow("Hide when still", isOn: Binding(get: { (cursor.hideAfterMs ?? 0) > 0 }, set: { on in
                        model.setCursor { $0.hideAfterMs = on ? 1500 : 0 }
                    }))
                    .accessibilityIdentifier("recorder.style.cursorHide")
                    if let hide = cursor.hideAfterMs, hide > 0 {
                        SectionLabel(text: "Hide after", value: String(format: "%.1f s", Double(hide) / 1000))
                        Slider(value: Binding(get: { Double(hide) }, set: { value in
                            model.setCursor { $0.hideAfterMs = Int((value / 250).rounded() * 250) }
                        }), in: 500...5000)
                            .accessibilityIdentifier("recorder.style.cursorHideAfter")
                    }
                }
            } else if model.cursor != nil {
                Text("This recording has the system cursor in its picture. Record without --system-cursor to draw a smoothed cursor of any size.")
                    .font(.system(size: 11.5)).foregroundStyle(RecorderPalette.dim)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

private struct CaptionsInspector: View {
    @Bindable var model: EditorModel

    var body: some View {
        Text("Captions and Shortcuts").font(.system(size: 15, weight: .semibold))
        if let track = model.cursor, !track.keys.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                let keys = model.project.keys
                SwitchRow("Show shortcuts", isOn: Binding(get: { keys?.show == true }, set: { on in
                    model.setLooks { project in
                        var next = project.keys ?? EditProject.Keys()
                        next.show = on
                        project.keys = next
                    }
                }))
                .instantTooltip("Draws the ⌘ and ⌃ shortcuts pressed while recording (\(Plural.count(track.keys.count, "press")))")
                .accessibilityIdentifier("recorder.style.keys")
                if let keys, keys.show {
                    GenSegmentedTabs("Shortcuts position", items: EditProject.CaptionPosition.allCases.map { .init($0, $0.rawValue.capitalized) },
                                     selection: Binding(get: { keys.position }, set: { value in model.setLooks { $0.keys?.position = value } }),
                                     minSegmentWidth: 60, identifier: "recorder.style.keysPosition")
                    SectionLabel(text: "Shortcut size", value: String(format: "%.1f%%", keys.size * 100))
                    Slider(value: Binding(get: { keys.size }, set: { value in model.setLooks { $0.keys?.size = (value * 1000).rounded() / 1000 } }),
                           in: 0.03...0.1)
                        .accessibilityIdentifier("recorder.style.keysSize")
                }
            }
        }
        VStack(alignment: .leading, spacing: 10) {
            let captions = model.project.captions
            if model.hasTranscript {
                SwitchRow("Captions", isOn: Binding(get: { captions?.show == true }, set: { on in
                    model.setLooks { project in
                        var next = project.captions ?? EditProject.Captions()
                        next.show = on
                        project.captions = next
                    }
                }))
                .accessibilityIdentifier("recorder.style.captions")
                if let captions, captions.show {
                    GenSegmentedTabs("Captions position", items: EditProject.CaptionPosition.allCases.map { .init($0, $0.rawValue.capitalized) },
                                     selection: Binding(get: { captions.position }, set: { value in model.setLooks { $0.captions?.position = value } }),
                                     minSegmentWidth: 60, identifier: "recorder.style.captionsPosition")
                    SectionLabel(text: "Text size", value: String(format: "%.1f%%", captions.size * 100))
                    Slider(value: Binding(get: { captions.size }, set: { value in model.setLooks { $0.captions?.size = (value * 1000).rounded() / 1000 } }),
                           in: 0.025...0.08)
                        .accessibilityIdentifier("recorder.style.captionsSize")
                }
            } else {
                HStack {
                    Text("Captions").font(.system(size: 13))
                    Spacer()
                    Button(model.isTranscribing ? "Transcribing…" : "Transcribe") { model.transcribe() }
                        .buttonStyle(.genHoverPlain())
                        .disabled(model.isTranscribing)
                        .instantTooltip("Runs tools transcribe once; the spoken lines become captions that follow every cut")
                        .accessibilityIdentifier("recorder.style.transcribe")
                }
            }
        }
    }

}

private func swiftColor(_ hex: String) -> Color {
    let color = Looks.color(hex)
    return Color(red: color.red, green: color.green, blue: color.blue)
}

/// Lines of text over the picture: a list, and for the selected one its words, place, size, style and length.
private struct TextInspector: View {
    @Bindable var model: EditorModel
    private static let places: [(name: String, x: Double, y: Double)] = [
        ("Top left", 0.2, 0.12), ("Top", 0.5, 0.12), ("Top right", 0.8, 0.12),
        ("Left", 0.2, 0.5), ("Middle", 0.5, 0.5), ("Right", 0.8, 0.5),
        ("Bottom left", 0.2, 0.88), ("Bottom", 0.5, 0.88), ("Bottom right", 0.8, 0.88),
    ]

    var body: some View {
        let list = model.project.texts ?? []
        VStack(alignment: .leading, spacing: 10) {
            Text("Text").font(.system(size: 15, weight: .semibold))
            Text("A title or a step's name over the picture for a time. It stays in place through a zoom and fades in and out.")
                .font(.system(size: 12.5)).foregroundStyle(RecorderPalette.dim)
                .fixedSize(horizontal: false, vertical: true)
            WideButton(title: "Add Text at Playhead", systemImage: "textformat") { model.addText() }
                .instantTooltip("A 3 s text at the top middle, from the playhead")
                .accessibilityIdentifier("recorder.text.add")
            ForEach(list) { note in
                let selected = model.selectedText == note.id
                HStack(spacing: 4) {
                    Button {
                        model.selectedText = selected ? nil : note.id
                        if !selected, let at = TimelineMap.outputTime(ofSource: note.startUs, in: model.project) { model.seek(at) }
                    } label: {
                        HStack(spacing: 8) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(verbatim: note.text).font(.system(size: 12.5, weight: .medium)).lineLimit(1).truncationMode(.tail)
                                Text(verbatim: editRange(model.project, fromUs: note.startUs, toUs: note.endUs).edit)
                                    .font(.system(size: 11.5).monospacedDigit()).foregroundStyle(RecorderPalette.dim)
                            }
                            Spacer(minLength: 4)
                            Image(systemName: selected ? "chevron.down" : "chevron.right").font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(RecorderPalette.dim)
                        }
                        .padding(.horizontal, 8).padding(.vertical, 6)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.genHoverRow())
                    .accessibilityLabel("Text \(note.text), \(editRange(model.project, fromUs: note.startUs, toUs: note.endUs).edit)")
                    IconButton(systemName: "trash", tooltip: "Delete this text", size: 12) { model.deleteText(note.id) }
                }
                if selected { editor(note) }
            }
        }
    }

    private func editor(_ note: EditProject.TextNote) -> some View {
        let id = note.id
        return VStack(alignment: .leading, spacing: 8) {
            TextField("Text", text: Binding(get: { note.text }, set: { value in
                let words = String(value.prefix(200))
                if !words.trimmingCharacters(in: .whitespaces).isEmpty { model.updateText(id) { $0.text = words } }
            }), axis: .vertical)
            .lineLimit(1...3)
            .textFieldStyle(.roundedBorder)
            .accessibilityIdentifier("recorder.text.words")
            SectionLabel(text: "Place")
            LazyVGrid(columns: Array(repeating: GridItem(.fixed(30), spacing: 6), count: 3), spacing: 6) {
                ForEach(Self.places, id: \.name) { place in
                    let here = abs(note.x - place.x) < 0.01 && abs(note.y - place.y) < 0.01
                    Button { model.updateText(id) { $0.x = place.x; $0.y = place.y } } label: {
                        RoundedRectangle(cornerRadius: 5, style: .continuous)
                            .fill(here ? RecorderPalette.zoom : Color.white.opacity(0.08))
                            .frame(width: 30, height: 20)
                    }
                    .buttonStyle(.genHoverPlain())
                    .instantTooltip(place.name)
                    .accessibilityLabel("Place \(place.name)")
                }
            }
            GenSegmentedTabs("Style", items: [.init(EditProject.TextStyle.plate, "On a plate"), .init(.plain, "Plain")],
                             selection: Binding(get: { note.style }, set: { value in model.updateText(id) { $0.style = value } }),
                             minSegmentWidth: 90, identifier: "recorder.text.style")
            SectionLabel(text: "Size", value: String(format: "%.1f%%", note.size * 100))
            Slider(value: Binding(get: { note.size }, set: { value in model.updateText(id) { $0.size = (value * 1000).rounded() / 1000 } }), in: 0.02...0.15)
                .accessibilityIdentifier("recorder.text.size")
            SectionLabel(text: "Lasts", value: String(format: "%.1f s", Double(note.endUs - note.startUs) / 1_000_000))
            Slider(value: Binding(get: { Double(note.endUs - note.startUs) / 1_000_000 }, set: { value in
                model.updateText(id) { $0.endUs = $0.startUs + Int64((value * 10).rounded() * 100_000) }
            }), in: 0.2...max(0.3, Double(model.project.source.durationUs - note.startUs) / 1_000_000))
            WideButton(title: "Delete", systemImage: "trash", role: .destructive) { model.deleteText(id) }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.white.opacity(0.05)))
    }
}

/// The parts of the picture to hide: a list, and for the selected one a frame to drag it on, its size, style and time.
private struct HideInspector: View {
    @Bindable var model: EditorModel

    var body: some View {
        let list = model.project.redactions ?? []
        VStack(alignment: .leading, spacing: 10) {
            Text("Hide Parts").font(.system(size: 15, weight: .semibold))
            Text("Blur, pixelate or black out a part of the picture for a time: an address, a token, a notification. It moves with a zoom.")
                .font(.system(size: 12.5)).foregroundStyle(RecorderPalette.dim)
                .fixedSize(horizontal: false, vertical: true)
            WideButton(title: "Hide a Part at the Playhead", systemImage: "eye.slash") { model.addRedaction() }
                .instantTooltip("A 3 s hidden part in the middle of the picture; or drag on the preview to draw one")
                .accessibilityIdentifier("recorder.hide.add")
            ForEach(list) { redaction in
                let selected = model.selectedRedaction == redaction.id
                HStack(spacing: 4) {
                    Button {
                        model.selectedRedaction = selected ? nil : redaction.id
                        if !selected, let at = TimelineMap.outputTime(ofSource: redaction.startUs, in: model.project) { model.seek(at) }
                    } label: {
                        HStack(spacing: 8) {
                            RedactionThumb(model: model, redaction: redaction)
                            let range = editRange(model.project, fromUs: redaction.startUs, toUs: redaction.endUs)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(verbatim: redaction.label ?? redaction.style.rawValue.capitalized)
                                    .font(.system(size: 12.5, weight: .medium)).lineLimit(1).truncationMode(.tail)
                                Text(verbatim: [range.edit, redaction.label == nil ? nil : redaction.style.rawValue.capitalized, range.recording]
                                    .compactMap { $0 }.joined(separator: " · "))
                                    .font(.system(size: 11.5).monospacedDigit()).foregroundStyle(RecorderPalette.dim)
                                    .lineLimit(1).truncationMode(.tail)
                            }
                            Spacer(minLength: 4)
                            Image(systemName: selected ? "chevron.down" : "chevron.right").font(.system(size: 10, weight: .semibold))
                                .foregroundStyle(RecorderPalette.dim)
                        }
                        .padding(.horizontal, 8).padding(.vertical, 6)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.genHoverRow())
                    .accessibilityLabel("Hidden part, \(editRange(model.project, fromUs: redaction.startUs, toUs: redaction.endUs).edit), \(redaction.style.rawValue)")
                    IconButton(systemName: "trash", tooltip: "Delete this hidden part", size: 12) { model.deleteRedaction(redaction.id) }
                }
                if selected { RedactionEditor(model: model, redaction: redaction) }
            }
        }
    }
}

private struct RedactionEditor: View {
    @Bindable var model: EditorModel
    let redaction: EditProject.Redaction

    var body: some View {
        let id = redaction.id
        VStack(alignment: .leading, spacing: 8) {
            TextField("Name (what it hides)", text: Binding(get: { redaction.label ?? "" }, set: { value in
                let name = String(value.prefix(60))
                model.updateRedaction(id) { $0.label = name.trimmingCharacters(in: .whitespaces).isEmpty ? nil : name }
            }))
            .textFieldStyle(.roundedBorder)
            .accessibilityIdentifier("recorder.hide.name")
            RedactionPicker(model: model, redaction: redaction)
            GenSegmentedTabs("Style", items: EditProject.RedactionStyle.allCases.map { .init($0, $0.rawValue.capitalized) },
                             selection: Binding(get: { redaction.style }, set: { value in model.updateRedaction(id) { $0.style = value } }),
                             minSegmentWidth: 70, identifier: "recorder.hide.style")
            SectionLabel(text: "Width", value: "\(Int((redaction.width * 100).rounded()))%")
            Slider(value: Binding(get: { redaction.width }, set: { value in model.updateRedaction(id) { $0.width = (value * 200).rounded() / 200 } }), in: 0.02...1)
            SectionLabel(text: "Height", value: "\(Int((redaction.height * 100).rounded()))%")
            Slider(value: Binding(get: { redaction.height }, set: { value in model.updateRedaction(id) { $0.height = (value * 200).rounded() / 200 } }), in: 0.02...1)
            SectionLabel(text: "Lasts", value: String(format: "%.1f s", Double(redaction.endUs - redaction.startUs) / 1_000_000))
            Slider(value: Binding(get: { Double(redaction.endUs - redaction.startUs) / 1_000_000 }, set: { value in
                model.updateRedaction(id) { $0.endUs = $0.startUs + Int64((value * 10).rounded() * 100_000) }
            }), in: 0.2...max(0.3, Double(model.project.source.durationUs - redaction.startUs) / 1_000_000))
            WideButton(title: "Delete", systemImage: "trash", role: .destructive) { model.deleteRedaction(id) }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.white.opacity(0.05)))
    }
}

/// The hidden area of the frame at the redaction's start, as the row's leading picture: which part this row hides.
private struct RedactionThumb: View {
    let model: EditorModel
    let redaction: EditProject.Redaction

    var body: some View {
        Group {
            if let tile = model.filmstrip.tile(atSource: redaction.startUs),
               let crop = tile.image.cropping(to: CGRect(x: redaction.x * Double(tile.image.width), y: redaction.y * Double(tile.image.height),
                                                         width: max(1, redaction.width * Double(tile.image.width)),
                                                         height: max(1, redaction.height * Double(tile.image.height))).integral) {
                Image(decorative: crop, scale: 1).resizable().aspectRatio(contentMode: .fill)
            } else {
                Image(systemName: "eye.slash").font(.system(size: 11)).foregroundStyle(RecorderPalette.dim)
            }
        }
        .frame(width: 44, height: 28)
        .background(Color.black.opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
        .accessibilityHidden(true)
    }
}

/// The source frame at the redaction's start with its rectangle on it; dragging moves the rectangle.
private struct RedactionPicker: View {
    @Bindable var model: EditorModel
    let redaction: EditProject.Redaction
    @State private var grab: CGSize?

    var body: some View {
        let aspect = CGFloat(model.project.source.width) / CGFloat(max(1, model.project.source.height))
        GeometryReader { geometry in
            let size = geometry.size
            let rect = CGRect(x: redaction.x * size.width, y: redaction.y * size.height,
                              width: redaction.width * size.width, height: redaction.height * size.height)
            ZStack(alignment: .topLeading) {
                if let tile = model.filmstrip.tile(atSource: redaction.startUs) {
                    Image(decorative: tile.image, scale: 1).resizable().aspectRatio(contentMode: .fill)
                        .frame(width: size.width, height: size.height).clipped()
                } else {
                    Color.black
                }
                Rectangle().fill(Color.black.opacity(0.45))
                    .frame(width: rect.width, height: rect.height)
                    .overlay(Rectangle().strokeBorder(Color.white, style: StrokeStyle(lineWidth: 1.5, dash: [5, 3])))
                    .offset(x: rect.minX, y: rect.minY)
            }
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0).onChanged { value in
                // The rectangle keeps the offset of the point grabbed; a press outside it centres it there.
                let offset = grab ?? (rect.contains(value.startLocation)
                    ? CGSize(width: value.startLocation.x - rect.minX, height: value.startLocation.y - rect.minY)
                    : CGSize(width: rect.width / 2, height: rect.height / 2))
                grab = offset
                model.updateRedaction(redaction.id) {
                    $0.x = Double((value.location.x - offset.width) / size.width)
                    $0.y = Double((value.location.y - offset.height) / size.height)
                }
            }.onEnded { _ in grab = nil })
        }
        .aspectRatio(aspect, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        .accessibilityLabel("Hidden part position")
        .accessibilityIdentifier("recorder.hide.position")
    }
}

private struct AudioInspector: View {
    @Bindable var model: EditorModel

    var body: some View {
        let audio = model.project.audio
        if model.waveform.loaded && !model.waveform.hasAudio {
            VStack(alignment: .leading, spacing: 10) {
                Text("Audio").font(.system(size: 15, weight: .semibold))
                EmptyState(symbol: "speaker.slash", text: "This recording has no sound",
                           detail: "Record with the microphone or the system audio on to get a sound track.")
            }
        } else {
        VStack(alignment: .leading, spacing: 10) {
            Text("Audio").font(.system(size: 15, weight: .semibold))
            SwitchRow("Include audio", isOn: Binding(get: { audio.include }, set: { value in model.setAudio { $0.include = value } }))
                .accessibilityIdentifier("recorder.audio.include")
            VStack(alignment: .leading, spacing: 8) {
                SectionLabel(text: "Volume", value: "\(Int((audio.volume * 100).rounded()))%")
                Slider(value: Binding(get: { audio.volume }, set: { value in model.setAudio { $0.volume = (value * 20).rounded() / 20 } }), in: 0...2)
                    .accessibilityIdentifier("recorder.audio.volume")
            }
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.white.opacity(0.05)))
            .disabled(!audio.include)
            if model.waveform.hasAudio {
                WideButton(title: model.isNormalizing ? "Measuring the Loudness…" : "Normalize Loudness", systemImage: "waveform.badge.magnifyingglass") {
                    model.normalizeLoudness()
                }
                .disabled(model.isNormalizing)
                .instantTooltip("Sets the volume so the export reaches -16 LUFS, the level of speech on the web")
                .accessibilityIdentifier("recorder.audio.normalize")
            }
        }
        }
    }
}

private struct ExportInspector: View {
    @Bindable var model: EditorModel
    /// Opinionated, so a setting: an export reveals its file in Finder by default (Finder then comes to the front).
    @AppStorage(EditorModel.revealAfterExportKey) private var revealAfterExport = true
    @AppStorage(EditorModel.copyAfterExportKey) private var copyAfterExport = false
    private let heights: [Int] = [0, 2160, 1440, 1080, 720]

    var body: some View {
        let settings = model.project.export
        VStack(alignment: .leading, spacing: 12) {
            Text("Export").font(.system(size: 15, weight: .semibold))
            SectionLabel(text: "Format")
            GenSegmentedTabs("Format", items: EditProject.ExportFormat.allCases.map { .init($0, $0.rawValue.uppercased()) },
                             selection: Binding(get: { settings.format ?? .mp4 }, set: { format in model.setExport { $0.format = format == .mp4 ? nil : format } }),
                             minSegmentWidth: 70, identifier: "recorder.export.format")
            if let format = settings.format, format != .mp4 {
                Text(format == .gif ? "A GIF is 10 fps and at most 960 pixels wide, without sound." : "WebM is VP9 with Opus sound.")
                    .font(.system(size: 11.5)).foregroundStyle(RecorderPalette.dim)
                    .fixedSize(horizontal: false, vertical: true)
            }
            // A GIF has its own size and both converted formats their own codec, so those choices show for MP4 only.
            if (settings.format ?? .mp4) == .mp4 {
                SectionLabel(text: "Codec")
                GenSegmentedTabs("Codec", items: [.init(EditProject.Codec.h264, "H.264"), .init(.hevc, "HEVC")],
                                 selection: Binding(get: { settings.codec }, set: { codec in model.setExport { $0.codec = codec } }),
                                 minSegmentWidth: 110, identifier: "recorder.export.codec")
            }
            if settings.format != .gif {
                SectionLabel(text: "Size")
                // A size at or above the recording's own height is the same as Source, so it is not offered.
                let offered = heights.filter { $0 == 0 || $0 < model.project.source.height || $0 == settings.maxHeight }
                GenSegmentedTabs("Size", items: offered.map { .init($0, $0 == 0 ? "Source" : ($0 == 2160 ? "4K" : "\($0)p")) },
                                 selection: Binding(get: { settings.maxHeight }, set: { value in model.setExport { $0.maxHeight = value } }),
                                 minSegmentWidth: 36, identifier: "recorder.export.size")
            }
            let source = CGSize(width: model.project.source.width, height: model.project.source.height)
            // A screen recording exports at 60 fps; the label uses the same size rule as the export.
            let aspect = model.project.frame?.aspect
            let size = EditRenderer.outputSizes(source: source, maxHeight: settings.maxHeight, aspect: aspect,
                                                h264Fps: settings.codec == .h264 ? 60 : nil).canvas
            let full = EditRenderer.outputSizes(source: source, maxHeight: settings.maxHeight, aspect: aspect).canvas
            let capped = size.height < full.height
            let movie = (settings.format ?? .mp4) == .mp4
            let part = model.exportPart
            let length = part.map { $0.toUs - $0.fromUs } ?? model.durationUs
            HStack {
                SectionLabel(text: "Part", value: part.map { "\(formatClock($0.fromUs, tenths: true)) – \(formatClock($0.toUs, tenths: true))" }
                    ?? "Everything (\(formatClock(model.durationUs, tenths: true)))")
                if part != nil {
                    IconButton(systemName: "xmark.circle.fill", tooltip: "Export the whole edit again", size: 12) { model.clearPart() }
                        .accessibilityIdentifier("recorder.export.clearPart")
                }
            }
            if part == nil {
                HStack(spacing: 8) {
                    WideButton(title: "Set In (I)") { model.markIn() }
                        .accessibilityIdentifier("recorder.export.markIn")
                    WideButton(title: "Set Out (O)") { model.markOut() }
                        .accessibilityIdentifier("recorder.export.markOut")
                }
                Text("A part from In to Out exports alone; the edit stays whole.")
                    .font(.system(size: 11)).foregroundStyle(RecorderPalette.dim)
                    .fixedSize(horizontal: false, vertical: true)
            }
            SectionLabel(text: "Output", value: movie ? "\(Int(size.width)) × \(Int(size.height)) · \(formatClock(length, tenths: true))"
                                                      : formatClock(length, tenths: true))
            if capped && movie {
                Text(verbatim: "H.264 at 60 fps stops at \(Int(size.width)) × \(Int(size.height)). HEVC keeps \(Int(full.width)) × \(Int(full.height)).")
                    .font(.system(size: 11))
                    .foregroundStyle(RecorderPalette.dim)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if movie {
                PathLabel(path: EditExporter.outputURL(for: model.project).path)
            }
            if let progress = model.exportProgress {
                ProgressView(value: progress).progressViewStyle(.linear)
                Text(verbatim: "Exporting… \(Int(progress * 100))%").font(.system(size: 12).monospacedDigit()).foregroundStyle(RecorderPalette.dim)
            } else {
                SwitchRow("Copy to clipboard when done", isOn: $copyAfterExport)
                    .instantTooltip("Puts the exported file on the clipboard, ready to paste into a chat or a mail")
                    .accessibilityIdentifier("recorder.export.copy")
                SwitchRow("Show in Finder when done", isOn: $revealAfterExport)
                    .accessibilityIdentifier("recorder.export.reveal")
                Button((settings.format ?? .mp4) == .mp4 ? "Export Movie" : "Export \(settings.format?.rawValue.uppercased() ?? "")") { model.export() }
                    .buttonStyle(.genPrimary())
                    .keyboardShortcut("e", modifiers: .command)
                    .accessibilityIdentifier("recorder.export.start")
            }
        }
    }
}

// MARK: - Preview and transport

private struct PreviewView: View {
    @Bindable var model: EditorModel
    let still: CGImage?

    var body: some View {
        // The canvas the export draws: the movie's own shape, or the frame's aspect.
        let canvas = EditRenderer.outputSizes(source: CGSize(width: model.project.source.width, height: model.project.source.height),
                                              maxHeight: 0, aspect: model.project.frame?.aspect).canvas
        let aspect = canvas.width / max(1, canvas.height)
        ZStack {
            RecorderPalette.window
            Group {
                if let still {
                    Image(decorative: still, scale: 1).resizable()
                } else {
                    PlayerLayerView(player: model.player)
                }
            }
            .aspectRatio(aspect, contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .onTapGesture { model.togglePlay() }
            .overlay {
                if model.tab == .hide && !model.isPlaying {
                    HiddenPartHandles(model: model, clock: model.clock)
                }
            }
            .shadow(color: .black.opacity(0.5), radius: 18, y: 6)
            .padding(28)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityLabel("Preview")
    }
}

/// The Hide tab on the preview itself: every hidden part showing at the playhead is outlined where it lands (through
/// the zoom and the frame); the selected one has a dashed frame to drag and corner handles to size it. With none
/// selected, a drag on the picture draws a new hidden part from the playhead.
private struct HiddenPartHandles: View {
    @Bindable var model: EditorModel
    let clock: PlayheadClock
    @State private var drawing: CGRect?
    @State private var grabbed: CGRect?

    private enum Grip: CaseIterable { case topLeft, topRight, bottomLeft, bottomRight }

    var body: some View {
        GeometryReader { geometry in
            let size = geometry.size
            let map = model.sourceToCanvas(atOutput: clock.outUs)
            let sourceUs = TimelineMap.sourceTime(atOutput: clock.outUs, in: model.project)
            let showing = (model.project.redactions ?? []).filter { sourceUs >= $0.startUs && sourceUs < $0.endUs }
            let toView = { (rect: CGRect) in CGRect(x: rect.minX * size.width, y: rect.minY * size.height,
                                                    width: rect.width * size.width, height: rect.height * size.height) }
            ZStack(alignment: .topLeading) {
                // The surface that draws a new part; a tap on it still plays and pauses.
                Color.clear.contentShape(Rectangle())
                    .onTapGesture { model.togglePlay() }
                    .gesture(DragGesture(minimumDistance: 6).onChanged { value in
                        drawing = CGRect(x: min(value.startLocation.x, value.location.x), y: min(value.startLocation.y, value.location.y),
                                         width: abs(value.location.x - value.startLocation.x), height: abs(value.location.y - value.startLocation.y))
                    }.onEnded { _ in
                        defer { drawing = nil }
                        guard let drawn = drawing, drawn.width > 8, drawn.height > 8 else { return }
                        let canvas = CGRect(x: drawn.minX / size.width, y: drawn.minY / size.height,
                                            width: drawn.width / size.width, height: drawn.height / size.height)
                        model.addRedaction(rect: map.sourceRect(ofCanvas: canvas))
                    })
                    .accessibilityLabel("Draw a part to hide")
                ForEach(showing) { redaction in
                    // Only the part the picture shows: a zoom or a cover crop can put the rest outside it.
                    let mapped = map.rect(CGRect(x: redaction.x, y: redaction.y, width: redaction.width, height: redaction.height))
                    let rect = toView(mapped.intersection(map.shown).isNull ? .zero : mapped.intersection(map.shown))
                    let selected = model.selectedRedaction == redaction.id
                    Rectangle()
                        .strokeBorder(Color.white.opacity(selected ? 1 : 0.6), style: StrokeStyle(lineWidth: selected ? 1.5 : 1, dash: [5, 3]))
                        .background(Color.white.opacity(selected ? 0.06 : 0.001))
                        .frame(width: rect.width, height: rect.height)
                        .contentShape(Rectangle())
                        .offset(x: rect.minX, y: rect.minY)
                        .gesture(DragGesture(minimumDistance: 0).onChanged { value in
                            model.selectedRedaction = redaction.id
                            let start = grabbed ?? rect
                            grabbed = start
                            move(redaction.id, to: start.offsetBy(dx: value.translation.width, dy: value.translation.height), size: size, map: map)
                        }.onEnded { _ in grabbed = nil })
                        .instantTooltip("\(redaction.style.rawValue.capitalized): drag to move")
                        .accessibilityLabel("Hidden part, \(redaction.style.rawValue)")
                    if selected {
                        ForEach(Grip.allCases, id: \.self) { grip in
                            let corner = Self.corner(grip, of: rect)
                            RoundedRectangle(cornerRadius: 2).fill(Color.white)
                                .overlay(RoundedRectangle(cornerRadius: 2).strokeBorder(Color.black.opacity(0.4), lineWidth: 1))
                                .frame(width: 10, height: 10)
                                .contentShape(Rectangle().inset(by: -5))
                                .offset(x: corner.x - 5, y: corner.y - 5)
                                .gesture(DragGesture(minimumDistance: 0).onChanged { value in
                                    let start = grabbed ?? rect
                                    grabbed = start
                                    move(redaction.id, to: Self.resized(start, grip: grip, by: value.translation), size: size, map: map)
                                }.onEnded { _ in grabbed = nil })
                                .accessibilityHidden(true)
                        }
                    }
                }
                if let drawing {
                    Rectangle().strokeBorder(Color.white, style: StrokeStyle(lineWidth: 1.5, dash: [5, 3]))
                        .background(Color.black.opacity(0.35))
                        .frame(width: drawing.width, height: drawing.height)
                        .offset(x: drawing.minX, y: drawing.minY)
                        .allowsHitTesting(false)
                }
            }
        }
    }

    private func move(_ id: String, to rect: CGRect, size: CGSize, map: Looks.SourceToCanvas) {
        let canvas = CGRect(x: rect.minX / size.width, y: rect.minY / size.height,
                            width: max(4, rect.width) / size.width, height: max(4, rect.height) / size.height)
        let source = map.sourceRect(ofCanvas: canvas)
        model.updateRedaction(id) {
            $0.x = source.minX
            $0.y = source.minY
            $0.width = source.width
            $0.height = source.height
        }
    }

    private static func corner(_ grip: Grip, of rect: CGRect) -> CGPoint {
        switch grip {
        case .topLeft: CGPoint(x: rect.minX, y: rect.minY)
        case .topRight: CGPoint(x: rect.maxX, y: rect.minY)
        case .bottomLeft: CGPoint(x: rect.minX, y: rect.maxY)
        case .bottomRight: CGPoint(x: rect.maxX, y: rect.maxY)
        }
    }

    /// The rectangle with one corner moved; the opposite corner stays where it is.
    private static func resized(_ rect: CGRect, grip: Grip, by delta: CGSize) -> CGRect {
        var minX = rect.minX, minY = rect.minY, maxX = rect.maxX, maxY = rect.maxY
        switch grip {
        case .topLeft: minX += delta.width; minY += delta.height
        case .topRight: maxX += delta.width; minY += delta.height
        case .bottomLeft: minX += delta.width; maxY += delta.height
        case .bottomRight: maxX += delta.width; maxY += delta.height
        }
        return CGRect(x: min(minX, maxX - 4), y: min(minY, maxY - 4), width: max(4, abs(maxX - minX)), height: max(4, abs(maxY - minY)))
    }
}

private struct PlayerLayerView: NSViewRepresentable {
    let player: AVPlayer

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        view.wantsLayer = true
        let layer = AVPlayerLayer(player: player)
        layer.videoGravity = .resizeAspect
        layer.backgroundColor = NSColor.black.cgColor
        view.layer = layer
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        (nsView.layer as? AVPlayerLayer)?.player = player
    }
}

private struct TransportBar: View {
    @Bindable var model: EditorModel

    var body: some View {
        HStack(spacing: 16) {
            HStack(spacing: 10) {
                ClockLabel(clock: model.clock, durationUs: model.durationUs)
                    .fixedSize()
                if let part = model.exportPart { PartPill(model: model, part: part) }
            }
            .frame(width: 250, alignment: .leading)
            Spacer()
            IconButton(systemName: "backward.end.fill", tooltip: "To the start (Home)", size: 15) { model.seek(0) }
            IconButton(systemName: model.isPlaying ? "pause.fill" : "play.fill", tooltip: model.isPlaying ? "Pause (Space)" : "Play (Space)", size: 18) {
                model.togglePlay()
            }
            .accessibilityIdentifier("recorder.play")
            IconButton(systemName: "forward.end.fill", tooltip: "To the end (End)", size: 15) { model.seek(model.durationUs) }
            Spacer()
            HStack(spacing: 6) {
                IconButton(systemName: "minus", tooltip: "Zoom the timeline out", size: 11) { model.pointsPerSecond = max(0, model.pointsPerSecond * 0.7) }
                Slider(value: Binding(get: { model.pointsPerSecond }, set: { model.pointsPerSecond = $0 }), in: 0...400)
                    .frame(width: 120)
                    .instantTooltip("Timeline scale (0 fits the whole edit)")
                IconButton(systemName: "plus", tooltip: "Zoom the timeline in", size: 11) { model.pointsPerSecond = min(400, max(40, model.pointsPerSecond * 1.4)) }
            }
            .frame(width: 210, alignment: .trailing)
        }
        .padding(.horizontal, 18)
        .frame(height: 52)
        .background(RecorderPalette.panel)
    }
}

/// The marked part beside the clock: its length (the times in the tooltip), Export Part, and a clear button.
private struct PartPill: View {
    @Bindable var model: EditorModel
    let part: (fromUs: Int64, toUs: Int64)

    var body: some View {
        HStack(spacing: 6) {
            Text(verbatim: "Part \(String(format: "%.1f s", Double(part.toUs - part.fromUs) / 1_000_000))")
                .font(.system(size: 11.5, weight: .medium).monospacedDigit())
                .instantTooltip("From \(formatClock(part.fromUs, tenths: true)) to \(formatClock(part.toUs, tenths: true)); drag its edges on the timeline")
            Button("Export") { model.tab = .export; model.export() }
                .buttonStyle(.genHoverPlain())
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundStyle(Color.accentColor)
                .instantTooltip("Export only this part")
                .accessibilityIdentifier("recorder.part.export")
            IconButton(systemName: "xmark", tooltip: "Clear the part (the export writes everything again)", size: 9) { model.clearPart() }
                .accessibilityIdentifier("recorder.part.clear")
        }
        .padding(.leading, 9).padding(.trailing, 4).padding(.vertical, 3)
        .background(Capsule().fill(Color.accentColor.opacity(0.16)))
        .overlay(Capsule().strokeBorder(Color.accentColor.opacity(0.55), lineWidth: 1))
        .fixedSize()
    }
}

private struct ClockLabel: View {
    let clock: PlayheadClock
    let durationUs: Int64

    var body: some View {
        HStack(spacing: 6) {
            Text(verbatim: formatClock(clock.outUs, tenths: true)).foregroundStyle(RecorderPalette.text)
            Text(verbatim: "/").foregroundStyle(RecorderPalette.dim)
            Text(verbatim: formatClock(durationUs, tenths: true)).foregroundStyle(RecorderPalette.dim)
        }
        .font(.system(size: 13, weight: .medium).monospacedDigit())
        .accessibilityIdentifier("recorder.clock")
    }
}
