import AppKit
import Combine
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
    /// The button's keyboard focus: it comes back here when the preview this thumbnail opened closes.
    @FocusState private var focused: Bool

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
                    .focused($focused)
                    .onReceive(preview?.focusReturns.eraseToAnyPublisher() ?? Empty().eraseToAnyPublisher()) { id in
                        if id == item.id { focused = true }
                    }
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
            // The file as this load is about to read it, so a change while the decode runs reloads at once.
            let seen = MediaFileIdentity.current(item.path)
            await load()
            guard measure.bucket > 0 else { return }
            // The cache compares the file's identity only when asked; nothing asks while the tile stays the same
            // size. Wait for the file itself to change, then load again (the old picture stays until the new one).
            // A tile showing "took too long" also loads again once the decoder past its deadline answers.
            var lateAnswer: (@Sendable () async -> Bool)?
            if case .failed(let message) = result, message == MediaThumbnailCache.tooLong {
                let path = item.path
                let pixels = CGFloat(measure.bucket)
                lateAnswer = { await MediaThumbnailCache.shared.lateAnswer(path: path, maxPixels: pixels) }
            }
            if await MediaFileChange.nextReload(path: item.path, seen: seen, lateAnswer: lateAnswer) {
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
///
/// `seen` is the file as the caller last read it (nil: missing then). The watch starts after that read, so a change
/// in between (a file replaced while its thumbnail decoded, or while the tile waited for a watch) shows as another
/// identity once the watch is armed and counts at once.
///
/// Each watch holds one descriptor, and an app starts with a soft limit of 256, so at most `watchLimit` files are
/// watched at once: a tile past it waits for a watch to end (another tile went away or saw its change) and then
/// watches its own file. Waiting holds no descriptor. While it waits, the tile compares its file's identity every
/// `overflowCheck`, so a file replaced while every watch stays taken (a gallery that does not move) still reloads.
enum MediaFileChange {
    private final class Outcome: @unchecked Sendable {
        /// Touched only on `queue`, where both source handlers run.
        var changed = false
    }

    private static let queue = DispatchQueue(label: "genesiskit.media.file-change", qos: .utility)
    static let watchLimit = 64
    static let slots = MediaWatchSlots(limit: watchLimit)
    /// One `stat` per waiting tile in this interval; a watched tile sees its change at once.
    static let overflowCheck: Duration = .seconds(2)

    static func next(path: String, seen: MediaFileIdentity?, debounce: Duration = .milliseconds(200),
                     slots: MediaWatchSlots = MediaFileChange.slots,
                     overflowCheck: Duration = MediaFileChange.overflowCheck) async -> Bool
    {
        switch await slotOrChange(path: path, seen: seen, slots: slots, every: overflowCheck) {
        case .cancelled:
            return false
        case .changed:
            break
        case .slot:
            let changed = await watch(path, seen: seen)
            await slots.release()
            guard changed else { return false }
        }
        try? await Task.sleep(for: debounce)
        return !Task.isCancelled
    }

    /// The next reason for a tile to load again: its file changed (`next`), or `lateAnswer` said true (the decoder
    /// that ran past its deadline answered). A `lateAnswer` that says false leaves the file watch running.
    static func nextReload(path: String, seen: MediaFileIdentity?, lateAnswer: (@Sendable () async -> Bool)?,
                           debounce: Duration = .milliseconds(200)) async -> Bool
    {
        guard let lateAnswer else { return await next(path: path, seen: seen, debounce: debounce) }
        return await withTaskGroup(of: Bool.self) { group in
            group.addTask { await next(path: path, seen: seen, debounce: debounce) }
            group.addTask { await lateAnswer() }
            for await reload in group where reload {
                group.cancelAll()
                return true
            }
            return false
        }
    }

    private enum Wait: Sendable { case slot, changed, cancelled }

    /// A watch slot, or, while every slot stays taken, the file's own change, seen by its identity.
    private static func slotOrChange(path: String, seen: MediaFileIdentity?, slots: MediaWatchSlots,
                                     every interval: Duration) async -> Wait
    {
        await withTaskGroup(of: Wait.self) { group in
            group.addTask { await slots.acquire() ? .slot : .cancelled }
            group.addTask {
                while true {
                    do { try await Task.sleep(for: interval) } catch { return .cancelled }
                    if MediaFileIdentity.current(path) != seen { return .changed }
                }
            }
            let first = await group.next() ?? .cancelled
            group.cancelAll()
            // A slot granted just as the change was seen goes back.
            for await other in group where other == .slot { await slots.release() }
            return first
        }
    }

    private static func watch(_ path: String, seen: MediaFileIdentity?) async -> Bool {
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
                // Armed from here: a change before it shows as another identity, a change after it as an event.
                queue.async {
                    guard !outcome.changed, MediaFileIdentity.current(path) != seen else { return }
                    outcome.changed = true
                    source.cancel()
                }
            }
        } onCancel: {
            source.cancel()
        }
        return changed
    }
}

/// Watches allowed at once, handed out in request order. A request whose task is cancelled while it waits answers
/// false at once and takes no slot.
actor MediaWatchSlots {
    private let limit: Int
    private(set) var inUse = 0
    private var waiting: [(id: UUID, continuation: CheckedContinuation<Bool, Never>)] = []

    init(limit: Int) {
        self.limit = limit
    }

    var waitingCount: Int { waiting.count }

    func acquire() async -> Bool {
        guard !Task.isCancelled else { return false }
        if inUse < limit {
            inUse += 1
            return true
        }
        let id = UUID()
        return await withTaskCancellationHandler {
            await withCheckedContinuation { waiting.append((id, $0)) }
        } onCancel: {
            Task { await self.withdraw(id) }
        }
    }

    /// The slot goes to the oldest waiting request, or back to the pool.
    func release() {
        if waiting.isEmpty {
            inUse -= 1
        } else {
            waiting.removeFirst().continuation.resume(returning: true)
        }
    }

    private func withdraw(_ id: UUID) {
        guard let index = waiting.firstIndex(where: { $0.id == id }) else { return }
        waiting.remove(at: index).continuation.resume(returning: false)
    }
}
