import AppKit
import SwiftUI

/// The picture of a file, everywhere an image, a video or a document is shown: decoded off the main thread
/// (`MediaThumbnailCache`) at the pixel size its frame needs on this display, fitted at its own aspect ratio, a
/// poster frame and the length for a video, and a placeholder that names the file and offers Retry when no picture
/// can be made. A click previews it larger over the surface (`.mediaPreviewHost()`), Quick Look style.
///
/// The caller gives the frame; the picture fits inside it and never moves the layout when it arrives.
public struct MediaThumbnailView: View {
    public enum Emphasis: Sendable {
        /// Row icons and composer chips: a play glyph without the length.
        case compact
        case regular
        /// The preview itself: no play glyph, no hover.
        case large
    }

    let item: MediaPreviewItem
    let gallery: [MediaPreviewItem]
    let aspect: CGFloat?
    let cornerRadius: CGFloat
    let interactive: Bool
    let emphasis: Emphasis
    let onOpen: (() -> Void)?

    @Environment(\.displayScale) private var displayScale
    @Environment(\.mediaPreview) private var preview
    @State private var measure = Measure(bucket: 0, roomy: false)
    @State private var result: MediaThumbnailResult?
    @State private var attempt = 0
    /// Bumped when the file changes on disk, so a replaced or repaired file loads again at the same path and size.
    @State private var revision = 0
    @State private var hovering = false
    @State private var slow = false
    @State private var loadedPath: String?

    /// `gallery` is the set ← and → move through in the preview (this item included); `aspect` (width / height),
    /// when the caller knows it, shapes the loading placeholder like the picture. `onOpen` replaces the preview.
    public init(
        item: MediaPreviewItem, gallery: [MediaPreviewItem] = [], aspect: CGFloat? = nil, cornerRadius: CGFloat = 7,
        interactive: Bool = true, emphasis: Emphasis = .regular, onOpen: (() -> Void)? = nil
    ) {
        self.item = item
        self.gallery = gallery
        self.aspect = aspect.flatMap { $0.isFinite && $0 > 0 ? $0 : nil }
        self.cornerRadius = cornerRadius
        self.interactive = interactive
        self.emphasis = emphasis
        self.onOpen = onOpen
    }

    public init(
        path: String, name: String? = nil, kind: MediaKind? = nil, duration: Double? = nil, aspect: CGFloat? = nil,
        cornerRadius: CGFloat = 7, emphasis: Emphasis = .regular
    ) {
        self.init(
            item: MediaPreviewItem(path: path, name: name, kind: kind, duration: duration), aspect: aspect,
            cornerRadius: cornerRadius, emphasis: emphasis)
    }

    /// The frame for a picture of `aspect` that is at most `maxWidth` × `height`, at least `minWidth` wide.
    public static func frame(aspect: CGFloat?, height: CGFloat, maxWidth: CGFloat, minWidth: CGFloat = 0) -> CGSize {
        guard let aspect, aspect.isFinite, aspect > 0 else { return CGSize(width: min(maxWidth, height * 4 / 3), height: height) }
        let width = min(maxWidth, max(minWidth, height * aspect))
        return CGSize(width: width.rounded(), height: min(height, (width / aspect).rounded()))
    }

    private struct Measure: Equatable {
        var bucket: Int
        var roomy: Bool
    }

    private struct LoadKey: Equatable {
        let path: String
        let bucket: Int
        let attempt: Int
        let revision: Int
    }

    public var body: some View {
        Group {
            if case .failed(let reason) = result {
                failure(reason)
            } else if interactive && emphasis != .large {
                Button(action: open) { picture }
                    .buttonStyle(.genHoverPlain(brighten: 0.06))
                    .onHover { hovering = $0 }
                    .instantTooltip(item.kind == .video ? "Play \(item.name)" : "Preview \(item.name)")
                    .accessibilityLabel(Text(verbatim: (item.kind == .video ? "Play " : "Preview ") + item.name))
                    .contextMenu { menu }
            } else {
                picture
            }
        }
        .onGeometryChange(for: Measure.self) { proxy in
            let side = max(proxy.size.width, proxy.size.height)
            return Measure(
                bucket: side > 0 ? MediaThumbnailCache.bucket(forPixels: side * max(1, displayScale)) : 0,
                roomy: proxy.size.width >= 76 && proxy.size.height >= 64)
        } action: { measure = $0 }
        .task(id: LoadKey(path: item.path, bucket: measure.bucket, attempt: attempt, revision: revision)) {
            await load()
            // The cache compares the file's identity only when asked; nothing asks while the tile stays the same
            // size. Wait for the file itself to change, then load again (the old picture stays until the new one).
            if measure.bucket > 0, await MediaFileChange.next(path: item.path) {
                revision += 1
            }
        }
    }

