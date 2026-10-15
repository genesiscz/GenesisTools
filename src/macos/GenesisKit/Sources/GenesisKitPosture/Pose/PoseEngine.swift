import CoreGraphics
import Foundation
import Vision
import GenesisKit

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
/// the same frame when the body pose has no confident nose or misses a shoulder (Dorso's fallback,
/// widened: every body measure needs both shoulders, so without one the face is all there is). `.always`
/// runs both on every frame (calibration, so the baseline holds the face measures too, and a baseline
/// that has only face measures).
///
/// The 2D request often finds no body at all for a person sitting close to a laptop camera, while the 3D
/// request (`VNDetectHumanBodyPose3DRequest`, macOS 14) finds the same person with every joint (real
/// frames, 2026-10-14). The two place the shoulders differently (3D about a third narrower, at another
/// tilt), so one reading never mixes them: with `body3D` on, the shoulders and the neck always come from
/// 3D and the 2D ones are dropped. The 3D request costs about 80 ms of CPU against 7 ms for 2D plus face,
/// so `.throttled` runs it at most once per `body3DInterval` and keeps its shoulders for up to two
/// intervals; shoulders move slowly next to the onset delay. `.always` runs it on every frame
/// (calibration, so every reading carries the shoulders).
public final class VisionBodyPoseEngine: FramePoseEngine {
    public enum FaceDetection: Sendable {
        case never, fallback, always
    }

    public enum Body3D: Sendable {
        /// Shoulders from the 2D request only.
        case never
        /// Shoulders from the 3D request, refreshed at most once per `body3DInterval`.
        case throttled
        /// Shoulders from the 3D request on every frame.
        case always
    }

    public let kind: PoseEngineKind = .visionBody
    public let usesCamera = true
    /// When to run the face request. Change it only from the queue that calls `analyze`.
    public var faceDetection: FaceDetection
    /// When to run the 3D body request for the shoulders. Change it only from the queue that calls `analyze`.
    public var body3D: Body3D
    /// The least time between two throttled 3D requests, in frame-time seconds.
    public var body3DInterval: TimeInterval

    private let bodyRequest: VNDetectHumanBodyPoseRequest
    private let faceRequest: VNDetectFaceRectanglesRequest
    private let body3DRequest = VNDetectHumanBodyPose3DRequest()
    private var last3DAttempt: TimeInterval?
    private var last3D: (time: TimeInterval, joints: [PoseJoint: PoseJointPoint])?

    public init(faceDetection: FaceDetection = .fallback, body3D: Body3D = .throttled, body3DInterval: TimeInterval = 4) {
        self.faceDetection = faceDetection
        self.body3D = body3D
        self.body3DInterval = body3DInterval
        bodyRequest = VNDetectHumanBodyPoseRequest()
        bodyRequest.preferBackgroundProcessing = true
        faceRequest = VisionPose.makeFaceRequest()
        body3DRequest.preferBackgroundProcessing = true
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
        let current = VisionPose.joints(from: bodyRequest.results ?? [])
        var joints = current
        var cachedShoulders = false
        if body3D != .never {
            (joints, cachedShoulders) = withShoulders3D(current, handler: handler, time: frame.time)
        }
        var face: PoseFace?
        switch faceDetection {
        case .always:
            face = VisionPose.face(from: faceRequest.results ?? [])
        case .fallback:
            if Self.needsFace(joints), (try? handler.perform([faceRequest])) != nil {
                face = VisionPose.face(from: faceRequest.results ?? [])
            }
        case .never:
            break
        }
        joints = Self.trustedJoints(joints, current: current, cachedShoulders: cachedShoulders, face: face)
        return PoseSample(time: frame.time, engine: kind, joints: joints, face: face,
                          imageAspect: frame.imageAspect, lowLight: frame.isLowLight)
    }

