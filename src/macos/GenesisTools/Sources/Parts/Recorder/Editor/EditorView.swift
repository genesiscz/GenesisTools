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
                        .frame(width: 300)
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
            IconButton(systemName: "scissors", tooltip: "Split at the playhead (S)", size: 14) { model.splitAtPlayhead() }
                .padding(.bottom, 10)
        }
        .padding(.top, 12)
        .frame(width: 54)
        .background(RecorderPalette.panel)
    }
}

// MARK: - Inspector

private struct InspectorView: View {
    @Bindable var model: EditorModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                switch model.tab {
                case .zoom: ZoomInspector(model: model)
                case .clip: ClipInspector(model: model)
                case .audio: AudioInspector(model: model)
                case .export: ExportInspector(model: model)
                }
            }
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
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
            VStack(alignment: .leading, spacing: 8) {
                SectionLabel(text: "Zoom level", value: "\(Int((zoom.scale * 100).rounded()))%")
                Slider(value: Binding(get: { zoom.scale }, set: { value in model.updateZoom(id) { $0.scale = (value * 20).rounded() / 20 } }),
                       in: 1.1...4)
                    .accessibilityIdentifier("recorder.zoom.level")
                WideButton(title: "Apply Zoom Level to All") { model.applyScaleToAll(zoom.scale) }
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
                SectionLabel(text: "Animation", value: "\(zoom.easeInMs) ms in · \(zoom.easeOutMs) ms out")
                Slider(value: Binding(get: { Double(zoom.easeInMs) }, set: { value in model.updateZoom(id) { $0.easeInMs = Int((value / 50).rounded()) * 50 } }), in: 0...1500)
                    .instantTooltip("How long the zoom takes to come in")
                Slider(value: Binding(get: { Double(zoom.easeOutMs) }, set: { value in model.updateZoom(id) { $0.easeOutMs = Int((value / 50).rounded()) * 50 } }), in: 0...1500)
                    .instantTooltip("How long the zoom takes to leave")
            }
            SectionLabel(text: "From \(formatClock(zoom.startUs, tenths: true)) to \(formatClock(zoom.endUs, tenths: true)) of the recording")
            WideButton(title: "Delete Zoom", systemImage: "trash", role: .destructive) { model.deleteSelection() }
        } else {
            VStack(alignment: .leading, spacing: 10) {
                Text("Zoom").font(.system(size: 15, weight: .semibold))
                Text("Click or drag in the zoom lane to add a zoom, or select one to change it. Z adds one at the playhead.")
                    .font(.system(size: 12.5)).foregroundStyle(RecorderPalette.dim)
                    .fixedSize(horizontal: false, vertical: true)
                WideButton(title: "Add Zoom at Playhead", systemImage: "plus.magnifyingglass") { model.addZoom() }
                WideButton(title: "Auto Zoom from Clicks", systemImage: "cursorarrow.click.2") { model.autoZoom() }
                    .disabled(model.cursor == nil)
                    .instantTooltip(model.cursor == nil ? "This recording has no cursor track" : "One zoom per group of clicks, following the cursor")
                if !model.project.zooms.isEmpty {
                    Text(verbatim: Plural.count(model.project.zooms.count, "zoom"))
                        .font(.system(size: 12)).foregroundStyle(RecorderPalette.dim)
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
                SectionLabel(text: "Recording", value: "\(formatClock(clip.fromUs, tenths: true)) – \(formatClock(clip.toUs, tenths: true))")
                SectionLabel(text: "Plays for", value: formatClock(clip.outputDurationUs, tenths: true))
            }
            VStack(alignment: .leading, spacing: 8) {
                SectionLabel(text: "Speed", value: speedLabel(clip.speed))
                GenSegmentedTabs("Speed", items: speeds.map { .init($0, speedLabel($0)) },
                                 selection: Binding(get: { speeds.contains(clip.speed) ? clip.speed : 1 }, set: { model.setSpeed(id, $0) }),
                                 minSegmentWidth: 44, identifier: "recorder.clip.speed")
            }
            WideButton(title: "Split at Playhead", systemImage: "scissors") { model.splitAtPlayhead() }
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
                WideButton(title: model.isRemovingIdle ? "Looking for Still Parts…" : "Remove Still Parts", systemImage: "wand.and.stars") {
                    model.removeIdle()
                }
                .disabled(model.isRemovingIdle)
                .instantTooltip("Cuts every stretch of 2 s or more where the picture does not change and nothing is heard")
            }
        }
    }
}

