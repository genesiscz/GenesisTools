import CryptoKit
import Darwin
import Foundation

public struct ClickyPackReference: Codable, Equatable, Hashable, Sendable {
    public let libraryID: String
    public let packID: String

    public init(libraryID: String, packID: String) {
        self.libraryID = libraryID
        self.packID = packID
    }
}

struct ClickyLibraryRecord: Codable, Identifiable, Sendable {
    let id: String
    let displayName: String
    let bookmark: Data
}

struct ClickyPackEntry: Codable, Identifiable, Sendable {
    let id: String
    let name: String
    let kind: String
    let author: String
    let licence: String
    let manifest: String
    let licenceFile: String
    var availabilityError: String? = nil

    init(id: String, name: String, kind: String, author: String, licence: String, manifest: String, licenceFile: String) {
        self.id = id
        self.name = name
        self.kind = kind
        self.author = author
        self.licence = licence
        self.manifest = manifest
        self.licenceFile = licenceFile
    }

    private enum CodingKeys: String, CodingKey {
        case id, name, kind, author, licence, manifest, licenceFile, availabilityError
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        // Identity errors reject the catalogue; malformed descriptive fields disable only their row.
        func text(_ key: CodingKeys) -> String { (try? values.decode(String.self, forKey: key)) ?? "" }
        name = text(.name)
        kind = text(.kind)
        author = text(.author)
        licence = text(.licence)
        manifest = text(.manifest)
        licenceFile = text(.licenceFile)
    }
}

struct ClickyPackPermissions: Codable, Sendable {
    let personal: Bool
    let modification: Bool
    let redistribution: Bool
    let commercialRedistribution: Bool
}

struct ClickyPackSource: Codable, Sendable {
    let repository: String?
    let revision: String?
    let licenceEvidence: String?
    let qualityNote: String?
    let generator: String?
    let generatorVersion: String?
    let generatorSha256: String?
    let baseSeed: Int?
    let externalSamples: Bool?

    var sourceURL: URL? {
        for candidate in [repository, licenceEvidence] {
            if let candidate, let url = URL(string: candidate),
                url.scheme?.lowercased() == "https", let host = url.host, !host.isEmpty,
                url.user == nil, url.password == nil
            {
                return url
            }
        }
        return nil
    }
}

struct ClickyPackVariants: Codable, Sendable {
    let press: [String]
    let release: [String]
}

struct ClickyPackPlayback: Codable, Sendable {
    let defaultCategory: String
    let categories: [String: ClickyPackVariants]
    let keyCodes: [String: String]
    let gain: Float
    let keyupGain: Float
    let pitchVariation: Float

    func category(for keyCode: UInt16) -> String {
        guard let physical = Self.physicalCodes[keyCode] else { return defaultCategory }
        return keyCodes[physical] ?? defaultCategory
    }

