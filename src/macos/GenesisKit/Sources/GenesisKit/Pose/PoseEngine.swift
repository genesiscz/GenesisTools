import CoreGraphics
import Foundation
import Vision

/// A source of pose samples. Camera engines read frames (`FramePoseEngine`); AirPods push samples
/// (`HeadphoneMotionEngine`).
public protocol PoseEngine: AnyObject {
    var kind: PoseEngineKind { get }
    /// Whether the engine needs camera frames.
    var usesCamera: Bool { get }
}

/// An engine that turns one camera frame into one sample.
public protocol FramePoseEngine: PoseEngine {
    /// Analyses one frame. Call it from one serial queue (the camera's delivery queue); the engine keeps
    /// its Vision request between calls. Nil when Vision failed; a sample with no person when nobody is
    /// there.
    func analyze(_ frame: CameraFrame) -> PoseSample?
}

/// Vision 2D body pose: nose, eyes, ears, neck and shoulders with a confidence each, on macOS 11 and
/// later, with no model download (`VNDetectHumanBodyPoseRequest`). The default engine.
///
/// A seated upper body sometimes yields no body at all, so by default a face-rectangle request runs on
/// the same frame when the body pose has no confident nose (Dorso's fallback). `.always` runs both on
/// every frame (calibration, so the baseline holds the face measures too).
public final class VisionBodyPoseEngine: FramePoseEngine {
    public enum FaceDetection: Sendable {
        case never, fallback, always
    }

    public let kind: PoseEngineKind = .visionBody
    public let usesCamera = true
    /// When to run the face request. Change it only from the queue that calls `analyze`.
    public var faceDetection: FaceDetection

    private let bodyRequest: VNDetectHumanBodyPoseRequest
    private let faceRequest: VNDetectFaceRectanglesRequest

    public init(faceDetection: FaceDetection = .fallback) {
        self.faceDetection = faceDetection
        bodyRequest = VNDetectHumanBodyPoseRequest()
        bodyRequest.preferBackgroundProcessing = true
        faceRequest = VisionPose.makeFaceRequest()
    }

    public func analyze(_ frame: CameraFrame) -> PoseSample? {
        let handler = VNImageRequestHandler(cvPixelBuffer: frame.pixelBuffer, orientation: .up, options: [:])
        var requests: [VNRequest] = [bodyRequest]
        if faceDetection == .always { requests.append(faceRequest) }
        do {
            try handler.perform(requests)
        } catch {
            return nil
        }
        let joints = VisionPose.joints(from: bodyRequest.results ?? [])
        var face: PoseFace?
        switch faceDetection {
        case .always:
            face = VisionPose.face(from: faceRequest.results ?? [])
        case .fallback:
            let nose = joints[.nose].map { $0.confidence > PoseSample.minimumConfidence } ?? false
            if !nose, (try? handler.perform([faceRequest])) != nil {
                face = VisionPose.face(from: faceRequest.results ?? [])
            }
        case .never:
            break
        }
        return PoseSample(time: frame.time, engine: kind, joints: joints, face: face,
                          imageAspect: frame.imageAspect, lowLight: frame.isLowLight)
    }
}

/// Vision face rectangles alone (`VNDetectFaceRectanglesRequest` revision 3): face box, roll, yaw and
/// pitch. No shoulders, so it measures head drop, forward head (face width), sideways tilt and head
/// pitch only. It still works when a chair back or a monitor hides the shoulders.
public final class VisionFaceEngine: FramePoseEngine {
    public let kind: PoseEngineKind = .visionFace
    public let usesCamera = true
    private let request: VNDetectFaceRectanglesRequest

    public init() {
        request = VisionPose.makeFaceRequest()
    }

    public func analyze(_ frame: CameraFrame) -> PoseSample? {
        let handler = VNImageRequestHandler(cvPixelBuffer: frame.pixelBuffer, orientation: .up, options: [:])
        do {
            try handler.perform([request])
        } catch {
            return nil
        }
        return PoseSample(time: frame.time, engine: kind, face: VisionPose.face(from: request.results ?? []),
                          imageAspect: frame.imageAspect, lowLight: frame.isLowLight)
    }
}

enum VisionPose {
    static let jointNames: [(VNHumanBodyPoseObservation.JointName, PoseJoint)] = [
        (.nose, .nose), (.leftEye, .leftEye), (.rightEye, .rightEye), (.leftEar, .leftEar),
        (.rightEar, .rightEar), (.neck, .neck), (.leftShoulder, .leftShoulder), (.rightShoulder, .rightShoulder),
    ]

    static func makeFaceRequest() -> VNDetectFaceRectanglesRequest {
        let request = VNDetectFaceRectanglesRequest()
        request.revision = VNDetectFaceRectanglesRequestRevision3
        request.preferBackgroundProcessing = true
        return request
    }

    /// The joints of the nearest person (widest confident shoulders, else the most confident nose),
    /// flipped from Vision's bottom-left origin to top-left. Zero-confidence points are invalid and left out.
    static func joints(from observations: [VNHumanBodyPoseObservation]) -> [PoseJoint: PoseJointPoint] {
        var best: [PoseJoint: PoseJointPoint] = [:]
        var bestScore = -1.0
        for observation in observations {
            guard let points = try? observation.recognizedPoints(.all) else { continue }
            var joints: [PoseJoint: PoseJointPoint] = [:]
            for (name, joint) in jointNames {
                guard let point = points[name], point.confidence > 0 else { continue }
                joints[joint] = PoseJointPoint(x: Double(point.location.x), y: 1 - Double(point.location.y),
                                               confidence: Double(point.confidence))
            }
            let score = personScore(joints)
            if score > bestScore {
                best = joints
                bestScore = score
            }
        }
        return best
    }

    static func personScore(_ joints: [PoseJoint: PoseJointPoint]) -> Double {
        let minimum = PoseSample.minimumConfidence
        if let left = joints[.leftShoulder], let right = joints[.rightShoulder],
           left.confidence > minimum, right.confidence > minimum {
            return 1 + hypot(left.x - right.x, left.y - right.y)
        }
        return joints[.nose]?.confidence ?? 0
    }

    /// The largest face, flipped to top-left.
    static func face(from observations: [VNFaceObservation]) -> PoseFace? {
        guard let observation = observations.max(by: { $0.boundingBox.width < $1.boundingBox.width }) else {
            return nil
        }
        let box = observation.boundingBox
        return PoseFace(box: CGRect(x: box.minX, y: 1 - box.maxY, width: box.width, height: box.height),
                        confidence: Double(observation.confidence),
                        roll: observation.roll?.doubleValue, yaw: observation.yaw?.doubleValue,
                        pitch: observation.pitch?.doubleValue)
    }
}
