import SwiftUI

/// A settings row for a size limit ("Warn below 10 GB"): a typed number and a unit menu on the right. The bytes are
/// decimal like `ByteFormat.file` and Finder (1 GB = 1,000,000,000 bytes), so the number shown is the number printed
/// everywhere else.
///
/// Typing changes nothing until Return or focus loss: then the text is read (a comma counts as the decimal point),
/// multiplied by the unit, clamped to `range` and written to the binding once, and `onCommit` runs when the bytes
/// changed. Text that was not edited is never read back, so tabbing through the field keeps the exact bytes (the
/// field rounds to two decimals). Picking another unit converts the value when nothing was typed (10 GB shows as
/// 10000 MB); when a number was typed, it is read in the new unit ("2" with GB picked is 2 GB), so a user who types
/// first and picks the unit second gets what they typed. A value that cannot be read keeps the old one.
public struct NativeSettingsByteThreshold: View {
    public enum Unit: Int64, CaseIterable, Identifiable, Sendable {
        case kb = 1_000
        case mb = 1_000_000
        case gb = 1_000_000_000
        case tb = 1_000_000_000_000

        public var id: Int64 { rawValue }
        public var title: String {
            switch self {
            case .kb: return "KB"
            case .mb: return "MB"
            case .gb: return "GB"
            case .tb: return "TB"
            }
        }
    }

    private let title: String
    private let detail: String?
    private let identifier: String
    @Binding private var bytes: Int64
    private let range: ClosedRange<Int64>
    private let units: [Unit]
    private let onCommit: ((Int64) -> Void)?
    @State private var entry = ""
    /// The text the field was last given; an `entry` equal to it was not edited.
    @State private var shownText = ""
    @State private var unit: Unit?
    @FocusState private var editing: Bool

    /// - Parameters:
    ///   - range: the accepted bytes; anything outside is clamped on commit.
    ///   - units: the units the menu offers, smallest first. The field starts in the largest unit the value fills.
    public init(
        _ title: String, detail: String? = nil, identifier: String, bytes: Binding<Int64>,
        range: ClosedRange<Int64>, units: [Unit] = [.mb, .gb], onCommit: ((Int64) -> Void)? = nil
    ) {
        self.title = title
        self.detail = detail
        self.identifier = identifier
        _bytes = bytes
        self.range = range
        self.units = units.isEmpty ? [.gb] : units.sorted { $0.rawValue < $1.rawValue }
        self.onCommit = onCommit
    }

    private var shownUnit: Unit { unit ?? Self.bestUnit(for: bytes, among: units) }

    public var body: some View {
        NativeSettingsRow(title, detail: detail) {
            HStack(spacing: 6) {
                TextField(title, text: $entry)
                    .textFieldStyle(.roundedBorder)
                    .multilineTextAlignment(.trailing)
                    .font(.system(size: 14, weight: .medium, design: .rounded)).monospacedDigit()
                    .frame(width: 72)
                    .focused($editing)
                    .onSubmit { commit(in: shownUnit) }
                    .onChange(of: editing) { _, focused in
                        if !focused { commit(in: shownUnit) }
                    }
                    .onChange(of: bytes) { _, updated in
                        if !editing { show(updated, in: shownUnit) }
                    }
                    .onAppear {
                        if unit == nil { unit = Self.bestUnit(for: bytes, among: units) }
                        show(bytes, in: shownUnit)
                    }
                    .instantTooltip("Between \(ByteFormat.file(range.lowerBound)) and \(ByteFormat.file(range.upperBound))")
                    .accessibilityLabel(title)
                    .accessibilityValue(ByteFormat.file(bytes))
                    .accessibilityIdentifier(identifier)
                MenuButton(style: .genHoverPlain(brighten: 0.12)) {
                    units.map { option in
                        MenuButtonItem.action(option.title, checked: option == shownUnit) { pick(option) }
                    }
                } label: {
                    HStack(spacing: 5) {
                        Text(verbatim: shownUnit.title).font(.system(size: 12, weight: .semibold))
                        Image(systemName: "chevron.up.chevron.down").font(.system(size: 8, weight: .semibold))
                            .foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 9)
                    .frame(height: 24)
                    .background(Color.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .strokeBorder(Color.white.opacity(0.09), lineWidth: 0.5))
                }
                .fixedSize()
                .accessibilityLabel("\(title) unit")
                .accessibilityValue(shownUnit.title)
                .accessibilityIdentifier(identifier + ".unit")
            }
            .fixedSize()
            .nativeSettingsDisabledLook()
        }
    }

    private func commit(in unit: Unit) {
        guard let next = Self.committed(entry, shown: shownText, unit: unit, range: range, bytes: bytes) else { return }
        apply(next, in: unit)
    }

    private func pick(_ option: Unit) {
        unit = option
        apply(Self.picked(entry, shown: shownText, unit: option, range: range, bytes: bytes), in: option)
    }

    private func show(_ value: Int64, in unit: Unit) {
        entry = Self.text(value, in: unit)
        shownText = entry
    }

    /// Writes the binding and tells the host only when the bytes changed; the field always shows the result.
    private func apply(_ next: Int64, in unit: Unit) {
        show(next, in: unit)
        guard next != bytes else { return }
        bytes = next
        onCommit?(next)
    }

    // MARK: - Pure helpers (tested)

    /// What a commit writes: nil when the text is the one the field was given (not edited), else the bytes it reads
    /// as, or the old bytes when it cannot be read.
    static func committed(
        _ entry: String, shown: String, unit: Unit, range: ClosedRange<Int64>, bytes: Int64
    ) -> Int64? {
        guard entry != shown else { return nil }
        return parse(entry, unit: unit, range: range) ?? bytes
    }

    /// The bytes after picking `unit`: unchanged when nothing was typed, else the typed number read in `unit`.
    static func picked(_ entry: String, shown: String, unit: Unit, range: ClosedRange<Int64>, bytes: Int64) -> Int64 {
        entry == shown ? bytes : (parse(entry, unit: unit, range: range) ?? bytes)
    }

    /// The largest unit in which `bytes` is at least 1, else the smallest offered.
    static func bestUnit(for bytes: Int64, among units: [Unit]) -> Unit {
        let sorted = units.sorted { $0.rawValue < $1.rawValue }
        return sorted.last { bytes >= $0.rawValue } ?? sorted.first ?? .gb
    }

    /// `text` read as a number of `unit`, clamped; nil when it is not a number.
    static func parse(_ text: String, unit: Unit, range: ClosedRange<Int64>) -> Int64? {
        let cleaned = text.trimmingCharacters(in: .whitespaces)
            .replacingOccurrences(of: ",", with: ".")
            .replacingOccurrences(of: " ", with: "")
        guard let number = Double(cleaned), number.isFinite else { return nil }
        let raw = (number * Double(unit.rawValue)).rounded()
        // Clamped in Int64: `Double(Int64.max)` is 2^63, which does not convert back.
        if raw >= Double(range.upperBound) { return range.upperBound }
        if raw <= Double(range.lowerBound) { return range.lowerBound }
        return Int64(exactly: raw) ?? range.upperBound
    }

    /// `bytes` in `unit` with at most two decimals and no trailing zeros: "500", "1.5", "0.25".
    static func text(_ bytes: Int64, in unit: Unit) -> String {
        let value = Double(bytes) / Double(unit.rawValue)
        var text = String(format: "%.2f", value)
        while text.contains("."), text.hasSuffix("0") { text.removeLast() }
        if text.hasSuffix(".") { text.removeLast() }
        return text
    }
}
