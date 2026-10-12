import AVKit
import AppKit
import Combine
import SwiftUI

/// One file a preview can show: a picture, a video or a document.
public struct MediaPreviewItem: Identifiable, Hashable, Sendable {
    public let id: String
    public let path: String
    public let name: String
    public let kind: MediaKind
    /// Seconds, when the caller already knows a video's length.
    public let duration: Double?

    public init(id: String? = nil, path: String, name: String? = nil, kind: MediaKind? = nil, duration: Double? = nil) {
        self.id = id ?? path
        self.path = path
        self.name = name ?? (path as NSString).lastPathComponent
        self.kind = kind ?? MediaKind.of(path: path)
        self.duration = duration
    }
}

/// The in-place preview of one surface (a widget panel, a module). At most one is open across all surfaces, and that
/// one answers the keyboard (`MediaPreviewKeyboard`).
@MainActor
public final class MediaPreviewState: ObservableObject {
    @Published public private(set) var items: [MediaPreviewItem] = []
    @Published public private(set) var index = 0

    static weak var active: MediaPreviewState?

    /// The item the preview opened on: its thumbnail opened it, and gets the keyboard back when it closes.
    private var openedID: String?
    /// The opener's item id, sent once the preview has closed and the surface under it takes input again
    /// (`MediaThumbnailView` focuses its button on it). A passthrough, so a late subscriber is not focused.
    public let focusReturns = PassthroughSubject<String, Never>()

    /// The Copy button: one copy at a time, and a refusal says why.
    public enum CopyStatus: Equatable {
        case idle, copying, copied
        case refused(String)
    }

    @Published public private(set) var copyStatus: CopyStatus = .idle
    /// Checks and reads the file off the main actor, inside `MediaImageCopy`'s budget; tests answer without a file.
    var loadImage: @Sendable (_ path: String) async -> MediaImageCopy.Outcome = { path in
        await Task.detached(priority: .userInitiated) { MediaImageCopy.prepare(path: path) }.value
    }
    /// Puts the prepared picture, or only the file, on the pasteboard and answers what to tell the user; tests record
    /// instead of touching the user's clipboard.
    var writeImage: @MainActor (_ outcome: MediaImageCopy.Outcome, _ path: String) -> CopyStatus =
        MediaImageCopy.writeToPasteboard
    private var copyReset: Task<Void, Never>?
    private var copyTimeout: Task<Void, Never>?
    /// How long Copy waits for the read. The read itself cannot be stopped (a file on a stalled network volume blocks
    /// in the kernel), so past this the copy is refused and its late answer is dropped.
    var copyDeadline: Duration = .seconds(10)
    /// A read that has not returned yet, expired or not. A new click while it runs starts no second read beside it.
    private var readInFlight = false
    /// The copy whose answer may still reach the clipboard. An expired copy is never the current one.
    private var copyGeneration = 0

    public init() {}

    public var isOpen: Bool { !items.isEmpty }

    /// Copies the picture and its file. A click while a copy runs is ignored, and so is one while an expired read is
    /// still running, so repeated clicks never start parallel reads of one file.
    public func copyImage(_ item: MediaPreviewItem) {
        guard copyStatus != .copying else { return }
        guard !readInFlight else {
            showCopy(.refused("The last image read has not finished yet. Try again in a moment."))
            return
        }
        copyReset?.cancel()
        copyGeneration &+= 1
        let generation = copyGeneration
        readInFlight = true
        copyStatus = .copying
        let load = loadImage
        Task { [weak self] in
            let outcome = await load(item.path)
            guard let self else { return }
            self.readInFlight = false
            // Expired (the deadline answered) or replaced: this answer never reaches the clipboard.
            guard generation == self.copyGeneration, self.copyStatus == .copying else {
                GenesisKit.log("media copy of \(item.path) answered after its deadline; dropped")
                return
            }
            self.copyTimeout?.cancel()
            self.finishCopy(outcome, item: item)
        }
        let deadline = copyDeadline
        copyTimeout = Task { [weak self] in
            try? await Task.sleep(for: deadline)
            guard !Task.isCancelled, let self, generation == self.copyGeneration, self.copyStatus == .copying else {
                return
            }
            self.copyGeneration &+= 1
            GenesisKit.log("media copy of \(item.path) timed out after \(deadline)")
            self.showCopy(.refused("Reading the image took too long; its volume may be slow or unavailable."))
        }
    }

    private func finishCopy(_ outcome: MediaImageCopy.Outcome, item: MediaPreviewItem) {
        switch outcome {
        case .image, .fileOnly:
            showCopy(writeImage(outcome, item.path))
        case .failed(let reason):
            GenesisKit.log("media copy failed \(item.path): \(reason)")
            showCopy(.refused(reason))
        }
    }

