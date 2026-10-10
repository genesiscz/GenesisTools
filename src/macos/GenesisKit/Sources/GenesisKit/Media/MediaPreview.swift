import AVKit
import AppKit
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

    public init() {}

    public var isOpen: Bool { !items.isEmpty }
    public var current: MediaPreviewItem? { items.indices.contains(index) ? items[index] : nil }

    public func present(_ items: [MediaPreviewItem], selectedID: String? = nil) {
        guard !items.isEmpty else { return }
        if let other = Self.active, other !== self { other.dismiss() }
        self.items = items
        index = items.firstIndex { $0.id == selectedID } ?? 0
        Self.active = self
    }

    public func dismiss() {
        guard isOpen else { return }
        items = []
        index = 0
        if Self.active === self { Self.active = nil }
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
    @State private var copied = false

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
            if copied {
                Label("Copied", systemImage: "checkmark").font(.system(size: 10, weight: .medium))
                    .foregroundStyle(.green).transition(.opacity)
            }
            if item.kind == .image {
                IconButton(systemName: "doc.on.doc", tooltip: "Copy image") { copy(item) }
            }
            IconButton(systemName: "folder", tooltip: "Show in Finder") { PathOpener.reveal(item.path) }
            IconButton(systemName: "arrow.up.forward.app", tooltip: "Open in its app") { PathOpener.open(item.path) }
            IconButton(systemName: "xmark", tooltip: "Close preview (Esc)") { state.dismiss() }
                .accessibilityIdentifier("media-preview-close")
        }
        .foregroundStyle(.primary)
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

    private func copy(_ item: MediaPreviewItem) {
        let path = item.path
        Task {
            let data = await Task.detached(priority: .userInitiated) { try? Data(contentsOf: URL(fileURLWithPath: path)) }.value
            guard let data, let image = NSImage(data: data) else { return }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.writeObjects([image, URL(fileURLWithPath: path) as NSURL])
            withAnimation(.easeOut(duration: 0.15)) { copied = true }
            try? await Task.sleep(for: .seconds(1.4))
            withAnimation(.easeOut(duration: 0.3)) { copied = false }
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
