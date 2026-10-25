import Foundation

/// The one copy of the `tools` fixtures: the frozen CLI contracts (`contract-*`) and real captured outputs
/// (`doctor.json`, `du-*.json`, `clones-*.json`, `hub-worktrees-*.json`, `macos-swap.json`) in `Disk/`, and the git
/// rules both languages implement (`contract-worktree-renames.json`) in `Git/`.
/// The kit's tests and Genesis's tests read them through this product; the GenesisTools bun tests read the same
/// files by path and check every contract against the real output of the command code. Test targets only: an app
/// target never links this product.
public enum KitFixture {
    /// A file name that is not in `Disk/`.
    public struct Missing: Error, CustomStringConvertible {
        public let name: String
        public var folder = "Disk"
        public var description: String { "no fixture named \(name) in GenesisKitFixtures/\(folder)" }
    }

    /// The fixture file `name`, with its extension (`contract-du-index-schema.sql`, `doctor.json`), in `folder`.
    public static func url(_ name: String, in folder: String = "Disk") throws -> URL {
        guard let url = Bundle.module.url(forResource: name, withExtension: nil, subdirectory: folder) else {
            throw Missing(name: name, folder: folder)
        }
        return url
    }

    public static func data(_ name: String, in folder: String = "Disk") throws -> Data {
        try Data(contentsOf: url(name, in: folder))
    }

    public static func string(_ name: String) throws -> String {
        try String(contentsOf: url(name), encoding: .utf8)
    }
}
