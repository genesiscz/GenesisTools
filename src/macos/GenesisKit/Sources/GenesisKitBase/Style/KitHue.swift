import SwiftUI

/// A colour for a person: the same for a name every time, and without a meaning. None of them is the play blue,
/// so a person's colour is never read as "this plays". Each carries white initials.
public enum KitPersonColor {
    public static let palette: [Color] = [
        Color(red: 0.55, green: 0.36, blue: 0.96), Color(red: 0.93, green: 0.49, blue: 0.13), Color(red: 0.16, green: 0.62, blue: 0.42),
        Color(red: 0.86, green: 0.30, blue: 0.52), Color(red: 0.10, green: 0.60, blue: 0.66), Color(red: 0.72, green: 0.55, blue: 0.10),
        Color(red: 0.80, green: 0.33, blue: 0.27), Color(red: 0.42, green: 0.58, blue: 0.18),
    ]

    /// The colour of `name`. With the names it stands `among` (the speakers of one meeting), two of them never share
    /// a colour while the palette lasts: each takes its own colour, or the next free one, in the order of the names.
    public static func color(for name: String, among names: [String] = []) -> Color {
        guard names.count > 1, names.contains(name) else { return palette[slot(name)] }
        var taken = Set<Int>()
        for other in Set(names).sorted() {
            var index = slot(other)
            var steps = 0
            while taken.contains(index), steps < palette.count {
                index = (index + 1) % palette.count
                steps += 1
            }
            taken.insert(index)
            if other == name { return palette[index] }
        }
        return palette[slot(name)]
    }

    /// Stable across runs (Swift's `hashValue` is seeded per process).
    private static func slot(_ name: String) -> Int {
        name.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0xFFFF } % palette.count
    }
}

/// A colour with a meaning. A view names the meaning and never an RGB value, so one thing has one colour in every
/// window: what plays is blue in the transcript, on the timeline and on the button that plays it.
///
/// The inks are the values the kit already drew text in (`KitPalette.renamed`, `added`, `modified`, `removed` and the
/// session purple), so a view that moves to a hue keeps its colour.
public enum KitHue: String, CaseIterable, Sendable {
    /// Sound and time: what plays, what was heard, a time a click plays. Also the one main action of a bar.
    case play
    /// A question for the user, a selection, something staged for an agent.
    case ask
    /// Decided, confirmed, healthy.
    case done
    /// Needs care: a warning, low confidence, a mark.
    case care
    /// Destroys something, or failed.
    case danger
    /// No meaning: the window's own ink.
    case neutral

    /// Text, glyphs and tints on a dark ground.
    public var ink: Color {
        switch self {
        case .play: Color(red: 0.45, green: 0.62, blue: 0.98)
        case .ask: Color(red: 0.72, green: 0.56, blue: 0.98)
        case .done: Color(red: 0.36, green: 0.80, blue: 0.47)
        case .care: Color(red: 0.98, green: 0.66, blue: 0.25)
        case .danger: Color(red: 0.96, green: 0.38, blue: 0.40)
        case .neutral: Color.white.opacity(0.88)
        }
    }

    /// A fill that carries a white label at 4.5:1 or better (computed from the sRGB values: 4.7 to 5.6).
    public var solid: Color {
        switch self {
        case .play: Color(red: 0.14, green: 0.40, blue: 0.93)
        case .ask: Color(red: 0.44, green: 0.30, blue: 0.86)
        case .done: Color(red: 0.10, green: 0.50, blue: 0.30)
        case .care: Color(red: 0.66, green: 0.37, blue: 0.02)
        case .danger: Color(red: 0.80, green: 0.20, blue: 0.24)
        case .neutral: Color(red: 0.30, green: 0.31, blue: 0.35)
        }
    }

    /// The light end of a gradient that ends in `solid`: the top of a filled button.
    public var bright: Color {
        switch self {
        case .play: Color(red: 0.27, green: 0.55, blue: 1.0)
        case .ask: Color(red: 0.60, green: 0.46, blue: 1.0)
        case .done: Color(red: 0.20, green: 0.68, blue: 0.42)
        case .care: Color(red: 0.90, green: 0.58, blue: 0.12)
        case .danger: Color(red: 0.96, green: 0.36, blue: 0.38)
        case .neutral: Color(red: 0.42, green: 0.43, blue: 0.48)
        }
    }
}
