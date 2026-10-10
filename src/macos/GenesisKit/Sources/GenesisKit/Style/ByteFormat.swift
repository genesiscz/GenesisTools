import Foundation

/// File and memory sizes in one locale: "3.21 GB", "655.1 MB". `ByteCountFormatter` follows the system's
/// region, so on a Czech Mac the hub printed "3,21 GB" beside "471.2K" in an English UI (hub inventory
/// H15, 2026-10-10). Every size label goes through here.
public enum ByteFormat {
    private static let english = Locale(identifier: "en_US")

    public static func file(_ bytes: Int64) -> String {
        bytes.formatted(ByteCountFormatStyle(style: .file, allowedUnits: .all, spellsOutZero: true, includesActualByteCount: false, locale: english))
    }

    public static func memory(_ bytes: Int64) -> String {
        bytes.formatted(ByteCountFormatStyle(style: .memory, allowedUnits: .all, spellsOutZero: true, includesActualByteCount: false, locale: english))
    }
}
