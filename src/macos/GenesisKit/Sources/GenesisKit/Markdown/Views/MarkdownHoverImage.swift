//
//  MarkdownHoverImage.swift
//  GenesisKit
//
//  An image file in the hover preview (`MarkdownHoverPreview.swift`): the picture itself, fitted to the
//  panel, with its format and size in pixels under it. An SVG switches to its source and back.
//
//  The picture is decoded off the main thread by `MediaThumbnailCache`, keyed by the file's identity (an SVG
//  is drawn there by AppKit's own renderer, which runs no script). No web view is made
//  for a picture: the card's one web view stays under it, holding the SVG's source, so the switch is instant.
//

import AppKit
import SwiftUI

/// What the hover preview does with an image file.
enum MarkdownHoverImage {
    /// The picture as one preview shows it.
    enum Picture: Sendable {
        case loading
        case ready(MediaThumbnail)
        case failed(String)
    }

    /// A picture file: by its extension, no disk access.
    static func isImage(_ url: URL) -> Bool {
        MediaKind.of(path: url.path) == .image
    }

    /// A picture whose source is text the viewer shows (an SVG): the preview offers the source too.
    static func hasSource(_ url: URL) -> Bool {
        isImage(url) && FileTree.isReadable(url)
    }

    /// The pixels a picture is decoded at: the panel's long side on this display.
    static func pixels(for size: CGSize, scale: CGFloat) -> CGFloat {
        max(size.width, size.height) * max(1, scale)
    }

    /// The picture of `url`, decoded off the main thread: through the cache, by the file's identity, or for an
    /// SVG open as a tab with unsaved edits, from `draft`, as the tab shows it. `reload` forgets a failure.
    static func picture(url: URL, pixels: CGFloat, draft: String?, reload: Bool = false) async -> Picture {
        if let draft {
            let bucket = MediaThumbnailCache.bucket(forPixels: pixels)
            return await Task.detached(priority: .userInitiated) { () -> Picture in
                MediaThumbnailCache.decodeSVG(data: Data(draft.utf8), bucket: bucket).map(Picture.ready)
                    ?? .failed(MediaThumbnailCache.unreadableSVG)
            }.value
        }
        switch await MediaThumbnailCache.shared.thumbnail(path: url.path, maxPixels: pixels, kind: .image, reload: reload) {
        case .ready(let thumbnail): return .ready(thumbnail)
        case .failed(let reason): return .failed(reason)
        }
    }

    /// "PNG · 1200 × 800 px · 245 KB": the caption under the picture.
    static func caption(url: URL, size: CGSize?, bytes: Int64?) -> String {
        var parts = [url.pathExtension.uppercased()]
        if let size, size.width > 0, size.height > 0 {
            parts.append("\(Int(size.width.rounded())) × \(Int(size.height.rounded())) px")
        }
        if let bytes {
            parts.append(ByteCountFormatter.string(fromByteCount: bytes, countStyle: .file))
        }
        return parts.joined(separator: " · ")
    }
}

/// One preview's own state while it is up: an image file's picture as it loads, and whether the reader
/// switched to its source. A preview of another file starts again with the picture: nothing is remembered.
@MainActor
final class MarkdownHoverCardState: ObservableObject {
    /// nil for a note or a text file: the card shows the page.
    @Published var picture: MarkdownHoverImage.Picture?
    /// The SVG's source instead of its picture.
    @Published private(set) var showsSource = false
    /// The file's size, for the caption.
    let bytes: Int64?
    let hasSource: Bool
    private let reload: (() async -> MarkdownHoverImage.Picture)?

    /// A note or a text file.
    init() {
        picture = nil
        bytes = nil
        hasSource = false
        reload = nil
    }

    /// An image file. `reload` makes the picture again for Retry.
    init(picture: MarkdownHoverImage.Picture, bytes: Int64?, hasSource: Bool,
         reload: @escaping () async -> MarkdownHoverImage.Picture)
    {
        self.picture = picture
        self.bytes = bytes
        self.hasSource = hasSource
        self.reload = reload
    }

