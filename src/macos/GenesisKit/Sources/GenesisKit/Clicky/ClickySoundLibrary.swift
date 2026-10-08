import AppKit
import Combine
import Foundation

protocol ClickyPackLoading: Sendable {
    func catalogue(at root: URL) async throws -> [ClickyPackEntry]
    func prepare(at root: URL, entry: ClickyPackEntry) async throws -> PreparedClickyPack
}

extension ClickyPackLoader: ClickyPackLoading {}

struct ClickyLibraryRow: Identifiable {
    let reference: ClickyPackReference
    let libraryName: String
    let entry: ClickyPackEntry
    var id: ClickyPackReference { reference }
}

struct ClickyActivePack {
    let reference: ClickyPackReference
    let entry: ClickyPackEntry
    let licenceText: String
    let source: ClickyPackSource
    let permissions: ClickyPackPermissions
    let attribution: String
    let attributionRequired: Bool

    init(reference: ClickyPackReference, pack: PreparedClickyPack) {
        self.reference = reference
        entry = pack.entry
        licenceText = pack.licenceText
        source = pack.source
        permissions = pack.permissions
        attribution = pack.attribution
        attributionRequired = pack.attributionRequired
    }
}

@MainActor
final class ClickySoundLibrary: ObservableObject {
    @Published private(set) var records: [ClickyLibraryRecord] = []
    @Published private(set) var rows: [ClickyLibraryRow] = []
    @Published private(set) var loading: ClickyPackReference?
    @Published private(set) var refreshing = false
    @Published private(set) var error: String?
    @Published private(set) var active: ClickyActivePack?
    var install: ((ClickyPackReference, PreparedClickyPack) throws -> Void)?
    private let defaults: UserDefaults
    private let loader: any ClickyPackLoading
    private var generation = 0
    private var catalogueGeneration = 0
    private var lifetime = 0
    private var stopped = false
    private var selectionTask: Task<Void, Never>?
    private var refreshTask: Task<Void, Never>?
    private let storageKey = "clicky.libraries.v1"

    init(defaults: UserDefaults, loader: any ClickyPackLoading = ClickyPackLoader()) {
        self.defaults = defaults
        self.loader = loader
        if let data = defaults.data(forKey: storageKey), data.count <= 1_048_576,
            let saved = try? JSONDecoder().decode([ClickyLibraryRecord].self, from: data), saved.count <= 32,
            Set(saved.map(\.id)).count == saved.count
        {
            records = saved
        }
    }

    func restore(_ reference: ClickyPackReference?) {
        guard !stopped else { return }
        refreshTask?.cancel()
        let selectionGeneration = generation
        refreshTask = Task { [weak self] in
            guard let self else { return }
            await refresh()
            guard !Task.isCancelled, generation == selectionGeneration, let reference else { return }
            select(reference)
        }
    }

    func addFolder() {
        let panel = NSOpenPanel()
        panel.title = "Add a Clicky sound library"
        panel.message = "Choose the audio folder containing registry.json. Sounds remain in that folder."
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.begin { [weak self] response in
            Task { @MainActor in
                guard response == .OK, let url = panel.url else { return }
                await self?.register(url)
            }
        }
    }

    func register(_ url: URL) async {
        guard !stopped else { return }
        let token = lifetime
        guard records.count < 32 else {
            error = "You can add up to 32 libraries. Remove one before adding another."
            return
        }
        do {
            let accessed = url.startAccessingSecurityScopedResource()
            defer { if accessed { url.stopAccessingSecurityScopedResource() } }
            let entries = try await loader.catalogue(at: url)
            try Task.checkCancellation()
            guard !stopped, lifetime == token else { return }
            guard records.count < 32 else {
                throw ClickyPackError.invalid("You can add up to 32 libraries. Remove one before adding another.")
            }
            let bookmark = try url.bookmarkData(options: [.withSecurityScope], includingResourceValuesForKeys: nil, relativeTo: nil)
            let record = ClickyLibraryRecord(id: UUID().uuidString, displayName: url.lastPathComponent, bookmark: bookmark)
            let updated = records + [record]
            let data = try encodedRecords(updated)
            defaults.set(data, forKey: storageKey)
            records = updated
            rows.append(contentsOf: entries.map {
                ClickyLibraryRow(reference: ClickyPackReference(libraryID: record.id, packID: $0.id), libraryName: record.displayName, entry: $0)
            })
            error = nil
        } catch is CancellationError {
            error = "Library import cancelled."
        } catch {
            self.error = error.localizedDescription
        }
    }