    static let categoryNames: Set<String> = ["letter", "digit", "space", "enter", "backspace", "modifier"]
    static let physicalCodes: [UInt16: String] = [
        0: "KeyA", 1: "KeyS", 2: "KeyD", 3: "KeyF", 4: "KeyH", 5: "KeyG",
        6: "KeyZ", 7: "KeyX", 8: "KeyC", 9: "KeyV", 10: "IntlBackslash", 11: "KeyB",
        12: "KeyQ", 13: "KeyW", 14: "KeyE", 15: "KeyR", 16: "KeyY", 17: "KeyT",
        18: "Digit1", 19: "Digit2", 20: "Digit3", 21: "Digit4", 22: "Digit6", 23: "Digit5",
        24: "Equal", 25: "Digit9", 26: "Digit7", 27: "Minus", 28: "Digit8", 29: "Digit0",
        30: "BracketRight", 31: "KeyO", 32: "KeyU", 33: "BracketLeft", 34: "KeyI", 35: "KeyP",
        36: "Enter", 37: "KeyL", 38: "KeyJ", 39: "Quote", 40: "KeyK", 41: "Semicolon",
        42: "Backslash", 43: "Comma", 44: "Slash", 45: "KeyN", 46: "KeyM", 47: "Period",
        48: "Tab", 49: "Space", 50: "Backquote", 51: "Backspace", 53: "Escape",
        54: "MetaRight", 55: "MetaLeft", 56: "ShiftLeft", 57: "CapsLock", 58: "AltLeft",
        59: "ControlLeft", 60: "ShiftRight", 61: "AltRight", 62: "ControlRight", 63: "Fn",
        64: "F17", 65: "NumpadDecimal", 67: "NumpadMultiply", 69: "NumpadAdd", 71: "NumLock",
        72: "AudioVolumeUp", 73: "AudioVolumeDown", 74: "AudioVolumeMute", 75: "NumpadDivide",
        76: "NumpadEnter", 78: "NumpadSubtract", 79: "F18", 80: "F19", 81: "NumpadEqual",
        82: "Numpad0", 83: "Numpad1", 84: "Numpad2", 85: "Numpad3", 86: "Numpad4",
        87: "Numpad5", 88: "Numpad6", 89: "Numpad7", 90: "F20", 91: "Numpad8", 92: "Numpad9",
        93: "IntlYen", 94: "IntlRo", 95: "NumpadComma", 96: "F5", 97: "F6", 98: "F7",
        99: "F3", 100: "F8", 101: "F9", 102: "Lang2", 103: "F11", 104: "Lang1",
        105: "F13", 106: "F16", 107: "F14", 109: "F10", 111: "F12", 113: "F15",
        114: "Help", 115: "Home", 116: "PageUp", 117: "Delete", 118: "F4", 119: "End",
        120: "F2", 121: "PageDown", 122: "F1", 123: "ArrowLeft", 124: "ArrowRight",
        125: "ArrowDown", 126: "ArrowUp",
    ]
}

struct ClickySampleChoice: Equatable, Sendable {
    let filename: String
    let category: String
    let variant: Int
    let release: Bool
}

struct ClickyPackSelectionState {
    private var counters: [String: Int] = [:]
    private var held: [UInt16: ClickySampleChoice] = [:]

    mutating func clear() {
        counters.removeAll(keepingCapacity: true)
        held.removeAll(keepingCapacity: true)
    }

    mutating func next(playback: ClickyPackPlayback, keyCode: UInt16, release: Bool) -> ClickySampleChoice? {
        if release {
            guard let press = held.removeValue(forKey: keyCode),
                let variants = playback.categories[press.category], !variants.release.isEmpty
            else { return nil }
            return ClickySampleChoice(
                filename: variants.release[press.variant % variants.release.count],
                category: press.category, variant: press.variant, release: true)
        }
        let category = playback.category(for: keyCode)
        guard let variants = playback.categories[category], !variants.press.isEmpty else { return nil }
        let index = (counters[category] ?? 0) % variants.press.count
        counters[category] = (index + 1) % variants.press.count
        let choice = ClickySampleChoice(
            filename: variants.press[index], category: category, variant: index, release: false)
        held[keyCode] = choice
        return choice
    }
}

struct ClickyPreparedSample: Sendable {
    let sha256: String
    let frames: [Float]
}

struct PreparedClickyPack: Sendable {
    let entry: ClickyPackEntry
    let manifestHash: String
    let licenceText: String
    let source: ClickyPackSource
    let permissions: ClickyPackPermissions
    let attribution: String
    let attributionRequired: Bool
    let playback: ClickyPackPlayback
    let samples: [String: ClickyPreparedSample]
    let decodedFrameCount: Int
}

enum ClickyPackError: LocalizedError {
    case invalid(String)
    var errorDescription: String? {
        switch self {
        case .invalid(let reason): return reason
        }
    }
}

private struct ClickyPackRegistry: Decodable {
    let formatVersion: Int
    let sets: [ClickyPackEntry]
}

