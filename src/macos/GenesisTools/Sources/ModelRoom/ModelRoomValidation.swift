import Foundation

enum ModelRoomLimits {
    static let maximumPosition = 8192.0
    static let maximumQuantities = 256

    static func position(for index: Int) -> ModelRoomPoint {
        ModelRoomPoint(x: 40 + Double(index % 12) * 240, y: 40 + Double(index / 12) * 160)
    }
}

extension ModelRoomFile {
    func validateForEditing() throws {
        func require(_ condition: Bool, _ message: String) throws {
            if !condition { throw NSError(domain: "ModelRoom", code: 7, userInfo: [NSLocalizedDescriptionKey: message]) }
        }
        func text(_ value: String, maximum: Int, nonempty: Bool = false) throws {
            try require(value.utf16.count <= maximum && (!nonempty || !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty), "A document text field is empty or exceeds its supported length.")
        }
        func identifier(_ value: String) throws {
            let reserved: Set<String> = ["time", "step", "min", "max", "abs", "clamp", "lag", "__proto__", "constructor", "prototype"]
            try require(value.range(of: "^[A-Za-z_][A-Za-z_0-9]{0,63}$", options: .regularExpression) != nil && !reserved.contains(value), "Invalid or reserved identifier: \(value.prefix(80))")
        }
        func unique(_ values: [String]) throws {
            try require(Set(values).count == values.count, "Document identifiers must be unique within their collection.")
            for value in values { try identifier(value) }
        }
        func quantity(_ item: ModelRoomQuantity) throws {
            try identifier(item.id)
            try text(item.label, maximum: 160, nonempty: true)
            try text(item.unit, maximum: 256)
            try text(item.description, maximum: 8000)
            try require(["assumption", "identity", "measured", "estimate"].contains(item.provenance), "Unknown quantity provenance.")
            try require(item.position.x.isFinite && item.position.y.isFinite && (0...ModelRoomLimits.maximumPosition).contains(item.position.x) && (0...ModelRoomLimits.maximumPosition).contains(item.position.y), "Board positions must be between 0 and 8192 points.")
            for number in [item.value, item.initial, item.seed, item.min, item.max].compactMap({ $0 }) {
                try require(number.isFinite, "Quantity values must be finite.")
            }
            if let range = item.range {
                let span = range.max - range.min
                try require(range.min.isFinite && range.max.isFinite && span.isFinite && span > 0 && range.step.isFinite && range.step > 0 && (span / range.step).isFinite, "An input range needs finite increasing endpoints and a positive representable step.")
            }
            switch item.kind {
            case "input": try require(item.value != nil, "An assumption needs a value.")
            case "formula":
                try require(item.expression != nil, "A formula needs an expression.")
                try text(item.expression ?? "", maximum: 4096, nonempty: true)
            case "stock":
                try require(item.initial != nil && item.derivative != nil, "A stock needs its initial value and rate expression.")
                try text(item.derivative ?? "", maximum: 4096, nonempty: true)
                if let lower = item.min, let upper = item.max { try require(lower <= upper, "Stock limits are inverted.") }
            case "data":
                guard let points = item.points else { try require(false, "An observation quantity needs data."); return }
                try require(!points.isEmpty && points.count <= 10000, "An observation quantity supports 1 to 10000 points.")
                var prior = -Double.infinity
                for point in points {
                    try require(point.time.isFinite && point.time >= 0 && point.time > prior && point.value.isFinite, "Observation times must be finite, nonnegative and strictly increasing.")
                    prior = point.time
                }
                try require(item.interpolation == "hold" || item.interpolation == "linear", "Unknown observation interpolation.")
                try text(item.source ?? "", maximum: 8000)
            default: try require(false, "Unknown quantity kind: \(item.kind.prefix(80))")
            }
        }
        func values(_ entries: [String: Double]) throws {
            try require(entries.count <= ModelRoomLimits.maximumQuantities, "Too many changed assumptions.")
            for (key, value) in entries { try identifier(key); try require(value.isFinite, "Assumptions must be finite.") }
        }
        try require(format == "genesis-model-room" && version == 1, "This is not a supported Model Room document.")
        try identifier(id)
        try text(title, maximum: 160, nonempty: true)
        try text(description, maximum: 32000)
        try text(time.unit, maximum: 256, nonempty: true)
        let ratio = time.duration / time.step
        try require(time.duration.isFinite && time.duration > 0 && time.step.isFinite && time.step > 0 && ratio.isFinite && (1...10000).contains(ratio.rounded()) && abs(ratio.rounded() * time.step - time.duration) <= time.duration * 1e-10, "Choose a duration that is an exact multiple of its step, with 1 to 10000 steps.")
        try require(!quantities.isEmpty && quantities.count <= ModelRoomLimits.maximumQuantities && scenarios.count <= 32 && subsystems.count <= 64, "This document exceeds the supported quantity, scenario or subsystem count.")
        try unique(quantities.map(\.id)); try unique(scenarios.map(\.id)); try unique(subsystems.map(\.id))
        for item in quantities { try quantity(item) }
        var totalQuantities = quantities.count
        for scenario in scenarios {
            try text(scenario.label, maximum: 160, nonempty: true)
            try text(scenario.description, maximum: 8000)
            try require(scenario.color.range(of: "^#[0-9a-fA-F]{6}$", options: .regularExpression) != nil, "A scenario color must be a six-digit hex color.")
            try require(scenario.interventions.count <= 256 && scenario.replacements.count <= 256 && scenario.removed.count <= 256, "A scenario exceeds its edit limits.")
            try unique(scenario.replacements.map(\.id)); try unique(scenario.removed)
            try values(scenario.overrides)
            for item in scenario.replacements { try quantity(item) }
            for intervention in scenario.interventions {
                try require(intervention.at.isFinite && intervention.at >= 0 && intervention.at <= time.duration, "An intervention is outside the model time range.")
                try text(intervention.label, maximum: 160, nonempty: true)
                try values(intervention.values)
            }
            var ids = Set(quantities.map(\.id))
            ids.formUnion(scenario.replacements.map(\.id)); ids.subtract(scenario.removed)
            try require(ids.count <= ModelRoomLimits.maximumQuantities, "A scenario exceeds 256 quantities.")
            totalQuantities += ids.count
        }
        try require((ratio.rounded() + 1) * Double(totalQuantities) <= 2_000_000, "The scenario comparison exceeds two million result values.")
        for subsystem in subsystems {
            try text(subsystem.label, maximum: 160, nonempty: true)
            try text(subsystem.description, maximum: 8000)
            try require(!subsystem.quantities.isEmpty && subsystem.quantities.count <= 256, "A subsystem supports 1 to 256 references.")
            try unique(subsystem.quantities)
        }
        try require(presentation.controls.count <= 32 && presentation.outputs.count <= 32 && presentation.steps.count <= 64, "The presentation exceeds its supported control, output or step count.")
        try unique(presentation.controls); try unique(presentation.outputs)
        for step in presentation.steps {
            try text(step.title, maximum: 160, nonempty: true)
            try text(step.text, maximum: 8000)
            if let scenario = step.scenario { try require(scenarios.contains { $0.id == scenario }, "A presentation step names an unknown scenario.") }
            if let at = step.time { try require(at.isFinite && at >= 0 && at <= time.duration, "A presentation step is outside the model time range.") }
        }
    }
}
