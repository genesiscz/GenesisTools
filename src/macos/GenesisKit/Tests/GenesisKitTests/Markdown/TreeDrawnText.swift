import AppKit
import Vision

/// The text a view draws, read back with Vision. SwiftUI's list rows are neither views nor in-process accessibility
/// children, and a test process has no accessibility windows, so the pixels are the one honest witness of which rows
/// are on screen (the sidebar reveal tests).
@MainActor
enum TreeDrawnText {
    /// Reads the text actually drawn in a view, optionally saving the captured pixels.
    static func lines(of view: NSView, savingTo png: String? = nil) -> [String] {
        placed(in: view, savingTo: png).map(\.text)
    }

    /// Each drawn line with the height of its middle in the view: 0 at the top, 1 at the bottom.
    static func placed(in view: NSView, savingTo png: String? = nil) -> [(text: String, middle: Double)] {
        let rect = view.bounds
        guard let rep = view.bitmapImageRepForCachingDisplay(in: rect) else { return [] }
        view.cacheDisplay(in: rect, to: rep)
        if let png {
            try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: png))
        }
        guard let image = rep.cgImage else { return [] }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try? VNImageRequestHandler(cgImage: image).perform([request])
        return (request.results ?? []).compactMap { result in
            result.topCandidates(1).first.map { (text: $0.string, middle: 1 - Double(result.boundingBox.midY)) }
        }
    }

    /// The tallest scroll view in the window's left third: the file tree's.
    static func treeScroll(in window: NSWindow) -> NSScrollView? {
        var found: [NSScrollView] = []
        func walk(_ view: NSView) {
            if let scroll = view as? NSScrollView { found.append(scroll) }
            view.subviews.forEach(walk)
        }
        guard let content = window.contentView else { return nil }
        walk(content)
        return found
            .filter { $0.convert($0.bounds, to: nil).midX < window.frame.width / 3 }
            .max { ($0.documentView?.frame.height ?? 0) < ($1.documentView?.frame.height ?? 0) }
    }
}
