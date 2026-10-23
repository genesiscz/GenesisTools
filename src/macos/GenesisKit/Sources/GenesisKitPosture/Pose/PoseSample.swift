import CoreGraphics
import Foundation
import GenesisKit

/// The upper-body joints a posture check reads. Vision names the subject's own left and right, so
/// `leftShoulder` is on the right of an unmirrored camera image.
public enum PoseJoint: String, CaseIterable, Codable, Sendable {
    case nose, leftEye, rightEye, leftEar, rightEar, neck, leftShoulder, rightShoulder
}

/// One joint: a position in normalized image space and the engine's confidence in it.
///
/// Coordinates run 0...1 with the origin at the top left of the camera image as the sensor delivers
/// it (not mirrored), `y` growing downwards. A view that mirrors the preview mirrors `x` itself.
public struct PoseJointPoint: Equatable, Codable, Sendable {
    public var x: Double
    public var y: Double
    public var confidence: Double

    public init(x: Double, y: Double, confidence: Double) {
        self.x = x
        self.y = y
        self.confidence = confidence
    }

    public var point: CGPoint { CGPoint(x: x, y: y) }
}

/// A detected face: its box in the same normalized top-left space as the joints, and the head angles
/// in radians when the engine reports them. `pitch` is positive when the head nods down (Vision's
/// convention, kept as is).
public struct PoseFace: Equatable, Codable, Sendable {
    public var box: CGRect
    public var confidence: Double
    public var roll: Double?
    public var yaw: Double?
    public var pitch: Double?

    public init(box: CGRect, confidence: Double = 1, roll: Double? = nil, yaw: Double? = nil, pitch: Double? = nil) {
        self.box = box
        self.confidence = confidence
        self.roll = roll
        self.yaw = yaw
        self.pitch = pitch
    }
}

/// Which engine produced a sample.
public enum PoseEngineKind: String, CaseIterable, Codable, Sendable {
    /// Vision 2D body pose (`VNDetectHumanBodyPoseRequest`); its face fallback still reports this kind.
    case visionBody
    /// Vision face rectangles (`VNDetectFaceRectanglesRequest`): face box, roll, yaw and pitch.
    case visionFace
    /// AirPods head motion (`CMHeadphoneMotionManager`): head pitch, no camera.
    case headphones
}

/// Which Vision request placed the shoulders and the neck. The two place them differently (3D about a third
/// narrower, at another tilt), so a baseline is only comparable with readings from the same request.
public enum PoseShoulderSource: String, CaseIterable, Codable, Sendable {
    /// `VNDetectHumanBodyPoseRequest`.
    case body2D
    /// `VNDetectHumanBodyPose3DRequest`, projected into the image.
    case body3D
}

/// One reading of the user's pose. Engines fill what they can see; every field is optional except the
/// time and the engine.
public struct PoseSample: Equatable, Codable, Sendable {
    /// Seconds on the monotonic uptime clock (`ProcessInfo.systemUptime`), so durations survive a wall
    /// clock change. Sleep stops this clock, which is what a posture timer wants.
    public var time: TimeInterval
    public var engine: PoseEngineKind
    public var joints: [PoseJoint: PoseJointPoint]
    public var face: PoseFace?
    /// Head pitch in radians from AirPods, positive when the head nods down (the engine flips Core
    /// Motion's sign so both pitch sources agree).
    public var headphonePitch: Double?
    /// Width over height of the analysed image; the overlay needs it to match an aspect-fill preview.
    public var imageAspect: Double
    /// True when the frame was too dark to judge. A dark frame is "unknown", never "away".
    public var lowLight: Bool
    /// The request behind the shoulders and the neck. Nil when the sample has no shoulders, or when the engine does
    /// not say (test samples).
    public var shoulderSource: PoseShoulderSource?
    /// Seconds since the request behind the shoulders ran: 0 when it ran on this frame. A throttled 3D request is
    /// reused for several seconds, so this tells a held reading from a fresh one.
    public var shoulderAge: TimeInterval?

