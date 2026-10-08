import AppKit
import GenesisKit

private struct RecastCapturedLine: Sendable {
    var text: String
    var region: RecastRegion
    var alternatives: [String]
}

extension RecastModel {
    func extractSelection(intoField: Bool, createRows: Bool = true, openProposal: Bool = true) {
        guard let source, let data = assets[source.assetName], let collection else { return }
        guard ["image", "pdf", "text"].contains(source.kind) else {
            error = "Choose an image, PDF, or text source to extract."
            return
        }
        if intoField && (record == nil || field == nil) { error = "Select the field that should receive this reading."; return }
        let selectedRecordID = selectedRecord
        let selectedField = field
        let previousCell = cell
        let requestedPage = page
        let region = selectedRegion ?? NativeSourceRect(x: 0, y: 0, width: 1, height: 1)
        let text = sourceText
        let offset = sourceTextOffset
        let selection = textSelection
        perform(intoField ? "Reading into selected field" : createRows ? "Extracting proposed rows" : "Reading source regions") { model in
            let selected = source.kind == "text" ?
                try Self.captureText(text, offset: offset, selection: selection, split: false).first?.region :
                RecastRegion.rectangle(region, page: requestedPage)
            guard let selected else { throw recastError("Choose source material to interpret.") }
            _ = try await model.checkpointForInference(anchor: RecastAnchor(id: recastID("anchor"), sourceId: source.id,
                sourceHash: source.contentHash, label: "Selected for interpretation", region: selected))
            let lines: [RecastCapturedLine]
            let method: String
            let engine: String
            if source.kind == "text" {
                let result = try await Task.detached(priority: .userInitiated) {
                    try Self.captureText(text, offset: offset, selection: selection, split: !intoField)
                }.value
                lines = result; method = "manual"; engine = "Selected source text"
            } else {
                let extraction = try await NativeSourceReader.shared.extract(data: data, kind: source.kind, page: requestedPage, region: region)
                method = extraction.method; engine = extraction.engine
                if intoField {
                    let text = extraction.blocks.map(\.text).joined(separator: "\n")
                    lines = text.isEmpty ? [] : [RecastCapturedLine(text: text,
                        region: .rectangle(region, page: requestedPage), alternatives: [])]
                } else {
                    lines = extraction.blocks.compactMap { block in
                        guard let bounds = block.bounds else { return nil }
                        return RecastCapturedLine(text: block.text, region: .rectangle(bounds, page: requestedPage),
                            alternatives: block.alternatives)
                    }
                }
            }
            try Task.checkCancellation()
            guard !lines.isEmpty else { throw recastError("No text was found in the selected area. Try a different region.") }
            guard lines.count <= 1000, lines.allSatisfy({ $0.text.utf16.count <= 32000 }) else {
                throw recastError("Choose a smaller selection: at most 1,000 readings of 32,000 characters each.")
            }
            let fingerprints: [String]
            if ["image", "pdf"].contains(source.kind) {
                let preview = try await NativeSourceReader.shared.preview(data: data, kind: source.kind, page: requestedPage)
                fingerprints = try await NativeSourceReader.shared.regionFingerprints(preview: preview, regions: lines.compactMap { $0.region.rectangle })
                guard fingerprints.count == lines.count else { throw recastError("A source region lost its comparison bounds.") }
            } else { fingerprints = [] }
            var anchors = [RecastAnchor]()
            var readings = [RecastReading]()
            var records = [RecastRecord]()
            for (index, line) in lines.enumerated() {
                let anchor = RecastAnchor(id: recastID("anchor"), sourceId: source.id, sourceHash: source.contentHash,
                    label: String(line.text.prefix(80)), region: line.region,
                    fingerprint: fingerprints.isEmpty ? nil : fingerprints[index])
                let reading = RecastReading(id: recastID("reading"), anchorId: anchor.id, text: line.text,
                    alternatives: line.alternatives, method: method, engine: engine, createdAt: recastTimestamp())
                anchors.append(anchor); readings.append(reading)
                if !intoField, createRows, let first = collection.fields.first(where: { $0.type == "text" }) {
                    var cells = Dictionary(uniqueKeysWithValues: collection.fields.map { ($0.id, RecastCell()) })
                    let fits = line.text.utf16.count <= 8000
                    cells[first.id] = RecastCell(value: fits ? .string(line.text) : .null, state: fits ? "proposed" : "unknown", origin: "source",
                        anchorIds: [anchor.id], readingIds: [reading.id],
                        alternatives: line.alternatives.filter { $0.utf16.count <= 8000 }.map { .string($0) },
                        note: fits ? "" : "Reading exceeds the field limit. Review the full literal reading and supply a shorter value.")
                    records.append(RecastRecord(id: recastID("record"), collectionId: collection.id, state: "draft",
                        cells: cells, createdAt: recastTimestamp()))
                }
            }
            var operations = [recastOperation("capture", [
                "anchors": try .encoded(anchors), "readings": try .encoded(readings), "records": try .encoded(records)
            ])]
            if intoField, let field = selectedField, let reading = readings.first, let anchor = anchors.first {
                var cell = previousCell ?? RecastCell()
                let value = Self.interpretedLiteral(reading.text, field: field)
                cell.value = value; cell.state = value.isNull ? "unknown" : "proposed"; cell.origin = "source"
                cell.anchorIds = [anchor.id]; cell.readingIds = [reading.id]
                cell.alternatives = reading.alternatives.filter { $0.utf16.count <= 8000 }.map { .string($0) }
                cell.note = value.isNull ? "The source was read, but its value needs your interpretation." : ""
                operations.append(recastOperation("set-cell", [
                    "recordId": .string(selectedRecordID), "fieldId": .string(field.id),
                    "cell": try .encoded(cell), "reason": .string("Read selected source region")
                ]))
            }
            try await model.apply(operations, title: intoField ? "Read source into field" : "Extract rows")
            if let first = records.first { model.selectedRecord = first.id; model.selectedField = collection.fields.first?.id ?? "" }
            model.selectedAnchor = anchors.first?.id ?? ""
            if !createRows && openProposal {
                model.proposalReadingIDs = readings.count <= 200 ? Set(readings.map(\.id)) : []
                model.proposal = nil; model.showAIProposal = true
            }
            model.notice = intoField ? "Reading added. Review the value before accepting." :
                createRows ? "\(records.count) proposed rows. Review and complete their fields." :
                "\(readings.count) source readings saved for review and comparison."
        }
    }

