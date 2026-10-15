import Foundation
import GenesisKit

/// One available-space reading for the forecaster.
public struct SpacePoint: Codable, Equatable, Sendable {
    public var date: Date
    public var available: Int64

    public init(date: Date, available: Int64) {
        self.date = date
        self.available = available
    }

    public init(_ sample: VolumeSample) {
        self.init(date: sample.date, available: sample.available)
    }
}

/// When the disk fills at the current pace, and how sure that is.
public struct SpaceForecast: Equatable, Sendable {
    public enum Verdict: String, Codable, Equatable, Sendable {
        /// Free space falls steadily: the times below are set.
        case filling
        /// Free space barely moves.
        case stable
        /// Free space grows (usage shrinks).
        case freeing
        /// Too few readings, or too short a span, to say.
        case notEnoughHistory
        /// The rate swings too much between readings to extrapolate.
        case erratic
    }

    public var verdict: Verdict
    /// The smoothed change of free space in bytes per second; negative while the disk fills.
    public var bytesPerSecond: Double
    /// Seconds until free space reaches the floor at this pace; 0 when it is already under it.
    public var timeToFloor: TimeInterval?
    /// Seconds until free space reaches zero at this pace.
    public var timeToZero: TimeInterval?
    /// 0...1: grows with the covered span and the number of readings, falls with swings in the rate.
    public var confidence: Double
    public var pairsUsed: Int
    /// Single steps left out: rises of at least `jumpThreshold` (a delete, a purge) and drops of at least
    /// `dropJumpThreshold` (one large copy).
    public var jumpsIgnored: Int
    public var span: TimeInterval
    /// The bytes the left-out rises freed inside the window (cleanups, purges).
    public var cleanedBytes: Int64
    /// The moment the times count from: the `now` passed to `forecast(_:now:)`, else the last reading's date.
    public var asOf: Date?

    public init(verdict: Verdict, bytesPerSecond: Double, timeToFloor: TimeInterval?, timeToZero: TimeInterval?,
                confidence: Double, pairsUsed: Int, jumpsIgnored: Int, span: TimeInterval, asOf: Date? = nil,
                cleanedBytes: Int64 = 0) {
        self.cleanedBytes = cleanedBytes
        self.verdict = verdict
        self.bytesPerSecond = bytesPerSecond
        self.timeToFloor = timeToFloor
        self.timeToZero = timeToZero
        self.confidence = confidence
        self.pairsUsed = pairsUsed
        self.jumpsIgnored = jumpsIgnored
        self.span = span
        self.asOf = asOf
    }

    public var bytesPerHour: Double { bytesPerSecond * 3600 }
}

/// A free-space forecast from recent readings: an exponentially weighted average of the rate between consecutive
/// readings (weights halve every `halfLife`, so uneven sampling is fine), over the last `window`. A rise of at least
/// `jumpThreshold` in one step is a delete or a purge and is left out, so a cleanup does not read as "freeing"; a
/// drop of at least `dropJumpThreshold` in one step is one large copy and is left out too, so it does not read as a
/// pace. Pure: no clock, no I/O; pass `now` to `forecast(_:now:)` so the time since the last reading counts.
public struct SpaceForecaster: Codable, Equatable, Sendable {
    public var floor: Int64
    public var halfLife: TimeInterval
    public var window: TimeInterval
    public var minimumSpan: TimeInterval
    public var minimumPairs: Int
    public var jumpThreshold: Int64
    /// A pace under this many bytes per hour (either way) is `stable`.
    public var stableBytesPerHour: Double
    /// A rate whose weighted spread exceeds this many times its mean is `erratic`.
    public var erraticRatio: Double
    /// A fall of at least this many bytes in one step is left out (nil keeps every fall).
    public var dropJumpThreshold: Int64?

    public init(floor: Int64, halfLife: TimeInterval = 1800, window: TimeInterval = 3600, minimumSpan: TimeInterval = 600,
                minimumPairs: Int = 3, jumpThreshold: Int64 = 1_000_000_000, stableBytesPerHour: Double = 50_000_000,
                erraticRatio: Double = 4, dropJumpThreshold: Int64? = 5_000_000_000) {
        self.dropJumpThreshold = dropJumpThreshold
        self.floor = floor
        self.halfLife = halfLife
        self.window = window
        self.minimumSpan = minimumSpan
        self.minimumPairs = minimumPairs
        self.jumpThreshold = jumpThreshold
        self.stableBytesPerHour = stableBytesPerHour
        self.erraticRatio = erraticRatio
    }