    private func showCopy(_ status: CopyStatus) {
        copyReset?.cancel()
        copyStatus = status
        let shown: Duration = status == .copied ? .seconds(1.4) : .seconds(5)
        copyReset = Task { [weak self] in
            try? await Task.sleep(for: shown)
            if !Task.isCancelled { self?.copyStatus = .idle }
        }
    }

    public var current: MediaPreviewItem? { items.indices.contains(index) ? items[index] : nil }

    public func present(_ items: [MediaPreviewItem], selectedID: String? = nil) {
        guard !items.isEmpty else { return }
        // The other surface's preview closes without taking the keyboard back: this one is taking it.
        if let other = Self.active, other !== self { other.close(returningFocus: false) }
        self.items = items
        index = items.firstIndex { $0.id == selectedID } ?? 0
        openedID = items[index].id
        Self.active = self
    }

    public func dismiss() {
        close(returningFocus: true)
    }

    private func close(returningFocus: Bool) {
        guard isOpen else { return }
        let opener = openedID
        // A copy's "Copied" or refusal belongs to this preview; one still reading ends by its deadline.
        if copyStatus != .copying {
            copyReset?.cancel()
            copyStatus = .idle
        }
        items = []
        index = 0
        openedID = nil
        if Self.active === self { Self.active = nil }
        guard returningFocus, let opener else { return }
        // A turn later: the surface is disabled while the preview is up, and a disabled button takes no focus.
        DispatchQueue.main.async { [weak self] in
            self?.focusReturns.send(opener)
        }
    }

    public func step(_ delta: Int) {
        guard items.count > 1 else { return }
        index = (index + delta % items.count + items.count) % items.count
    }
}

/// Quick Look's keys for the open in-place preview. A window's own key handler asks first and stops when it is true:
/// Esc and Space close, ← and → move through the set. Space and the arrows stay with a text field being edited.
public enum MediaPreviewKeyboard {
    @MainActor public static var isOpen: Bool { MediaPreviewState.active?.isOpen == true }

    @MainActor
    public static func handle(keyCode: UInt16, editingText: Bool) -> Bool {
        guard let state = MediaPreviewState.active, state.isOpen else { return false }
        switch keyCode {
        case 53:
            state.dismiss()
        case 49 where !editingText:
            state.dismiss()
        case 123 where !editingText:
            state.step(-1)
        case 124 where !editingText:
            state.step(1)
        default:
            return false
        }
        return true
    }
}

private struct MediaPreviewKey: EnvironmentKey {
    static let defaultValue: MediaPreviewState? = nil
}

extension EnvironmentValues {
    /// The surface's preview, set by `.mediaPreviewHost()`. Nil outside one: a thumbnail then opens the file.
    public var mediaPreview: MediaPreviewState? {
        get { self[MediaPreviewKey.self] }
        set { self[MediaPreviewKey.self] = newValue }
    }
}

extension View {
    /// Lets every `MediaThumbnailView` inside preview its file over this view, Quick Look style, instead of in a
    /// new window. Put it on the surface that should be covered (a panel's content, a module).
    public func mediaPreviewHost() -> some View {
        modifier(MediaPreviewHost())
    }
}

private struct MediaPreviewHost: ViewModifier {
    @StateObject private var state = MediaPreviewState()
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    @Environment(\.widgetReduceMotion) private var widgetReduceMotion

    func body(content: Content) -> some View {
        let reduceMotion = systemReduceMotion || widgetReduceMotion
        content
            .environment(\.mediaPreview, state)
            // The covered surface leaves the keyboard order and the accessibility tree while the preview is up:
            // `.isModal` on the overlay alone let Tab reach the inbox buttons and composer fields behind it.
            .disabled(state.isOpen)
            .accessibilityHidden(state.isOpen)
            .overlay {
                if state.isOpen {
                    MediaPreviewOverlay(state: state)
                        .transition(
                            reduceMotion
                                ? .opacity
                                : .opacity.combined(with: .scale(scale: 0.96)))
                }
            }
            .animation(reduceMotion ? .easeOut(duration: 0.12) : .spring(response: 0.26, dampingFraction: 0.9),
                value: state.isOpen)
            .onDisappear { state.dismiss() }
    }
}

private struct MediaPreviewOverlay: View {
    @ObservedObject var state: MediaPreviewState
    @Environment(\.accessibilityReduceTransparency) private var systemReduceTransparency
    @Environment(\.widgetReduceTransparency) private var widgetReduceTransparency
    /// The keyboard moves into the preview when it opens, so a field behind it is no longer being edited.
    @FocusState private var focused: Bool

