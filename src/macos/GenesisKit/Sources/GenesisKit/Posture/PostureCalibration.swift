import ColorSync
import CoreGraphics
import Foundation

/// The kind of a calibration slot. Home, Office and Cafe exist from the start; custom slots are added.
public enum PostureSlotKind: String, CaseIterable, Codable, Sendable {
    case home, office, cafe, custom

    public var defaultName: String {
        switch self {
        case .home: "Home"
        case .office: "Office"
        case .cafe: "Cafe"
        case .custom: "Custom"
        }
    }

    public var symbol: String {
        switch self {
        case .home: "house.fill"
        case .office: "building.2.fill"
        case .cafe: "cup.and.saucer.fill"
        case .custom: "slider.horizontal.3"
        }
    }
}

/// One saved setup: where the user sits, with which camera and which displays, and their upright pose.
public struct PostureCalibrationSlot: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var kind: PostureSlotKind
    /// Nil until the slot is calibrated.
    public var baseline: PostureBaseline?
    /// The upright pose the overlay draws as its target ghost.
    public var referencePose: PoseSample?
    /// The camera the slot was calibrated with (`AVCaptureDevice.uniqueID`).
    public var cameraID: String?
    /// The sorted display UUIDs connected at calibration; the key for picking the slot automatically.
    public var displaySet: [String]
    public var calibratedAt: Date?

    public init(id: String = UUID().uuidString, name: String, kind: PostureSlotKind, baseline: PostureBaseline? = nil,
                referencePose: PoseSample? = nil, cameraID: String? = nil, displaySet: [String] = [],
                calibratedAt: Date? = nil) {
        self.id = id
        self.name = name
        self.kind = kind
        self.baseline = baseline
        self.referencePose = referencePose
        self.cameraID = cameraID
        self.displaySet = displaySet.sorted()
        self.calibratedAt = calibratedAt
    }

    public var isCalibrated: Bool { baseline != nil }
}

/// Every slot and which one is active. Codable, so the host persists it wherever it keeps settings.
public struct PostureCalibrationBook: Codable, Equatable, Sendable {
    public var slots: [PostureCalibrationSlot]
    public var activeSlotID: String?
    /// Pick the slot by the connected displays when they change (Dorso keys calibrations by display set).
    public var autoSelectByDisplays: Bool

    public init(slots: [PostureCalibrationSlot], activeSlotID: String? = nil, autoSelectByDisplays: Bool = true) {
        self.slots = slots
        self.activeSlotID = activeSlotID ?? slots.first?.id
        self.autoSelectByDisplays = autoSelectByDisplays
    }

    /// Home, Office and Cafe, none calibrated, Home active. Fixed ids so settings can name them.
    public static var standard: PostureCalibrationBook {
        PostureCalibrationBook(slots: [PostureSlotKind.home, .office, .cafe].map {
            PostureCalibrationSlot(id: $0.rawValue, name: $0.defaultName, kind: $0)
        })
    }

    private enum CodingKeys: String, CodingKey { case slots, activeSlotID, autoSelectByDisplays }

    /// Missing keys take their defaults, so a file from an older version still loads.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        slots = try container.decodeIfPresent([PostureCalibrationSlot].self, forKey: .slots) ?? []
        activeSlotID = try container.decodeIfPresent(String.self, forKey: .activeSlotID) ?? slots.first?.id
        autoSelectByDisplays = try container.decodeIfPresent(Bool.self, forKey: .autoSelectByDisplays) ?? true
    }

    public var activeSlot: PostureCalibrationSlot? {
        slots.first { $0.id == activeSlotID }
    }

    public func slot(id: String) -> PostureCalibrationSlot? {
        slots.first { $0.id == id }
    }

    /// The calibrated slot for a display set: an exact match first, else the one sharing the most
    /// displays (at least one). Nil when no calibrated slot shares a display.
    public func slot(matching displaySet: [String]) -> PostureCalibrationSlot? {
        let wanted = Set(displaySet)
        let calibrated = slots.filter { $0.isCalibrated && !$0.displaySet.isEmpty }
        if let exact = calibrated.first(where: { Set($0.displaySet) == wanted }) { return exact }
        let ranked = calibrated
            .map { slot in (slot, Set(slot.displaySet).intersection(wanted).count) }
            .filter { $0.1 > 0 }
            .max { lhs, rhs in lhs.1 < rhs.1 }
        return ranked?.0
    }

    /// Activates the slot matching the displays when auto-select is on. Returns true when the active
    /// slot changed.
    @discardableResult
    public mutating func autoSelect(displaySet: [String]) -> Bool {
        guard autoSelectByDisplays, let match = slot(matching: displaySet), match.id != activeSlotID else { return false }
        activeSlotID = match.id
        return true
    }

    /// Saves a calibration into a slot (the active one by default) and makes it active.
    public mutating func store(_ baseline: PostureBaseline, referencePose: PoseSample?, cameraID: String?,
                               displaySet: [String], at date: Date = Date(), in slotID: String? = nil) {
        guard let id = slotID ?? activeSlotID, let index = slots.firstIndex(where: { $0.id == id }) else { return }
        slots[index].baseline = baseline
        slots[index].referencePose = referencePose
        slots[index].cameraID = cameraID
        slots[index].displaySet = displaySet.sorted()
        slots[index].calibratedAt = date
        activeSlotID = id
    }

    /// Adds a custom slot and returns its id.
    @discardableResult
    public mutating func addCustom(name: String) -> String {
        let slot = PostureCalibrationSlot(name: name, kind: .custom)
        slots.append(slot)
        return slot.id
    }

    /// Removes a slot. The active slot falls back to the first remaining one.
    public mutating func remove(id: String) {
        slots.removeAll { $0.id == id }
        if activeSlotID == id { activeSlotID = slots.first?.id }
    }

    /// Forgets a slot's calibration and keeps the slot.
    public mutating func clear(id: String) {
        guard let index = slots.firstIndex(where: { $0.id == id }) else { return }
        slots[index].baseline = nil
        slots[index].referencePose = nil
        slots[index].calibratedAt = nil
    }
}

