import Foundation

/// The five posture faults a frontal webcam can see, plus head pitch. A frontal camera cannot measure
/// the clinical craniovertebral angle (that needs a side view), so each one is a proxy that only means
/// something against the user's own calibrated baseline.
public enum PostureMetricKind: String, CaseIterable, Codable, Sendable {
    /// The head sinks towards the shoulder line.
    case headDrop
    /// The head moves forward of the shoulders: the face grows against the shoulder width.
    case forwardHead
    /// The whole upper body moves towards the screen: the shoulders grow in the frame.
    case leanIn
    /// One shoulder sits higher than the other.
    case shoulderTilt
    /// The head moves sideways off the middle of the shoulders, or tilts sideways.
    case lateralLean
    /// The head nods down (AirPods, or the face request's pitch).
    case headPitch

    public var title: String {
        switch self {
        case .headDrop: "Head drop"
        case .forwardHead: "Forward head"
        case .leanIn: "Leaning in"
        case .shoulderTilt: "Shoulder tilt"
        case .lateralLean: "Leaning sideways"
        case .headPitch: "Head down"
        }
    }
}

/// One raw measurement taken from a pose sample. Body measures are divided by the shoulder width, so
/// the distance to the camera cancels out; face measures are compared through the baseline face width.
public enum PostureMeasure: String, CaseIterable, Codable, Sendable {
    /// (shoulder midpoint y − nose y) / shoulder width. Smaller is worse.
    case headHeight
    /// Shoulder span in image heights. Larger than the baseline is leaning in.
    case shoulderWidth
    /// Eye span / shoulder width. Larger than the baseline is the head forward of the shoulders.
    case eyeSpanRatio
    /// Angle of the shoulder line in radians.
    case shoulderTilt
    /// (nose x − shoulder midpoint x) / shoulder width.
    case lateralOffset
    /// Face box centre x, in image heights from the left edge.
    case faceCenterX
    /// Face box centre y (image fraction, top-left origin). Larger is lower.
    case faceCenterY
    /// Face box width, in image heights.
    case faceWidth
    /// Face roll in radians.
    case faceRoll
    /// Face pitch in radians, positive nodding down.
    case facePitch
    /// AirPods pitch in radians, positive nodding down.
    case headphonePitch

    /// How a reading compares with its baseline.
    enum Comparison {
        /// baseline − current: worse when the value falls.
        case falls
        /// current − baseline: worse when the value rises.
        case rises
        /// current / baseline − 1: worse when the value grows.
        case grows
        /// |current − baseline|: worse either way.
        case drifts
        /// (current − baseline) / baseline face width: worse when it rises.
        case risesInFaceWidths
        /// |current − baseline| / baseline face width.
        case driftsInFaceWidths
    }

    /// Which fault this measure stands in for.
    public var kind: PostureMetricKind {
        switch self {
        case .headHeight, .faceCenterY: .headDrop
        case .eyeSpanRatio, .faceWidth: .forwardHead
        case .shoulderWidth: .leanIn
        case .shoulderTilt: .shoulderTilt
        case .lateralOffset, .faceCenterX, .faceRoll: .lateralLean
        case .facePitch, .headphonePitch: .headPitch
        }
    }

    var comparison: Comparison {
        switch self {
        case .headHeight: .falls
        case .shoulderWidth, .eyeSpanRatio, .faceWidth: .grows
        case .shoulderTilt, .lateralOffset, .faceRoll: .drifts
        case .faceCenterX: .driftsInFaceWidths
        case .faceCenterY: .risesInFaceWidths
        case .facePitch, .headphonePitch: .rises
        }
    }

    /// The deviation that counts as one whole "calibrated range" when the user gave no slouch sample.
    /// Sources: Dorso's forward-head span (0.15) and AirPods severity span (0.3 rad); the rest are
    /// proposals in the same units (see the PostureApps research note).
    public var defaultSpan: Double {
        switch self {
        case .headHeight: 0.20
        case .shoulderWidth: 0.20
        case .eyeSpanRatio, .faceWidth: 0.15
        case .shoulderTilt: 0.17
        case .lateralOffset: 0.30
        case .faceCenterX: 0.60
        case .faceCenterY: 0.35
        case .faceRoll: 0.26
        case .facePitch, .headphonePitch: 0.30
        }
    }

    /// Deviation that is always tolerated, before the dead zone: sensor noise and normal movement.
    /// Sources: Dorso's forward-head base threshold (0.05) and AirPods base threshold (0.15 rad).
    public var minimumTolerance: Double {
        switch self {
        case .headHeight: 0.04
        case .shoulderWidth: 0.06
        case .eyeSpanRatio, .faceWidth: 0.05
        case .shoulderTilt: 0.05
        case .lateralOffset: 0.08
        case .faceCenterX: 0.15
        case .faceCenterY: 0.07
        case .faceRoll: 0.09
        case .facePitch, .headphonePitch: 0.15
        }
    }

