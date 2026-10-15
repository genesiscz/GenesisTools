import Darwin
import Foundation

/// Where a `SettingsDocument` keeps one value: JSON bytes under a key. A feature's settings are one key holding one
/// Codable value (`disk`, `posture`), stored and replaced as a whole, so a removed field or list entry really goes.
///
/// The methods are called off the main actor and may block on file I/O or a cross-process lock, so an
/// implementation must not hop to the main actor for its I/O. The Genesis app passes its own backend over its
/// config store; `ClientConfigBackend` and `UserDefaultsSettingsBackend` cover everything else.
public protocol KitSettingsBackend: Sendable {
    /// The stored JSON for `key`, or nil when nothing is stored.
    func loadData(forKey key: String) async throws -> Data?
    /// Stores `data` (a JSON value) under `key` as a whole; nil removes the key.
    func saveData(_ data: Data?, forKey key: String) async throws
    /// Calls `onChange` (on any thread) when the stored value may have changed outside this backend, for example
    /// another process wrote the file. The call can be spurious, and it also follows this backend's own writes;
    /// the caller reads the value again and compares. nil when the backend cannot observe changes. The
    /// observation lasts until the returned object is cancelled or released.
    func observeChanges(forKey key: String, _ onChange: @escaping @Sendable () -> Void) -> SettingsObservation?
}

/// A running change observation. `cancel()` stops it, and so does releasing the object.
public final class SettingsObservation: @unchecked Sendable {
    private let lock = NSLock()
    private var onCancel: (() -> Void)?

    public init(onCancel: @escaping () -> Void) {
        self.onCancel = onCancel
    }

    public func cancel() {
        lock.lock()
        let pending = onCancel
        onCancel = nil
        lock.unlock()
        pending?()
    }

    deinit { cancel() }
}

/// `app.<key>` in `~/.genesis/client.json`, through `ClientConfigFile`: a whole-value replace under the shared lock.
/// It observes the folder with one kqueue source (no polling), so a write by the app, the CLI or another process
/// reaches `observeChanges` after `coalesce` seconds; writes of other files in the folder do not.
public struct ClientConfigBackend: KitSettingsBackend {
    public let file: ClientConfigFile
    /// Folder events within this window become one change call: a write creates the lock, the temporary file and
    /// the rename.
    public let coalesce: TimeInterval

    public init(file: ClientConfigFile = ClientConfigFile(), coalesce: TimeInterval = 0.25) {
        self.file = file
        self.coalesce = coalesce
    }

    public func loadData(forKey key: String) async throws -> Data? {
        guard let value = try file.readForWrite()["app"].flatMap({ ($0 as? [String: Any])?[key] }) else { return nil }
        return try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .sortedKeys])
    }

    public func saveData(_ data: Data?, forKey key: String) async throws {
        let value = try data.map { try JSONSerialization.jsonObject(with: $0, options: [.fragmentsAllowed]) }
        try await file.replaceAppValue(value, forKey: key)
    }

    /// Folder events for other files in the folder (sibling atomic writes) are dropped: `onChange` runs only when
    /// `client.json`'s inode, size or modification time moved. A missing folder is created (0700) so a document
    /// made before the first write still sees later ones.
    public func observeChanges(forKey key: String, _ onChange: @escaping @Sendable () -> Void) -> SettingsObservation? {
        try? FileManager.default.createDirectory(at: file.directory, withIntermediateDirectories: true,
                                                 attributes: [.posixPermissions: 0o700])
        let path = file.fileURL.path
        let last = FileSignature.Box(FileSignature(path: path))
        return FolderChangeSource.observe(folder: file.directory, coalesce: coalesce) {
            guard last.replace(with: FileSignature(path: path)) else { return }
            onChange()
        }
    }
}

/// Identity and version of a file: inode, size and modification time (nil when it does not exist).
struct FileSignature: Equatable, Sendable {
    let inode: UInt64
    let size: Int64
    let modifiedSeconds: Int
    let modifiedNanoseconds: Int

