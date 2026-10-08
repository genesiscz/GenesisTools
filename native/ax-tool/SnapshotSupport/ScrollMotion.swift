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

public enum ScrollNumericError: Error, Equatable, CustomStringConvertible {
    case invalidValue(String)
    case outOfRange(String)

    public var description: String {
        switch self {
        case .invalidValue(let flag): return "\(flag) must be a valid number"
        case .outOfRange(let message): return message
        }
    }
}

/// Numeric scroll options are parsed before looking up a target or posting an event.
public struct ScrollNumericOptions {
    public let amount: Int
    public let pixels: Int
    public let seconds: Double?
    public let repeats: Int
    public let pause: Double

    public init(_ values: [String: String]) throws {
        func integer(_ flag: String) throws -> Int? {
            guard let raw = values[flag] else { return nil }
            guard let number = Int(raw) else { throw ScrollNumericError.invalidValue(flag) }
            return number
        }
        func decimal(_ flag: String) throws -> Double? {
            guard let raw = values[flag] else { return nil }
            guard let number = Double(raw), number.isFinite else { throw ScrollNumericError.invalidValue(flag) }
            return number
        }
        let explicitPixels = try integer("--pixels")
        amount = try integer("--amount") ?? 3
        // Checked even when --pixels sets the distance: the result reports `amount` either way.
        guard (1...2500).contains(amount) else { throw ScrollNumericError.outOfRange("--amount must be 1–2500") }
        pixels = explicitPixels ?? amount * 40
        guard (1...100_000).contains(pixels) else { throw ScrollNumericError.outOfRange("--pixels must be 1–100000") }
        seconds = try decimal("--time")
        if let seconds, !(0.05...30).contains(seconds) { throw ScrollNumericError.outOfRange("--time must be 0.05–30 seconds") }
        repeats = try integer("--repeat") ?? 1
        guard (1...200).contains(repeats) else { throw ScrollNumericError.outOfRange("--repeat must be 1–200") }
        pause = try decimal("--pause") ?? 0.3
        guard (0...30).contains(pause) else { throw ScrollNumericError.outOfRange("--pause must be 0–30 seconds") }
    }
}