    // MARK: - States

    @ViewBuilder private var picture: some View {
        ZStack {
            if case .ready(let thumbnail) = result {
                ready(thumbnail)
            } else {
                placeholder
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
    }

    @ViewBuilder private func ready(_ thumbnail: MediaThumbnail) -> some View {
        let image = Image(decorative: thumbnail.image, scale: max(1, displayScale))
            .resizable()
            .interpolation(.high)
            .aspectRatio(contentMode: .fit)
        if thumbnail.isIcon {
            image.padding(4)
        } else {
            image
                .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.14), lineWidth: 0.5))
                .overlay { if thumbnail.kind == .video && emphasis != .large { playGlyph } }
                .overlay(alignment: .bottomTrailing) {
                    if thumbnail.kind == .video, emphasis == .regular,
                        let seconds = item.duration ?? thumbnail.duration
                    {
                        durationBadge(seconds)
                    }
                }
                .overlay(alignment: .topTrailing) {
                    if hovering && emphasis == .regular {
                        Image(systemName: "arrow.up.left.and.arrow.down.right")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(.white)
                            .padding(4)
                            .background(Circle().fill(.black.opacity(0.55)))
                            .padding(4)
                            .transition(.opacity)
                            .accessibilityHidden(true)
                    }
                }
        }
    }

    private var placeholder: some View {
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            .fill(Color.white.opacity(0.06))
            .aspectRatio(aspect, contentMode: .fit)
            .overlay {
                if slow {
                    Color.clear.skeletonShimmer()
                        .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
                }
            }
            .overlay {
                Image(systemName: item.kind.symbol)
                    .font(.system(size: emphasis == .large ? 28 : 13, weight: .light))
                    .foregroundStyle(.white.opacity(0.22))
            }
            .accessibilityLabel(Text(verbatim: "Loading the preview of \(item.name)"))
    }

    private func failure(_ reason: String) -> some View {
        let roomy = measure.roomy || emphasis == .large
        return VStack(spacing: roomy ? 5 : 3) {
            Image(systemName: item.kind.symbol)
                .font(.system(size: roomy ? 17 : 12, weight: .light))
                .foregroundStyle(.secondary)
                .overlay(alignment: .bottomTrailing) {
                    Image(systemName: "exclamationmark.circle.fill")
                        .font(.system(size: roomy ? 8 : 6))
                        .foregroundStyle(.orange)
                        .offset(x: 3, y: 2)
                }
            if roomy {
                Text(verbatim: item.name)
                    .font(.system(size: 9.5, weight: .medium))
                    .lineLimit(2).truncationMode(.middle)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 4)
                Button { retry() } label: {
                    Label("Retry", systemImage: "arrow.clockwise").font(.system(size: 9.5, weight: .medium))
                }
                .buttonStyle(.genHover(padding: EdgeInsets(top: 2, leading: 5, bottom: 2, trailing: 5)))
                .accessibilityLabel(Text(verbatim: "Retry the preview of \(item.name)"))
            } else {
                IconButton(systemName: "arrow.clockwise", tooltip: "Retry the preview of \(item.name)", size: 9) { retry() }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous).fill(Color.white.opacity(0.035)))
        .overlay(
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .strokeBorder(Color.white.opacity(0.18), style: StrokeStyle(lineWidth: 1, dash: [3, 3])))
        .instantTooltip(title: item.name, bullets: [reason, "Retry makes the preview again."])
        .contextMenu { menu }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(verbatim: "No preview of \(item.name): \(reason)"))
    }

    private var playGlyph: some View {
        let compact = emphasis == .compact
        return Image(systemName: "play.fill")
            .font(.system(size: compact ? 8 : 11, weight: .bold))
            .foregroundStyle(.white)
            .padding(compact ? 5 : 7)
            .background(Circle().fill(.black.opacity(0.5)))
            .overlay(Circle().strokeBorder(.white.opacity(0.25), lineWidth: 0.5))
            .accessibilityHidden(true)
    }

    private func durationBadge(_ seconds: Double) -> some View {
        Text(verbatim: MediaFormat.duration(seconds))
            .font(.system(size: 9, weight: .semibold).monospacedDigit())
            .foregroundStyle(.white)
            .padding(.horizontal, 4).padding(.vertical, 1.5)
            .background(Capsule().fill(.black.opacity(0.62)))
            .padding(4)
            .accessibilityLabel(Text(verbatim: "Length \(MediaFormat.duration(seconds))"))
    }

    @ViewBuilder private var menu: some View {
        if result.map({ if case .ready = $0 { return true } else { return false } }) == true {
            Button(item.kind == .video ? "Play" : "Preview") { open() }
        }
        Button("Open in its app") { PathOpener.open(item.path) }
        Button("Show in Finder") { PathOpener.reveal(item.path) }
        Button("Copy path") { PathOpener.copy(item.path, what: "file path") }
    }

    // MARK: - Actions

    private func open() {
        if let onOpen {
            onOpen()
        } else if let preview {
            preview.present(gallery.isEmpty ? [item] : gallery, selectedID: item.id)
        } else {
            PathOpener.open(item.path)
        }
    }

    private func retry() {
        result = nil
        attempt += 1
    }

    private func load() async {
        guard measure.bucket > 0 else { return }
        if loadedPath != item.path {
            // A reused view for another file must not show the previous file's picture while it loads.
            result = nil
            loadedPath = item.path
        }
        let reload = attempt > 0 && result == nil
        let slowMark = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(150))
            if !Task.isCancelled, result == nil { slow = true }
        }
        let next = await MediaThumbnailCache.shared.thumbnail(
            path: item.path, maxPixels: CGFloat(measure.bucket), kind: item.kind, reload: reload)
        slowMark.cancel()
        guard !Task.isCancelled else { return }
        slow = false
        result = next
    }
}

