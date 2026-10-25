//
//  MarkdownImageViewer.swift
//  GenesisKit
//
//  A double-click on a picture in the rendered note opens GenesisKit's image
//  viewer, grown from the picture's place on the page. The page names each
//  picture only by its `src`; Swift opens a picture only when the page could
//  load it anyway: a `gnmedia:` token this render registered (the file is
//  admitted again, so it is still inside the vault or the note's folder), or a
//  `data:image/` URL of an image type the page allows (written to a private
//  temporary file). Remote pictures never open.
//

import AppKit

import WebKit

extension MarkdownWebView.Coordinator {
    /// A picture the viewer may show, and whether it came from an embedded `data:` URL.
    struct ViewerFile {
        let url: URL
        let temporary: Bool
    }

    /// The MIME types the page shows, by the extension the temporary file gets.
    static let viewerDataTypes: [String: String] = MarkdownMedia.imageTypes.reduce(into: [:]) { out, pair in
        out[pair.value] = out[pair.value] ?? (pair.key == "jpeg" ? "jpg" : pair.key)
    }

    /// The registry's file for a `gnmedia://m/<token>` this render handed out; nil for anything else.
    func viewerFile(token src: String) -> ViewerFile? {
        guard src.lowercased().hasPrefix("\(MarkdownMedia.scheme)://"), let url = URL(string: src), url.host == "m",
              url.pathComponents.count == 2, let entry = media.entry(url.lastPathComponent), entry.kind == .image,
              let file = entry.readableURL else { return nil }
        return ViewerFile(url: file, temporary: false)
    }

    static func isDataImage(_ src: String) -> Bool {
        src.prefix(11).lowercased() == "data:image/"
    }

    /// `image.press`: the first click of what may be a double-click. The picture decodes now, so the viewer opens
    /// with it a moment later.
    @MainActor
    func prefetchViewerImage(_ body: [String: Any]) {
        guard let src = body["src"] as? String else { return }
        if let file = viewerFile(token: src) {
            ImageViewer.prefetch(path: file.url.path, screen: web?.window?.screen)
        } else if Self.isDataImage(src) {
            ImageViewer.prepare()
        }
    }

    /// `image.open`: the page's pictures in document order, the double-clicked one, and its rect in CSS pixels.
    @MainActor
    func openImageViewer(_ body: [String: Any]) {
        let started = CACurrentMediaTime()
        guard let web, let window = web.window, let selected = body["n"] as? Int,
              let images = body["images"] as? [[String: Any]] else { return }
        // Read the click's rect now: the page may scroll while embedded pictures are written out.
        let origin = (body["rect"] as? [String: Any]).flatMap { viewerOrigin(css: $0, in: web) }
        let embedded = images.compactMap { image -> (Int, String)? in
            guard let number = image["n"] as? Int, let src = image["src"] as? String, Self.isDataImage(src) else { return nil }
            return (number, src)
        }
        let request: ([Int: URL]) -> Void = { [weak self] written in
            guard let self, let web = self.web else { return }
            var items: [ImageViewerItem] = []
            for image in images {
                guard let number = image["n"] as? Int, let src = image["src"] as? String else { continue }
                let alt = (image["alt"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                let group = image["row"] as? String
                if let file = self.viewerFile(token: src) {
                    items.append(ImageViewerItem(id: String(number), path: file.url.path, group: group))
                } else if let file = written[number] {
                    items.append(ImageViewerItem(id: String(number), path: file.path,
                                                 name: alt ?? "Embedded picture \(number + 1)", group: group, isTemporary: true))
                }
            }
            guard items.contains(where: { $0.id == String(selected) }) else {
                PerfLog.mark("imageviewer.refused n=\(selected) (not a vault or embedded picture)")
                // Moved or deleted since the render: the double-click gets an answer.
                self.show(.pictureGone)
                return
            }
            ImageViewer.present(ImageViewerRequest(
                ownerID: ObjectIdentifier(web), items: items, selectedID: String(selected), origin: origin,
                background: self.viewerBackground, level: window.level, screen: window.screen,
                currentOrigin: { [weak self] item in await self?.currentViewerOrigin(of: item) },
                startedAt: started))
        }
        guard !embedded.isEmpty else {
            request([:])
            return
        }
        // Decoding and writing an embedded picture is file work: off the main thread.
        let types = Self.viewerDataTypes
        Task.detached(priority: .userInitiated) {
            var written: [Int: URL] = [:]
            for (number, src) in embedded {
                written[number] = MediaDataURL.materialize(src, allowed: types, maxBytes: MarkdownMedia.maxImageBytes)
            }
            await MainActor.run { request(written) }
        }
    }

    /// Where a picture is on the page now, for the zoom back: nil when the page is hidden or the picture has
    /// scrolled away (the viewer then fades).
    @MainActor
    func currentViewerOrigin(of item: ImageViewerItem) async -> ImageViewerOrigin? {
        guard let web, let window = web.window, window.isVisible, !window.isMiniaturized,
              window.occlusionState.contains(.visible), let number = Int(item.id) else { return nil }
        guard let json = try? await web.evaluateJavaScript("window.gnImageRect(\(number))") as? String,
              let data = json.data(using: .utf8),
              let rect = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return viewerOrigin(css: rect, in: web)
    }

    /// A CSS rect from `getBoundingClientRect()` on screen: through the text zoom and the pinch magnification
    /// (`WebImageRect`), then the web view's own conversion. Nil when too little of it is visible.
    @MainActor
    func viewerOrigin(css: [String: Any], in web: WKWebView) -> ImageViewerOrigin? {
        func number(_ key: String) -> CGFloat? { (css[key] as? NSNumber).map { CGFloat($0.doubleValue) } }
        guard let window = web.window, let x = number("x"), let y = number("y"), let width = number("w"),
              let height = number("h"), width > 0, height > 0 else { return nil }
        let rect = WebImageRect.viewRect(css: CGRect(x: x, y: y, width: width, height: height), pageZoom: web.pageZoom,
                                         magnification: web.magnification)
        let visible = web.visibleRect
        guard WebImageRect.isVisible(rect, in: visible) else { return nil }
        return ImageViewerOrigin(
            rect: window.convertToScreen(web.convert(rect, to: nil)),
            clip: window.convertToScreen(web.convert(visible, to: nil)),
            cornerRadius: (number("radius") ?? 0) * web.pageZoom * web.magnification)
    }

    /// The page's own background when it is dark; the viewer stays dark under the light theme.
    var viewerBackground: NSColor {
        guard let hex = parent.cssVariables?["--dd-bg"], hex.hasPrefix("#"), hex.count == 7,
              let value = Int(hex.dropFirst(), radix: 16) else { return ImageViewerRequest.defaultBackground }
        let color = NSColor(srgbRed: CGFloat((value >> 16) & 0xff) / 255, green: CGFloat((value >> 8) & 0xff) / 255,
                            blue: CGFloat(value & 0xff) / 255, alpha: 1)
        return color.brightnessComponent < 0.3 ? color : ImageViewerRequest.defaultBackground
    }
}
