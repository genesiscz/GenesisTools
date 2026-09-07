import AppKit

public final class ClipboardTransaction {
    private let board: NSPasteboard
    private let original: [[NSPasteboard.PasteboardType: Data]]
    private let initialCount: Int
    private var ownedCount: Int?

    public init(board: NSPasteboard) throws {
        self.board = board
        initialCount = board.changeCount
        original = try (board.pasteboardItems ?? []).map { item in
            var values: [NSPasteboard.PasteboardType: Data] = [:]
            for type in item.types {
                guard let data = item.data(forType: type) else {
                    throw WindowEventError.unavailable("cannot preserve clipboard representation \(type.rawValue); clipboard unchanged")
                }
                values[type] = data
            }
            return values
        }
        guard board.changeCount == initialCount else {
            throw WindowEventError.unavailable("clipboard changed during preservation; no paste dispatched")
        }
    }

    public func write(text: String, format: String) throws {
        guard ["text", "md", "html"].contains(format), board.changeCount == initialCount, ownedCount == nil else {
            throw WindowEventError.unavailable("invalid paste format or clipboard changed before paste")
        }
        let item = NSPasteboardItem()
        item.setString(text, forType: .string)
        if format == "html" { item.setString(text, forType: .html) }
        if format == "md" { item.setString(text, forType: NSPasteboard.PasteboardType("net.daringfireball.markdown")) }
        guard board.changeCount == initialCount else {
            throw WindowEventError.unavailable("clipboard changed while preparing paste; no paste dispatched")
        }
        ownedCount = board.clearContents()
        guard board.changeCount == ownedCount else {
            ownedCount = nil
            throw WindowEventError.unavailable("clipboard changed after preparation; newer copy left intact")
        }
        guard board.writeObjects([item]) else {
            _ = restore()
            throw WindowEventError.unavailable("clipboard write failed; paste not dispatched")
        }
        ownedCount = board.changeCount
    }

    /// Best effort: skip observed competing writes. AppKit has no atomic compare-and-swap.
    @discardableResult public func restore() -> String {
        guard let expected = ownedCount else { return "unchanged" }
        ownedCount = nil
        guard board.changeCount == expected else { return "skipped-concurrent-change" }
        let items = original.map { values in
            let item = NSPasteboardItem()
            for (type, data) in values { item.setData(data, forType: type) }
            return item
        }
        guard board.changeCount == expected else { return "skipped-concurrent-change" }
        let cleared = board.clearContents()
        guard board.changeCount == cleared else { return "skipped-concurrent-change" }
        return items.isEmpty || board.writeObjects(items) ? "restored" : "restore-failed"
    }
}
