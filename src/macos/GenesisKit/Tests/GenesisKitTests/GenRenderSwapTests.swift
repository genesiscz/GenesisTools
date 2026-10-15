import AppKit
import SwiftUI
import XCTest
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
        var body: some View {
            GenRenderSwap(id: rig.id, timeout: timeout) { id, ready in
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
}
