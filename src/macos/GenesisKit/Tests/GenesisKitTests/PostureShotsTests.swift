import CoreGraphics
import CoreVideo
import Foundation
import ImageIO
import XCTest
@testable import GenesisKitBase
@testable import GenesisKit
@testable import GenesisKitPosture

/// Replays real camera frames through the Vision body engine and the scorer. The frames come from
/// `genesis://posture/capture?label=<pose>` and live in `Tests/PostureShots/<pose>/` (gitignored: they show
/// the user) or in `POSTURE_SHOTS_DIR`. Without them the test skips.
///
/// Folder names say what each pose must score as: `upright*` must not be bad against a baseline built
/// from the upright frames; head-down, slump, lean-in, forward-head, head-on-hand and tilt-* must be bad.
/// Any other folder is only reported, and a folder whose name starts with `_` is skipped (a set kept
/// aside). Every frame prints one `posture.shot` line.
final class PostureShotsTests: XCTestCase {
    static let badPoses = ["head-down", "slump", "lean-in", "forward-head", "head-on-hand", "tilt-left", "tilt-right"]

    static var shotsDirectory: URL {
        if let path = ProcessInfo.processInfo.environment["POSTURE_SHOTS_DIR"], !path.isEmpty {
            return URL(fileURLWithPath: path, isDirectory: true)
        }
        return URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("PostureShots", isDirectory: true)
    }

    func testRealFramesScoreAsTheirPose() throws {
        let root = Self.shotsDirectory
        let poses = try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)
            .filter { $0.hasDirectoryPath && !$0.lastPathComponent.hasPrefix("_") }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        guard let poses, !poses.isEmpty else { throw XCTSkip("no shots in \(root.path)") }

        var frames: [String: [(name: String, sample: PoseSample)]] = [:]
        for pose in poses {
            // Each shot is its own reading: the 3D fallback runs on every frame that needs it, not throttled.
            let engine = VisionBodyPoseEngine(faceDetection: pose.lastPathComponent.hasPrefix("upright") ? .always : .fallback,
                                              body3D: .always)
            let pngs = try FileManager.default.contentsOfDirectory(at: pose, includingPropertiesForKeys: nil)
                .filter { $0.pathExtension == "png" }.sorted { $0.path < $1.path }
            for png in pngs {
                let sample = try XCTUnwrap(engine.analyze(try Self.frame(png)), png.lastPathComponent)
                frames[pose.lastPathComponent, default: []].append((png.lastPathComponent, sample))
            }
        }
        let upright = frames.filter { $0.key.hasPrefix("upright") }.flatMap(\.value).map { PostureMetrics(sample: $0.sample) }
        let baseline = try XCTUnwrap(PostureBaseline.calibrate(upright: upright), "needs 4+ upright frames with a person")
        let scorer = PostureScorer(forwardHeadWithoutShoulders: .needsShoulders)

        for (pose, shots) in frames.sorted(by: { $0.key < $1.key }) {
            for shot in shots {
                let score = scorer.score(PostureMetrics(sample: shot.sample), against: baseline)
                print("posture.shot \(pose)/\(shot.name) \(Self.describe(shot.sample)) bad=\(score.isBad) worst=\(score.worst?.rawValue ?? "-") unjudged=\(score.unjudged.map(\.rawValue).sorted())")
                if pose.hasPrefix("upright") {
                    XCTAssertFalse(score.isBad, "\(pose)/\(shot.name) is upright but scored bad (\(score.worst?.rawValue ?? "-"))")
                } else if Self.badPoses.contains(where: { pose.hasPrefix($0) }) {
                    XCTAssertTrue(score.isBad, "\(pose)/\(shot.name) slouches but scored fine")
                }
            }
        }
    }

    /// Which joints Vision found (with confidence) and whether the face request ran.
    static func describe(_ sample: PoseSample) -> String {
        let joints = PoseJoint.allCases.map { joint -> String in
            guard let point = sample.joints[joint] else { return "\(joint.rawValue)=-" }
            return "\(joint.rawValue)=\(String(format: "%.2f", point.confidence))"
        }
        return joints.joined(separator: " ") + " face=\(sample.face.map { String(format: "%.2f", $0.confidence) } ?? "-")"
    }

    /// A PNG drawn into a BGRA pixel buffer, as the camera delivers it.
    static func frame(_ url: URL) throws -> CameraFrame {
        let source = try XCTUnwrap(CGImageSourceCreateWithURL(url as CFURL, nil))
        let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
        var buffer: CVPixelBuffer?
        let attributes: [String: Any] = [kCVPixelBufferIOSurfacePropertiesKey as String: [:]]
        CVPixelBufferCreate(nil, image.width, image.height, kCVPixelFormatType_32BGRA, attributes as CFDictionary, &buffer)
        let pixelBuffer = try XCTUnwrap(buffer)
        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        let context = try XCTUnwrap(CGContext(
            data: CVPixelBufferGetBaseAddress(pixelBuffer), width: image.width, height: image.height, bitsPerComponent: 8,
            bytesPerRow: CVPixelBufferGetBytesPerRow(pixelBuffer), space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue))
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        CVPixelBufferUnlockBaseAddress(pixelBuffer, [])
        return CameraFrame(pixelBuffer: pixelBuffer, time: 0, meanLuma: PixelLuma.mean(pixelBuffer))
    }
}