extension MediaKind {
    /// The SF Symbol for a file of this kind, where no picture of it is shown yet.
    public var symbol: String {
        switch self {
        case .image: return "photo"
        case .video: return "film"
        case .file: return "doc"
        }
    }
}

/// The next change of one file, event-driven (a vnode dispatch source, no polling): a write, an append, a delete or a
/// rename (an atomic save replaces the file by a rename), or, while the file is missing, any change of its folder, so a
/// repaired file is seen. True after the change, debounced by 200 ms so a file written in pieces loads once; false when
/// the task is cancelled or nothing can be watched. Cancellation closes the descriptor.
enum MediaFileChange {
    private final class Outcome: @unchecked Sendable {
        /// Touched only on `queue`, where both source handlers run.
        var changed = false
    }

    private static let queue = DispatchQueue(label: "genesiskit.media.file-change", qos: .utility)

    static func next(path: String, debounce: Duration = .milliseconds(200)) async -> Bool {
        guard !Task.isCancelled else { return false }
        let exists = FileManager.default.fileExists(atPath: path)
        let descriptor = open(exists ? path : (path as NSString).deletingLastPathComponent, O_EVTONLY)
        guard descriptor >= 0 else { return false }
        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: descriptor, eventMask: exists ? [.write, .extend, .delete, .rename, .revoke] : [.write],
            queue: queue)
        let outcome = Outcome()
        let changed = await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
                source.setEventHandler {
                    outcome.changed = true
                    source.cancel()
                }
                source.setCancelHandler {
                    close(descriptor)
                    continuation.resume(returning: outcome.changed)
                }
                source.resume()
            }
        } onCancel: {
            source.cancel()
        }
        guard changed else { return false }
        try? await Task.sleep(for: debounce)
        return !Task.isCancelled
    }
}
