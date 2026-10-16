import Foundation
import GenesisKit

/// How much drift is tolerated before a reading counts as bad, as a fraction of the calibrated range.
/// Levels and values from Dorso's "Dead zone" setting (`SettingsWindow.swift:61`); Medium is the default
/// because users of the tight end reported unwanted alerts (Dorso #55, #84).
public enum PostureDeadZone: Int, CaseIterable, Codable, Sendable {
    case strict, tight, medium, relaxed, loose

    public static let `default`: PostureDeadZone = .medium

    public var fraction: Double {
        switch self {
        case .strict: 0.0
        case .tight: 0.08
        case .medium: 0.15
        case .relaxed: 0.25
        case .loose: 0.40
        }
    }

    public var title: String {
        switch self {
        case .strict: "Strict"
        case .tight: "Tight"
        case .medium: "Medium"
        case .relaxed: "Relaxed"
        case .loose: "Loose"
        }
    }
}

/// How hard a given slouch hits: the effect strength is `severity ^ (1 / exponent)`, so a high level
/// shows a strong effect for a small slouch. Levels and exponents from Dorso's "Intensity" setting
/// (`SettingsWindow.swift:58`, `PostureEngine.swift:226`); Medium is the default.
public enum PostureSensitivity: Int, CaseIterable, Codable, Sendable {
    case gentle, easy, medium, firm, aggressive

    public static let `default`: PostureSensitivity = .medium

    public var exponent: Double {
        switch self {
        case .gentle: 0.08
        case .easy: 0.15
        case .medium: 0.35
        case .firm: 0.65
        case .aggressive: 1.2
        }
    }

    public var title: String {
        switch self {
        case .gentle: "Gentle"
        case .easy: "Easy"
        case .medium: "Medium"
        case .firm: "Firm"
        case .aggressive: "Aggressive"
        }
    }
}

/// How Forward head is judged when a body-pose reading has no shoulders, so only the face width is left. The face also
/// grows when the user only sits closer, so a face-only reading cannot tell the two apart (live run 2026-10-14: the face
/// 25% wider while upright, against an enter threshold of 0.078, kept a slouch on for good).
public enum PostureForwardHeadFallback: String, CaseIterable, Codable, Sendable {
    /// Forward head counts only while the shoulders are in view (eye span against shoulder width).
    case needsShoulders
    /// Without the shoulders the face width judges it, with at least `faceOnlyTolerance` drift tolerated.
    case faceSize

    public static let `default`: PostureForwardHeadFallback = .needsShoulders
    /// The growth a face-only reading always tolerates: the face may get a fifth wider before it counts.
    public static let faceOnlyTolerance = 0.20

    public var title: String {
        switch self {
        case .needsShoulders: "Needs shoulders"
        case .faceSize: "Face size"
        }
    }

    public var detail: String {
        switch self {
        case .needsShoulders: "Forward head counts only while the camera sees your shoulders."
        case .faceSize: "Without the shoulders, it counts once your face looks a fifth bigger. Sitting closer counts too."
        }
    }
}

/// The user's calibrated upright posture: the measures, how much each is allowed to drift, and how far
/// each drifts in a real slouch (the "calibrated range").
public struct PostureBaseline: Equatable, Codable, Sendable {
    /// The upright median.
    public var metrics: PostureMetrics
    /// Drift always tolerated per measure (noise, looking around), never below the measure's minimum.
    public var tolerance: PostureMetrics
    /// Drift beyond the tolerance that equals severity 1. From the slouch sample when there was one.
    public var span: PostureMetrics
    public var uprightCount: Int
    public var slouchCount: Int

    public init(metrics: PostureMetrics, tolerance: PostureMetrics = PostureMetrics(),
                span: PostureMetrics = PostureMetrics(), uprightCount: Int = 0, slouchCount: Int = 0) {
        self.metrics = metrics
        self.tolerance = tolerance
        self.span = span
        self.uprightCount = uprightCount
        self.slouchCount = slouchCount
    }

    /// Readings an upright calibration needs. Dorso refuses a calibration with fewer than 4.
    public static let minimumUprightReadings = 4

