import Foundation

struct ModelRoomPoint: Codable, Equatable {
    var x: Double
    var y: Double
}

struct ModelRoomRange: Codable, Equatable {
    var min: Double
    var max: Double
    var step: Double
}

struct ModelRoomObservation: Codable, Equatable {
    var time: Double
    var value: Double
}

struct ModelRoomQuantity: Codable, Equatable, Identifiable {
    var id: String
    var label: String
    var unit: String
    var description: String = ""
    var provenance: String = "assumption"
    var seed: Double?
    var range: ModelRoomRange?
    var position: ModelRoomPoint
    var kind: String
    var value: Double?
    var expression: String?
    var initial: Double?
    var derivative: String?
    var min: Double?
    var max: Double?
    var points: [ModelRoomObservation]?
    var interpolation: String?
    var source: String?

    var formula: String { expression ?? derivative ?? "" }
    var baseValue: Double { value ?? initial ?? points?.first?.value ?? 0 }
}

struct ModelRoomIntervention: Codable, Equatable, Identifiable {
    var at: Double
    var values: [String: Double]
    var label: String
    var id = UUID()

    private enum CodingKeys: String, CodingKey { case at, values, label }
    static func == (lhs: Self, rhs: Self) -> Bool { lhs.at == rhs.at && lhs.values == rhs.values && lhs.label == rhs.label }
}

struct ModelRoomScenario: Codable, Equatable, Identifiable {
    var id: String
    var label: String
    var description: String = ""
    var color: String = "#dfacff"
    var overrides: [String: Double] = [:]
    var interventions: [ModelRoomIntervention] = []
    var replacements: [ModelRoomQuantity] = []
    var removed: [String] = []
}

struct ModelRoomSubsystem: Codable, Equatable, Identifiable {
    var id: String
    var label: String
    var description: String
    var quantities: [String]
}

struct ModelRoomPresentationStep: Codable, Equatable, Identifiable {
    var title: String
    var text: String
    var scenario: String?
    var time: Double?
    var id = UUID()

    private enum CodingKeys: String, CodingKey { case title, text, scenario, time }
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.title == rhs.title && lhs.text == rhs.text && lhs.scenario == rhs.scenario && lhs.time == rhs.time
    }
}

struct ModelRoomPresentation: Codable, Equatable {
    var controls: [String]
    var outputs: [String]
    var steps: [ModelRoomPresentationStep]
}

struct ModelRoomTime: Codable, Equatable {
    var unit: String
    var duration: Double
    var step: Double
}

struct ModelRoomFile: Codable, Equatable {
    var format: String = "genesis-model-room"
    var version: Int = 1
    var id: String
    var title: String
    var description: String
    var time: ModelRoomTime
    var quantities: [ModelRoomQuantity]
    var scenarios: [ModelRoomScenario]
    var subsystems: [ModelRoomSubsystem]
    var presentation: ModelRoomPresentation
}

extension ModelRoomFile {
    mutating func editQuantity(id: String, scenarioID: String, edit: (inout ModelRoomQuantity) -> Void) {
        if let scenarioIndex = scenarios.firstIndex(where: { $0.id == scenarioID }) {
            guard var quantity = effectiveQuantities(scenarioID: scenarioID).first(where: { $0.id == id }) else { return }
            edit(&quantity)
            if let index = scenarios[scenarioIndex].replacements.firstIndex(where: { $0.id == id }) { scenarios[scenarioIndex].replacements[index] = quantity }
            else { scenarios[scenarioIndex].replacements.append(quantity) }
        } else {
            guard let index = quantities.firstIndex(where: { $0.id == id }) else { return }
            edit(&quantities[index])
        }
    }

    var comparisonInputs: [ModelRoomQuantity] {
        var result: [ModelRoomQuantity] = []
        var seen: Set<String> = []
        for scenarioID in [""] + scenarios.map(\.id) {
            for quantity in effectiveQuantities(scenarioID: scenarioID) where quantity.kind == "input" && !seen.contains(quantity.id) {
                result.append(quantity); seen.insert(quantity.id)
            }
        }
        return result
    }

