import AppKit
import SwiftUI
import XCTest
@testable import GenesisKitBase
@testable import GenesisKit

/// A pane switch keeps the old content on screen until the new one is ready (Martin, 2026-10-13).
@MainActor
final class GenRenderSwapTests: XCTestCase {
    final class Rig: ObservableObject {
        @Published var id = "a"
        var mounted: Set<String> = []
        var readies: [String: GenRenderReady] = [:]
    }

    struct Probe: View {
        let id: String
        let ready: GenRenderReady
        let rig: Rig
        var body: some View {
            Text(verbatim: id)
                .onAppear {
                    rig.mounted.insert(id)
                    rig.readies[id] = ready
                }
                .onDisappear { rig.mounted.remove(id) }
        }
    }

    struct Host: View {
        @ObservedObject var rig: Rig
        let timeout: TimeInterval
        /// The fade mode exercised by the hosted render-swap test.
        var fade: GenRenderSwapFade = .swiftUI
        var body: some View {
            GenRenderSwap(id: rig.id, timeout: timeout, fade: fade) { id, ready in
                Probe(id: id, ready: ready, rig: rig)
            }
        }
    }

    private func pump(_ seconds: TimeInterval) {
        RunLoop.main.run(until: Date().addingTimeInterval(seconds))
    }

    func testTheOldContentStaysUntilTheNewOneIsReadyOrTheTimeoutPasses() {
        let rig = Rig()
        let hosting = NSHostingView(rootView: Host(rig: rig, timeout: 0.6))
        hosting.frame = NSRect(x: 0, y: 0, width: 300, height: 200)
        let window = NSWindow(contentRect: hosting.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        defer { window.contentView = nil }
        pump(0.1)
        XCTAssertEqual(rig.mounted, ["a"])

        rig.id = "b"
        pump(0.2)
        XCTAssertEqual(rig.mounted, ["a", "b"], "the new content builds under the old one")
        rig.readies["b"]?()
        pump(0.4)
        XCTAssertEqual(rig.mounted, ["b"], "once ready, the old content goes")

        // A content that never signals still arrives.
        rig.id = "c"
        pump(0.3)
        XCTAssertEqual(rig.mounted, ["b", "c"])
        pump(0.6)
        XCTAssertEqual(rig.mounted, ["c"], "the timeout swaps without a ready")
    }

    /// The markdown viewer's fade: the old content goes in the swap's own pass, and the crossfade is an animation on the
    /// hosting view's layer, so no SwiftUI frame runs for it.
    func testALayerFadeSwapsAtOnceAndCrossfadesTheHostingLayer() throws {
        let rig = Rig()
        let hosting = NSHostingView(rootView: Host(rig: rig, timeout: 0.6, fade: .layer))
        hosting.frame = NSRect(x: 0, y: 0, width: 300, height: 200)
        hosting.wantsLayer = true
        let window = NSWindow(contentRect: hosting.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        defer { window.contentView = nil }
        pump(0.1)
        XCTAssertEqual(rig.mounted, ["a"])

        rig.id = "b"
        pump(0.1)
        XCTAssertEqual(rig.mounted, ["a", "b"], "the new content builds under the old one")
        let layer = try XCTUnwrap(hosting.layer)
        XCTAssertNil(layer.animation(forKey: kCATransition))
        rig.readies["b"]?()
        pump(0.03)
        XCTAssertEqual(rig.mounted, ["b"], "the old content goes at once, not after the fade")
        let fade = try XCTUnwrap(layer.animation(forKey: kCATransition) as? CATransition, "a crossfade on the hosting layer")
        XCTAssertEqual(fade.type, .fade)
    }

    final class Doc: ObservableObject {
        let name: String
        var id: String { "/notes/\(name).md" }
        init(_ name: String) { self.name = name }
    }

    final class DocRig: ObservableObject {
        let docs = [Doc("a"), Doc("b"), Doc("c")]
        @Published var selectedId: String?
        var mounted: Set<String> = []
        var appears: [String: Int] = [:]
        var selected: Doc? { docs.first { $0.id == selectedId } ?? docs.last }
    }

    struct DocProbe: View {
        @ObservedObject var doc: Doc
        let rig: DocRig
        var body: some View {
            Text(verbatim: doc.name)
                .onAppear {
                    rig.mounted.insert(doc.name)
                    rig.appears[doc.name, default: 0] += 1
                }
                .onDisappear { rig.mounted.remove(doc.name) }
        }
    }

    struct DocHost: View {
        @ObservedObject var rig: DocRig
        var body: some View {
            if let doc = rig.selected {
                HStack {
                    GenRenderSwap(value: doc, id: \.id) { shown, _ in
                        DocProbe(doc: shown, rig: rig)
                    }
                }
            }
        }
    }

    /// The viewer's case: class documents, the first value the fallback (the last tab) before the saved selection
    /// arrives, then tab switches.
    func testClassDocumentsFollowTheSelection() {
        let rig = DocRig()
        let hosting = NSHostingView(rootView: DocHost(rig: rig))
        hosting.frame = NSRect(x: 0, y: 0, width: 300, height: 200)
        let window = NSWindow(contentRect: hosting.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        defer { window.contentView = nil }
        pump(0.1)
        XCTAssertEqual(rig.mounted, ["c"])
        rig.selectedId = "/notes/a.md"
        pump(0.9)
        XCTAssertEqual(rig.mounted, ["a"], "the saved selection replaces the fallback")
        rig.selectedId = "/notes/b.md"
        pump(0.9)
        XCTAssertEqual(rig.mounted, ["b"], "a tab switch arrives")
        XCTAssertEqual(rig.appears, ["c": 1, "a": 1, "b": 1], "every content appears once: none is built twice")
    }
}
