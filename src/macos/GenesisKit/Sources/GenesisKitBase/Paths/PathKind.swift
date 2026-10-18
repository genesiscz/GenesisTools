import Foundation

/// A file or a folder, as a path menu treats it.
public enum PathKind: Sendable, Equatable {
    case file
    case folder

    /// What is at `url`: a folder (not a package, which Finder shows as one item), or a file.
    public static func of(_ url: URL) -> PathKind {
        let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .isPackageKey])
        return values?.isDirectory == true && values?.isPackage != true ? .folder : .file
    }
}
