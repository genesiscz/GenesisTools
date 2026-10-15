import Foundation

/// What a slouch alert says: the fault that triggered it, how far it drifted from the baseline, and how
/// bad that is. `PostureMonitor` sets one each time a slouch episode starts.
///
/// A frontal webcam measures in image units, not centimetres. The drift is therefore given in the unit the
/// measure uses (shoulder widths, face widths, radians, or a fraction of the baseline size), and
/// `approximateCentimeters` converts the first two with a typical body size you can replace with the
/// user's own. Say "about" when you show it.
public struct PostureAlert: Equatable, Sendable {
    /// The unit of `deviation`.
    public enum Unit: String, Sendable {
        /// Multiples of the user's shoulder width (head drop, sideways lean on the body engine).
        case shoulderWidths
        /// Multiples of the user's baseline face width (head drop, sideways lean on the face engine).
        case faceWidths
        /// An angle (shoulder tilt, head roll, head pitch).
        case radians
        /// A share of the baseline size: 0.12 is 12% bigger (forward head, leaning in).
        case fraction
    }

    public var kind: PostureMetricKind
    public var measure: PostureMeasure
    /// How far the reading sat from the baseline, in `unit`, on the bad side.
    public var deviation: Double
    public var unit: Unit
    /// 0 at the enter threshold, 1 at the calibrated slouch.
    public var severity: Double
    /// What a screen effect shows for it (`severity ^ (1 / sensitivity)`).
    public var strength: Double
    /// The drift as a share of the calibrated slouch (tolerance plus span): 1 is as far as the slouch
    /// the user showed at calibration, or as the default range when they showed none.
    public var rangeFraction: Double
    /// Every fault's reading at that moment.
    public var signals: [PostureSignal]
    public var date: Date

    public init(kind: PostureMetricKind, measure: PostureMeasure, deviation: Double, unit: Unit, severity: Double,
                strength: Double, rangeFraction: Double, signals: [PostureSignal] = [], date: Date = Date()) {
        self.kind = kind
        self.measure = measure
        self.deviation = deviation
        self.unit = unit
        self.severity = severity
        self.strength = strength
        self.rangeFraction = rangeFraction
        self.signals = signals
        self.date = date
    }

    /// The alert for a score's worst fault, nil when no fault is past its threshold.
    public init?(score: PostureScore, baseline: PostureBaseline, date: Date) {
        guard let worst = score.worst, let signal = score.signals.first(where: { $0.kind == worst }) else { return nil }
        let tolerance = baseline.tolerance[signal.measure] ?? signal.measure.minimumTolerance
        let span = baseline.span[signal.measure] ?? signal.measure.defaultSpan
        self.init(kind: worst, measure: signal.measure, deviation: signal.deviation, unit: Self.unit(of: signal.measure),
                  severity: signal.severity, strength: score.strength,
                  rangeFraction: signal.deviation / max(tolerance + span, 1e-6), signals: score.signals, date: date)
    }

    static func unit(of measure: PostureMeasure) -> Unit {
        switch measure {
        case .headHeight, .lateralOffset: .shoulderWidths
        case .faceCenterX, .faceCenterY: .faceWidths
        case .shoulderTilt, .faceRoll, .facePitch, .headphonePitch: .radians
        case .shoulderWidth, .eyeSpanRatio, .faceWidth: .fraction
        }
    }

    /// A typical adult shoulder (biacromial) breadth: about 41 cm for men and 37 cm for women in
    /// anthropometric surveys. Pass the user's own when you know it.
    public static let typicalShoulderWidthCM = 39.0
    /// A typical adult face (bizygomatic) breadth, about 14 cm.
    public static let typicalFaceWidthCM = 14.0

    /// The drift in centimetres, for shoulder-width and face-width units; nil for angles and fractions.
    /// It is an estimate that assumes the given body sizes, not a measurement.
    public func approximateCentimeters(shoulderWidthCM: Double = typicalShoulderWidthCM,
                                       faceWidthCM: Double = typicalFaceWidthCM) -> Double? {
        switch unit {
        case .shoulderWidths: deviation * shoulderWidthCM
        case .faceWidths: deviation * faceWidthCM
        case .radians, .fraction: nil
        }
    }

    /// The drift in degrees for angle units; nil otherwise.
    public var degrees: Double? { unit == .radians ? deviation * 180 / .pi : nil }

    /// The drift as a percentage for fraction units; nil otherwise.
    public var percent: Double? { unit == .fraction ? deviation * 100 : nil }
}

/// Why `PostureMonitor.collectCalibrationSamples` stopped without its samples.
public enum PostureCalibrationError: Error, Equatable, Sendable {
    /// Another collection is running.
    case busy
    /// The time ran out; the samples gathered so far are attached (four or more still calibrate).
    case timedOut(collected: [PoseSample])
    case cancelled
    /// The camera cannot run (no grant, no device); the samples gathered so far are attached.
    case cameraUnavailable(PostureCameraIssue, collected: [PoseSample])
}
