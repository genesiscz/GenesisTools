import Foundation
import SwiftUI

/// How `HighlightedText` marks its ranges.
public enum HighlightStyle: Sendable, Equatable {
    /// The marked words in a gradient from the play hue to the ask hue, semibold, with one sheen that runs across them
    /// when the text appears. Still under Reduce Motion.
    case sparkle
    /// The marked words in the play hue's ink, semibold, still.
    case accent
}

/// Text with some of its characters marked: the words a decision changes in a line, a match in a quote. One component
/// for every window, so a marked word looks the same everywhere.
///
///     HighlightedText(line.text, ranges: line.ranges)                  // sparkle
///     HighlightedText(quote, ranges: [match], style: .accent)
///
/// `ranges` count UTF-16 code units (NSString's and the TypeScript engine's units). A range outside the text is cut to
/// it, ranges that overlap or touch merge, and an empty one marks nothing. The view is one `Text`, so it wraps, takes
/// the surrounding font and reads as one sentence to VoiceOver.
public struct HighlightedText: View {
    /// One run of the text: marked or plain.
    public struct Segment: Equatable, Sendable {
        public let text: String
        public let marked: Bool

        public init(_ text: String, marked: Bool) {
            self.text = text
            self.marked = marked
        }
    }

    public let text: String
    public let ranges: [NSRange]
    public let style: HighlightStyle
    @GenReduceMotion private var reduceMotion

    public init(_ text: String, ranges: [NSRange], style: HighlightStyle = .sparkle) {
        self.text = text
        self.ranges = ranges
        self.style = style
    }

    public var body: some View {
        let segments = Self.segments(text, ranges: ranges)
        if style == .sparkle, !reduceMotion, segments.contains(where: \.marked) {
            SheenSweep(segments: segments)
        } else {
            Self.rendered(segments, style: style, phase: nil)
        }
    }

    /// The text cut at its ranges, in order. Plain runs and marked runs alternate; no run is empty.
    public static func segments(_ text: String, ranges: [NSRange]) -> [Segment] {
        let string = text as NSString
        let length = string.length
        guard length > 0 else { return [] }
        let clipped = ranges
            .filter { $0.location != NSNotFound && $0.length > 0 && $0.location < length }
            .map { NSRange(location: $0.location, length: min($0.length, length - $0.location)) }
            .sorted { $0.location < $1.location }
        var merged: [NSRange] = []
        for range in clipped {
            if let last = merged.last, range.location <= NSMaxRange(last) {
                merged[merged.count - 1] = NSRange(location: last.location, length: max(NSMaxRange(last), NSMaxRange(range)) - last.location)
            } else {
                merged.append(range)
            }
        }
        var segments: [Segment] = []
        var at = 0
        for range in merged {
            if range.location > at {
                segments.append(Segment(string.substring(with: NSRange(location: at, length: range.location - at)), marked: false))
            }
            segments.append(Segment(string.substring(with: range), marked: true))
            at = NSMaxRange(range)
        }
        if at < length {
            segments.append(Segment(string.substring(from: at), marked: false))
        }
        return segments
    }

    /// One `Text` of the segments. `phase` places the sheen of a sweep (0 to 1 across the text); nil draws none.
    static func rendered(_ segments: [Segment], style: HighlightStyle, phase: Double?) -> Text {
        segments.reduce(Text(verbatim: "")) { result, segment in
            guard segment.marked else { return result + Text(verbatim: segment.text) }
            let marked = Text(verbatim: segment.text).fontWeight(.semibold)
            switch style {
            case .accent: return result + marked.foregroundStyle(KitHue.play.ink)
            case .sparkle: return result + marked.foregroundStyle(sparkle(phase: phase))
            }
        }
    }

    // MARK: The sheen

    /// How long the one sheen takes to cross the text.
    static let sweepSec: Double = 1.1
    /// Half the sheen's width, as a share of the text's width.
    static let sheenHalfWidth: Double = 0.12

    /// The sheen's centre at `progress` (0 to 1) of the sweep: it enters before the text's leading edge and leaves
    /// after its trailing one, so no marked word starts or ends lit.
    static func sweepPhase(progress: Double) -> Double {
        -sheenHalfWidth + min(1, max(0, progress)) * (1 + 2 * sheenHalfWidth)
    }

    /// The five gradient stops for a sheen centred at `phase`: the two hues, white at the centre. Always in order and
    /// always from 0 to 1, as SwiftUI needs them.
    static func sheenLocations(phase: Double) -> [Double] {
        let clamp = { (value: Double) in min(1, max(0, value)) }
        return [0, clamp(phase - sheenHalfWidth), clamp(phase), clamp(phase + sheenHalfWidth), 1]
    }

    private static func sparkle(phase: Double?) -> LinearGradient {
        let from = KitHue.play.bright
        let to = KitHue.ask.ink
        guard let phase else { return LinearGradient(colors: [from, to], startPoint: .leading, endPoint: .trailing) }
        let at = sheenLocations(phase: phase)
        return LinearGradient(stops: [
            .init(color: from, location: at[0]),
            .init(color: from, location: at[1]),
            .init(color: .white, location: at[2]),
            .init(color: to, location: at[3]),
            .init(color: to, location: at[4]),
        ], startPoint: .leading, endPoint: .trailing)
    }
}

/// The sparkle's one sweep: a sheen crosses the text once when it appears, then the timeline pauses and the text stays
/// still, so an open dialog costs no frames.
private struct SheenSweep: View {
    let segments: [HighlightedText.Segment]
    @State private var start = Date()
    @State private var done = false

    var body: some View {
        TimelineView(.animation(minimumInterval: nil, paused: done)) { context in
            let progress = context.date.timeIntervalSince(start) / HighlightedText.sweepSec
            HighlightedText.rendered(segments, style: .sparkle,
                                     phase: done || progress >= 1 ? nil : HighlightedText.sweepPhase(progress: progress))
        }
        .task {
            start = Date()
            try? await Task.sleep(for: .seconds(HighlightedText.sweepSec))
            done = true
        }
    }
}