    /// Builds a baseline from readings taken while the user sat upright (looking around the screen is
    /// welcome: that spread becomes the tolerance) and, optionally, while they slouched on purpose.
    /// Returns nil with fewer than `minimumUprightReadings` usable readings.
    public static func calibrate(upright: [PostureMetrics], slouch: [PostureMetrics] = []) -> PostureBaseline? {
        let usable = upright.filter { !$0.isEmpty }
        guard usable.count >= minimumUprightReadings else { return nil }
        let median = PostureMetrics.median(usable)
        guard !median.isEmpty else { return nil }
        var tolerance = PostureMetrics()
        var span = PostureMetrics()
        for measure in median.values.keys {
            let spread = usable.compactMap { PostureScorer.drift(measure, in: $0, baseline: median) }.max() ?? 0
            let tol = min(max(measure.minimumTolerance, spread), measure.defaultSpan * 0.6)
            tolerance[measure] = tol
            span[measure] = measure.defaultSpan
        }
        let slouchMedian = PostureMetrics.median(slouch.filter { !$0.isEmpty })
        for measure in slouchMedian.values.keys {
            // The slouch median's own drift, measured the way scoring measures it: a forward head capped by face
            // growth here too, or the span would come from a drift scoring never sees.
            guard let tol = tolerance[measure],
                  let drift = PostureScorer.drift(measure, in: slouchMedian, baseline: median),
                  drift > tol * 1.5 else { continue }
            span[measure] = max(drift - tol, measure.defaultSpan * 0.25)
        }
        return PostureBaseline(metrics: median, tolerance: tolerance, span: span,
                               uprightCount: usable.count, slouchCount: slouch.count)
    }
}

/// One fault's reading against the baseline.
public struct PostureSignal: Equatable, Sendable {
    public var kind: PostureMetricKind
    public var measure: PostureMeasure
    /// Drift in the measure's units; zero or negative is at or better than the baseline.
    public var deviation: Double
    public var enterThreshold: Double
    public var exitThreshold: Double
    /// 0 at the enter threshold, 1 at the calibrated slouch.
    public var severity: Double

    public init(kind: PostureMetricKind, measure: PostureMeasure, deviation: Double,
                enterThreshold: Double, exitThreshold: Double, severity: Double) {
        self.kind = kind
        self.measure = measure
        self.deviation = deviation
        self.enterThreshold = enterThreshold
        self.exitThreshold = exitThreshold
        self.severity = severity
    }

    public var isBad: Bool { deviation > enterThreshold }
    public var isClear: Bool { deviation < exitThreshold }
}

/// The verdict on one reading.
public struct PostureScore: Equatable, Sendable {
    public var signals: [PostureSignal]
    /// The worst signal's severity, 0...1.
    public var severity: Double
    /// `severity ^ (1 / sensitivity exponent)`: what a screen effect shows, 0...1.
    public var strength: Double
    /// Faults left out on purpose: Forward head when the shoulders are out of view and the scorer's
    /// `forwardHeadWithoutShoulders` is `.needsShoulders`.
    public var unjudged: Set<PostureMetricKind>

    public init(signals: [PostureSignal], severity: Double, strength: Double, unjudged: Set<PostureMetricKind> = []) {
        self.signals = signals
        self.severity = severity
        self.strength = strength
        self.unjudged = unjudged
    }

    /// Nothing could be compared (no shared measure between the reading and the baseline).
    public var isEmpty: Bool { signals.isEmpty }
    /// Some fault is past its enter threshold.
    public var isBad: Bool { signals.contains(where: \.isBad) }
    /// Every fault is back under its exit threshold (0.7 of the dead zone): the hysteresis band.
    public var isClear: Bool { !signals.isEmpty && signals.allSatisfy(\.isClear) }
    /// The fault furthest past its threshold, so the UI can say what triggered.
    public var worst: PostureMetricKind? {
        signals.max { lhs, rhs in
            (lhs.deviation - lhs.enterThreshold) / max(lhs.enterThreshold, 1e-6)
                < (rhs.deviation - rhs.enterThreshold) / max(rhs.enterThreshold, 1e-6)
        }.flatMap { $0.deviation > $0.exitThreshold ? $0.kind : nil }
    }
}

/// Scores a reading against a baseline. Pure: the same inputs give the same score.
///
/// Per fault: enter when `deviation > tolerance + deadZone × span`, leave below
/// `0.85 × tolerance + 0.7 × deadZone × span` (Dorso exits at 0.7 of its dead-zone threshold), severity
/// `(deviation − enter) / (span × (1 − deadZone))` clamped to 0...1 (Dorso's vertical severity), and the
/// reading's severity is the worst fault's (Dorso takes the max).
public struct PostureScorer: Equatable, Sendable {
    public var deadZone: PostureDeadZone
    public var sensitivity: PostureSensitivity
    public var enabled: Set<PostureMetricKind>
    /// How Forward head is judged when a reading has no shoulders and only the face width is left. Nil judges the
    /// face width with the calibrated tolerance, as the Vision face engine (which never sees shoulders) needs.
    public var forwardHeadWithoutShoulders: PostureForwardHeadFallback?

    public init(deadZone: PostureDeadZone = .default, sensitivity: PostureSensitivity = .default,
                enabled: Set<PostureMetricKind> = Set(PostureMetricKind.allCases),
                forwardHeadWithoutShoulders: PostureForwardHeadFallback? = nil) {
        self.deadZone = deadZone
        self.sensitivity = sensitivity
        self.enabled = enabled
        self.forwardHeadWithoutShoulders = forwardHeadWithoutShoulders
    }

