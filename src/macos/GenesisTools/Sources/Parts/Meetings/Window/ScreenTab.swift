import AppKit
import SwiftUI

// MARK: - Screen

/// The screen recording as a timeline: every kept frame in time order with the OCR lines that changed since the same
/// display's earlier frame. A display filter on top; a click on a frame shows it large with those lines boxed.
struct ScreenTab: View {
    @Bindable var detail: MeetingDetailModel
    @State private var display: Int = -1
    @State private var opened: TimelineFrame?
    @State private var hideQuiet = true
    /// Below this width a frame's text goes under its thumbnail: beside a 220 pt thumbnail at the window's smallest
    /// size the time, the display and the lines had about 60 pt and wrapped one or two letters per line.
    static let stackWidth: CGFloat = 520
    @State private var stacked = false

    var body: some View {
        if detail.record.value?.recording?.frames ?? 0 == 0, detail.record.value != nil {
            EmptyState(symbol: "rectangle.on.rectangle.slash", text: "This meeting has no screen recording",
                       detail: "A recording started with the meeting takes a frame when the screen changes.",
                       actionTitle: "Recording settings…") { FeatureSettingsLaunch.open(pageID: MeetingsSettingsPages.recordingPage) }
        } else {
            LoadablePane(state: detail.timeline, reading: "Reading the screen timeline…", retry: detail.loadTimeline) { timeline in
                VStack(spacing: 0) {
                    // Wraps in a narrow column: in one row the display tabs, the checkbox and the count needed about
                    // 560 pt and ran past the window at its smallest size.
                    if timeline.displays.count > 1 {
                        DisplayPicker(displays: timeline.displays.map { ($0.id ?? 0, $0.name ?? "Display \($0.id ?? 0)") },
                                      selection: $display)
                            .padding(.horizontal, 14).padding(.top, 8)
                    }
                    WrapLayout(spacing: 12, lineSpacing: 8) {
                        Toggle("Only frames with new text", isOn: $hideQuiet).toggleStyle(.checkbox).font(.system(size: 12))
                            .fixedSize()
                            .instantTooltip("Leave out the frames whose text the display already showed")
                        Text(verbatim: Plural.count(frames(timeline).count, "frame")).font(.system(size: 11).monospacedDigit())
                            .foregroundStyle(.secondary).lineLimit(1).fixedSize()
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    Divider()
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 10) {
                            ForEach(frames(timeline)) { frame in
                                FrameRow(frame: frame, displayName: name(of: frame, in: timeline),
                                         showAll: MeetingsPreferences.timelineLines() == .all, stacked: stacked) { opened = frame }
                                    .equatable()
                            }
                        }
                        .padding(14)
                    }
                    .onGeometryChange(for: Bool.self, of: { $0.size.width < Self.stackWidth }) { stacked = $0 }
                }
                .sheet(item: $opened) { frame in
                    FrameViewer(frame: frame, detail: detail) { opened = nil }
                }
            }
        }
    }

    private func frames(_ timeline: ScreenTimeline) -> [TimelineFrame] {
        timeline.frames.filter { (display == -1 || $0.displayId == display) && (!hideQuiet || !$0.changed.isEmpty) }
    }

    private func name(of frame: TimelineFrame, in timeline: ScreenTimeline) -> String {
        guard let id = frame.displayId else { return "Screen" }
        return timeline.displays.first { $0.id == id }?.name ?? "Display \(id)"
    }
}

struct FrameRow: View, Equatable {
    let frame: TimelineFrame
    let displayName: String
    let showAll: Bool
    /// The text under the thumbnail instead of beside it (a narrow Screen tab).
    var stacked = false
    let open: () -> Void

    nonisolated static func == (a: FrameRow, b: FrameRow) -> Bool {
        a.frame == b.frame && a.displayName == b.displayName && a.showAll == b.showAll && a.stacked == b.stacked
    }

    var body: some View {
        let layout = stacked ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
                             : AnyLayout(HStackLayout(alignment: .top, spacing: 12))
        layout {
            // A resting row has no responder; a click on the thumbnail still opens it (`pressable`).
            LiveButton(tooltip: "Show this frame large, with the changed lines boxed", pressable: true, action: open) {
                FrameThumbnail(path: frame.path, width: 220)
            }
            .accessibilityLabel("Frame at \(MeetingsFormat.clock(frame.meetingSec)) on \(displayName)")
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(verbatim: MeetingsFormat.clock(frame.meetingSec)).font(.system(size: 12, weight: .semibold, design: .monospaced))
                        .fixedSize()
                    Text(verbatim: displayName).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                    Text(verbatim: frame.changed.isEmpty ? "no new text" : Plural.count(frame.changed.count, "changed line"))
                        .font(.system(size: 11)).foregroundStyle(.tertiary).lineLimit(1).layoutPriority(1)
                }
                let lines = showAll ? (frame.lines ?? frame.changed) : frame.changed
                ForEach(Array(lines.prefix(14).enumerated()), id: \.offset) { _, line in
                    Text(verbatim: line.text).font(.system(size: 12)).lineLimit(1).textSelection(.enabled)
                }
                if lines.count > 14 {
                    LiveButton(tooltip: "Show the frame large, with every line boxed", action: open) {
                        Text(verbatim: "\(lines.count - 14) more lines…").font(.system(size: 11)).foregroundStyle(.secondary)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .frameProbe("meetings.frame.text")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.bottom, 6)
        .contentShape(Rectangle())
        .liveRow()
        .accessibilityAction(named: "Show large", open)
    }
}

/// A frame drawn at its full width in a sheet, with the changed lines boxed in the frame's own pixels, or every line
/// the OCR read (the changed ones still in the accent colour). It opens on the Screen tab's own line choice.
private struct FrameViewer: View {
    let frame: TimelineFrame
    let detail: MeetingDetailModel
    let close: () -> Void
    @State private var shown = MeetingsPreferences.timelineLines()
    @State private var lines: Loadable<[OcrBox]> = .idle

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Text(verbatim: "Frame at \(MeetingsFormat.clock(frame.meetingSec))").font(.system(size: 14, weight: .semibold))
                Text(verbatim: "\(Plural.count(frame.changed.count, "changed line")) of \(frame.lineCount) read")
                    .foregroundStyle(.secondary).font(.system(size: 12).monospacedDigit())
                Picker("Boxes", selection: $shown) {
                    Text("Changed lines").tag(MeetingsPreferences.TimelineLines.changed)
                    Text("All text").tag(MeetingsPreferences.TimelineLines.all)
                }
                .pickerStyle(.segmented).labelsHidden().fixedSize()
                .instantTooltip("Box only the lines that changed since this display's earlier frame, or every line the OCR read")
                if shown == .all, case .loading = lines { ProgressView().controlSize(.small) }

