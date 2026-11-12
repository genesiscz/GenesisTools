import AppKit
import SwiftUI

/// Pixel-space focus math, shared by every screen shape and independent of the thumbnail's decode size.
enum FrameReviewFocus {
    static func layout(box: OcrBox, image: CGSize, viewport: CGSize) -> (scale: CGFloat, offset: CGSize) {
        let bounds = CGRect(origin: .zero, size: image)
        let clipped = CGRect(x: box.x, y: box.y, width: box.width, height: box.height)
            .insetBy(dx: -24, dy: -24).intersection(bounds)
        let padded = clipped.isNull || clipped.isEmpty ? bounds : clipped
        let fit = min(viewport.width / max(1, image.width), viewport.height / max(1, image.height))
        let scale = max(fit, min(fit * 8, viewport.width / max(1, padded.width), viewport.height / max(1, padded.height)))
        return (scale, CGSize(width: viewport.width / 2 - padded.midX * scale,
                              height: viewport.height / 2 - padded.midY * scale))
    }
}

/// This cache belongs to the viewer. Scrub previews cannot queue behind full-size pictures in other windows.
private enum FrameReviewImages {
    static let cache = MediaThumbnailCache(byteLimit: 128 << 20, concurrency: 2, deadline: .seconds(5))
}

struct FrameReviewImage: View {
    let frame: TimelineFrame
    let neighbors: [TimelineFrame]
    let zoom: Double
    let scrubbing: Bool
    let boxes: [OcrBox]
    let query: String
    let highlightedText: String?
    let autoFocus: Bool
    private struct Shown { let frame: TimelineFrame; let image: CGImage }
    private struct Request: Hashable { let path: String; let pixels: Int }
    @State private var shown: Shown?
    @State private var failure: String?
    @State private var manualFocus: OcrBox?
    @State private var autoSuppressed = false
    private var pixels: Int { scrubbing ? 1024 : (manualFocus != nil || autoFocus || zoom > 1 ? 8192 : 4096) }

    var body: some View {
        GeometryReader { proxy in
            let visible = shown?.frame ?? frame
            let glowing = highlights(in: visible)
            let focus = focused(in: visible, glowing: glowing)
            ZStack(alignment: .topTrailing) {
                if let focus {
                    let layout = FrameReviewFocus.layout(box: focus, image: CGSize(width: visible.width, height: visible.height), viewport: proxy.size)
                    picture(visible, glowing: glowing, focus: focus, scale: layout.scale)
                        .offset(x: layout.offset.width, y: layout.offset.height)
                        .frame(width: proxy.size.width, height: proxy.size.height, alignment: .topLeading)
                        .clipped()
                    Button("Fit frame") { manualFocus = nil; autoSuppressed = true }
                        .buttonStyle(.borderedProminent).padding(12)
                        .accessibilityIdentifier("meetings.frame-review.fit")
                } else {
                    let fit = min(proxy.size.width / max(1, visible.width), proxy.size.height / max(1, visible.height))
                    ScrollView([.horizontal, .vertical]) {
                        picture(visible, glowing: glowing, focus: nil, scale: fit * zoom)
                            .frame(minWidth: proxy.size.width, minHeight: proxy.size.height)
                    }
                }
            }
        }
        .background(.black.opacity(0.9))
        .onChange(of: frame.file) { _, _ in manualFocus = nil; autoSuppressed = false }
        .onChange(of: highlightedText) { _, _ in manualFocus = nil; autoSuppressed = false }
        .onChange(of: zoom) { _, _ in manualFocus = nil; autoSuppressed = true }
        .task(id: Request(path: frame.path, pixels: pixels)) {
            failure = nil
            let started = ContinuousClock.now
            let result = await FrameReviewImages.cache.thumbnail(path: frame.path, maxPixels: CGFloat(pixels), kind: .image, ceiling: 8192)
            guard !Task.isCancelled else { return }
            switch result {
            case .ready(let thumbnail): shown = Shown(frame: frame, image: thumbnail.image)
            case .failed(let message): failure = message
            }
            let elapsed = ContinuousClock.now - started
            if elapsed > .milliseconds(100) { PerfLog.mark("meetings.frame-preview \(pixels)px \(elapsed)") }
            if let index = neighbors.firstIndex(where: { $0.file == frame.file }) {
                let paths = [index - 1, index + 1].filter { neighbors.indices.contains($0) }.map { neighbors[$0].path }
                await withTaskGroup(of: Void.self) { group in
                    for path in paths {
                        group.addTask {
                            if !Task.isCancelled { _ = await FrameReviewImages.cache.thumbnail(path: path, maxPixels: 1024, kind: .image) }
                        }
                    }
                }
            }
        }
    }

