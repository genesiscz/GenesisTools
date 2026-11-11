import GenesisKitBase
import SwiftUI

/// Where a value stands (genesiscz.md 12a): the engine's suggestion, a confirmed answer, a rejected one, or a plain
/// choice. Each state has its own hue AND its own glyph, so it reads at a glance and also without colour, and the row's
/// choices, its folded mark, the timeline pins and the "This also affects" sheet draw the same pair.
enum DecisionState: Equatable {
    case suggested, confirmed, rejected, plain

    /// The hue under `meetings.rows.stateLook`; nil draws the window's own ink.
    func hue(_ look: MeetingsPreferences.Rows.StateLook) -> KitHue? {
        switch (self, look) {
        case (.suggested, _): return .play
        case (.confirmed, .hueAndGlyph): return .done
        case (.rejected, .hueAndGlyph): return .danger
        case (.confirmed, .shade), (.rejected, .shade), (.plain, _): return nil
        }
    }

    /// The glyph before the value under `meetings.rows.stateLook`; the older look (`shade`) has none.
    func glyph(_ look: MeetingsPreferences.Rows.StateLook) -> String? {
        guard look == .hueAndGlyph else { return nil }
        switch self {
        case .suggested: return "sparkles"
        case .confirmed: return "checkmark.circle.fill"
        case .rejected: return "xmark.circle"
        case .plain: return nil
        }
    }

    /// A suggestion is tentative: an outline, dashed, never the solid ground of a decided value.
    var dashed: Bool { self == .suggested }

    /// A rejected value is struck through, in both looks.
    var struck: Bool { self == .rejected }

    /// The state in words, for VoiceOver and a tooltip.
    var words: String {
        switch self {
        case .suggested: return "suggested"
        case .confirmed: return "confirmed"
        case .rejected: return "rejected"
        case .plain: return ""
        }
    }

    /// A choice of a row: its confirmed or rejected answer once the row is decided, else the engine's suggestion.
    static func of(_ choice: RowChoice, in row: ReviewRow) -> DecisionState {
        if !row.isOpen, let answer = row.answer, choice.value == answer || choice.label == answer {
            return row.status == "rejected" ? .rejected : .confirmed
        }
        if row.status == "rejected" && choice.role == "suggested" { return .rejected }
        return choice.role == "suggested" ? .suggested : .plain
    }

    /// A decided row's state for its folded mark and its pin.
    static func of(status: String) -> DecisionState {
        switch status {
        case "confirmed": return .confirmed
        case "rejected": return .rejected
        default: return .suggested
        }
    }
}

/// A value as its state draws it: the glyph, then the text in the state's hue, struck through when rejected. The
/// sheet's before and after use it, so a suggestion there looks as it does on the row.
struct DecisionStateValue: View {
    let text: String
    let state: DecisionState
    var size: CGFloat = 12.5
    @AppStorage(MeetingsPreferences.Rows.stateLook.key) private var look = MeetingsPreferences.Rows.stateLook.defaultValue

    var body: some View {
        HStack(spacing: 3) {
            if let glyph = state.glyph(look) {
                Image(systemName: glyph).font(.system(size: size - 2.5, weight: .semibold))
            }
            Text(verbatim: text).font(.system(size: size, weight: state == .plain ? .regular : .semibold))
                .strikethrough(state.struck)
        }
        .foregroundStyle(state.hue(look).map { AnyShapeStyle($0.ink) } ?? AnyShapeStyle(.primary))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(state.words.isEmpty ? text : "\(text), \(state.words)")
    }
}