    /// The forecast as of the last reading.
    public func forecast(_ points: [SpacePoint]) -> SpaceForecast {
        compute(points, now: nil)
    }

    /// The forecast as of `now`. The window ends at `now` (or at the last reading, when that is later). Readings
    /// stop while free space moves less than the monitor's `minimumChange`, so the quiet time after the last
    /// reading counts as a flat stretch, but only the part that still sits inside the window. A cleanup older
    /// than the window no longer counts.
    public func forecast(_ points: [SpacePoint], now: Date) -> SpaceForecast {
        compute(points, now: now)
    }

    private func compute(_ points: [SpacePoint], now: Date?) -> SpaceForecast {
        let sorted = points.sorted { $0.date < $1.date }
        guard let last = sorted.last else {
            return SpaceForecast(verdict: .notEnoughHistory, bytesPerSecond: 0, timeToFloor: nil, timeToZero: nil,
                                 confidence: 0, pairsUsed: 0, jumpsIgnored: 0, span: 0, asOf: now)
        }
        let end = now.map { max($0, last.date) } ?? last.date
        let start = end.addingTimeInterval(-max(0, window))
        let recent = sorted.filter { $0.date >= start && $0.date <= end }
        var rate: Double?
        var variance = 0.0
        var pairs = 0
        var jumps = 0
        var cleaned: Int64 = 0
        var cleanups = 0
        var span = 0.0
        func add(step: Double, elapsed: TimeInterval) {
            pairs += 1
            span += elapsed
            guard let mean = rate else {
                rate = step
                return
            }
            let alpha = 1 - pow(0.5, elapsed / max(1, halfLife))
            let difference = step - mean
            rate = mean + alpha * difference
            variance = (1 - alpha) * (variance + alpha * difference * difference)
        }
        for (previous, current) in zip(recent, recent.dropFirst()) {
            let elapsed = current.date.timeIntervalSince(previous.date)
            guard elapsed > 0 else { continue }
            let delta = current.available - previous.available
            if delta >= jumpThreshold || (dropJumpThreshold.map { -delta >= $0 } ?? false) {
                jumps += 1
                if delta > 0 {
                    cleaned += delta
                    cleanups += 1
                }
                continue
            }
            add(step: Double(delta) / elapsed, elapsed: elapsed)
        }
        if let now, now > last.date, rate != nil {
            let quietStart = max(last.date, start)
            let quiet = now.timeIntervalSince(quietStart)
            if quiet >= 1 { add(step: 0, elapsed: quiet) }
        }

        let slope = rate ?? 0
        let spread = variance.squareRoot()
        let ratio = spread / max(abs(slope), 1)
        let coverage = min(1, span / max(1, window))
        let count = min(1, Double(pairs) / Double(max(1, minimumPairs * 2)))
        let confidence = max(0, min(1, coverage * count / (1 + ratio)))
        func result(_ verdict: SpaceForecast.Verdict, floorETA: TimeInterval? = nil, zeroETA: TimeInterval? = nil,
                    confidence: Double = confidence) -> SpaceForecast {
            SpaceForecast(verdict: verdict, bytesPerSecond: slope, timeToFloor: floorETA, timeToZero: zeroETA,
                          confidence: confidence, pairsUsed: pairs, jumpsIgnored: jumps, span: span,
                          asOf: now ?? last.date, cleanedBytes: cleaned)
        }

        if pairs < max(1, minimumPairs) || span < minimumSpan {
            return result(.notEnoughHistory, confidence: min(confidence, 0.2))
        }
        if ratio > erraticRatio, spread * 3600 >= stableBytesPerHour {
            return result(.erratic)
        }
        if abs(slope) * 3600 < stableBytesPerHour {
            return result(.stable)
        }
        if slope > 0 {
            return result(.freeing)
        }
        let speed = -slope
        // Repeated cleanups inside the window freed more than the writing used (build output written and removed
        // again and again): free space did not fall, so a "full in" time would contradict the chart. One cleanup
        // during a steady fill is different: the fill goes on after it, and stays a forecast.
        if cleanups >= 2, Double(cleaned) >= speed * span {
            return result(.erratic)
        }
        let aboveFloor = Double(max(0, last.available - floor))
        return result(.filling, floorETA: aboveFloor / speed, zeroETA: Double(max(0, last.available)) / speed)
    }
}