    init?(path: String) {
        var info = stat()
        guard lstat(path, &info) == 0 else { return nil }
        inode = UInt64(info.st_ino)
        size = Int64(info.st_size)
        modifiedSeconds = info.st_mtimespec.tv_sec
        modifiedNanoseconds = info.st_mtimespec.tv_nsec
    }

    final class Box: @unchecked Sendable {
        private let lock = NSLock()
        private var value: FileSignature?

        init(_ value: FileSignature?) {
            self.value = value
        }

        /// Stores `next` and returns whether it differs from the stored one.
        func replace(with next: FileSignature?) -> Bool {
            lock.lock()
            defer { lock.unlock() }
            guard next != value else { return false }
            value = next
            return true
        }
    }
}

/// One key of a `UserDefaults` suite, holding the JSON bytes. Changes from another process sharing the suite arrive
/// through key-value observing, which needs a key without dots.
public struct UserDefaultsSettingsBackend: KitSettingsBackend, @unchecked Sendable {
    public let defaults: UserDefaults

    /// `suite` opens that suite; nil uses `defaults`.
    public init(defaults: UserDefaults = .standard, suite: String? = nil) {
        self.defaults = suite.flatMap(UserDefaults.init(suiteName:)) ?? defaults
    }

    public func loadData(forKey key: String) async throws -> Data? {
        defaults.data(forKey: key)
    }

    public func saveData(_ data: Data?, forKey key: String) async throws {
        if let data {
            defaults.set(data, forKey: key)
        } else {
            defaults.removeObject(forKey: key)
        }
    }

    public func observeChanges(forKey key: String, _ onChange: @escaping @Sendable () -> Void) -> SettingsObservation? {
        guard !key.isEmpty, !key.contains(".") else { return nil }
        let observer = DefaultsKeyObserver(defaults: defaults, key: key, onChange: onChange)
        return SettingsObservation { observer.stop() }
    }
}

private final class DefaultsKeyObserver: NSObject, @unchecked Sendable {
    private let defaults: UserDefaults
    private let key: String
    private let onChange: @Sendable () -> Void
    private let lock = NSLock()
    private var active = true

    init(defaults: UserDefaults, key: String, onChange: @escaping @Sendable () -> Void) {
        self.defaults = defaults
        self.key = key
        self.onChange = onChange
        super.init()
        defaults.addObserver(self, forKeyPath: key, options: [.new], context: nil)
    }

    func stop() {
        lock.lock()
        let wasActive = active
        active = false
        lock.unlock()
        if wasActive { defaults.removeObserver(self, forKeyPath: key) }
    }

    override func observeValue(forKeyPath keyPath: String?, of object: Any?,
                               change: [NSKeyValueChangeKey: Any]?, context: UnsafeMutableRawPointer?) {
        lock.lock()
        let isActive = active
        lock.unlock()
        if isActive { onChange() }
    }
}

/// A kqueue source on a folder: it fires when an entry in the folder is added, removed or renamed (an atomic
/// write's rename), and coalesces a burst into one call on a utility queue. A file write inside a subfolder does
/// not fire it.
enum FolderChangeSource {
    static func observe(folder: URL, coalesce: TimeInterval,
                        _ onChange: @escaping @Sendable () -> Void) -> SettingsObservation? {
        let descriptor = open(folder.path, O_EVTONLY | O_CLOEXEC)
        guard descriptor >= 0 else { return nil }
        let queue = DispatchQueue(label: "genesis.settings.folder-watch", qos: .utility)
        let source = DispatchSource.makeFileSystemObjectSource(fileDescriptor: descriptor,
                                                               eventMask: [.write, .rename, .delete], queue: queue)
        let state = State()
        source.setEventHandler {
            guard !state.scheduled, !state.cancelled else { return }
            state.scheduled = true
            queue.asyncAfter(deadline: .now() + max(0, coalesce)) {
                state.scheduled = false
                if !state.cancelled { onChange() }
            }
        }
        source.setCancelHandler { close(descriptor) }
        source.resume()
        return SettingsObservation {
            queue.async { state.cancelled = true }
            source.cancel()
        }
    }

    /// Touched only on the source's queue.
    private final class State: @unchecked Sendable {
        var scheduled = false
        var cancelled = false
    }
}
