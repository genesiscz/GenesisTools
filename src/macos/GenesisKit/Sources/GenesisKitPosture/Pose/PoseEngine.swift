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
/// that uses face measures or face growth to corroborate Forward head).
///
/// The 2D request often finds no body at all for a person sitting close to a laptop camera, while the 3D
/// request (`VNDetectHumanBodyPose3DRequest`, macOS 14) finds the same person with every joint (real
/// frames, 2026-10-14). The two place the shoulders differently (3D about a third narrower, at another
/// tilt), so one reading never mixes them: with `body3D` on, the shoulders and the neck always come from
/// 3D and the 2D ones are dropped. The 3D request costs about 80 ms of CPU against 7 ms for 2D plus face,
/// so `.throttled` runs it at most once per `body3DInterval` and keeps projected candidates for up to two
/// intervals, matching them to the current person on each frame. `.always` runs it on every frame
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
    private var last3D: (time: TimeInterval, bodies: [VisionPose.Body3DCandidate])?

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
        let current = VisionPose.joints(from: bodyRequest.results ?? [], aspect: frame.imageAspect)
        var joints = current
        var cachedShoulders = false
        if body3D != .never {
            (joints, cachedShoulders) = withShoulders3D(current, handler: handler, time: frame.time,
                                                        aspect: frame.imageAspect)
        }
        var face: PoseFace?
        switch faceDetection {
        case .always:
            face = VisionPose.face(from: faceRequest.results ?? [], near: current)
        case .fallback:
            if Self.needsFace(joints), (try? handler.perform([faceRequest])) != nil {
                face = VisionPose.face(from: faceRequest.results ?? [], near: current)
            }
        case .never:
            break
        }
        if body3D != .never, face != nil {
            (joints, cachedShoulders) = matchedShoulders3D(current, time: frame.time, aspect: frame.imageAspect,
                                                           cached: cachedShoulders, face: face)
        }
        joints = Self.trustedJoints(joints, current: current, cachedShoulders: cachedShoulders, face: face)
        return PoseSample(time: frame.time, engine: kind, joints: joints, face: face,
                          imageAspect: frame.imageAspect, lowLight: frame.isLowLight)
    }

    /// Replaces 2D shoulders with a matching projected 3D candidate, refreshing the candidates when due.
    /// Cached candidates are matched again against this frame's person, so switching heads cannot reuse
    /// the previous person's shoulders. Without a match the reading has no shoulders.
    private func withShoulders3D(_ joints: [PoseJoint: PoseJointPoint], handler: VNImageRequestHandler,
                                 time: TimeInterval, aspect: Double) -> (joints: [PoseJoint: PoseJointPoint], cached: Bool) {
        let due: Bool
        switch body3D {
        case .never: return (joints, false)
        case .always: due = true
        case .throttled: due = last3DAttempt.map { time - $0 >= body3DInterval || time < $0 } ?? true
        }
        if due {
            last3DAttempt = time
            last3D = (try? handler.perform([body3DRequest])) != nil
                ? (time, VisionPose.bodies3D(from: body3DRequest.results ?? []))
                : nil
        }
        return matchedShoulders3D(joints, time: time, aspect: aspect, cached: !due, face: nil)
    }

    /// Matches the already-fetched candidates without another 3D request. After face detection this runs
    /// again so a face-only frame can supply the anchor that the initial 2D matching lacked.
    private func matchedShoulders3D(_ joints: [PoseJoint: PoseJointPoint], time: TimeInterval, aspect: Double,
                                    cached: Bool, face: PoseFace?) -> (joints: [PoseJoint: PoseJointPoint], cached: Bool) {
        var head = joints
        for joint in VisionPose.shoulderJoints { head[joint] = nil }
        guard let stored = last3D, abs(time - stored.time) <= body3DInterval * 2 else { return (head, false) }
        let shoulders = VisionPose.shoulders3D(from: stored.bodies, matching: joints, aspect: aspect, cached: cached, face: face)
        return (head.merging(shoulders) { _, new in new }, cached)
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

    /// Whether this frame independently detects a person, without relying on cached 3D joints.
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

    /// A background face request with the revision that supplies head pitch as well as roll and yaw.
    static func makeFaceRequest() -> VNDetectFaceRectanglesRequest {
        let request = VNDetectFaceRectanglesRequest()
        request.revision = VNDetectFaceRectanglesRequestRevision3
        request.preferBackgroundProcessing = true
        return request
    }

    /// The joints of the nearest person (`nearestPerson`), flipped from Vision's bottom-left origin to top-left.
    /// Zero-confidence points are invalid and left out. `aspect` is the frame's width over its height.
    static func joints(from observations: [VNHumanBodyPoseObservation], aspect: Double) -> [PoseJoint: PoseJointPoint] {
        let people: [[PoseJoint: PoseJointPoint]] = observations.compactMap { observation in
            guard let points = try? observation.recognizedPoints(.all) else { return nil }
            var joints: [PoseJoint: PoseJointPoint] = [:]
            for (name, joint) in jointNames {
                guard let point = points[name], point.confidence > 0 else { continue }
                joints[joint] = PoseJointPoint(x: Double(point.location.x), y: 1 - Double(point.location.y),
                                               confidence: Double(point.confidence))
            }
            return joints
        }
        return nearestPerson(people, aspect: aspect)
    }

    /// The person closest to the camera: the one whose head looks largest. A low camera cuts the user's shoulders
    /// off while someone standing behind shows both, so ranking by shoulder width tracked the colleague for a whole
    /// debug recording (2026-10-15 14:58, Office). A person with no measurable head counts by an estimate from the
    /// shoulders, and a person with neither by the nose's confidence, below anyone with a size.
    /// Lengths are image heights, so a rolled head on a wide frame does not outrank a wider upright one.
    static func nearestPerson(_ people: [[PoseJoint: PoseJointPoint]], aspect: Double = 1) -> [PoseJoint: PoseJointPoint] {
        people.max { personScore($0, aspect: aspect) < personScore($1, aspect: aspect) } ?? [:]
    }

    /// Comparable apparent size, falling back to nose confidence only when neither head nor shoulders has a span.
    static func personScore(_ joints: [PoseJoint: PoseJointPoint], aspect: Double = 1) -> Double {
        if let head = headSize(joints, aspect: aspect) { return 1 + head }
        if let span = shoulderSpan(joints, aspect: aspect) { return 1 + span * headPerShoulder }
        return joints[.nose]?.confidence ?? 0
    }

    /// A head's width over a shoulder span, for comparing a person seen only by the shoulders with one seen by the
    /// head (about 0.45 for an adult facing the camera).
    static let headPerShoulder = 0.45

    /// Width over height. A non-positive value stands in for 4:3, as a sample's aspect does.
    static func aspectScale(_ aspect: Double) -> Double {
        aspect > 0 ? aspect : 4.0 / 3.0
    }

    /// The distance between two joints in image heights. Normalized x is a fraction of the width, so it is
    /// scaled by the aspect, the same way `PostureMetrics` scales a shoulder line.
    static func lengthInImageHeights(_ left: PoseJointPoint, _ right: PoseJointPoint, aspect: Double) -> Double {
        let scale = aspectScale(aspect)
        return hypot((left.x - right.x) * scale, left.y - right.y)
    }

    /// The head's width in image heights: ear to ear, else eye to eye doubled (the eyes sit about half as far
    /// apart). The default aspect is a square image, where a normalized length is already a fraction of the height.
    static func headSize(_ joints: [PoseJoint: PoseJointPoint], aspect: Double = 1) -> Double? {
        let minimum = PoseSample.minimumConfidence
        if let left = joints[.leftEar], let right = joints[.rightEar],
           left.confidence > minimum, right.confidence > minimum {
            return lengthInImageHeights(left, right, aspect: aspect)
        }
        if let left = joints[.leftEye], let right = joints[.rightEye],
           left.confidence > minimum, right.confidence > minimum {
            return 2 * lengthInImageHeights(left, right, aspect: aspect)
        }
        return nil
    }

    /// Shoulder width in image heights, available only when both joints clear the confidence gate.
    static func shoulderSpan(_ joints: [PoseJoint: PoseJointPoint], aspect: Double = 1) -> Double? {
        let minimum = PoseSample.minimumConfidence
        guard let left = joints[.leftShoulder], let right = joints[.rightShoulder],
              left.confidence > minimum, right.confidence > minimum else { return nil }
        return lengthInImageHeights(left, right, aspect: aspect)
    }

    /// One 3D body already projected into the image (top-left). Tests build these; Vision observations cannot.
    struct Body3DCandidate: Equatable {
        var confidence: Double
        var left: PoseJointPoint
        var right: PoseJointPoint
        var neck: PoseJointPoint
        /// `centerHead` projected into the image. Nil when the observation has no head joint.
        var head: PoseJointPoint? = nil
    }

    /// The 3D body that belongs to the person `joints` already chose (`nearestPerson`).
    /// With no confident 2D shoulders, the body whose projected head sits on the chosen nose (the low-camera
    /// case: the user's shoulders are below the frame). With no nose, the most confident 3D body.
    /// A body whose shoulder midpoint sits farther than the 2D shoulder span is someone else and is left out:
    /// the same person's 3D shoulders are narrower, but they share the midpoint.
    static func selectBody(_ bodies: [Body3DCandidate], matching joints: [PoseJoint: PoseJointPoint],
                           aspect: Double = 1) -> Body3DCandidate? {
        let minimum = PoseSample.minimumConfidence
        let eligible = bodies.filter { $0.confidence > minimum }
        guard !eligible.isEmpty else { return nil }
        guard let left = joints[.leftShoulder], let right = joints[.rightShoulder],
              left.confidence > minimum, right.confidence > minimum else {
            guard let nose = joints[.nose], nose.confidence > minimum else {
                return eligible.max { $0.confidence < $1.confidence }
            }
            return bodyForShoulderlessPerson(eligible, matching: joints, nose: nose, aspect: aspect)
        }
        let anchor = PoseJointPoint(x: (left.x + right.x) / 2, y: (left.y + right.y) / 2, confidence: 1)
        let span = lengthInImageHeights(left, right, aspect: aspect)
        guard span > 0 else { return eligible.max { $0.confidence < $1.confidence } }
        let ranked = eligible.map { body -> (body: Body3DCandidate, distance: Double) in
            let midX = (body.left.x + body.right.x) / 2
            let midY = (body.left.y + body.right.y) / 2
            let midpoint = PoseJointPoint(x: midX, y: midY, confidence: 1)
            return (body, lengthInImageHeights(midpoint, anchor, aspect: aspect))
        }
        guard let nearest = ranked.min(by: { lhs, rhs in
            if lhs.distance == rhs.distance { return lhs.body.confidence > rhs.body.confidence }
            return lhs.distance < rhs.distance
        }) else { return nil }
        guard nearest.distance <= span else { return nil }
        return nearest.body
    }

    /// Shoulders for a person the 2D request saw without them. The 3D body's projected head has to sit on
    /// that person's nose. Ranking shoulder midpoints by horizontal offset took a colleague standing in
    /// line with the user (review of #529): both bodies were under the nose, and the smaller x won.
    static func bodyForShoulderlessPerson(_ bodies: [Body3DCandidate], matching joints: [PoseJoint: PoseJointPoint],
                                          nose: PoseJointPoint, aspect: Double) -> Body3DCandidate? {
        let scale = aspectScale(aspect)
        let headWidth = headSize(joints, aspect: aspect) ?? 0
        // Head width is an image height. The sideways gate is a normalized x distance, so divide it back.
        let reach = max(1.5 * headWidth / scale, 0.1)
        if bodies.contains(where: { $0.head != nil }) {
            let limit = max(headWidth, 0.08)
            let ranked = bodies.compactMap { body -> (body: Body3DCandidate, distance: Double)? in
                guard let head = body.head else { return nil }
                let midY = (body.left.y + body.right.y) / 2
                guard midY > nose.y else { return nil }
                return (body, lengthInImageHeights(head, nose, aspect: scale))
            }.sorted { lhs, rhs in
                if lhs.distance == rhs.distance { return lhs.body.confidence > rhs.body.confidence }
                return lhs.distance < rhs.distance
            }
            let inside = ranked.filter { $0.distance <= limit }
            guard let nearest = inside.first else { return nil }
            if inside.count > 1 {
                let second = inside[1].distance
                // A second head almost as close belongs to someone else. Leave both out.
                let ambiguous = nearest.distance == 0 ? second <= 0 : second < nearest.distance * 2
                if ambiguous { return nil }
            }
            return nearest.body
        }
        let under = bodies.filter { body in
            let midX = (body.left.x + body.right.x) / 2
            let midY = (body.left.y + body.right.y) / 2
            return abs(midX - nose.x) <= reach && midY > nose.y
        }
        // One body under the nose is this person. Two can be told apart only by x, which is the mix-up.
        guard under.count == 1 else { return nil }
        return under[0]
    }

    /// The face that belongs with `anchor` (the selected person's nose). Without an anchor, the largest face
    /// (a face-only engine). A face whose centre is farther than its own size is a different person.
    static func selectFace(_ faces: [PoseFace], near anchor: PoseJointPoint?) -> PoseFace? {
        guard !faces.isEmpty else { return nil }
        guard let anchor, anchor.confidence > PoseSample.minimumConfidence else {
            return faces.max { $0.box.width < $1.box.width }
        }
        let ranked = faces.map { face -> (face: PoseFace, distance: Double) in
            let centerX = face.box.midX
            let centerY = face.box.midY
            return (face, hypot(centerX - anchor.x, centerY - anchor.y))
        }
        guard let nearest = ranked.min(by: { $0.distance < $1.distance }) else { return nil }
        let limit = max(nearest.face.box.width, nearest.face.box.height, 0.05)
        guard nearest.distance <= limit else { return nil }
        return nearest.face
    }

    /// Projects all 3D bodies into the top-left image coordinates so later frames can match them again.
    /// The 3D joints have no confidence of their own: each takes the body's.
    static func bodies3D(from observations: [VNHumanBodyPose3DObservation]) -> [Body3DCandidate] {
        var bodies: [Body3DCandidate] = []
        for body in observations {
            guard let left = try? body.pointInImage(.leftShoulder),
                  let right = try? body.pointInImage(.rightShoulder),
                  let neck = try? body.pointInImage(.centerShoulder) else { continue }
            let confidence = Double(body.confidence)
            let head = (try? body.pointInImage(.centerHead)).map { point in
                PoseJointPoint(x: Double(point.location.x), y: 1 - Double(point.location.y), confidence: confidence)
            }
            bodies.append(Body3DCandidate(
                confidence: confidence,
                left: PoseJointPoint(x: Double(left.location.x), y: 1 - Double(left.location.y), confidence: confidence),
                right: PoseJointPoint(x: Double(right.location.x), y: 1 - Double(right.location.y), confidence: confidence),
                neck: PoseJointPoint(x: Double(neck.location.x), y: 1 - Double(neck.location.y), confidence: confidence),
                head: head))
        }
        return bodies
    }

    /// Shoulders for the current person, or an empty map when no body matches. With no 2D anchor, a
    /// confident current face supplies its centre and width for head matching. Cached candidates require
    /// one of these anchors: body confidence alone cannot identify a person across frames.
    static func shoulders3D(from bodies: [Body3DCandidate], matching joints: [PoseJoint: PoseJointPoint],
                            aspect: Double, cached: Bool = false, face: PoseFace? = nil) -> [PoseJoint: PoseJointPoint] {
        var anchor = joints
        let hasNose = (joints[.nose]?.confidence ?? 0) > PoseSample.minimumConfidence
        let hasShoulders = (shoulderSpan(joints, aspect: aspect) ?? 0) > 0
        if !hasNose, !hasShoulders, let face, face.confidence > PoseSample.minimumConfidence,
           face.box.width > 0.01, face.box.height > 0.01 {
            anchor[.nose] = PoseJointPoint(x: face.box.midX, y: face.box.midY, confidence: face.confidence)
            anchor[.leftEar] = PoseJointPoint(x: face.box.minX, y: face.box.midY, confidence: face.confidence)
            anchor[.rightEar] = PoseJointPoint(x: face.box.maxX, y: face.box.midY, confidence: face.confidence)
        }
        if cached, (anchor[.nose]?.confidence ?? 0) <= PoseSample.minimumConfidence, !hasShoulders { return [:] }
        guard let chosen = selectBody(bodies, matching: anchor, aspect: aspect) else { return [:] }
        return [.leftShoulder: chosen.left, .rightShoulder: chosen.right, .neck: chosen.neck]
    }

    /// A face from the observations, flipped to top-left, chosen for the person in `joints` when that person
    /// has a nose. With no joints, the largest face.
    static func face(from observations: [VNFaceObservation], near joints: [PoseJoint: PoseJointPoint] = [:]) -> PoseFace? {
        let faces = observations.map { observation -> PoseFace in
            let box = observation.boundingBox
            return PoseFace(box: CGRect(x: box.minX, y: 1 - box.maxY, width: box.width, height: box.height),
                            confidence: Double(observation.confidence),
                            roll: observation.roll?.doubleValue, yaw: observation.yaw?.doubleValue,
                            pitch: observation.pitch?.doubleValue)
        }
        return selectFace(faces, near: joints[.nose])
    }
}
