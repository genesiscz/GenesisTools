import AppKit
import QuartzCore
import SwiftUI
import XCTest
@testable import GenesisKitBase
@testable import GenesisKit

/// A persistent hidden host. Call record with the ACTUAL production view and its state mutation.
/// The recorder supplies no animation, transition, delayed removal, or copied row implementation.
/// The positive control below must pass on the runner before the recorder can support a fade claim.
@MainActor
enum WorkMotionPictureEvidence {
    struct Frame {
        let elapsedMS: Double
        let image: CGImage
    }

    /// Async counterpart for real model stream ticks. Suspension lets the actual model's load task and
    /// production animation transaction run; the test never inserts its own animation context.
    static func recordLive(_ view: some View, size: CGSize, mutate: () -> Void) async throws -> [Frame] {
        let host = NSHostingView(rootView: AnyView(view
            .frame(width: size.width, height: size.height, alignment: .topLeading)
            .background(Color.black).environment(\.colorScheme, .dark)))
        let window = NSWindow(contentRect: CGRect(origin: .zero, size: size),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.orderInForSnapshot()
        defer { window.close() }
        try await Task.sleep(for: .milliseconds(300))
        let before = try bitmap(host)
        let start = CACurrentMediaTime()
        mutate()
        var result = [Frame(elapsedMS: -1, image: before)]
        repeat {
            // Yield after every capture. Catching up on missed deadlines without yielding captures
            // the same display transaction repeatedly and starves the animation being measured.
            try await Task.sleep(for: .milliseconds(8))
            result.append(Frame(elapsedMS: (CACurrentMediaTime() - start) * 1000, image: try bitmap(host)))
        } while CACurrentMediaTime() - start < 0.65
        return result
    }

    private static func bitmap(_ host: NSView) throws -> CGImage {
        host.layoutSubtreeIfNeeded()
        let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: rep)
        return try XCTUnwrap(rep.cgImage)
    }

    /// Projection onto before→after over a known disappearing area. Crop must contain the removed row's
    /// ink and background, with no sibling moving into it. Use the last row in a fixture section.
    /// Values near 1 are old pixels, near 0 are final pixels; an intermediate value with a low residual
    /// supports an opacity fade. Distinct frames alone could instead be a slide or a changing clock.
    static func fadeSamples(_ frames: [Frame], crop: CGRect) throws -> [(time: Double, oldInk: Double, residual: Double)] {
        let before = try rgba(try XCTUnwrap(frames.first?.image.cropping(to: crop)))
        let after = try rgba(try XCTUnwrap(frames.last?.image.cropping(to: crop)))
        XCTAssertEqual(before.count, after.count)
        let delta = zip(before, after).map { Double($0) - Double($1) }
        let energy = delta.reduce(0) { $0 + $1 * $1 }
        XCTAssertGreaterThan(energy, 10_000, "crop needs real disappearing pixels")
        return try frames.map { frame in
            let pixels = try rgba(try XCTUnwrap(frame.image.cropping(to: crop)))
            XCTAssertEqual(pixels.count, delta.count)
            let offset = zip(pixels, after).map { Double($0) - Double($1) }
            let projection = zip(offset, delta).reduce(0.0) { $0 + $1.0 * $1.1 } / max(1, energy)
            let residual = sqrt(zip(offset, delta).reduce(0.0) {
                let error = $1.0 - projection * $1.1
                return $0 + error * error
            } / max(1, energy))
            return (frame.elapsedMS, projection, residual)
        }
    }

    static func rgba(_ image: CGImage) throws -> [UInt8] {
        var result = [UInt8](repeating: 0, count: image.width * image.height * 4)
        try result.withUnsafeMutableBytes { bytes in
            let context = try XCTUnwrap(CGContext(data: bytes.baseAddress, width: image.width, height: image.height,
                                                bitsPerComponent: 8, bytesPerRow: image.width * 4,
                                                space: CGColorSpaceCreateDeviceRGB(),
                                                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
            context.draw(image, in: CGRect(x: 0, y: 0, width: CGFloat(image.width), height: CGFloat(image.height)))
        }
        return result
    }

    static func write(_ frames: [Frame], folder: String, stem: String) throws {
        let directory = URL(fileURLWithPath: folder, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        var times: [[String: Any]] = []
        for (index, frame) in frames.enumerated() {
            let filename = String(format: "%@-%02d.png", stem, index)
            let rep = NSBitmapImageRep(cgImage: frame.image)
            try XCTUnwrap(rep.representation(using: .png, properties: [:]))
                .write(to: directory.appendingPathComponent(filename))
            times.append(["file": filename, "elapsedMS": frame.elapsedMS,
                          "width": frame.image.width, "height": frame.image.height])
        }
        try JSONSerialization.data(withJSONObject: times, options: [.prettyPrinted, .sortedKeys])
            .write(to: directory.appendingPathComponent(stem + "-times.json"))
    }
}

@MainActor
private final class WorkMotionControlState: ObservableObject {
    @Published var opacity = 1.0
}

private struct WorkMotionControl: View {
    @ObservedObject var state: WorkMotionControlState
    var body: some View {
        ZStack(alignment: .topLeading) {
            Color.black
            Rectangle().fill(Color.white).frame(width: 160, height: 60).padding(20).opacity(state.opacity)
        }
    }
}

@MainActor
final class WorkScreenTestsMotionCapture: XCTestCase {
    func testTheHiddenRecorderSeesAFadeAndRejectsAnInstantRemoval() async throws {
        for animated in [true, false] {
            let state = WorkMotionControlState()
            let frames = try await WorkMotionPictureEvidence.recordLive(WorkMotionControl(state: state),
                size: CGSize(width: 220, height: 120)) {
                    Task {
                        // Calibrate against known brightness levels. The production removal test
                        // supplies only a store tick and must produce its own intermediate frames.
                        if animated {
                            for value in [0.75, 0.5, 0.25] {
                                state.opacity = value
                                try? await Task.sleep(for: .milliseconds(75))
                            }
                        }
                        state.opacity = 0
                    }
                }
            let samples = try WorkMotionPictureEvidence.fadeSamples(frames, crop: CGRect(
                x: 0, y: 0, width: CGFloat(frames[0].image.width), height: CGFloat(frames[0].image.height)))
            let middle = samples.filter { $0.oldInk > 0.08 && $0.oldInk < 0.92 && $0.residual < 0.12 }
            if animated {
                XCTAssertGreaterThanOrEqual(Set(middle.map { Int(($0.oldInk * 100).rounded()) }).count, 2,
                    "The capture must distinguish known intermediate opacity levels.")
            } else {
                XCTAssertEqual(middle.count, 0, "Instant control must not look like a fade")
            }
            if let folder = ProcessInfo.processInfo.environment["WIDGET_SHOTS"] {
                try WorkMotionPictureEvidence.write(frames, folder: folder,
                                                    stem: animated ? "capture-control-fade" : "capture-control-instant")
            }
        }
    }
}