    /// The 2D joints with the shoulders and the neck replaced by the 3D request's (run now when due, else
    /// the last result while it is fresh). Without a fresh 3D body the reading has no shoulders. `cached` is
    /// true when the shoulders came from an earlier frame's 3D result.
    private func withShoulders3D(_ joints: [PoseJoint: PoseJointPoint], handler: VNImageRequestHandler,
                                 time: TimeInterval) -> (joints: [PoseJoint: PoseJointPoint], cached: Bool) {
        var head = joints
        for joint in VisionPose.shoulderJoints { head[joint] = nil }
        let due: Bool
        switch body3D {
        case .never: return (joints, false)
        case .always: due = true
        case .throttled: due = last3DAttempt.map { time - $0 >= body3DInterval || time < $0 } ?? true
        }
        if due {
            last3DAttempt = time
            last3D = (try? handler.perform([body3DRequest])) != nil
                ? VisionPose.shoulders3D(from: body3DRequest.results ?? []).map { (time, $0) }
                : nil
        }
        guard let cached = last3D, abs(time - cached.time) <= body3DInterval * 2 else { return (head, false) }
        return (head.merging(cached.joints) { _, new in new }, !due)
    }

    /// Whether this frame shows a person by itself: a confident 2D joint other than the shoulders and the neck
    /// (those come from the 3D request), or a confident face. Cached 3D shoulders count only then: after the
    /// user left, a throttled frame kept the last shoulders for up to the 3D interval, `hasPerson` stayed true,
    /// and with no nose the scorer read a full head drop instead of away (review of #514, 2026-10-14).
    static func trustedJoints(_ joints: [PoseJoint: PoseJointPoint], current: [PoseJoint: PoseJointPoint],
                              cachedShoulders: Bool, face: PoseFace?) -> [PoseJoint: PoseJointPoint] {
        guard cachedShoulders, !showsPerson(current: current, face: face) else { return joints }
        var trusted = joints
        for joint in VisionPose.shoulderJoints { trusted[joint] = nil }
        return trusted
    }

    static func showsPerson(current: [PoseJoint: PoseJointPoint], face: PoseFace?) -> Bool {
        let own = current.contains { joint, point in
            !VisionPose.shoulderJoints.contains(joint) && point.confidence > PoseSample.minimumConfidence
        }
        return own || (face.map { $0.confidence > PoseSample.minimumConfidence } ?? false)
    }

    /// The fallback's rule: the body reading cannot give the shoulder-based measures (no confident nose,
    /// or a shoulder missing), so the face request has to run. Live run 2026-10-14: a hand over one
    /// shoulder left nose, eyes and one shoulder, no measure at all, and a stale "Upright".
    static func needsFace(_ joints: [PoseJoint: PoseJointPoint]) -> Bool {
        let required: [PoseJoint] = [.nose, .leftShoulder, .rightShoulder]
        return required.contains { joint in
            !(joints[joint].map { $0.confidence > PoseSample.minimumConfidence } ?? false)
        }
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
    /// The joints the 3D request supplies in place of the 2D ones.
    static let shoulderJoints: [PoseJoint] = [.leftShoulder, .rightShoulder, .neck]

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

    /// The shoulders and the neck (centre shoulder) of the most confident 3D body, projected into the
    /// image and flipped to top-left. The 3D joints have no confidence of their own: each takes the body's.
    static func shoulders3D(from observations: [VNHumanBodyPose3DObservation]) -> [PoseJoint: PoseJointPoint]? {
        guard let body = observations.max(by: { $0.confidence < $1.confidence }),
              Double(body.confidence) > PoseSample.minimumConfidence else { return nil }
        let names: [(VNHumanBodyPose3DObservation.JointName, PoseJoint)] = [
            (.leftShoulder, .leftShoulder), (.rightShoulder, .rightShoulder), (.centerShoulder, .neck),
        ]
        var joints: [PoseJoint: PoseJointPoint] = [:]
        for (name, joint) in names {
            guard let point = try? body.pointInImage(name) else { return nil }
            joints[joint] = PoseJointPoint(x: Double(point.location.x), y: 1 - Double(point.location.y),
                                           confidence: Double(body.confidence))
        }
        return joints
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
