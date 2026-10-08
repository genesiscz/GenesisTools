import QuartzCore

/// Times an existing animation driver. It creates no display link or timer and cannot measure presented frames.
public struct AnimationTiming {
    public struct Summary: Codable, Sendable {
        public let outcome: String
        public let elapsedMs: Double
        public let callbacks: Int
        public let firstCallbackMs: Double?
        public let gapP50Ms: Double
        public let gapP95Ms: Double
        public let gapMaxMs: Double
        public let gapsOver50Ms: Int
        public let workTotalMs: Double
        public let workMaxMs: Double

        public var description: String {
            String(format: "outcome=%@ elapsed=%.1fms callbacks=%d first=%.1fms gap-p50=%.1fms gap-p95=%.1fms gap-max=%.1fms gaps-over-50ms=%d work-total=%.1fms work-max=%.1fms",
                   outcome, elapsedMs, callbacks, firstCallbackMs ?? 0, gapP50Ms, gapP95Ms, gapMaxMs,
                   gapsOver50Ms, workTotalMs, workMaxMs)
        }
    }

    private let start: CFTimeInterval
    private var last: CFTimeInterval?
    private var first: CFTimeInterval?
    private var gaps: [Double] = []
    private var count = 0
    private var workTotal = 0.0
    private var workMax = 0.0

    public init(at time: CFTimeInterval = CACurrentMediaTime()) {
        start = time
    }

    public mutating func record(startedAt: CFTimeInterval, finishedAt: CFTimeInterval) {
        if let last {
            gaps.append(max(0, startedAt - last) * 1000)
        } else {
            first = startedAt
        }
        last = startedAt
        count += 1
        let work = max(0, finishedAt - startedAt) * 1000
        workTotal += work
        workMax = max(workMax, work)
    }

    public func summary(at time: CFTimeInterval = CACurrentMediaTime(), outcome: String) -> Summary {
        let sorted = gaps.sorted()
        func percentile(_ fraction: Double) -> Double {
            guard !sorted.isEmpty else { return 0 }
            return sorted[max(0, Int(ceil(Double(sorted.count) * fraction)) - 1)]
        }
        return Summary(
            outcome: outcome, elapsedMs: max(0, time - start) * 1000, callbacks: count,
            firstCallbackMs: first.map { max(0, $0 - start) * 1000 },
            gapP50Ms: percentile(0.5), gapP95Ms: percentile(0.95), gapMaxMs: sorted.last ?? 0,
            gapsOver50Ms: gaps.filter { $0 >= 50 }.count, workTotalMs: workTotal, workMaxMs: workMax)
    }
}
