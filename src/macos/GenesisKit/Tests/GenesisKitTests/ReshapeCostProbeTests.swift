import SwiftUI
import XCTest

@testable import GenesisKitBase
@testable import GenesisKit

/// Opt-in probe (`RESHAPE_PROBE=1 swift test --filter ReshapeCostProbeTests`): what a reshape costs the main thread
/// with an inbox-like pane, a scroll view of long text rows over a composer, in a hidden edge panel.
/// - `fill`: the pane fills the window and only the mask moves (the floor).
/// - `field`: the pane follows `contentFrame` with an AppKit text field in its composer.
/// - `standIn`: the same, with the composer drawn while the panel moves, as LiveWidgetView does (`edgePanelMoving`).
/// Measured 2026-10-11 20:44, 12 reshapes per mode, display-link gap p50 / max: fill 7.7-8.6 / 11.7-17.3 ms, field
/// 18.4-25.9 / 24.8-44.1 ms, standIn 7.5-9.4 / 13.5-24.9 ms. The AppKit field moving on every frame was the cost.
@MainActor
final class ReshapeCostProbeTests: XCTestCase {
    enum Mode: String { case fill, field, standIn }

    private struct Pane: View {
        @ObservedObject var motion: EdgePanelMotion
        let mode: Mode
        @State private var draft = ""

        var body: some View {
            let frame = mode == .fill ? nil : motion.contentFrame
            Color.clear
                .overlay(alignment: .topLeading) {
                    VStack(spacing: 12) {
                        Text("Header").font(.headline)
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 14) {
                                ForEach(0..<14, id: \.self) { index in
                                    Text(String(repeating: "Row \(index) carries a long paragraph of answer text. ", count: 9))
                                        .font(.system(size: 12))
                                        .padding(10)
                                        .background(Color.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 10))
                                }
                            }
                        }
                        HStack {
                            if mode == .standIn && frame != nil {
                                Text("Reply…").frame(maxWidth: .infinity, minHeight: 22, maxHeight: 22, alignment: .leading)
                            } else {
                                TextField("Reply…", text: $draft).textFieldStyle(.roundedBorder)
                            }
                            Button("Send") {}
                        }
                    }
                    .padding(18)
                    .frame(width: frame?.width, height: frame?.height)
                    .frame(maxWidth: frame == nil ? .infinity : nil, maxHeight: frame == nil ? .infinity : nil)
                    .offset(x: frame?.minX ?? 0, y: frame?.minY ?? 0)
                }
        }
    }

    func testReshapeCostOfFollowingTheOutline() async throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["RESHAPE_PROBE"] == "1", "opt-in probe")
        _ = NSApplication.shared
        let screen = try XCTUnwrap(NSScreen.screens.first)
        for mode in [Mode.fill, .field, .standIn, .fill, .field, .standIn] {
            let motion = EdgePanelMotion()
            let value = EdgePanelController(
                placement: .right, screen: screen, compactSize: CGSize(width: 40, height: 100),
                expandedSize: CGSize(width: 700, height: 500), title: "Hidden reshape probe", motion: motion
            ) { Pane(motion: motion, mode: mode) }
            value.panel.alphaValue = 0
            value.panel.level = NSWindow.Level(rawValue: -1000)
            value.setSideCenterY(screen.visibleFrame.midY)
            value.setPresentation(.expanded, reduceMotion: true)
            value.show()
            try await Task.sleep(for: .milliseconds(300))
            var lines: [String] = []
            for height: CGFloat in [880, 500, 880, 500, 880, 500] {
                value.setExpandedSize(CGSize(width: 700, height: height))
                value.setPresentation(.expanded, reduceMotion: false)
                let deadline = ContinuousClock.now + .seconds(3)
                while value.lastTransitionTiming == nil || value.motion.contentFrame != nil
                    || value.panel.frame.height != height, ContinuousClock.now < deadline {
                    try await Task.sleep(for: .milliseconds(20))
                }
                try await Task.sleep(for: .milliseconds(150))
                if let timing = value.lastTransitionTiming {
                    lines.append(String(format: "%@ p50=%.1f max=%.1f n=%d",
                        height > 600 ? "grow" : "shrink", timing.gapP50Ms, timing.gapMaxMs, timing.callbacks))
                }
            }
            print("reshape-probe \(mode.rawValue): " + lines.joined(separator: " | "))
            value.hide()
            value.panel.close()
        }
    }
}
