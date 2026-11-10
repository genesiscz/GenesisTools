import SwiftUI

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