    /// The page shows (a note, a text file, an SVG's source), not a picture.
    var showsPage: Bool { picture == nil || showsSource }

    func toggleSource() {
        guard hasSource, picture != nil else { return }
        showsSource.toggle()
    }

    func retry() {
        guard let reload else { return }
        picture = .loading
        Task { [weak self] in
            let next = await reload()
            self?.picture = next
        }
    }
}

/// The picture of an image file, on the page colour: fitted to the pane, a raster picture at most at its own
/// size (a pixel per point), a vector always filling it, over a checkerboard where it is transparent. Its
/// format and size go under it. A failure says what failed and offers Retry.
struct MarkdownHoverPicturePane: View {
    let url: URL
    let picture: MarkdownHoverImage.Picture
    let bytes: Int64?
    let theme: MarkdownTheme
    let onRetry: () -> Void

    @Environment(\.displayScale) private var displayScale
    @GenReduceMotion private var reduceMotion

    var body: some View {
        content
            .padding(16)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(theme.page)
            // A picture that arrives after the panel opened fades in, at once under Reduce Motion.
            .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: phase)
    }

    private var phase: Int {
        switch picture {
        case .loading: 0
        case .ready: 1
        case .failed: 2
        }
    }

    private var name: String { url.lastPathComponent }

    @ViewBuilder private var content: some View {
        switch picture {
        case .loading:
            loading.transition(.opacity)
        case .ready(let thumbnail):
            ready(thumbnail).transition(.opacity)
        case .failed(let reason):
            failure(reason).transition(.opacity)
        }
    }

    private func ready(_ thumbnail: MediaThumbnail) -> some View {
        let caption = MarkdownHoverImage.caption(url: url, size: thumbnail.sourceSize, bytes: bytes)
        // A raster picture stops at its own size; a vector has none to stop at.
        let limit = MediaThumbnailCache.isVector(url.path) ? CGSize(width: CGFloat.infinity, height: .infinity) : thumbnail.sourceSize
        return VStack(spacing: 10) {
            Image(decorative: thumbnail.image, scale: max(1, displayScale))
                .resizable()
                .interpolation(.high)
                .aspectRatio(thumbnail.aspect, contentMode: .fit)
                // On the fitted picture itself, before the frame below widens it.
                .background { MarkdownHoverCheckerboard(dark: theme.isDark) }
                .overlay { Rectangle().strokeBorder(theme.border, lineWidth: 1) }
                .background(MarkdownHoverMarker(role: .picture))
                .frame(maxWidth: limit.width, maxHeight: limit.height)
                .accessibilityElement()
                .accessibilityLabel(Text(verbatim: "Picture of \(name), \(caption)"))
                .accessibilityIdentifier("markdown-hover-picture")
            Text(verbatim: caption)
                .font(GenTypography.mono(10))
                .foregroundStyle(theme.textMuted)
                .lineLimit(1)
                .truncationMode(.middle)
                .accessibilityHidden(true)
        }
    }

    private var loading: some View {
        VStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text("Loading the picture…")
                .font(.system(size: 11))
                .foregroundStyle(theme.textMuted)
        }
        .accessibilityElement(children: .combine)
    }

    private func failure(_ reason: String) -> some View {
        VStack(spacing: 8) {
            Image(systemName: "photo")
                .font(.system(size: 26, weight: .light))
                .foregroundStyle(theme.textMuted)
                .overlay(alignment: .bottomTrailing) {
                    Image(systemName: "exclamationmark.circle.fill")
                        .font(.system(size: 11))
                        .foregroundStyle(.orange)
                        .offset(x: 5, y: 3)
                }
                .accessibilityHidden(true)
            Text(verbatim: "No picture of \(name)")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(theme.text)
                .lineLimit(1)
                .truncationMode(.middle)
            Text(verbatim: reason)
                .font(.system(size: 11))
                .foregroundStyle(theme.textSecondary)
                .multilineTextAlignment(.center)
            Button(action: onRetry) {
                Label("Retry", systemImage: "arrow.clockwise")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(theme.text)
            }
            .buttonStyle(.genHover(accent: theme.accent))
            .background(MarkdownHoverMarker(role: .control))
            .instantTooltip("Make the picture again")
            .accessibilityLabel(Text(verbatim: "Retry the picture of \(name)"))
            .accessibilityIdentifier("markdown-hover-picture-retry")
        }
        .frame(maxWidth: 360)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(verbatim: "No picture of \(name): \(reason)"))
        .accessibilityIdentifier("markdown-hover-picture-failed")
    }
}