    func effectiveQuantities(scenarioID: String) -> [ModelRoomQuantity] {
        guard let scenario = scenarios.first(where: { $0.id == scenarioID }) else { return quantities }
        var result = quantities
        for replacement in scenario.replacements {
            if let index = result.firstIndex(where: { $0.id == replacement.id }) { result[index] = replacement }
            else { result.append(replacement) }
        }
        let removed = Set(scenario.removed)
        return result.filter { !removed.contains($0.id) }
    }
}

struct ModelRoomFrame: Codable {
    var tick: Int
    var time: Double
    var values: [String: Double]
}

struct ModelRoomResult: Codable {
    var scenarioId: String?
    var frames: [ModelRoomFrame]
    var method: String
    var timeUnit: String
    var step: Double
    var chartFrames: [String: [ModelRoomFrame]] = [:]

    private enum CodingKeys: String, CodingKey { case scenarioId, frames, method, timeUnit, step }
}

struct ModelRoomEvaluatedQuantity: Codable {
    var id: String
    var label: String
    var kind: String
    var unit: String
    var scale: Double
    var dimension: String

    func convert(_ value: Double?, to target: ModelRoomEvaluatedQuantity) -> Double? {
        guard let value, dimension == target.dimension else { return nil }
        let converted = value * scale / target.scale
        return converted.isFinite ? converted : nil
    }
}

struct ModelRoomEvaluatedScenario: Codable, Identifiable {
    var id: String?
    var label: String
    var color: String
    var quantities: [String: ModelRoomEvaluatedQuantity]
    var relationships: [ModelRoomRelationship]
    var result: ModelRoomResult?
    var error: String?
    var selectionID: String { id ?? "" }
}

struct ModelRoomRelationship: Codable, Identifiable {
    var source: String
    var target: String
    var delayed: Bool
    var id: String { "\(source):\(target):\(delayed)" }
}

struct ModelRoomEvaluation: Codable {
    var document: ModelRoomFile
    var scenarios: [ModelRoomEvaluatedScenario]
    var relationships: [ModelRoomRelationship]

    mutating func prepareCharts() {
        let series = scenarios.reduce(0) { $0 + ($1.result?.frames.first?.values.count ?? 0) }
        let limit = min(512, max(4, 32768 / max(1, series)))
        for index in scenarios.indices {
            guard var result = scenarios[index].result, let first = result.frames.first else { continue }
            for id in first.values.keys { result.chartFrames[id] = modelRoomChartSamples(result.frames, quantity: id, limit: limit) }
            scenarios[index].result = result
        }
    }
}

func modelRoomChartSamples(_ frames: [ModelRoomFrame], quantity: String, limit: Int) -> [ModelRoomFrame] {
    let limit = max(4, limit)
    guard frames.count > limit, let first = frames.first, let last = frames.last else { return frames }
    let buckets = (limit - 2) / 2
    var sampled = [first]
    for bucket in 0..<buckets {
        let start = 1 + bucket * (frames.count - 2) / buckets
        let end = 1 + (bucket + 1) * (frames.count - 2) / buckets
        var minimum = start
        var maximum = start
        for index in start..<end {
            if (frames[index].values[quantity] ?? 0) < (frames[minimum].values[quantity] ?? 0) { minimum = index }
            if (frames[index].values[quantity] ?? 0) > (frames[maximum].values[quantity] ?? 0) { maximum = index }
        }
        for index in Set([minimum, maximum]).sorted() { sampled.append(frames[index]) }
    }
    sampled.append(last)
    return sampled
}

enum ModelRoomMode: String, CaseIterable {
    case build = "Build"
    case explore = "Explore"
    case compare = "Compare"
    case present = "Present"
}

struct ModelRoomTablePreview: Codable {
    var headers: [String]
    var preview: [[String]]
    var rowCount: Int
    var sha256: String
}

struct ModelRoomTableSource: Identifiable {
    var url: URL
    var delimiter: String
    var table: ModelRoomTablePreview
    var id: String { url.path + ":" + delimiter + ":" + table.sha256 }
}
