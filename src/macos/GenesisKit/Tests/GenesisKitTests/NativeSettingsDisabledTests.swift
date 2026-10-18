import AppKit
import SwiftUI
import XCTest

@testable import GenesisKitBase
@testable import GenesisKit

/// A disabled settings control must look disabled. AppKit's own disabled switch drew like the enabled one over the
/// settings backdrop, so Hub → Appearance → Glass read as live in the Native style (2026-10-11).
@MainActor
final class NativeSettingsDisabledTests: XCTestCase {
    /// The mean brightness (0...1) of the right-hand `accessoryWidth` points, where a row draws its control.
    private func accessoryBrightness<V: View>(_ view: V, width: CGFloat = 420, height: CGFloat = 56,
                                              accessoryWidth: CGFloat = 140) throws -> Double {
        let host = NSHostingView(rootView: view.padding(8).frame(width: width, height: height)
            .background(Color.black).environment(\.colorScheme, .dark))
        host.frame = NSRect(x: 0, y: 0, width: width, height: height)
        host.layoutSubtreeIfNeeded()
        let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: bitmap)
        let scale = CGFloat(bitmap.pixelsWide) / width
        let start = Int((width - accessoryWidth) * scale)
        var sum = 0.0
        var count = 0.0
        for y in 0..<bitmap.pixelsHigh {
            for x in start..<bitmap.pixelsWide {
                guard let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
                sum += Double(color.redComponent + color.greenComponent + color.blueComponent) / 3
                count += 1
            }
        }
        return sum / max(count, 1)
    }

    func testADisabledSwitchIsDrawnVisiblyDimmerThanAnEnabledOne() throws {
        let toggle = NativeSettingsToggle("Glass", detail: "Native follows General → Theme.", isOn: .constant(true))
        let enabled = try accessoryBrightness(toggle)
        let disabled = try accessoryBrightness(toggle.disabled(true))
        XCTAssertGreaterThan(enabled, 0.05, "the switch must render at all, or the comparison proves nothing")
        XCTAssertLessThan(disabled, enabled * 0.7, "enabled \(enabled), disabled \(disabled)")
    }

    func testADisabledNumberFieldAndStepperAreDrawnDimmer() throws {
        let picker = NativeSettingsNumberPicker("Idle days", range: 0..<91, identifier: "fixture.days", value: .constant(30))
        let row = NativeSettingsRow("Idle for at least") { picker }
        let enabled = try accessoryBrightness(row)
        let disabled = try accessoryBrightness(row.disabled(true))
        XCTAssertGreaterThan(enabled, 0.02)
        XCTAssertLessThan(disabled, enabled * 0.8, "enabled \(enabled), disabled \(disabled)")
    }
}
