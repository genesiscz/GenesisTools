import SwiftUI

/// The images and videos of a draft or a sent message: real pictures, a poster frame and the length for a video,
/// its preparation state, and a click that previews it inside the widget.
struct WidgetAttachmentStrip: View {
    let assets: [WidgetAsset]
    let manifests: [String: WidgetVideoManifest]
    let tile: CGSize
    /// Nil for a sent message: its attachments can no longer be removed.
    let remove: ((WidgetAsset) -> Void)?
    let showMedia: (WidgetMediaSelection) -> Void

    private var gallery: [MediaPreviewItem] { assets.map(Self.item) }

    static func item(_ asset: WidgetAsset) -> MediaPreviewItem {
        MediaPreviewItem(
            id: asset.id, path: asset.path, name: asset.name, kind: asset.type == "video" ? .video : .image,
            duration: asset.durationUs.map { $0 / 1_000_000 })
    }

    var body: some View {
        ScrollView(.horizontal) {
            HStack(alignment: .top, spacing: 8) {
                ForEach(assets) { asset in
                    WidgetAssetTile(
                        asset: asset, manifest: manifests[asset.id], tile: tile, gallery: gallery,
                        remove: remove, showMedia: showMedia)
                }
            }
            .padding(.bottom, assets.count > 1 ? 4 : 0)
        }
        .scrollIndicators(.automatic)
        .scrollDisabled(assets.count < 2)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text(verbatim: assets.count == 1 ? "1 attachment" : "\(assets.count) attachments"))
    }
}

private struct WidgetAssetTile: View {
    let asset: WidgetAsset
    let manifest: WidgetVideoManifest?
    let tile: CGSize
    let gallery: [MediaPreviewItem]
    let remove: ((WidgetAsset) -> Void)?
    let showMedia: (WidgetMediaSelection) -> Void

    private var isVideo: Bool { asset.type == "video" }
    private var preparing: Bool { ["pending", "preparing"].contains(asset.status ?? "") }
    private var reviewRequired: Bool {
        isVideo && (asset.settings?.minimumDifferencePct ?? 0) > 0 && asset.confirmedRevision != asset.revision
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            MediaThumbnailView(
                item: WidgetAttachmentStrip.item(asset), gallery: gallery,
                aspect: asset.height > 0 ? CGFloat(asset.width) / CGFloat(asset.height) : nil,
                emphasis: tile.height < 56 ? .compact : .regular
            )
            .frame(width: tile.width, height: tile.height)
            .overlay(alignment: .bottomLeading) {
                if preparing {
                    ProgressView().controlSize(.mini).padding(5)
                        .background(Circle().fill(.black.opacity(0.55))).padding(4)
                        .accessibilityLabel(Text(verbatim: "Preparing \(asset.name)"))
                }
            }
            .overlay(alignment: .topTrailing) {
                if let remove {
                    IconButton(systemName: "xmark.circle.fill", tooltip: "Remove \(asset.name)", size: 13, tint: .white) {
                        remove(asset)
                    }
                    .background(Circle().fill(.black.opacity(0.5)).padding(3))
                    .offset(x: 6, y: -6)
                    .accessibilityIdentifier("widget.attachment.remove." + asset.id)
                }
            }
            .accessibilityIdentifier("widget.attachment." + asset.id)
            HStack(spacing: 3) {
                Text(verbatim: asset.name)
                    .font(.system(size: 10, weight: .medium)).lineLimit(1).truncationMode(.middle)
                if isVideo {
                    Spacer(minLength: 0)
                    IconButton(
                        systemName: "slider.horizontal.3",
                        tooltip: reviewRequired ? "Review the skipped frames before sending" : "Frame sampling for the agent",
                        size: 9, tint: reviewRequired ? .orange : nil
                    ) { showMedia(.video(asset.id)) }
                }
            }
            .frame(width: tile.width, alignment: .leading)
            Text(verbatim: detail)
                .font(.system(size: 9).monospacedDigit())
                .foregroundStyle(asset.error != nil || reviewRequired ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
                .lineLimit(1)
                .frame(width: tile.width, alignment: .leading)
                .instantTooltip(asset.error ?? detail)
        }
        // Room for the remove badge that sits over the corner.
        .padding(.top, remove == nil ? 0 : 6)
        .padding(.trailing, remove == nil ? 0 : 6)
    }