    /// Which measure a fault reads first when several are available: body joints before the face box.
    static func preference(for kind: PostureMetricKind) -> [PostureMeasure] {
        switch kind {
        case .headDrop: [.headHeight, .faceCenterY]
        case .forwardHead: [.eyeSpanRatio, .faceWidth]
        case .leanIn: [.shoulderWidth]
        case .shoulderTilt: [.shoulderTilt]
        case .lateralLean: [.lateralOffset, .faceRoll, .faceCenterX]
        case .headPitch: [.headphonePitch, .facePitch]
        }
    }
}

/// The measures read from one sample (or a median of several). A missing joint leaves its measures out.
public struct PostureMetrics: Equatable, Codable, Sendable {
    public var values: [PostureMeasure: Double]

    public init(_ values: [PostureMeasure: Double] = [:]) {
        self.values = values
    }

    public subscript(measure: PostureMeasure) -> Double? {
        get { values[measure] }
        set { values[measure] = newValue }
    }

    public var isEmpty: Bool { values.isEmpty }

    /// Reads every measure the sample supports. Horizontal distances are scaled by the image aspect
    /// first, so every length is in image heights and angles are true angles (a 4:3 frame no longer
    /// shrinks widths by a quarter). Shoulders narrower than 2% of the image height are treated as
    /// missing, because dividing by them turns noise into huge numbers.
    public init(sample: PoseSample) {
        var values: [PostureMeasure: Double] = [:]
        let aspect = sample.imageAspect > 0 ? sample.imageAspect : 4.0 / 3.0
        if let left = sample.joint(.leftShoulder), let right = sample.joint(.rightShoulder) {
            let width = hypot((left.x - right.x) * aspect, left.y - right.y)
            if width > 0.02 {
                let midX = (left.x + right.x) / 2
                let midY = (left.y + right.y) / 2
                values[.shoulderWidth] = width
                // Tilt of the line from the image-left shoulder to the image-right one, so the sign
                // does not depend on which side Vision calls left.
                let (a, b) = left.x < right.x ? (left, right) : (right, left)
                values[.shoulderTilt] = atan2(b.y - a.y, (b.x - a.x) * aspect)
                if let nose = sample.joint(.nose) {
                    values[.headHeight] = (midY - nose.y) / width
                    values[.lateralOffset] = (nose.x - midX) * aspect / width
                }
                if let leftEye = sample.joint(.leftEye), let rightEye = sample.joint(.rightEye) {
                    values[.eyeSpanRatio] = hypot((leftEye.x - rightEye.x) * aspect, leftEye.y - rightEye.y) / width
                }
            }
        }
        if let face = sample.face, face.confidence > PoseSample.minimumConfidence, face.box.width > 0.01 {
            values[.faceCenterX] = Double(face.box.midX) * aspect
            values[.faceCenterY] = Double(face.box.midY)
            values[.faceWidth] = Double(face.box.width) * aspect
            if let roll = face.roll { values[.faceRoll] = roll }
            if let pitch = face.pitch { values[.facePitch] = pitch }
        }
        if let pitch = sample.headphonePitch { values[.headphonePitch] = pitch }
        self.values = values
    }

    /// The per-measure median of several readings; a measure present in fewer than half of them is
    /// dropped, so one lucky frame cannot invent a value.
    public static func median(_ readings: [PostureMetrics]) -> PostureMetrics {
        guard !readings.isEmpty else { return PostureMetrics() }
        var result: [PostureMeasure: Double] = [:]
        for measure in PostureMeasure.allCases {
            let values = readings.compactMap { $0[measure] }.sorted()
            guard !values.isEmpty, values.count * 2 >= readings.count else { continue }
            let mid = values.count / 2
            result[measure] = values.count % 2 == 1 ? values[mid] : (values[mid - 1] + values[mid]) / 2
        }
        return PostureMetrics(result)
    }

    private enum CodingKeys: String, CodingKey { case values }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let raw = try container.decodeIfPresent([String: Double].self, forKey: .values) ?? [:]
        values = Dictionary(uniqueKeysWithValues: raw.compactMap { key, value in
            PostureMeasure(rawValue: key).map { ($0, value) }
        })
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(Dictionary(uniqueKeysWithValues: values.map { ($0.key.rawValue, $0.value) }), forKey: .values)
    }
}

extension PostureMeasure {
    /// How far `current` sits on the bad side of `baseline`, in this measure's own units. Negative or
    /// zero means at or better than the baseline. `faceWidth` is the baseline face width, needed for the
    /// face-position measures.
    func deviation(current: Double, baseline: Double, baselineFaceWidth: Double?) -> Double? {
        switch comparison {
        case .falls: return baseline - current
        case .rises: return current - baseline
        case .grows:
            guard baseline > 0 else { return nil }
            return current / baseline - 1
        case .drifts: return abs(current - baseline)
        case .risesInFaceWidths:
            guard let width = baselineFaceWidth, width > 0 else { return nil }
            return (current - baseline) / width
        case .driftsInFaceWidths:
            guard let width = baselineFaceWidth, width > 0 else { return nil }
            return abs(current - baseline) / width
        }
    }
}