    func refresh() async {
        guard !stopped else { return }
        catalogueGeneration &+= 1
        let token = catalogueGeneration
        refreshing = true
        defer { if token == catalogueGeneration { refreshing = false } }
        let requestedRecords = records
        var loaded: [ClickyLibraryRow] = []
        var failures: [String] = []
        for record in requestedRecords {
            do {
                let url = try resolve(record)
                let accessed = url.startAccessingSecurityScopedResource()
                defer { if accessed { url.stopAccessingSecurityScopedResource() } }
                let entries = try await loader.catalogue(at: url)
                try Task.checkCancellation()
                loaded.append(contentsOf: entries.map {
                    ClickyLibraryRow(reference: ClickyPackReference(libraryID: record.id, packID: $0.id), libraryName: record.displayName, entry: $0)
                })
            } catch is CancellationError {
                return
            } catch {
                failures.append("\(record.displayName): \(error.localizedDescription)")
            }
        }
        guard token == catalogueGeneration, !Task.isCancelled else { return }
        let requestedIDs = Set(requestedRecords.map(\.id))
        let currentIDs = Set(records.map(\.id))
        rows = loaded.filter { currentIDs.contains($0.reference.libraryID) }
            + rows.filter { !requestedIDs.contains($0.reference.libraryID) && currentIDs.contains($0.reference.libraryID) }
        error = failures.isEmpty ? nil : failures.joined(separator: "\n")
    }

    func select(_ reference: ClickyPackReference) {
        guard !stopped else { return }
        selectionTask?.cancel()
        generation &+= 1
        let token = generation
        loading = reference
        error = nil
        selectionTask = Task { [weak self] in
            guard let self else { return }
            defer { if generation == token { loading = nil } }
            do {
                guard let record = records.first(where: { $0.id == reference.libraryID }),
                    let row = rows.first(where: { $0.reference == reference })
                else { throw ClickyPackError.invalid("This sound library is unavailable. Reconnect its folder or choose a built-in switch.") }
                let url = try resolve(record)
                let accessed = url.startAccessingSecurityScopedResource()
                defer { if accessed { url.stopAccessingSecurityScopedResource() } }
                let pack = try await loader.prepare(at: url, entry: row.entry)
                try Task.checkCancellation()
                guard generation == token, records.contains(where: { $0.id == record.id }) else { return }
                guard let install else { throw ClickyPackError.invalid("Sound playback is unavailable.") }
                try install(reference, pack)
                active = ClickyActivePack(reference: reference, pack: pack)
            } catch is CancellationError {
                return
            } catch {
                if generation == token { self.error = error.localizedDescription }
            }
        }
    }

    func useBuiltIn() {
        cancelSelection()
        active = nil
        error = nil
    }

    func remove(_ id: String) {
        records.removeAll { $0.id == id }
        rows.removeAll { $0.reference.libraryID == id }
        if loading?.libraryID == id { cancelSelection() }
        do { try persist() } catch { self.error = error.localizedDescription }
    }

    func stop() {
        stopped = true
        lifetime &+= 1
        cancelSelection()
        refreshTask?.cancel()
        catalogueGeneration &+= 1
        refreshing = false
    }

    private func cancelSelection() {
        generation &+= 1
        selectionTask?.cancel()
        selectionTask = nil
        loading = nil
    }

    private func resolve(_ record: ClickyLibraryRecord) throws -> URL {
        var stale = false
        return try URL(resolvingBookmarkData: record.bookmark, options: [.withSecurityScope, .withoutUI], relativeTo: nil, bookmarkDataIsStale: &stale)
    }

    private func persist() throws {
        defaults.set(try encodedRecords(records), forKey: storageKey)
    }

    private func encodedRecords(_ records: [ClickyLibraryRecord]) throws -> Data {
        let data = try JSONEncoder().encode(records)
        guard data.count <= 1_048_576 else { throw ClickyPackError.invalid("The library list exceeds its storage limit.") }
        return data
    }
}