    private nonisolated static func captureText(_ text: String, offset: Int, selection: NSRange, split: Bool) throws -> [RecastCapturedLine] {
        let ns = text as NSString
        let range = selection.length > 0 ? selection : NSRange(location: 0, length: ns.length)
        guard range.location >= 0, range.length > 0, range.location <= ns.length,
              range.length <= ns.length - range.location else { throw recastError("Select some source text first.") }
        let ranges: [NSRange]
        if split {
            let regex = try NSRegularExpression(pattern: "[^\\r\\n]+")
            ranges = regex.matches(in: text, range: range).map(\.range)
        } else { ranges = [range] }
        return ranges.compactMap { span in
            let quote = ns.substring(with: span)
            guard !quote.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
            let range = Range(span, in: text)
            let before = range.map { String(text[..<$0.lowerBound].suffix(160)) } ?? ""
            let after = range.map { String(text[$0.upperBound...].prefix(160)) } ?? ""
            return RecastCapturedLine(text: quote, region: RecastRegion(kind: "text",
                start: offset + span.location, end: offset + NSMaxRange(span), quote: quote,
                prefix: before.utf16.count <= 160 ? before : "", suffix: after.utf16.count <= 160 ? after : ""), alternatives: [])
        }
    }

    private nonisolated static func interpretedLiteral(_ text: String, field: RecastField) -> RecastJSON {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if field.type == "number" {
            guard let number = Double(clean), number.isFinite else { return .null }
            return .number(number)
        }
        if field.type == "boolean" {
            if clean.lowercased() == "true" { return .bool(true) }
            if clean.lowercased() == "false" { return .bool(false) }
            return .null
        }
        if ["datetime", "date", "timezone"].contains(field.type) { return .null }
        return text.utf16.count <= 8000 ? .string(text) : .null
    }
}
