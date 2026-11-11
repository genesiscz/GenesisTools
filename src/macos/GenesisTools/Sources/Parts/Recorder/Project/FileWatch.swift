import Foundation

/// Watches one file for writes, growth, renames and deletes, or its folder until the file exists. `onChange` runs on
/// the main thread after each event. The watch then starts again on what the path names now, because a writer that
/// replaces the file by a rename leaves the old descriptor on the old file.
@MainActor
final class FileWatch {
    let url: URL
    var onChange: (() -> Void)?
    private var source: DispatchSourceFileSystemObject?
    private var folderSource: DispatchSourceFileSystemObject?

    init(url: URL) {
        self.url = url
    }

    func start() {
        stop()
        let descriptor = Darwin.open(url.path, O_EVTONLY)
        if descriptor >= 0 {
            source = Self.watch(descriptor, events: [.write, .extend, .rename, .delete]) { [weak self] in
                self?.start()
                self?.onChange?()
            }
            return
        }
        let folder = Darwin.open(url.deletingLastPathComponent().path, O_EVTONLY)
        guard folder >= 0 else { return }
        folderSource = Self.watch(folder, events: [.write]) { [weak self] in
            guard let self, FileManager.default.fileExists(atPath: self.url.path) else { return }
            self.start()
            self.onChange?()
        }
    }

    func stop() {
        source?.cancel()
        folderSource?.cancel()
        source = nil
        folderSource = nil
    }

    private static func watch(_ descriptor: Int32, events: DispatchSource.FileSystemEvent,
                              _ handler: @escaping @MainActor () -> Void) -> DispatchSourceFileSystemObject {
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: descriptor, eventMask: events, queue: .main)
        source.setEventHandler { MainActor.assumeIsolated { handler() } }
        source.setCancelHandler { close(descriptor) }
        source.resume()
        return source
    }
}
