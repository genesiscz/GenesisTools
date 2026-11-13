import AppKit

/// The width a one-line label takes, measured once per string, size and weight and kept: a control that picks its
/// shape from the room it has asks this instead of building each shape to measure it.
@MainActor
public enum KitTextWidth {
    private struct Key: Hashable {
        let text: String
        let size: CGFloat
        let weight: CGFloat
        let mono: Bool
        let symbol: Bool
    }

    /// The most widths kept. Counts and titles that change keep adding strings, so a full cache starts again: the
    /// labels on screen are measured once more, about a microsecond each.
    static let capacity = 512

    private static var widths: [Key: CGFloat] = [:]

    static var cachedCount: Int { widths.count }

    private static func remember(_ width: CGFloat, for key: Key) {
        if widths.count >= capacity {
            widths.removeAll(keepingCapacity: true)
        }
        widths[key] = width
    }

    /// A system-font text, as `Text(text).font(.system(size:weight:))` draws it (`.monospacedDigit()` with `monospacedDigits`).
    public static func text(_ text: String, size: CGFloat, weight: NSFont.Weight, monospacedDigits: Bool = false) -> CGFloat {
        let key = Key(text: text, size: size, weight: weight.rawValue, mono: monospacedDigits, symbol: false)
        if let width = widths[key] {
            return width
        }

        let font = monospacedDigits
            ? NSFont.monospacedDigitSystemFont(ofSize: size, weight: weight)
            : NSFont.systemFont(ofSize: size, weight: weight)
        let width = ((text as NSString).size(withAttributes: [.font: font]).width * 2).rounded(.up) / 2
        remember(width, for: key)
        return width
    }

    /// An SF Symbol, as `Image(systemName:).font(.system(size:weight:))` draws it, to within 1 pt: AppKit and SwiftUI
    /// round a symbol's width apart (14 against 15 pt for `list.bullet` at 12 pt, measured 2026-11-11).
    public static func symbol(_ name: String, size: CGFloat, weight: NSFont.Weight) -> CGFloat {
        let key = Key(text: name, size: size, weight: weight.rawValue, mono: false, symbol: true)
        if let width = widths[key] {
            return width
        }

        let image = NSImage(systemSymbolName: name, accessibilityDescription: nil)?
            .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: size, weight: weight))
        let width = image?.size.width ?? size
        remember(width, for: key)
        return width
    }
}
