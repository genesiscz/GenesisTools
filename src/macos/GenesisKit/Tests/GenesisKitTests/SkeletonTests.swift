import AppKit
import SwiftUI
import XCTest
@testable import GenesisKit

/// The skeletons draw bars where the real view puts its text: some pixels lighter than the background,
/// spread over the frame, never an empty or a uniform image. `SKELETON_PNG_DIR=<dir>` also writes each
/// one as a PNG to look at.
@MainActor
final class SkeletonTests: XCTestCase {
    func testEverySkeletonDrawsBarsAcrossItsFrame() throws {
        let cases: [(String, AnyView, CGSize)] = [
            ("transcript", AnyView(TranscriptSkeleton()), CGSize(width: 700, height: 520)),
            ("diff", AnyView(DiffSkeleton()), CGSize(width: 700, height: 460)),
            ("pane", AnyView(PaneSkeleton()), CGSize(width: 600, height: 300)),
            ("rows", AnyView(SkeletonRows(count: 6, leading: .avatar)), CGSize(width: 300, height: 264)),
        ]
        for (name, view, size) in cases {
            let image = try render(view, size: size, name: name)
            let (lit, rowsLit) = Self.coverage(image)
            XCTAssertGreaterThan(lit, 0.02, "\(name): almost nothing drawn")
            XCTAssertLessThan(lit, 0.8, "\(name): the frame is one block, not bars")
            XCTAssertGreaterThan(rowsLit, 0.25, "\(name): the bars sit in one strip of the frame")
        }
    }


    func testShimmerUpdatesBandForHeightChangesAtFixedWidth() throws {
        let view = ShimmerSweep.SweepView(frame: CGRect(x: 0, y: 0, width: 300, height: 40))
        view.layout()
        let band = try XCTUnwrap(view.layer?.sublayers?.first)
        XCTAssertEqual(band.bounds.height, 40)
        view.setFrameSize(CGSize(width: 300, height: 140))
        view.layout()
        XCTAssertEqual(band.bounds.height, 140)
        XCTAssertEqual(band.bounds.width, 135)
    }

    private func render(_ view: AnyView, size: CGSize, name: String) throws -> CGImage {
        let content = view
            .frame(width: size.width, height: size.height, alignment: .topLeading)
            .background(Color.black)
            .environment(\.colorScheme, .dark)
        let renderer = ImageRenderer(content: content)
        renderer.scale = 1
        let image = try XCTUnwrap(renderer.cgImage, name)
        if let dir = ProcessInfo.processInfo.environment["SKELETON_PNG_DIR"] {
            let rep = NSBitmapImageRep(cgImage: image)
            try rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: dir).appendingPathComponent("skeleton-\(name).png"))
        }
        return image
    }

    /// The share of pixels lighter than black, and the share of pixel rows with any such pixel.
    private static func coverage(_ image: CGImage) -> (Double, Double) {
        let width = image.width
        let height = image.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let context = CGContext(data: &pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        context?.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        var lit = 0
        var rows = 0
        for y in 0..<height {
            var rowLit = false
            for x in 0..<width {
                let i = (y * width + x) * 4
                if Int(pixels[i]) + Int(pixels[i + 1]) + Int(pixels[i + 2]) > 18 {
                    lit += 1
                    rowLit = true
                }
            }
            if rowLit {
                rows += 1
            }
        }
        return (Double(lit) / Double(width * height), Double(rows) / Double(height))
    }
}
