import Foundation

/// How a kit control spells a value inside an accessibility identifier, so a UI scenario can name a segment, a menu
/// option or a matrix cell without knowing the Swift type: `settings.style.vignette`, `disk.tiers.warn.banner`.
public enum GenAccessibilityID {
    /// The value as text (an enum case's name, a string or number as it is), lowercased in its first letter only,
    /// with spaces and dots replaced by `-` so the identifier keeps one dot per level. The spelling is lossy: "a b"
    /// and "a.b" both give "a-b", "Foo" and "foo" both give "foo". Keep the values of one control distinct after it.
    public static func suffix(_ value: some Hashable) -> String {
        let text = String(describing: value)
        var spelled = String(text.map { $0 == " " || $0 == "." || $0 == "\n" ? "-" : $0 })
        if let first = spelled.first, first.isUppercase {
            spelled.replaceSubrange(spelled.startIndex...spelled.startIndex, with: first.lowercased())
        }
        return spelled.isEmpty ? "none" : spelled
    }
}