public enum PostureDisplays {
    /// The sorted UUIDs of the active displays (`CGDisplayCreateUUIDFromDisplayID`). Any thread.
    public static func currentSet() -> [String] {
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return [] }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return [] }
        return ids.prefix(Int(count)).compactMap { id -> String? in
            guard let uuid = CGDisplayCreateUUIDFromDisplayID(id)?.takeRetainedValue() else { return nil }
            return CFUUIDCreateString(nil, uuid) as String?
        }.sorted()
    }
}

/// Collects readings during a guided calibration and turns them into a baseline: sit upright (and look
/// around the screen: that spread becomes the tolerance), then optionally slouch on purpose.
public struct PostureCalibrationSession: Sendable {
    public enum Phase: Sendable { case upright, slouch }

    public private(set) var upright: [PostureMetrics] = []
    public private(set) var slouch: [PostureMetrics] = []
    /// The upright sample with the most joints, for the overlay's target ghost.
    public private(set) var referencePose: PoseSample?

    public init() {}

    /// Adds one sample to a phase. Samples with no person or in low light are skipped.
    public mutating func add(_ sample: PoseSample, as phase: Phase) {
        guard sample.hasPerson, !sample.lowLight else { return }
        let metrics = PostureMetrics(sample: sample)
        guard !metrics.isEmpty else { return }
        switch phase {
        case .upright:
            upright.append(metrics)
            if sample.joints.count >= (referencePose?.joints.count ?? 0) { referencePose = sample }
        case .slouch:
            slouch.append(metrics)
        }
    }

    public var canFinish: Bool { upright.count >= PostureBaseline.minimumUprightReadings }

    /// The baseline, or nil with too few upright readings.
    public func baseline() -> PostureBaseline? {
        PostureBaseline.calibrate(upright: upright, slouch: slouch)
    }
}

/// Saves a calibration book as JSON in a folder the host names, off the main thread. A file that cannot
/// be read is never overwritten: `load` reports it and `save` refuses until `discardUnreadable()`, so a
/// bug or a newer format never silently wipes the user's slots. Saving is refused until the first
/// `load()` too, so a save that races the start-up load cannot replace slots nobody read yet. Only a
/// missing file counts as `.missing`; any other read error is `.unreadable`.
public final class PostureCalibrationStore: @unchecked Sendable {
    public enum LoadResult: Equatable, Sendable {
        case missing
        case loaded(PostureCalibrationBook)
        case unreadable(String)
    }

    public let fileURL: URL
    private let queue = DispatchQueue(label: "genesiskit.posture.calibration", qos: .utility)
    /// Saving is refused until a load has seen the file (or its absence) and could read it.
    private var blocked = true

    public init(directory: URL, fileName: String = "posture-calibration.json") {
        fileURL = directory.appendingPathComponent(fileName)
    }

    public func load() async -> LoadResult {
        await withCheckedContinuation { continuation in
            queue.async {
                continuation.resume(returning: self.loadNow())
            }
        }
    }

    /// Writes the book atomically on the store's queue. `completion` (any queue) gets the error, if any.
    public func save(_ book: PostureCalibrationBook, completion: (@Sendable (Error?) -> Void)? = nil) {
        queue.async {
            do {
                guard !self.blocked else { throw CocoaError(.fileWriteNoPermission) }
                try FileManager.default.createDirectory(at: self.fileURL.deletingLastPathComponent(),
                                                        withIntermediateDirectories: true)
                let encoder = JSONEncoder()
                encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
                encoder.dateEncodingStrategy = .iso8601
                try encoder.encode(book).write(to: self.fileURL, options: .atomic)
                completion?(nil)
            } catch {
                GenesisKit.log("posture: calibration not saved: \(error.localizedDescription)")
                completion?(error)
            }
        }
    }

    /// Allows saving over a file `load` could not read (after the user chose to start over).
    public func discardUnreadable() {
        queue.async { self.blocked = false }
    }

    /// Waits for queued saves (tests).
    public func flush() { queue.sync {} }

    private func loadNow() -> LoadResult {
        let data: Data
        do {
            data = try Data(contentsOf: fileURL)
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
            blocked = false
            return .missing
        } catch {
            blocked = true
            return .unreadable(error.localizedDescription)
        }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        do {
            let book = try decoder.decode(PostureCalibrationBook.self, from: data)
            blocked = false
            return .loaded(book)
        } catch {
            blocked = true
            return .unreadable(error.localizedDescription)
        }
    }
}