    public init(time: TimeInterval, engine: PoseEngineKind, joints: [PoseJoint: PoseJointPoint] = [:],
                face: PoseFace? = nil, headphonePitch: Double? = nil, imageAspect: Double = 4.0 / 3.0,
                lowLight: Bool = false, shoulderSource: PoseShoulderSource? = nil, shoulderAge: TimeInterval? = nil) {
        self.time = time
        self.engine = engine
        self.joints = joints
        self.face = face
        self.headphonePitch = headphonePitch
        self.imageAspect = imageAspect
        self.lowLight = lowLight
        self.shoulderSource = shoulderSource
        self.shoulderAge = shoulderAge
    }

    /// Whether the shoulders were read on this frame rather than held from an earlier 3D request.
    public var hasFreshShoulders: Bool { shoulderAge == 0 }

    /// The lowest confidence a joint needs to count. Dorso and Apple's own samples gate at 0.3.
    public static let minimumConfidence = 0.3

    /// The joint when its confidence clears `minimumConfidence`.
    public func joint(_ joint: PoseJoint) -> PoseJointPoint? {
        guard let point = joints[joint], point.confidence > Self.minimumConfidence else { return nil }
        return point
    }

    /// Whether the sample saw a person: a confident nose, a face, both shoulders, or AirPods motion. The
    /// shoulders count so that a head bent far down (no nose, no face) reads as a slouch, not as away.
    public var hasPerson: Bool {
        joint(.nose) != nil || (face.map { $0.confidence > Self.minimumConfidence } ?? false) || headphonePitch != nil
            || (joint(.leftShoulder) != nil && joint(.rightShoulder) != nil)
    }
}

/// Joint dictionaries encode as `{"nose": {...}}` rather than Swift's default key/value array.
extension Dictionary where Key == PoseJoint, Value == PoseJointPoint {
    init(stringKeyed: [String: PoseJointPoint]) {
        self.init(uniqueKeysWithValues: stringKeyed.compactMap { key, value in
            PoseJoint(rawValue: key).map { ($0, value) }
        })
    }
}

extension PoseSample {
    private enum CodingKeys: String, CodingKey {
        case time, engine, joints, face, headphonePitch, imageAspect, lowLight, shoulderSource, shoulderAge
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        time = try container.decode(TimeInterval.self, forKey: .time)
        engine = try container.decode(PoseEngineKind.self, forKey: .engine)
        let raw = try container.decodeIfPresent([String: PoseJointPoint].self, forKey: .joints) ?? [:]
        joints = [PoseJoint: PoseJointPoint](stringKeyed: raw)
        face = try container.decodeIfPresent(PoseFace.self, forKey: .face)
        headphonePitch = try container.decodeIfPresent(Double.self, forKey: .headphonePitch)
        imageAspect = try container.decodeIfPresent(Double.self, forKey: .imageAspect) ?? 4.0 / 3.0
        lowLight = try container.decodeIfPresent(Bool.self, forKey: .lowLight) ?? false
        shoulderSource = try container.decodeIfPresent(PoseShoulderSource.self, forKey: .shoulderSource)
        shoulderAge = try container.decodeIfPresent(TimeInterval.self, forKey: .shoulderAge)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(time, forKey: .time)
        try container.encode(engine, forKey: .engine)
        try container.encode(Dictionary(uniqueKeysWithValues: joints.map { ($0.key.rawValue, $0.value) }), forKey: .joints)
        try container.encodeIfPresent(face, forKey: .face)
        try container.encodeIfPresent(headphonePitch, forKey: .headphonePitch)
        try container.encode(imageAspect, forKey: .imageAspect)
        try container.encode(lowLight, forKey: .lowLight)
        try container.encodeIfPresent(shoulderSource, forKey: .shoulderSource)
        try container.encodeIfPresent(shoulderAge, forKey: .shoulderAge)
    }
}