                Spacer()
                Button("Show in Finder") { PathOpener.reveal(frame.path) }.buttonStyle(.genHoverPlain())
                Button("Close", action: close).keyboardShortcut(.cancelAction)
            }
            if shown == .all, case .failed(let failure, _) = lines {
                NoticePill(text: failure.sentence, more: failure.detail, tone: .error,
                           fixes: [.button("Retry", symbol: "arrow.clockwise") { Task { await loadLines() } }])
            }
            GeometryReader { proxy in
                let scale = min(proxy.size.width / max(frame.width, 1), proxy.size.height / max(frame.height, 1))
                ZStack(alignment: .topLeading) {
                    FrameThumbnail(path: frame.path, width: frame.width * scale)
                    if shown == .all {
                        ForEach(Array(unchanged.enumerated()), id: \.offset) { _, box in
                            Rectangle().strokeBorder(Color.secondary.opacity(0.8), lineWidth: 1)
                                .frame(width: box.width * scale, height: box.height * scale)
                                .offset(x: box.x * scale, y: box.y * scale)
                                .accessibilityLabel(box.text)
                        }
                    }
                    ForEach(Array(frame.changed.enumerated()), id: \.offset) { _, box in
                        Rectangle().strokeBorder(Color.accentColor, lineWidth: 1.5)
                            .frame(width: box.width * scale, height: box.height * scale)
                            .offset(x: box.x * scale, y: box.y * scale)
                            .accessibilityLabel(box.text)
                    }
                }
                .frame(width: frame.width * scale, height: frame.height * scale)
            }
        }
        .padding(16)
        // Smaller than the window's own minimum, so the sheet never hangs past a small window.
        .frame(minWidth: 640, minHeight: 420)
        .task(id: shown) { await loadLines() }
    }

    /// The lines the changed boxes do not already cover.
    private var unchanged: [OcrBox] {
        let changed = Set(frame.changed)
        return (lines.value ?? []).filter { !changed.contains($0) }
    }

    private func loadLines() async {
        guard shown == .all, lines.value == nil else { return }
        if let known = frame.lines {
            lines = .loaded(known)
            return
        }
        lines = .loading(previous: nil)
        do {
            lines = .loaded(try await detail.frameLines(file: frame.file))
        } catch {
            if !Task.isCancelled { lines = .failed(asFailure(error), previous: nil) }
        }
    }
}

/// A frame file drawn from a thumbnail made off the main thread and kept in a small cache.
struct FrameThumbnail: View {
    let path: String
    let width: CGFloat
    @State private var image: NSImage?

    var body: some View {
        Group {
            if let image {
                Image(nsImage: image).resizable().aspectRatio(contentMode: .fit)
            } else {
                Rectangle().fill(.white.opacity(0.05)).aspectRatio(16 / 10, contentMode: .fit)
                    .overlay { Image(systemName: "photo").foregroundStyle(.tertiary) }
            }
        }
        .frame(width: width)
        .clipShape(RoundedRectangle(cornerRadius: 4))
        .task(id: "\(path)@\(Int(width))") {
            image = await FrameThumbnails.shared.image(path: path, maxPixel: Int(width * 2))
        }
    }
}

actor FrameThumbnails {
    static let shared = FrameThumbnails()
    private let cache = NSCache<NSString, NSImage>()

    init() { cache.countLimit = 160 }

    func image(path: String, maxPixel: Int) -> NSImage? {
        let key = "\(path)@\(maxPixel)" as NSString
        if let hit = cache.object(forKey: key) { return hit }
        guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
              let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                  kCGImageSourceCreateThumbnailFromImageAlways: true,
                  kCGImageSourceThumbnailMaxPixelSize: maxPixel,
                  kCGImageSourceCreateThumbnailWithTransform: true,
              ] as CFDictionary) else { return nil }
        let image = NSImage(cgImage: cgImage, size: NSSize(width: cgImage.width, height: cgImage.height))
        cache.setObject(image, forKey: key)
        return image
    }
}