    private func focused(in visible: TimelineFrame, glowing: [OcrBox]) -> OcrBox? {
        guard !scrubbing, visible.file == frame.file else { return nil }
        if let manualFocus, (visible.lines ?? visible.changed).contains(manualFocus) { return manualFocus }
        return autoFocus && !autoSuppressed && glowing.count == 1 ? glowing[0] : nil
    }

    private func highlights(in visible: TimelineFrame) -> [OcrBox] {
        guard visible.file == frame.file, !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
        let lines = visible.lines ?? visible.changed
        if let highlightedText {
            let wanted = FrameReviewModel.fold(highlightedText.split(whereSeparator: \.isWhitespace).joined(separator: " "))
            let exact = lines.filter { FrameReviewModel.fold($0.text.split(whereSeparator: \.isWhitespace).joined(separator: " ")) == wanted }
            if !exact.isEmpty { return exact }
        }
        return lines.filter { !FrameReviewModel.highlightRanges(in: $0.text, query: query).isEmpty }
    }

    private func picture(_ visible: TimelineFrame, glowing: [OcrBox], focus: OcrBox?, scale: CGFloat) -> some View {
        var seen = Set<OcrBox>()
        let interactive = visible.file == frame.file ? (boxes + glowing).filter { seen.insert($0).inserted } : []
        return ZStack(alignment: .topLeading) {
            if let shown {
                Image(decorative: shown.image, scale: 1).resizable()
                    .frame(width: visible.width * scale, height: visible.height * scale)
            } else {
                Text(failure ?? "Reading frame…").foregroundStyle(.secondary)
                    .frame(width: visible.width * scale, height: visible.height * scale)
            }
            Canvas { context, _ in
                guard visible.file == frame.file else { return }
                for box in boxes { outline(box, context: &context, scale: scale, color: .accentColor, width: 1) }
                for box in glowing {
                    let rect = rectangle(box, scale: scale).insetBy(dx: -3, dy: -3)
                    let path = Path(roundedRect: rect, cornerRadius: 4)
                    var glow = context
                    glow.addFilter(.shadow(color: .orange.opacity(0.9), radius: 9))
                    glow.fill(path, with: .color(.orange.opacity(0.15)))
                    glow.stroke(path, with: .color(.orange), lineWidth: 3)
                    context.stroke(path, with: .color(.yellow), lineWidth: 1)
                }
            }.frame(width: visible.width * scale, height: visible.height * scale).allowsHitTesting(false)
            if !scrubbing {
                ForEach(interactive, id: \.self) { box in
                    Button {
                        if focus == box { manualFocus = nil; autoSuppressed = true }
                        else { manualFocus = box; autoSuppressed = false }
                    } label: { Color.clear.contentShape(Rectangle()) }
                    .buttonStyle(.plain)
                    .frame(width: max(1, box.width * scale), height: max(1, box.height * scale))
                    .offset(x: box.x * scale, y: box.y * scale)
                    .accessibilityLabel(focus == box ? "Fit frame" : "Zoom to \(box.text)")
                    .accessibilityHint("Click the same box again to return to the full frame")
                }
            }
        }
        .frame(width: visible.width * scale, height: visible.height * scale)
    }

    private func rectangle(_ box: OcrBox, scale: CGFloat) -> CGRect {
        CGRect(x: box.x * scale, y: box.y * scale, width: max(1, box.width * scale), height: max(1, box.height * scale))
    }
    private func outline(_ box: OcrBox, context: inout GraphicsContext, scale: CGFloat, color: Color, width: CGFloat) {
        context.stroke(Path(rectangle(box, scale: scale)), with: .color(color), lineWidth: width)
    }
}