    /// The shoulders are in view but the head is not (no nose, no face) while the baseline has a head
    /// height: the head went below the frame or far down, which is a full head drop, not "away".
    private func headLost(_ metrics: PostureMetrics, baseline: PostureBaseline, zone: Double) -> PostureSignal? {
        guard metrics[.shoulderWidth] != nil, metrics[.headHeight] == nil, metrics[.faceCenterY] == nil,
              baseline.metrics[.headHeight] != nil else { return nil }
        let tolerance = baseline.tolerance[.headHeight] ?? PostureMeasure.headHeight.minimumTolerance
        let span = max(baseline.span[.headHeight] ?? PostureMeasure.headHeight.defaultSpan, 1e-6)
        let enter = tolerance + zone * span
        return PostureSignal(kind: .headDrop, measure: .headHeight, deviation: enter + span * (1 - zone),
                             enterThreshold: enter, exitThreshold: 0.85 * tolerance + 0.7 * zone * span, severity: 1)
    }

    /// How far `measure` drifted in `metrics` from `baseline`, as scoring judges it; nil when either lacks it.
    /// Calibration measures tolerance and span with this too, so a calibrated slouch scores as a slouch.
    static func drift(_ measure: PostureMeasure, in metrics: PostureMetrics, baseline: PostureMetrics) -> Double? {
        guard let current = metrics[measure], let base = baseline[measure],
              let deviation = measure.deviation(current: current, baseline: base, baselineFaceWidth: baseline[.faceWidth])
        else { return nil }
        guard measure.kind == .forwardHead, measure != .faceWidth,
              let face = metrics[.faceWidth], let baseFace = baseline[.faceWidth], baseFace > 0
        else { return deviation }
        // A head that comes forward comes closer to the camera, so the face itself grows. A ratio to the shoulders
        // that grows while the face does not comes from the shoulder reading: 3D shoulders estimated below a low
        // camera's frame jumped 0.44 → 0.77 → 0.58 image heights between runs while the face stayed within 5%
        // (debug recording 2026-10-15 19:35, an upright sitter judged "head forward 133%" all along). Forward head
        // counts as far as both agree.
        return min(deviation, face / baseFace - 1)
    }

    public func score(_ metrics: PostureMetrics, against baseline: PostureBaseline) -> PostureScore {
        let zone = deadZone.fraction
        var signals: [PostureSignal] = []
        var unjudged: Set<PostureMetricKind> = []
        for kind in PostureMetricKind.allCases where enabled.contains(kind) {
            if kind == .headDrop, let lost = headLost(metrics, baseline: baseline, zone: zone) {
                signals.append(lost)
                continue
            }
            for measure in PostureMeasure.preference(for: kind) {
                guard let deviation = Self.drift(measure, in: metrics, baseline: baseline.metrics) else { continue }
                var tolerance = baseline.tolerance[measure] ?? measure.minimumTolerance
                if kind == .forwardHead, measure == .faceWidth, let fallback = forwardHeadWithoutShoulders {
                    guard fallback == .faceSize else {
                        unjudged.insert(kind)
                        break
                    }
                    tolerance = max(tolerance, PostureForwardHeadFallback.faceOnlyTolerance)
                }
                let span = max(baseline.span[measure] ?? measure.defaultSpan, 1e-6)
                let enter = tolerance + zone * span
                let exit = 0.85 * tolerance + 0.7 * zone * span
                let severity = min(max((deviation - enter) / max(span * (1 - zone), 1e-6), 0), 1)
                signals.append(PostureSignal(kind: kind, measure: measure, deviation: deviation,
                                             enterThreshold: enter, exitThreshold: exit, severity: severity))
                break
            }
        }
        let severity = signals.map(\.severity).max() ?? 0
        let strength = severity > 0 ? pow(severity, 1 / sensitivity.exponent) : 0
        return PostureScore(signals: signals, severity: severity, strength: strength, unjudged: unjudged)
    }
}

/// Smooths readings over a short time window (median of at most `maxCount` readings no older than
/// `window` seconds). Dorso averages 5 readings; a time window keeps the lag the same at 2 and 10 fps.
public struct PostureSmoother: Sendable {
    public var window: TimeInterval
    public var maxCount: Int
    private var readings: [(time: TimeInterval, metrics: PostureMetrics)] = []

    public init(window: TimeInterval = 1.0, maxCount: Int = 5) {
        self.window = window
        self.maxCount = max(1, maxCount)
    }

    /// Adds a reading and returns the smoothed metrics.
    public mutating func add(_ metrics: PostureMetrics, at time: TimeInterval) -> PostureMetrics {
        readings.append((time, metrics))
        readings.removeAll { time - $0.time > window }
        if readings.count > maxCount { readings.removeFirst(readings.count - maxCount) }
        return PostureMetrics.median(readings.map(\.metrics))
    }

    public mutating func reset() { readings.removeAll() }
}
