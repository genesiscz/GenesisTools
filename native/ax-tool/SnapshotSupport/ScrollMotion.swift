import Foundation

/// How a timed wheel scroll spreads its distance over time (`control scroll --time`).
///
/// A real flick on a trackpad does not move at one speed: it starts fast and slows down. A single
/// wheel event, or a loop of equal ones, never showed the jumps a reader sees while a page scrolls
/// fast, because the page had nothing to render between them.
public enum ScrollEase: String, CaseIterable {
    /// Fast at the start, slowing to the end, like a flick (ease-out cubic).
    case flick
    /// The same distance on every frame.
    case linear
}

public enum ScrollMotion {
    /// Events per second for a timed scroll: one per display frame.
    public static let framesPerSecond = 60.0

    /// The per-event deltas of one scroll: `total` pixels over `count` events, each a whole pixel, summing
    /// exactly to `total` (the rounding remainder is carried, never dropped). The sign follows `total`.
    public static func deltas(total: Int, count: Int, ease: ScrollEase) -> [Int32] {
        guard count > 0, total != 0 else { return [] }
        let magnitude = Double(abs(total))
        let sign: Int32 = total < 0 ? -1 : 1
        var result: [Int32] = []
        var sent = 0
        for step in 1...count {
            let progress = Double(step) / Double(count)
            let eased: Double
            switch ease {
            case .flick: eased = 1 - pow(1 - progress, 3)
            case .linear: eased = progress
            }
            let target = Int((magnitude * eased).rounded())
            result.append(sign * Int32(target - sent))
            sent = target
        }
        return result
    }

    /// The number of events for a scroll lasting `seconds`; one event when no time is given.
    public static func eventCount(seconds: Double?) -> Int {
        guard let seconds, seconds > 0 else { return 1 }
        return max(2, Int((seconds * framesPerSecond).rounded()))
    }

    /// The scroll phase of event `index` of `count`, as a trackpad reports it: began, changed, ended.
    /// Values of `kCGScrollWheelEventScrollPhase`: 1 began, 2 changed, 4 ended; 0 for a lone wheel click.
    public static func phase(index: Int, count: Int) -> Int64 {
        guard count > 1 else { return 0 }
        if index == 0 { return 1 }
        if index == count - 1 { return 4 }
        return 2
    }
}
