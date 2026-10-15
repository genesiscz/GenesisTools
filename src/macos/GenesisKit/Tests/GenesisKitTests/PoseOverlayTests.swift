import AppKit
import SwiftUI
import XCTest
@testable import GenesisKit

final class PoseOverlayGeometryTests: XCTestCase {
    func testAMatchingAspectFillsTheViewAndMirrorsX() {
        let map = PoseOverlayGeometry(size: CGSize(width: 400, height: 300), imageAspect: 4.0 / 3.0, mirrored: true)
        XCTAssertEqual(map.imageRect, CGRect(x: 0, y: 0, width: 400, height: 300))
        XCTAssertEqual(map.point(0.25, 0.5), CGPoint(x: 300, y: 150))
        let plain = PoseOverlayGeometry(size: CGSize(width: 400, height: 300), imageAspect: 4.0 / 3.0, mirrored: false)
        XCTAssertEqual(plain.point(0.25, 0.5), CGPoint(x: 100, y: 150))
    }

    func testAspectFillCropsTheLongerAxisLikeThePreviewLayer() {
        // A square view crops the 4:3 image left and right.
        let square = PoseOverlayGeometry(size: CGSize(width: 300, height: 300), imageAspect: 4.0 / 3.0, mirrored: false)
        XCTAssertEqual(square.imageRect.width, 400, accuracy: 1e-9)
        XCTAssertEqual(square.imageRect.minX, -50, accuracy: 1e-9)
        XCTAssertEqual(square.point(0.5, 0.5), CGPoint(x: 150, y: 150))
        // A wide view crops top and bottom.
        let wide = PoseOverlayGeometry(size: CGSize(width: 400, height: 200), imageAspect: 4.0 / 3.0, mirrored: false)
        XCTAssertEqual(wide.imageRect.height, 300, accuracy: 1e-9)
        XCTAssertEqual(wide.point(0, 0).y, -50, accuracy: 1e-9)
    }

    func testArrowsOnlyForJointsThatMoved() {
        XCTAssertTrue(PoseSkeletonOverlay.arrow(from: .zero, to: CGPoint(x: 3, y: 4), threshold: 9).isEmpty)
        XCTAssertEqual(PoseSkeletonOverlay.arrow(from: .zero, to: CGPoint(x: 0, y: 40), threshold: 9).count, 2)
    }

    func testTheOverlayComparesEqualForTheSameInputs() {
        let sample = postureSample()
        XCTAssertEqual(PoseSkeletonOverlay(sample: sample), PoseSkeletonOverlay(sample: sample))
        XCTAssertNotEqual(PoseSkeletonOverlay(sample: sample), PoseSkeletonOverlay(sample: postureSample(noseY: 0.5)))
    }
}

@MainActor
final class PoseOverlayRenderTests: XCTestCase {
    /// The brightest pixel (0...1) within `radius` points of `point` (top-left points).
    private func brightness(_ rep: NSBitmapImageRep, at point: CGPoint, viewSize: CGSize, radius: CGFloat = 4) -> Double {
        let scale = CGFloat(rep.pixelsWide) / viewSize.width
        var best = 0.0
        for dy in stride(from: -radius, through: radius, by: 1) {
            for dx in stride(from: -radius, through: radius, by: 1) {
                let x = Int((point.x + dx) * scale), y = Int((point.y + dy) * scale)
                guard x >= 0, y >= 0, x < rep.pixelsWide, y < rep.pixelsHigh,
                      let color = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
                best = max(best, Double(color.redComponent + color.greenComponent + color.blueComponent) / 3)
            }
        }
        return best
    }

    func testTheSkeletonIsDrawnMirroredWhereThePreviewShowsTheUser() throws {
        let size = CGSize(width: 320, height: 240)
        // Nose to the image's right (x 0.6); mirrored it lands at x 0.4.
        let sample = postureSample(noseY: 0.45, noseX: 0.6, imageAspect: 4.0 / 3.0)
        let view = PoseSkeletonOverlay(sample: sample, mirrored: true).background(Color.black)
        let (window, host) = HostedShot.host(view, size: size)
        defer { window.close() }
        RunLoop.main.run(until: Date().addingTimeInterval(0.2))
        let rep = try XCTUnwrap(HostedShot.bitmap(host))
        let nose = CGPoint(x: 0.4 * size.width, y: 0.45 * size.height)
        let unmirrored = CGPoint(x: 0.6 * size.width, y: 0.45 * size.height)
        let shoulderLine = CGPoint(x: 0.5 * size.width, y: 0.75 * size.height)
        let empty = CGPoint(x: 0.5 * size.width, y: 0.08 * size.height)
        XCTAssertGreaterThan(brightness(rep, at: nose, viewSize: size), 0.6)
        XCTAssertGreaterThan(brightness(rep, at: shoulderLine, viewSize: size), 0.6)
        XCTAssertLessThan(brightness(rep, at: unmirrored, viewSize: size), 0.2)
        XCTAssertLessThan(brightness(rep, at: empty, viewSize: size), 0.05)
        let shots = FileManager.default.temporaryDirectory.appendingPathComponent("posture-shots")
        try HostedShot.write(
            PoseSkeletonOverlay(sample: postureSample(noseY: 0.52, imageAspect: 4.0 / 3.0), target: postureSample(imageAspect: 4.0 / 3.0), mirrored: true)
                .background(Color(white: 0.18)),
            size: size, settle: 0.1, to: shots.appendingPathComponent("skeleton-target.png"))
    }

    func testTheTargetGhostAndArrowsAppearOnlyWhenTheUserMoved() throws {
        let size = CGSize(width: 320, height: 240)
        func arrowPixels(_ overlay: PoseSkeletonOverlay) throws -> Double {
            let (window, host) = HostedShot.host(overlay.background(Color.black), size: size)
            defer { window.close() }
            RunLoop.main.run(until: Date().addingTimeInterval(0.1))
            let rep = try XCTUnwrap(HostedShot.bitmap(host))
            // Halfway between the current nose (y 0.6) and the target nose (y 0.45), off every bone.
            return brightness(rep, at: CGPoint(x: 0.5 * size.width, y: 0.525 * size.height), viewSize: size, radius: 2)
        }
        let moved = try arrowPixels(PoseSkeletonOverlay(sample: postureSample(noseY: 0.6, imageAspect: 4.0 / 3.0), target: postureSample(imageAspect: 4.0 / 3.0),
                                                        targetTint: .white))
        let still = try arrowPixels(PoseSkeletonOverlay(sample: postureSample(noseY: 0.6, imageAspect: 4.0 / 3.0), targetTint: .white))
        XCTAssertGreaterThan(moved, 0.4, "an arrow points from the dropped nose back to the target")
        XCTAssertGreaterThan(moved, still + 0.2)
    }
}
