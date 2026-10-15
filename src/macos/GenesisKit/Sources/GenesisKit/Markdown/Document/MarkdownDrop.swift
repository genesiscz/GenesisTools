//
//  MarkdownDrop.swift
//  GenesisKit
//
//  Dropping a file from Finder onto the markdown window opens it as a tab.
//
//  Three views have to agree on that, because AppKit gives a drop to the
//  deepest view that registered for it: the WKWebView would navigate to the
//  file, the NSTextView would paste its path into the document, and only the
//  chrome around them would reach a SwiftUI drop target. So the two AppKit
//  views take file drops themselves and hand the URLs back here.
//

import AppKit
import UniformTypeIdentifiers
import WebKit

enum MarkdownDrop {
    /// The dragged file URLs, or an empty array when the drag carries none.
    static func urls(from pasteboard: NSPasteboard) -> [URL] {
        let options: [NSPasteboard.ReadingOptionKey: Any] = [.urlReadingFileURLsOnly: true]
        guard pasteboard.canReadObject(forClasses: [NSURL.self], options: options),
              let items = pasteboard.readObjects(forClasses: [NSURL.self], options: options) as? [URL]
        else { return [] }
        return items
    }

    /// Split what was dropped: what the window can render becomes tabs, and
    /// everything else goes to the app that owns it. A drop that did nothing
    /// at all would look like the window ignored it.
    static func split(_ urls: [URL]) -> (tabs: [URL], external: [URL]) {
        var tabs: [URL] = []
        var external: [URL] = []
        for url in urls {
            var isDirectory: ObjCBool = false
            let exists = FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory)
            guard exists else { continue }
            // A folder is where you browse, not what you read: it becomes the
            // file sidebar's root instead of a tab.
            if isDirectory.boolValue { continue }
            if FileTree.isReadable(url) { tabs.append(url) } else { external.append(url) }
        }
        return (tabs, external)
    }

    /// The first folder in a drop, which the sidebar roots itself at.
    static func firstFolder(_ urls: [URL]) -> URL? {
        urls.first { url in
            var isDirectory: ObjCBool = false
            return FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory)
                && isDirectory.boolValue
        }
    }

    /// Types a view registers so Finder offers it the drag.
    static let draggedTypes: [NSPasteboard.PasteboardType] = [.fileURL]
}

/// A WKWebView that does not navigate to a dropped file. The page is loaded
/// from `genres://`, so a `file://` navigation is never something we want.
final class MarkdownDropWebView: WKWebView {
    var onDropFiles: (([URL]) -> Void)?

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        MarkdownDrop.urls(from: sender.draggingPasteboard).isEmpty
            ? super.draggingEntered(sender)
            : .copy
    }

    override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation {
        MarkdownDrop.urls(from: sender.draggingPasteboard).isEmpty
            ? super.draggingUpdated(sender)
            : .copy
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let urls = MarkdownDrop.urls(from: sender.draggingPasteboard)
        guard !urls.isEmpty else { return super.performDragOperation(sender) }
        onDropFiles?(urls)
        return true
    }
}
