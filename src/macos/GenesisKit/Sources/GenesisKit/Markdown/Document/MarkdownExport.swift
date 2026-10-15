//
//  MarkdownExport.swift
//  GenesisKit
//
//  Getting a rendered note out of the window: a PDF beside the note (⇧⌘S) or the
//  print sheet (⌘P). Both go through the WKWebView that already rendered it, so
//  the PDF carries the reading view exactly as it looks — mermaid diagrams,
//  callouts and highlighted code included.
//

import AppKit
import SwiftUI
import WebKit

/// Handle on the live reading web view. The SwiftUI representable hands its
/// `WKWebView` over here so the toolbar can act on it.
@MainActor
final class MarkdownWebProxy: ObservableObject {
    weak var web: WKWebView?

    var isAttached: Bool { web != nil }

    /// The reading view as PDF. Fails silently only when the pane is not a web
    /// view; every real error is passed to `completion`.
    func exportPDF(to url: URL, completion: @escaping (Error?) -> Void) {
        guard let web else {
            completion(MarkdownExportError.noWebRenderer)
            return
        }
        // The page's own chrome (the sticky section line, the Copy buttons) is screen only. Print CSS
        // keeps it off paper; createPDF draws the screen, so the page is told for the export's span.
        web.evaluateJavaScript("window.gnExportMode&&window.gnExportMode(true)") { _, _ in
            web.createPDF(configuration: WKPDFConfiguration()) { result in
                web.evaluateJavaScript("window.gnExportMode&&window.gnExportMode(false)", completionHandler: nil)
                switch result {
                case .success(let data):
                    do {
                        try data.write(to: url, options: .atomic)
                        completion(nil)
                    } catch {
                        completion(error)
                    }
                case .failure(let error):
                    completion(error)
                }
            }
        }
    }

    /// `onError` hears why nothing printed, the way `exportPDF` reports it,
    /// so ⌘P without a web view says so instead of doing nothing.
    func printDocument(title: String, in window: NSWindow?, onError: (String) -> Void = { _ in }) {
        guard let web else {
            onError(MarkdownExportError.noWebRenderer.localizedDescription)
            return
        }
        let info = NSPrintInfo.shared.copy() as? NSPrintInfo ?? NSPrintInfo.shared
        info.jobDisposition = .spool
        info.horizontalPagination = .fit
        info.isHorizontallyCentered = false
        let operation = web.printOperation(with: info)
        operation.jobTitle = title
        operation.showsPrintPanel = true
        operation.showsProgressPanel = true
        if let window {
            operation.runModal(for: window, delegate: nil, didRun: nil, contextInfo: nil)
        } else {
            operation.run()
        }
    }
}

enum MarkdownExportError: LocalizedError {
    case noWebRenderer

    var errorDescription: String? {
        "Export needs the reading view with the Web renderer. Switch to it in the toolbar and try again."
    }
}

enum MarkdownExport {
    /// Where the save panel starts: the note's own folder, its own name, `.pdf`.
    static func defaultPDFURL(for note: URL) -> URL {
        note.deletingPathExtension().appendingPathExtension("pdf")
    }

    /// Asks for a destination, then writes the PDF. `onError` gets a message
    /// worth showing; a cancelled panel is not an error.
    @MainActor
    static func savePDF(
        from proxy: MarkdownWebProxy,
        note: URL,
        in window: NSWindow?,
        onError: @escaping (String) -> Void
    ) {
        // Say so before the save panel, not after the reader picked a file.
        guard proxy.isAttached else {
            onError(MarkdownExportError.noWebRenderer.localizedDescription)
            return
        }
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.pdf]
        panel.nameFieldStringValue = defaultPDFURL(for: note).lastPathComponent
        panel.directoryURL = note.deletingLastPathComponent()
        panel.canCreateDirectories = true

        // AppKit calls both completions on the main thread, which is where the
        // proxy and its web view live.
        let handle: (NSApplication.ModalResponse) -> Void = { response in
            MainActor.assumeIsolated {
                guard response == .OK, let target = panel.url else { return }
                proxy.exportPDF(to: target) { error in
                    if let error {
                        onError(error.localizedDescription)
                    } else {
                        NSWorkspace.shared.activateFileViewerSelecting([target])
                    }
                }
            }
        }

        if let window {
            panel.beginSheetModal(for: window, completionHandler: handle)
        } else {
            handle(panel.runModal())
        }
    }
}
