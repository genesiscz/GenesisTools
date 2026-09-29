import AppKit
import XCTest
@testable import SnapshotSupport

/// Synthetic captures in the spirit of typesafe-computer-use's tests: a light page, painted boxes.
final class DrawnCheckTests: XCTestCase {
    /// A page of one gray with `boxes` filled and `outlines` stroked one pixel wide.
    private func page(width: Int = 300, height: Int = 120, fill: UInt8 = 234,
                      boxes: [(CGRect, UInt8)] = [], outlines: [(CGRect, UInt8)] = []) -> GrayImage {
        let stride = width + 8
        var pixels = [UInt8](repeating: fill, count: stride * height)
        func set(_ x: Int, _ y: Int, _ value: UInt8) {
            guard x >= 0, y >= 0, x < width, y < height else { return }
            pixels[y * stride + x] = value
        }
        for (rect, value) in boxes {
            for y in Int(rect.minY)..<Int(rect.maxY) { for x in Int(rect.minX)..<Int(rect.maxX) { set(x, y, value) } }
        }
        for (rect, value) in outlines {
            for x in Int(rect.minX)...Int(rect.maxX) { set(x, Int(rect.minY), value); set(x, Int(rect.maxY), value) }
            for y in Int(rect.minY)...Int(rect.maxY) { set(Int(rect.minX), y, value); set(Int(rect.maxX), y, value) }
        }
        return GrayImage(width: width, height: height, bytesPerRow: stride, pixels: pixels)!
    }

    private let control = CGRect(x: 20, y: 20, width: 200, height: 30)

    func testAFlatBoxIsBlank() {
        XCTAssertEqual(drawnVerdict(page(), pixels: control), .blank)
    }

    func testAnEmptyFieldIsDrawnByItsBorder() {
        let image = page(outlines: [(CGRect(x: 20, y: 20, width: 200, height: 30), 40)])
        XCTAssertEqual(drawnVerdict(image, pixels: CGRect(x: 20, y: 20, width: 201, height: 31)), .drawn)
    }

    func testTextLikeInkInsideIsDrawn() {
        let image = page(boxes: [(CGRect(x: 60, y: 30, width: 30, height: 10), 30)])
        XCTAssertEqual(drawnVerdict(image, pixels: control), .drawn)
    }

    func testFaintNoiseBelowTheRangeStaysBlank() {
        let image = page(boxes: [(CGRect(x: 60, y: 30, width: 30, height: 10), 234 - 12)])
        XCTAssertEqual(drawnVerdict(image, pixels: control), .blank)
    }

    func testANeighboursBorderOverTheTopEdgeDoesNotCount() {
        // Chosen's clipped search box starts on the bottom border of the control above it.
        let image = page(outlines: [(CGRect(x: 10, y: 0, width: 240, height: 21), 40)])
        XCTAssertEqual(drawnVerdict(image, pixels: control), .blank)
    }

    func testARectPartlyOutsideTheCaptureIsUnknownNeverBlank() {
        XCTAssertEqual(drawnVerdict(page(), pixels: CGRect(x: 250, y: 20, width: 100, height: 30)), .unknown)
        XCTAssertEqual(drawnVerdict(page(), pixels: CGRect(x: -5, y: 20, width: 100, height: 30)), .unknown)
        XCTAssertEqual(drawnVerdict(page(), pixels: CGRect(x: 20, y: 20, width: 1, height: 30)), .unknown)
    }

    func testFramesMapToCapturePixelsWithRetinaScaleAndNegativeOrigin() {
        let window = CGRect(x: -800, y: 100, width: 400, height: 300)
        let rect = sourcePixelRect(CGRect(x: -700, y: 150, width: 50, height: 20), window: window,
                                   imageWidth: 800, imageHeight: 600)
        XCTAssertEqual(rect, CGRect(x: 200, y: 100, width: 100, height: 40))
    }

    func testOnlyVisibleControlsThatReadBlankAreNamed() {
        // Window at the origin, captured at 1x: frames are pixels.
        let image = page(boxes: [(CGRect(x: 30, y: 70, width: 20, height: 8), 30)])
        let window = CGRect(x: 0, y: 0, width: 300, height: 120)
        let rows: [[String: Any]] = [
            ["role": "AXWindow", "visible": true, "actions": ["AXRaise"]],
            ["role": "AXButton", "visible": true, "actions": ["AXPress"]],
            ["role": "AXButton", "visible": true, "actions": ["AXPress"]],
            ["role": "AXStaticText", "visible": true, "actions": ["AXScrollToVisible", "AXShowMenu"]],
            ["role": "AXTextField", "visible": false, "actions": []],
            ["role": "AXGroup", "visible": true, "actions": ["AXPress"]],
        ]
        let frames = [
            window,
            CGRect(x: 10, y: 10, width: 100, height: 30),
            CGRect(x: 20, y: 60, width: 100, height: 30),
            CGRect(x: 150, y: 10, width: 100, height: 30),
            CGRect(x: 150, y: 50, width: 100, height: 30),
            CGRect(x: 150, y: 85, width: 100, height: 30),
        ]
        XCTAssertEqual(undrawnRows(rows: rows, frames: frames, window: window, image: image), [1, 5])
        XCTAssertEqual(undrawnRows(rows: rows, frames: frames, window: window, image: image, limit: 1), [1])
    }

    func testACGImageConvertsTopRowFirst() throws {
        let width = 8
        let height = 4
        var rgba = [UInt8](repeating: 255, count: width * height * 4)
        for x in 0..<width {
            for channel in 0..<3 { rgba[x * 4 + channel] = 0 }
        }
        let provider = try XCTUnwrap(CGDataProvider(data: Data(rgba) as CFData))
        let image = try XCTUnwrap(CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
            bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
            provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent))
        let gray = try XCTUnwrap(GrayImage(image))
        XCTAssertLessThan(gray[3, 0], 20)
        XCTAssertGreaterThan(gray[3, 3], 235)
    }
}