private struct AudioInspector: View {
    @Bindable var model: EditorModel

    var body: some View {
        let audio = model.project.audio
        VStack(alignment: .leading, spacing: 10) {
            Text("Audio").font(.system(size: 15, weight: .semibold))
            Toggle("Include audio", isOn: Binding(get: { audio.include }, set: { value in model.setAudio { $0.include = value } }))
                .toggleStyle(.switch)
                .accessibilityIdentifier("recorder.audio.include")
            VStack(alignment: .leading, spacing: 8) {
                SectionLabel(text: "Volume", value: "\(Int((audio.volume * 100).rounded()))%")
                Slider(value: Binding(get: { audio.volume }, set: { value in model.setAudio { $0.volume = (value * 20).rounded() / 20 } }), in: 0...2)
                    .accessibilityIdentifier("recorder.audio.volume")
            }
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.white.opacity(0.05)))
            .disabled(!audio.include)
            if !model.waveform.hasAudio {
                Text("This movie has no audio track.").font(.system(size: 12)).foregroundStyle(RecorderPalette.dim)
            }
        }
    }
}

private struct ExportInspector: View {
    @Bindable var model: EditorModel
    private let heights: [Int] = [0, 2160, 1440, 1080, 720]

    var body: some View {
        let settings = model.project.export
        VStack(alignment: .leading, spacing: 12) {
            Text("Export").font(.system(size: 15, weight: .semibold))
            SectionLabel(text: "Codec")
            GenSegmentedTabs("Codec", items: [.init(EditProject.Codec.h264, "H.264"), .init(.hevc, "HEVC")],
                             selection: Binding(get: { settings.codec }, set: { codec in model.setExport { $0.codec = codec } }),
                             minSegmentWidth: 110, identifier: "recorder.export.codec")
            SectionLabel(text: "Size")
            GenSegmentedTabs("Size", items: heights.map { .init($0, $0 == 0 ? "Source" : "\($0)p") },
                             selection: Binding(get: { settings.maxHeight }, set: { value in model.setExport { $0.maxHeight = value } }),
                             minSegmentWidth: 44, identifier: "recorder.export.size")
            let source = CGSize(width: model.project.source.width, height: model.project.source.height)
            // A screen recording exports at 60 fps; the label uses the same size rule as the export.
            let size = EditRenderer.renderSize(source: source, maxHeight: settings.maxHeight, h264Fps: settings.codec == .h264 ? 60 : nil)
            let capped = size.height < EditRenderer.renderSize(source: source, maxHeight: settings.maxHeight).height
            SectionLabel(text: "Output", value: "\(Int(size.width)) × \(Int(size.height)) · \(formatClock(model.durationUs, tenths: true))")
            if capped {
                Text("H.264 keeps 60 fps up to 2560 × 1600. Pick HEVC for the full size.")
                    .font(.system(size: 11))
                    .foregroundStyle(RecorderPalette.dim)
                    .fixedSize(horizontal: false, vertical: true)
            }
            PathLabel(path: EditExporter.outputURL(for: model.project).path)
            if let progress = model.exportProgress {
                ProgressView(value: progress).progressViewStyle(.linear)
                Text(verbatim: "Exporting… \(Int(progress * 100))%").font(.system(size: 12).monospacedDigit()).foregroundStyle(RecorderPalette.dim)
            } else {
                Button("Export Movie") { model.export() }
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
        let aspect = CGFloat(model.project.source.width) / CGFloat(max(1, model.project.source.height))
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
            .shadow(color: .black.opacity(0.5), radius: 18, y: 6)
            .padding(28)
            .onTapGesture { model.togglePlay() }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityLabel("Preview")
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
            ClockLabel(clock: model.clock, durationUs: model.durationUs)
                .frame(width: 130, alignment: .leading)
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
