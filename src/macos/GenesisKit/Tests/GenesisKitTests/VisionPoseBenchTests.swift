import CoreGraphics
import CoreVideo
import Foundation
import XCTest
@testable import GenesisKit

/// The Vision engines on synthetic 640x480 frames: what they return, and what one request costs.
/// No camera is opened. `POSTURE_BENCH=1` runs 60 timed calls per engine instead of 8 and prints the
/// numbers as `posture.bench …` lines.
final class VisionPoseBenchTests: XCTestCase {
    /// A 640x480 BGRA frame: a lit backdrop with a head and shoulders drawn in flat shapes, or a dark one.
    static func frame(dark: Bool = false) throws -> CameraFrame {
        var buffer: CVPixelBuffer?
        let attributes: [String: Any] = [kCVPixelBufferIOSurfacePropertiesKey as String: [:]]
        CVPixelBufferCreate(nil, 640, 480, kCVPixelFormatType_32BGRA, attributes as CFDictionary, &buffer)
        let pixelBuffer = try XCTUnwrap(buffer)
        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        let context = try XCTUnwrap(CGContext(
            data: CVPixelBufferGetBaseAddress(pixelBuffer), width: 640, height: 480, bitsPerComponent: 8,
            bytesPerRow: CVPixelBufferGetBytesPerRow(pixelBuffer), space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue))
        let light = dark ? 0.03 : 0.78
        context.setFillColor(CGColor(red: light, green: light, blue: light * 0.95, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 640, height: 480))
        if !dark {
            context.setFillColor(CGColor(red: 0.15, green: 0.16, blue: 0.2, alpha: 1))
            context.fillEllipse(in: CGRect(x: 170, y: -120, width: 300, height: 260))
            context.setFillColor(CGColor(red: 0.86, green: 0.68, blue: 0.56, alpha: 1))
            context.fill(CGRect(x: 300, y: 120, width: 40, height: 40))
            context.fillEllipse(in: CGRect(x: 255, y: 150, width: 130, height: 165))
            context.setFillColor(CGColor(red: 0.2, green: 0.14, blue: 0.1, alpha: 1))
            context.fillEllipse(in: CGRect(x: 287, y: 245, width: 18, height: 10))
            context.fillEllipse(in: CGRect(x: 335, y: 245, width: 18, height: 10))
            context.fill(CGRect(x: 300, y: 195, width: 40, height: 6))
        }
        CVPixelBufferUnlockBaseAddress(pixelBuffer, [])
        let luma = PixelLuma.mean(pixelBuffer)
        return CameraFrame(pixelBuffer: pixelBuffer, time: 1, meanLuma: luma)
    }

    func testEnginesReturnSamplesAndMarkDarkFrames() throws {
        let lit = try Self.frame()
        let dark = try Self.frame(dark: true)
        XCTAssertGreaterThan(try XCTUnwrap(lit.meanLuma), 0.3)
        XCTAssertLessThan(try XCTUnwrap(dark.meanLuma), CameraFrame.lowLightLuma)
        let body = VisionBodyPoseEngine()
        let sample = try XCTUnwrap(body.analyze(lit))
        XCTAssertEqual(sample.engine, .visionBody)
        XCTAssertFalse(sample.lowLight)
        XCTAssertEqual(sample.imageAspect, 640.0 / 480.0, accuracy: 1e-9)
        XCTAssertTrue(try XCTUnwrap(body.analyze(dark)).lowLight)
        let face = try XCTUnwrap(VisionFaceEngine().analyze(lit))
        XCTAssertEqual(face.engine, .visionFace)
        XCTAssertTrue(face.joints.isEmpty)
        // Every joint that comes back sits in the normalized top-left space.
        for point in sample.joints.values {
            XCTAssertTrue((0...1).contains(point.x) && (0...1).contains(point.y))
        }
    }

    func testOneRequestCostsLittle() throws {
        let frame = try Self.frame()
        let runs = ProcessInfo.processInfo.environment["POSTURE_BENCH"] == "1" ? 60 : 8
        let engines: [(String, FramePoseEngine)] = [
            ("body", VisionBodyPoseEngine(faceDetection: .never)),
            ("body+face", VisionBodyPoseEngine(faceDetection: .always)),
            ("face", VisionFaceEngine()),
        ]
        var lines: [String] = []
        for (name, engine) in engines {
            for _ in 0..<3 { _ = engine.analyze(frame) }
            var walls: [Double] = []
            let cpuStart = Self.processCPU()
            for _ in 0..<runs {
                let start = DispatchTime.now().uptimeNanoseconds
                _ = engine.analyze(frame)
                walls.append(Double(DispatchTime.now().uptimeNanoseconds - start) / 1e6)
            }
            let cpu = (Self.processCPU() - cpuStart) * 1000 / Double(runs)
            walls.sort()
            let median = walls[walls.count / 2]
            let p95 = walls[min(walls.count - 1, Int(Double(walls.count) * 0.95))]
            lines.append(String(format: "posture.bench %@ runs=%d wall_median_ms=%.2f wall_p95_ms=%.2f cpu_ms_per_call=%.2f",
                                name, runs, median, p95, cpu))
            // A generous ceiling: a regression to seconds per frame fails, a busy machine does not.
            XCTAssertLessThan(median, 500, name)
        }
        let start = DispatchTime.now().uptimeNanoseconds
        for _ in 0..<1000 { _ = PixelLuma.mean(frame.pixelBuffer) }
        let lumaMicros = Double(DispatchTime.now().uptimeNanoseconds - start) / 1e6
        lines.append(String(format: "posture.bench luma us_per_frame=%.2f", lumaMicros))
        let load = Self.loadAverage()
        lines.append(String(format: "posture.bench load1=%.2f", load))
        print(lines.joined(separator: "\n"))
    }

    /// User plus system CPU seconds of this process (every thread, Vision's included).
    static func processCPU() -> Double {
        var usage = rusage()
        getrusage(RUSAGE_SELF, &usage)
        let user = Double(usage.ru_utime.tv_sec) + Double(usage.ru_utime.tv_usec) / 1e6
        let system = Double(usage.ru_stime.tv_sec) + Double(usage.ru_stime.tv_usec) / 1e6
        return user + system
    }

    static func loadAverage() -> Double {
        var load = [Double](repeating: 0, count: 3)
        getloadavg(&load, 3)
        return load[0]
    }
}
