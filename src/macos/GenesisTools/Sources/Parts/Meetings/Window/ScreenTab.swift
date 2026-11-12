import AppKit
import SwiftUI

// MARK: - Screen

/// The screen recording as a timeline: every kept frame in time order with the OCR lines that changed since the same
/// display's earlier frame. A display filter on top; a click on a frame shows it large with those lines boxed.
struct ScreenTab: View {
    @Bindable var detail: MeetingDetailModel
    @State private var display: Int = -1
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
                                         showAll: MeetingsPreferences.timelineLines() == .all, stacked: stacked) {
                                    FrameReviewWindow.show(meeting: detail.id, file: frame.file, at: frame.meetingSec,
                                                           player: detail.window?.player, defaults: detail.defaults, timeline: timeline,
                                                           duration: detail.window?.meeting(detail.id)?.durationSec)
                                }
                                    .equatable()
                            }
                        }
                        .padding(14)
                    }
                    .onGeometryChange(for: Bool.self, of: { $0.size.width < Self.stackWidth }) { stacked = $0 }
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

    /// The lines a row lists before "N more lines…": with its header about as tall as the picture beside it (a
    /// 220 pt thumbnail of a 16:10 screen is 138 pt). At 14 lines each row was two pictures tall, most of it menu words.
    static let shownLines = 6

    /// The lines in reading order, with the band at the frame's top (the menu bar: its top 4 %) moved to the end. The
    /// OCR reads top down, so a display's first frame listed "Messages, Edit, View, Conversation…" in all six places,
    /// and the content that changed stood behind "N more lines…". Nothing is left out; the viewer can show every line.
    static func listed(_ lines: [OcrBox], frameHeight: Double) -> [OcrBox] {
        let band = frameHeight * 0.04
        let top = lines.filter { $0.y + $0.height / 2 < band }
        guard !top.isEmpty, top.count < lines.count else { return lines }
        return lines.filter { $0.y + $0.height / 2 >= band } + top
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
                let lines = Self.listed(showAll ? (frame.lines ?? frame.changed) : frame.changed, frameHeight: frame.height)
                ForEach(Array(lines.prefix(Self.shownLines).enumerated()), id: \.offset) { _, line in
                    Text(verbatim: line.text).font(.system(size: 12)).lineLimit(1).textSelection(.enabled)
                }
                if lines.count > Self.shownLines {
                    LiveButton(tooltip: "Show the frame large, with every line boxed", action: open) {
                        Text(verbatim: "\(lines.count - Self.shownLines) more lines…").font(.system(size: 11)).foregroundStyle(.secondary)
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