private struct ClickyPackManifest: Decodable {
    struct Audio: Decodable {
        let sampleRate: Int
        let channels: Int
        let bitsPerSample: Int
    }
    struct File: Decodable {
        let filename: String
        let sha256: String
        let frames: Int
    }
    let formatVersion: Int
    let id: String
    let name: String
    let kind: String
    let author: String
    let licence: String
    let attribution: String?
    let attributionRequired: Bool
    let permissions: ClickyPackPermissions
    let source: ClickyPackSource
    let audio: Audio
    let playback: ClickyPackPlayback
    let files: [File]
}

actor ClickyPackLoader {
    static let maximumFrames = 64 * 12_000

    func catalogue(at root: URL) throws -> [ClickyPackEntry] {
        try Task.checkCancellation()
        let directory = try ClickyPackDirectory(root: root)
        let bytes = try directory.read("registry.json", limit: 2 * 1024 * 1024)
        let registry = try JSONDecoder().decode(ClickyPackRegistry.self, from: bytes)
        guard registry.formatVersion == 1, registry.sets.count <= 500 else {
            throw ClickyPackError.invalid("Unsupported or oversized sound library catalogue.")
        }
        var identities = Set<String>()
        return try registry.sets.map { original in
            try Task.checkCancellation()
            guard Self.validSlug(original.id), identities.insert(original.id).inserted else {
                throw ClickyPackError.invalid("The sound library contains an invalid or duplicate pack ID.")
            }
            var entry = original
            entry.availabilityError = nil
            do {
                try Self.validateEntry(entry)
            } catch {
                entry.availabilityError = error.localizedDescription
            }
            return entry
        }
    }

    func prepare(at root: URL, entry: ClickyPackEntry) throws -> PreparedClickyPack {
        try Task.checkCancellation()
        try Self.validateEntry(entry)
        let directory = try ClickyPackDirectory(root: root)
        let pack = try directory.child(entry.id)
        let bytes = try pack.read("manifest.json", limit: 256 * 1024)
        let manifest = try JSONDecoder().decode(ClickyPackManifest.self, from: bytes)
        try Self.validate(manifest, entry: entry)
        let licenceBytes = try pack.read("LICENCE.txt", limit: 256 * 1024)
        guard let licenceText = String(data: licenceBytes, encoding: .utf8),
            !licenceText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            !licenceText.contains("\0")
        else { throw ClickyPackError.invalid("The pack licence must be nonempty UTF-8 text.") }
        var samples: [String: ClickyPreparedSample] = [:]
        var byHash: [String: ClickyPreparedSample] = [:]
        var decodedFrameCount = 0
        for file in manifest.files {
            try Task.checkCancellation()
            let data = try pack.read(file.filename, limit: 64 * 1024)
            let hash = Self.sha256(data)
            guard hash == file.sha256.lowercased() else {
                throw ClickyPackError.invalid("Sample checksum mismatch: \(file.filename)")
            }
            if let cached = byHash[hash] {
                guard cached.frames.count == file.frames else {
                    throw ClickyPackError.invalid("Sample frame count mismatch: \(file.filename)")
                }
                samples[file.filename] = cached
            } else {
                let frames = try Self.decodePCM16(data, expectedFrames: file.frames)
                decodedFrameCount += frames.count
                let sample = ClickyPreparedSample(sha256: hash, frames: frames)
                byHash[hash] = sample
                samples[file.filename] = sample
            }
        }
        try Task.checkCancellation()
        let authoritativeEntry = ClickyPackEntry(
            id: manifest.id, name: manifest.name, kind: manifest.kind, author: manifest.author,
            licence: manifest.licence, manifest: entry.manifest, licenceFile: entry.licenceFile)
        return PreparedClickyPack(
            entry: authoritativeEntry, manifestHash: Self.sha256(bytes), licenceText: licenceText,
            source: manifest.source, permissions: manifest.permissions, attribution: manifest.attribution ?? "",
            attributionRequired: manifest.attributionRequired, playback: manifest.playback,
            samples: samples, decodedFrameCount: decodedFrameCount)
    }

    nonisolated static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static func validSlug(_ value: String) -> Bool {
        !value.isEmpty && value.utf8.count <= 128 && value.utf8.allSatisfy {
            (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95
        }
    }

    private static func validateEntry(_ entry: ClickyPackEntry) throws {
        guard validSlug(entry.id), entry.manifest == "\(entry.id)/manifest.json",
            entry.licenceFile == "\(entry.id)/LICENCE.txt",
            [entry.name, entry.author, entry.kind, entry.licence].allSatisfy({ !$0.isEmpty && $0.utf8.count <= 1024 })
        else { throw ClickyPackError.invalid("Invalid pack metadata or paths.") }
    }

    private static func validate(_ manifest: ClickyPackManifest, entry: ClickyPackEntry) throws {
        guard manifest.formatVersion == 1, manifest.id == entry.id,
            manifest.audio.sampleRate == 48_000, manifest.audio.channels == 1, manifest.audio.bitsPerSample == 16,
            (1...64).contains(manifest.files.count),
            [manifest.name, manifest.author, manifest.kind, manifest.licence].allSatisfy({ !$0.isEmpty && $0.utf8.count <= 1024 })
        else { throw ClickyPackError.invalid("Unsupported pack identity, format, or sample count.") }
        var names = Set<String>()
        var totalFrames = 0
        for file in manifest.files {
            guard ClickyPackDirectory.validBasename(file.filename), file.filename.hasSuffix(".wav"),
                names.insert(file.filename).inserted, file.sha256.utf8.count == 64,
                file.sha256.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) || (65...70).contains($0) }),
                (1...12_000).contains(file.frames)
            else { throw ClickyPackError.invalid("Invalid or duplicate sample declaration.") }
            totalFrames += file.frames
        }
        guard totalFrames <= maximumFrames else { throw ClickyPackError.invalid("The pack exceeds the decoded audio limit.") }
        let playback = manifest.playback
        let knownCodes = Set(ClickyPackPlayback.physicalCodes.values)
        guard Set(playback.categories.keys) == ClickyPackPlayback.categoryNames,
            ClickyPackPlayback.categoryNames.contains(playback.defaultCategory),
            playback.keyCodes.count <= knownCodes.count,
            playback.keyCodes.allSatisfy({ knownCodes.contains($0.key) && ClickyPackPlayback.categoryNames.contains($0.value) }),
            playback.gain.isFinite, (0...1).contains(playback.gain),
            playback.keyupGain.isFinite, (0...1).contains(playback.keyupGain), playback.pitchVariation == 0
        else { throw ClickyPackError.invalid("Unsupported playback mapping or gain.") }
        for variants in playback.categories.values {
            guard (1...16).contains(variants.press.count), (1...16).contains(variants.release.count),
                (variants.press + variants.release).allSatisfy({ names.contains($0) })
            else { throw ClickyPackError.invalid("Playback references an undeclared sample or invalid variant count.") }
        }
    }

    nonisolated static func decodePCM16(_ data: Data, expectedFrames: Int) throws -> [Float] {
        func invalid() -> ClickyPackError { .invalid("Expected a non-silent mono 48 kHz PCM16 WAV, at most 250 ms.") }
        guard data.count >= 12, data.count <= 64 * 1024 else { throw invalid() }
        let bytes = [UInt8](data)
        func u16(_ offset: Int) -> Int { Int(bytes[offset]) | Int(bytes[offset + 1]) << 8 }
        func u32(_ offset: Int) -> Int { u16(offset) | u16(offset + 2) << 16 }
        func tag(_ offset: Int, _ value: String) -> Bool { Array(bytes[offset..<(offset + 4)]) == Array(value.utf8) }
        guard tag(0, "RIFF"), tag(8, "WAVE"), u32(4) == bytes.count - 8 else { throw invalid() }
        var offset = 12
        var sawFormat = false
        var payload: Range<Int>?
        while offset < bytes.count {
            guard bytes.count - offset >= 8 else { throw invalid() }
            let size = u32(offset + 4)
            let start = offset + 8
            guard size <= bytes.count - start else { throw invalid() }
            let end = start + size
            if tag(offset, "fmt ") {
                guard !sawFormat, size >= 16,
                    u16(start) == 1, u16(start + 2) == 1, u32(start + 4) == 48_000,
                    u32(start + 8) == 96_000, u16(start + 12) == 2, u16(start + 14) == 16
                else { throw invalid() }
                sawFormat = true
            } else if tag(offset, "data") {
                guard payload == nil, size > 0, size % 2 == 0 else { throw invalid() }
                payload = start..<end
            }
            offset = end + size % 2
            guard offset <= bytes.count else { throw invalid() }
        }
        guard sawFormat, let payload, (1...12_000).contains(expectedFrames), payload.count / 2 == expectedFrames else {
            throw invalid()
        }
        var frames = [Float]()
        frames.reserveCapacity(expectedFrames)
        var audible = false
        for index in stride(from: payload.lowerBound, to: payload.upperBound, by: 2) {
            let sample = Int16(bitPattern: UInt16(u16(index)))
            audible = audible || sample != 0
            frames.append(Float(sample) / 32768)
        }
        guard audible else { throw invalid() }
        return frames
    }
}