    var body: some View {
        ZStack {
            backdrop
            if let item = state.current {
                VStack(spacing: 10) {
                    header(item)
                    ZStack {
                        MediaPreviewContent(item: item).id(item.id)
                        if state.items.count > 1 { stepButtons }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                .padding(14)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .focusable()
        .focusEffectDisabled()
        .focused($focused)
        .onAppear { focused = true }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("media-preview")
        .accessibilityAddTraits(.isModal)
    }

    private var backdrop: some View {
        Group {
            if systemReduceTransparency || widgetReduceTransparency {
                Rectangle().fill(Color.black.opacity(0.92))
            } else {
                Rectangle().fill(.ultraThinMaterial).overlay(Color.black.opacity(0.55))
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { state.dismiss() }
        .accessibilityHidden(true)
    }

    private func header(_ item: MediaPreviewItem) -> some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: item.name)
                    .font(.system(size: 12, weight: .semibold)).lineLimit(1).truncationMode(.middle)
                if state.items.count > 1 {
                    Text(verbatim: "\(state.index + 1) of \(state.items.count)")
                        .font(.system(size: 10).monospacedDigit()).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 8)
            switch state.copyStatus {
            case .copied:
                Label("Copied", systemImage: "checkmark").font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.green).transition(.opacity)
            case .refused(let message):
                Label(message, systemImage: "exclamationmark.triangle").font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.orange).lineLimit(2).frame(maxWidth: 280, alignment: .trailing)
                    .transition(.opacity)
            case .copying:
                ProgressView().controlSize(.small).accessibilityLabel("Copying the image")
            case .idle:
                EmptyView()
            }
            if item.kind == .image {
                IconButton(systemName: "doc.on.doc", tooltip: "Copy image") { state.copyImage(item) }
                    .disabled(state.copyStatus == .copying)
            }
            IconButton(systemName: "folder", tooltip: "Show in Finder") { PathOpener.reveal(item.path) }
            IconButton(systemName: "arrow.up.forward.app", tooltip: "Open in its app") { PathOpener.open(item.path) }
            IconButton(systemName: "xmark", tooltip: "Close preview (Esc)") { state.dismiss() }
                .accessibilityIdentifier("media-preview-close")
        }
        .foregroundStyle(.primary)
        .animation(.easeOut(duration: 0.15), value: state.copyStatus)
    }

    private var stepButtons: some View {
        HStack {
            stepButton(systemName: "chevron.left", tooltip: "Previous (←)") { state.step(-1) }
            Spacer()
            stepButton(systemName: "chevron.right", tooltip: "Next (→)") { state.step(1) }
        }
        .padding(.horizontal, 2)
    }

    private func stepButton(systemName: String, tooltip: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 13, weight: .semibold))
                .frame(width: 28, height: 28)
                .background(Circle().fill(.black.opacity(0.45)))
                .overlay(Circle().strokeBorder(.white.opacity(0.15)))
                .contentShape(Circle())
        }
        .buttonStyle(.genHoverPlain(scale: 1.06))
        .instantTooltip(tooltip)
        .accessibilityLabel(Text(tooltip))
    }
}

extension MediaImageCopy {
    /// Puts what `prepare` made on the pasteboard: the picture as TIFF beside its file, or the file alone when the
    /// original is too large to copy as a picture. The answer is what the preview tells the user.
    @MainActor
    static func writeToPasteboard(_ outcome: Outcome, path: String) -> MediaPreviewState.CopyStatus {
        let pasteboard = NSPasteboard.general
        let file = URL(fileURLWithPath: path) as NSURL
        let notCopied = MediaPreviewState.CopyStatus.refused("The image could not be put on the clipboard.")
        switch outcome {
        case .image(let tiff):
            let picture = NSPasteboardItem()
            picture.setData(tiff, forType: .tiff)
            pasteboard.clearContents()
            return pasteboard.writeObjects([picture, file]) ? .copied : notCopied
        case .fileOnly(let reason):
            pasteboard.clearContents()
            return pasteboard.writeObjects([file]) ? .refused("Copied the file only. \(reason)") : notCopied
        case .failed(let reason):
            return .refused(reason)
        }
    }
}

/// The picture at the preview's own size, or the video playing, or a document's Quick Look thumbnail.
private struct MediaPreviewContent: View {
    let item: MediaPreviewItem

    var body: some View {
        switch item.kind {
        case .video:
            MediaInlinePlayer(path: item.path)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        case .image, .file:
            MediaThumbnailView(item: item, cornerRadius: 10, interactive: false, emphasis: .large)
        }
    }
}

private struct MediaInlinePlayer: NSViewRepresentable {
    let path: String

    func makeNSView(context: Context) -> AVPlayerView {
        let view = AVPlayerView()
        view.controlsStyle = .inline
        view.videoGravity = .resizeAspect
        view.showsFullScreenToggleButton = false
        let player = AVPlayer(url: URL(fileURLWithPath: path))
        view.player = player
        player.play()
        return view
    }

    func updateNSView(_ view: AVPlayerView, context: Context) {}

    static func dismantleNSView(_ view: AVPlayerView, coordinator: ()) {
        view.player?.pause()
        view.player = nil
    }
}