    private var detail: String {
        if asset.error != nil { return "Preparation failed" }
        guard isVideo else {
            return asset.width > 0 ? "\(asset.width) × \(asset.height)" : (asset.mimeType ?? "Image")
        }
        if preparing {
            if let progress = asset.progress, progress.total > 0 {
                return "Preparing \(progress.completed)/\(progress.total)"
            }
            return "Preparing frames…"
        }
        guard let counts = manifest?.counts else { return asset.status?.capitalized ?? "Video" }
        return reviewRequired ? "Review \(counts.kept) frames" : "\(counts.kept) frames · \(counts.images) images"
    }
}

/// The pictures an inbox item carries, for every kind (decision, todo, form, result, answer, message): thumbnails
/// at their own aspect ratio that preview in place, all of them, and a side-by-side compare for two or more.
struct WidgetCardAttachments: View {
    let card: WidgetCard
    let height: CGFloat
    let maxWidth: CGFloat
    let compare: Bool
    let showMedia: (WidgetMediaSelection) -> Void

    private var gallery: [MediaPreviewItem] { card.attachments.map(Self.item) }

    static func item(_ image: WidgetImageReference) -> MediaPreviewItem {
        MediaPreviewItem(id: image.id, path: image.path, name: image.label ?? image.name)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ScrollView(.horizontal) {
                HStack(alignment: .top, spacing: 8) {
                    ForEach(card.attachments) { image in
                        let aspect = image.height > 0 ? CGFloat(image.width) / CGFloat(image.height) : nil
                        let size = MediaThumbnailView.frame(
                            aspect: aspect, height: height, maxWidth: maxWidth, minWidth: height * 0.6)
                        VStack(alignment: .leading, spacing: 3) {
                            MediaThumbnailView(item: Self.item(image), gallery: gallery, aspect: aspect)
                                .frame(width: size.width, height: size.height)
                            Text(verbatim: image.label ?? image.name)
                                .font(.system(size: 10)).foregroundStyle(.secondary)
                                .lineLimit(1).truncationMode(.middle)
                                .frame(width: size.width, alignment: .leading)
                        }
                        .accessibilityIdentifier("widget.card.attachment." + image.id)
                    }
                }
                .padding(.bottom, card.attachments.count > 1 ? 4 : 0)
            }
            .scrollIndicators(.automatic)
            if compare && card.attachments.count > 1 {
                Button {
                    showMedia(.images(card.attachments, card.attachments[0].id))
                } label: {
                    Label("Compare side by side…", systemImage: "rectangle.split.2x1")
                        .font(.system(size: 11))
                }
                .buttonStyle(.genHoverPlain())
                .instantTooltip("Single, side by side, wipe and pixel difference views")
            }
        }
    }
}

/// The typed outcomes of a screenshot as both capture doors (`hub widget call` capture, `hub widget shelf capture`)
/// report them. Escape is a result, `{"cancelled": true, "reason": "user"}`, never an error. A missing Screen
/// Recording grant is an error whose text starts with `[screen-recording-denied]` (`SCREEN_RECORDING_DENIED` in
/// src/hub/lib/widget/screenshot.ts); the permissions dialog decides what the user sees for it.
public enum WidgetCaptureError {
    public static let screenRecordingDenied = "screen-recording-denied"

    public static func isScreenRecordingDenied(_ error: Error) -> Bool {
        isScreenRecordingDenied(message: error.localizedDescription)
    }

    public static func isScreenRecordingDenied(message: String) -> Bool {
        message.contains("[\(screenRecordingDenied)]")
    }
}