// Each child is opened relative to a pinned directory descriptor. No pathname is reopened after validation.
final class ClickyPackDirectory {
    private let descriptor: Int32

    init(root: URL) throws {
        guard root.isFileURL else { throw ClickyPackError.invalid("Choose a local sound library folder.") }
        let opened = root.withUnsafeFileSystemRepresentation { pointer in
            pointer.map { Darwin.open($0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC) } ?? -1
        }
        guard opened >= 0 else { throw ClickyPackError.invalid("The sound library folder is unavailable or is a symbolic link.") }
        descriptor = opened
    }

    private init(descriptor: Int32) { self.descriptor = descriptor }
    deinit { Darwin.close(descriptor) }

    static func validBasename(_ name: String) -> Bool {
        !name.isEmpty && name.utf8.count <= 255 && name != "." && name != ".."
            && name.utf8.allSatisfy { $0 >= 32 && $0 < 127 && $0 != 47 && $0 != 92 && $0 != 37 && $0 != 58 }
    }

    func child(_ name: String) throws -> ClickyPackDirectory {
        guard Self.validBasename(name) else { throw ClickyPackError.invalid("Invalid pack directory name.") }
        let opened = openat(descriptor, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard opened >= 0 else { throw ClickyPackError.invalid("The pack directory is missing or is a symbolic link.") }
        return ClickyPackDirectory(descriptor: opened)
    }

    func read(_ name: String, limit: Int) throws -> Data {
        try Task.checkCancellation()
        guard Self.validBasename(name) else { throw ClickyPackError.invalid("Invalid pack filename.") }
        let opened = openat(descriptor, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
        guard opened >= 0 else { throw ClickyPackError.invalid("Cannot open pack file: \(name)") }
        defer { Darwin.close(opened) }
        var info = stat()
        guard fstat(opened, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG,
            info.st_size > 0, info.st_size <= limit
        else { throw ClickyPackError.invalid("Pack file is empty, oversized, or not a regular file: \(name)") }
        var result = Data()
        result.reserveCapacity(Int(info.st_size))
        var buffer = [UInt8](repeating: 0, count: 16 * 1024)
        while true {
            try Task.checkCancellation()
            let count = buffer.withUnsafeMutableBytes { Darwin.read(opened, $0.baseAddress, min($0.count, limit + 1 - result.count)) }
            if count < 0 {
                if errno == EINTR {
                    continue
                }
                throw ClickyPackError.invalid("Cannot read pack file: \(name)")
            }
            if count == 0 {
                break
            }
            guard result.count + count <= limit else { throw ClickyPackError.invalid("Pack file grew beyond its size limit: \(name)") }
            result.append(contentsOf: buffer.prefix(count))
        }
        guard result.count == info.st_size else { throw ClickyPackError.invalid("Pack file changed while reading: \(name)") }
        return result
    }
}
