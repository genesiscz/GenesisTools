import CryptoKit
import Foundation
import GenesisKit

indirect enum RecastJSON: Codable, Sendable, Equatable {
    case string(String), number(Double), bool(Bool), null, array([RecastJSON]), object([String: RecastJSON])

    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let boolean = try? value.decode(Bool.self) { self = .bool(boolean) }
        else if let number = try? value.decode(Double.self) { self = .number(number) }
        else if let text = try? value.decode(String.self) { self = .string(text) }
        else if let array = try? value.decode([RecastJSON].self) { self = .array(array) }
        else { self = .object(try value.decode([String: RecastJSON].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .string(let text): try value.encode(text)
        case .number(let number): try value.encode(number)
        case .bool(let boolean): try value.encode(boolean)
        case .null: try value.encodeNil()
        case .array(let array): try value.encode(array)
        case .object(let object): try value.encode(object)
        }
    }

    static func encoded<T: Encodable>(_ input: T) throws -> RecastJSON {
        try JSONDecoder().decode(RecastJSON.self, from: JSONEncoder().encode(input))
    }

    var display: String {
        switch self {
        case .string(let text): return text
        case .number(let number): return String(number)
        case .bool(let boolean): return boolean ? "true" : "false"
        case .null: return ""
        default: return ""
        }
    }
    var isNull: Bool { self == .null }
}

struct RecastFile: Codable, Sendable {
    var format: String
    var version: Int
    var id: String
    var title: String
    var revision: Int
    var sources: [RecastSource]
    var anchors: [RecastAnchor]
    var readings: [RecastReading]
    var collections: [RecastCollection]
    var records: [RecastRecord]
    var corrections: [RecastCorrection]
    var journal: [RecastJournal]
    var renderings: [RecastRenderingReceipt]?
    var reconciliations: [RecastSourceReconciliation]?
    var contradictions: [RecastContradiction]?
}

struct RecastContradiction: Codable, Identifiable, Sendable {
    var id: String
    var collectionId: String
    var fieldId: String
    var label: String
    var reason: String
    var createdAt: String
    var status: String
    var decision: String?
    var preferredRecordId: String?
    var resolvedAt: String?
    var members: [RecastContradictionMember]
}
struct RecastContradictionMember: Codable, Identifiable, Sendable {
    var recordId: String
    var cell: RecastCell
    var context: String
    var id: String { recordId }
}

struct RecastSource: Codable, Identifiable, Sendable {
    var id: String
    var name: String
    var contentHash: String
    var assetName: String
    var mime: String
    var kind: String
    var bytes: Int
    var importedAt: String
    var externalLocation: String?
    var pageCount: Int?
    var pages: [NativeSourcePage]
    var textLength: Int?
    var durationMs: Double?
    var error: String?
    var replaces: String?
}

struct RecastRegion: Codable, Sendable {
    var kind: String
    var page: Int?
    var x: Double?
    var y: Double?
    var width: Double?
    var height: Double?
    var start: Int?
    var end: Int?
    var quote: String?
    var prefix: String?
    var suffix: String?
    var startMs: Double?
    var endMs: Double?

    static func rectangle(_ rect: NativeSourceRect, page: Int) -> RecastRegion {
        RecastRegion(kind: "rect", page: page, x: rect.x, y: rect.y, width: rect.width, height: rect.height)
    }
    var rectangle: NativeSourceRect? {
        guard kind == "rect", let x, let y, let width, let height else { return nil }
        return NativeSourceRect(x: x, y: y, width: width, height: height)
    }
    var description: String {
        switch kind {
        case "rect": return String(format: "Page %d · x %.0f%%, y %.0f%% · %.0f%% × %.0f%%",
            (page ?? 0) + 1, (x ?? 0) * 100, (y ?? 0) * 100, (width ?? 0) * 100, (height ?? 0) * 100)
        case "text": return "Characters \((start ?? 0) + 1)–\(end ?? 0)"
        case "audio": return String(format: "%.1f–%.1f seconds", (startMs ?? 0) / 1000, (endMs ?? 0) / 1000)
        default: return "Whole source"
        }
    }
}

struct RecastAnchor: Codable, Identifiable, Sendable {
    var id: String
    var sourceId: String
    var sourceHash: String
    var label: String
    var region: RecastRegion
    var fingerprint: String?
}

struct RecastReading: Codable, Identifiable, Sendable {
    var id: String
    var anchorId: String
    var text: String
    var alternatives: [String]
    var method: String
    var engine: String
    var createdAt: String
}

struct RecastField: Codable, Identifiable, Sendable {
    var id: String
    var label: String
    var type: String
    var required: Bool
}
struct RecastCollection: Codable, Identifiable, Sendable {
    var id: String
    var label: String
    var kind: String
    var fields: [RecastField]
}
struct RecastCell: Codable, Sendable {
    var value: RecastJSON = .null
    var state = "unknown"
    var origin = "user"
    var anchorIds: [String] = []
    var readingIds: [String] = []
    var alternatives: [RecastJSON] = []
    var note = ""
}
struct RecastRecord: Codable, Identifiable, Sendable {
    var id: String
    var collectionId: String
    var state: String
    var cells: [String: RecastCell]
    var createdAt: String
}
struct RecastCorrection: Codable, Identifiable, Sendable {
    var id: String
    var recordId: String
    var fieldId: String
    var before: RecastCell
    var after: RecastCell
    var reason: String
    var createdAt: String
}
struct RecastJournal: Codable, Identifiable, Sendable {
    var id: String
    var revision: Int
    var at: String
    var action: String
    var recordIds: [String]
}
struct RecastIssue: Decodable, Identifiable, Sendable {
    var recordId: String
    var fieldId: String?
    var message: String
    var id: String { recordId + ":" + (fieldId ?? "") + ":" + message }
}
struct RecastInspection: Decodable, Sendable {
    var document: RecastFile
    var issues: [RecastIssue]
}
struct RecastRendering: Decodable, Sendable {
    var receipt: RecastRenderingReceipt
    var format: String
    var mime: String
    var text: String
    var contentHash: String
    var recordIds: [String]
    var evidence: String
}
struct RecastSourceReconciliation: Codable, Identifiable, Sendable {
    var id: String
    var oldSourceId: String
    var newSourceId: String
    var createdAt: String
    var items: [Item]
    struct Item: Codable, Sendable {
        var oldAnchorId: String
        var status: String
        var newAnchorId: String?
    }
}

struct RecastReconciliationPreview: Decodable, Sendable {
    var documentId: String
    var revision: Int
    var oldSourceId: String
    var newSourceId: String
    var jobId: String?
    var items: [Item]
    struct Item: Decodable, Identifiable, Sendable {
        var id: String { oldAnchorId }
        var oldAnchorId: String
        var label: String
        var quote: String
        var match: String
        var candidateCount: Int
        var candidates: [Candidate]
        var decision: String
        var newAnchorId: String?
    }
    struct Candidate: Decodable, Identifiable, Sendable {
        var id: String { anchorId }
        var anchorId: String
        var method: String
        var quote: String
        var score: Double
    }
}

struct RecastRenderingReceipt: Codable, Identifiable, Sendable {
    var id: String
    var documentId: String
    var revision: Int
    var collectionId: String
    var format: String
    var createdAt: String
    var contentHash: String
    var includeRecordIds: Bool
    var fields: [RecastField]
    var rows: [Row]

    var createdLabel: String {
        ISO8601DateFormatter().date(from: createdAt)?.formatted(date: .abbreviated, time: .shortened) ?? createdAt
    }

    struct Row: Codable, Identifiable, Sendable {
        var id: String
        var values: [String: RecastJSON]
    }
}

struct RecastRoundTripChange: Decodable, Identifiable, Sendable {
    var id: String
    var kind: String
    var status: String
    var recordId: String
    var fieldId: String?
    var label: String
    var base: RecastJSON
    var current: RecastJSON
    var incoming: RecastJSON
    var message: String
}
struct RecastRoundTripReview: Decodable, Sendable {
    var documentId: String
    var revision: Int
    var receiptId: String
    var collectionId: String
    var changes: [RecastRoundTripChange]
    var unchanged: Int
    var importedRows: Int
}
struct RecastRoundTripDraft: Identifiable {
    let id = UUID()
    var csv: String
    var name: String
    var review: RecastRoundTripReview
}

struct RecastTaskAccountChoice: Decodable, Identifiable {
    var id: String
    var name: String
    var provider: String
    var modelRef: String
    var defaultModel: String?
    var local: Bool
}

struct RecastProposalInput: Decodable, Sendable {
    var documentId: String
    var revision: Int
    var collectionId: String
    var sourceIds: [String]
    var readingIds: [String]
    var contextHash: String
    var serialized: String
    var characters: Int
}

struct RecastProposalReview: Decodable, Sendable {
    var documentId: String
    var revision: Int
    var collectionId: String
    var sourceIds: [String]
    var readingIds: [String]
    var contextHash: String
    var explanation: String
    var records: [RecastRecord]
    var warnings: [String]
}

struct RecastState: Sendable {
    var file: RecastFile
    var assets: [String: Data]
}

func recastID(_ prefix: String) -> String { prefix + "_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased() }
func recastTimestamp() -> String { ISO8601DateFormatter().string(from: Date()) }
func recastError(_ message: String) -> NSError {
    NSError(domain: "Recast", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}
func recastOperation(_ kind: String, _ values: [String: RecastJSON] = [:]) -> RecastJSON {
    .object(values.merging(["kind": .string(kind)]) { _, new in new })
}

enum RecastPackage {
    static let type = "com.genesiscz.genesistools.recast"

    static func load(_ url: URL) throws -> RecastState {
        let directory = try url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard directory.isDirectory == true, directory.isSymbolicLink != true else { throw recastError("Open a regular Recast package.") }
        func read(_ file: URL, limit: Int) throws -> Data {
            let values = try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
            guard values.isRegularFile == true, values.isSymbolicLink != true,
                  let size = values.fileSize, size <= limit else { throw recastError("The package contains an oversized or invalid file.") }
            let data = try Data(contentsOf: file)
            guard data.count == size, data.count <= limit else { throw recastError("The package changed while opening.") }
            return data
        }
        let manifest = try read(url.appendingPathComponent("manifest.json"), limit: 32 * 1024 * 1024)
        let file = try JSONDecoder().decode(RecastFile.self, from: manifest)
        guard file.sources.count <= 128 else { throw recastError("The package has too many sources.") }
        var sourceWrappers = [String: FileWrapper]()
        var total = 0
        let sourcesURL = url.appendingPathComponent("sources")
        if !file.sources.isEmpty {
            let values = try sourcesURL.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            guard values.isDirectory == true, values.isSymbolicLink != true else { throw recastError("The source directory is missing or invalid.") }
        }
        for source in file.sources {
            guard source.assetName.range(of: "^[a-f0-9]{64}\\.[a-z0-9]{1,10}$", options: .regularExpression) != nil else {
                throw recastError("The package has an invalid source filename.")
            }
            if sourceWrappers[source.assetName] != nil { continue }
            guard source.bytes >= 0, source.bytes <= NativeSourceReader.maximumBytes,
                  total + source.bytes <= 512 * 1024 * 1024 else { throw recastError("The source package exceeds its size limit.") }
            let data = try read(sourcesURL.appendingPathComponent(source.assetName), limit: source.bytes)
            total += data.count
            sourceWrappers[source.assetName] = FileWrapper(regularFileWithContents: data)
        }
        return try decode(FileWrapper(directoryWithFileWrappers: [
            "manifest.json": FileWrapper(regularFileWithContents: manifest),
            "sources": FileWrapper(directoryWithFileWrappers: sourceWrappers)
        ]))
    }

    static func decode(_ wrapper: FileWrapper) throws -> RecastState {
        guard wrapper.isDirectory, let entries = wrapper.fileWrappers,
              let manifest = entries["manifest.json"], manifest.isRegularFile,
              let bytes = manifest.regularFileContents, bytes.count <= 32 * 1024 * 1024 else {
            throw recastError("Open a Recast package containing a manifest smaller than 32 MiB.")
        }
        var file = try JSONDecoder().decode(RecastFile.self, from: bytes)
        guard file.format == "genesis-recast", [1, 2].contains(file.version),
              (file.version == 1 ? file.contradictions == nil : file.contradictions != nil),
              (file.contradictions?.count ?? 0) <= 256, file.sources.count <= 128,
              file.records.count <= 2000, file.anchors.count <= 20000 else {
            throw recastError("This document has an unsupported format or exceeds Recast's limits.")
        }
        if file.version == 1 { file.version = 2; file.contradictions = [] }
        let sourceDirectory = entries["sources"]
        guard file.sources.isEmpty || sourceDirectory?.isDirectory == true else {
            throw recastError("The package's source snapshots are missing.")
        }
        var assets: [String: Data] = [:]
        var total = 0
        for source in file.sources {
            guard source.assetName.range(of: "^[a-f0-9]{64}\\.[a-z0-9]{1,10}$", options: .regularExpression) != nil,
                  let entry = sourceDirectory?.fileWrappers?[source.assetName], entry.isRegularFile,
                  let data = entry.regularFileContents, data.count <= NativeSourceReader.maximumBytes,
                  data.count == source.bytes else {
                throw recastError("A source snapshot is missing or has changed: " + source.name)
            }
            guard source.assetName.hasPrefix(source.contentHash + ".") else {
                throw recastError("A source snapshot no longer matches its evidence: " + source.name)
            }
            if assets[source.assetName] == nil {
                total += data.count
                guard total <= 512 * 1024 * 1024 else { throw recastError("The source package exceeds 512 MiB.") }
                let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
                guard hash == source.contentHash, source.assetName.hasPrefix(hash + ".") else {
                    throw recastError("A source snapshot no longer matches its evidence: " + source.name)
                }
                assets[source.assetName] = data
            }
            if source.kind == "text" {
                guard let text = String(data: data, encoding: .utf8), text.utf16.count == source.textLength else {
                    throw recastError("The source text length does not match its snapshot metadata.")
                }
                let units = Array(text.utf16)
                for anchor in file.anchors where anchor.sourceId == source.id && anchor.region.kind == "text" {
                    let region = anchor.region
                    guard anchor.sourceHash == source.contentHash, let start = region.start, let end = region.end,
                          start >= 0, end > start, end <= units.count, let quote = region.quote,
                          units[start..<end].elementsEqual(quote.utf16),
                          units[..<start].suffix((region.prefix ?? "").utf16.count).elementsEqual((region.prefix ?? "").utf16),
                          units[end...].prefix((region.suffix ?? "").utf16.count).elementsEqual((region.suffix ?? "").utf16) else {
                        throw recastError("A literal text region does not match the preserved source.")
                    }
                }
            }
        }
        return RecastState(file: file, assets: assets)
    }

    static func encode(_ state: RecastState) throws -> FileWrapper {
        guard [1, 2].contains(state.file.version),
              (state.file.version == 1 ? state.file.contradictions == nil : state.file.contradictions != nil) else {
            throw recastError("Contradiction state requires Recast package version 2.")
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let manifest = try encoder.encode(state.file)
        guard manifest.count <= 32 * 1024 * 1024 else { throw recastError("The document manifest exceeds 32 MiB.") }
        var sources: [String: FileWrapper] = [:]
        for source in state.file.sources {
            guard let data = state.assets[source.assetName], data.count == source.bytes else {
                throw recastError("The original source is unavailable: " + source.name)
            }
            sources[source.assetName] = FileWrapper(regularFileWithContents: data)
        }
        return FileWrapper(directoryWithFileWrappers: [
            "manifest.json": FileWrapper(regularFileWithContents: manifest),
            "sources": FileWrapper(directoryWithFileWrappers: sources)
        ])
    }
}