/// The header's switch between an SVG's picture and its source. It names the side it goes to.
struct MarkdownHoverSourceToggle: View {
    let showsSource: Bool
    let theme: MarkdownTheme
    let action: () -> Void

    var help: String { showsSource ? "Show the picture" : "Show the SVG code" }

    var body: some View {
        Button(action: action) {
            Label(showsSource ? "Image" : "Code", systemImage: showsSource ? "photo" : "chevron.left.forwardslash.chevron.right")
                .labelStyle(.titleAndIcon)
                .font(.system(size: 10.5, weight: .medium))
                .foregroundStyle(theme.textSecondary)
                .padding(.horizontal, 7)
                .padding(.vertical, 2.5)
                // At rest too: a control, not more of the header's text.
                .background(RoundedRectangle(cornerRadius: 5, style: .continuous).fill(theme.fill))
        }
        .buttonStyle(.genHover(accent: theme.accent, cornerRadius: 5, padding: EdgeInsets()))
        .background(MarkdownHoverMarker(role: .control))
        .instantTooltip(help)
        .accessibilityLabel(Text(verbatim: help))
        .accessibilityIdentifier("markdown-hover-source-toggle")
    }
}

/// Transparency as image editors show it: squares a step apart in the theme's lightness.
private struct MarkdownHoverCheckerboard: View {
    let dark: Bool
    static let square: CGFloat = 8

    var body: some View {
        Canvas(opaque: true) { context, size in
            let base = dark ? Color(white: 0.20) : Color.white
            let other = dark ? Color(white: 0.26) : Color(white: 0.91)
            context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(base))
            var squares = Path()
            let side = Self.square
            for row in 0..<Int((size.height / side).rounded(.up)) {
                for column in 0..<Int((size.width / side).rounded(.up)) where (row + column) % 2 == 1 {
                    squares.addRect(CGRect(x: CGFloat(column) * side, y: CGFloat(row) * side, width: side, height: side))
                }
            }
            context.fill(squares, with: .color(other))
        }
        .accessibilityHidden(true)
    }
}

/// Marks a place in the card for the panel, which sees AppKit views, not SwiftUI ones: a control a click must
/// reach (the source switch, Retry), or the picture (the image viewer grows from it). It takes no events.
struct MarkdownHoverMarker: NSViewRepresentable {
    enum Role {
        case control
        case picture
    }

    let role: Role

    func makeNSView(context: Context) -> MarkerView {
        MarkerView(role: role)
    }

    func updateNSView(_ view: MarkerView, context: Context) {
        view.role = role
    }

    final class MarkerView: NSView {
        var role: Role

        init(role: Role) {
            self.role = role
            super.init(frame: .zero)
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) { nil }

        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }

    /// The markers for `role` under `view`, in window coordinates.
    @MainActor
    static func rects(_ role: Role, in view: NSView) -> [CGRect] {
        var found: [CGRect] = []
        func walk(_ view: NSView) {
            if let marker = view as? MarkerView, marker.role == role, !marker.isHiddenOrHasHiddenAncestor {
                found.append(marker.convert(marker.bounds, to: nil))
            }
            view.subviews.forEach(walk)
        }
        walk(view)
        return found
    }
}
