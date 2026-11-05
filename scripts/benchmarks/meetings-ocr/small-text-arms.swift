// Vision OCR arms for the small-text bench (`small-text.ts`): one long-lived process that reads one JSON job per stdin
// line and prints one JSON answer per job, so every arm pays the same warm-up and the bench can interleave arms.
//
// A job: { id, path, level: "accurate" | "fast", correction, languages, minimumTextHeight?, regions? }. `regions` are
// normalized boxes with a top-left origin ([x, y, width, height]); each is read by its own request with that region of
// interest, which Vision crops before it reads. No `regions` reads the whole image. Every job opens the image again,
// as darwinkit does for each call.
//
// The answer: { id, cpuMs, wallMs, lines: [{ text, x, y, width, height }] }, the boxes normalized to the whole image
// with a top-left origin. cpuMs is this process's user + system CPU over the job (getrusage), Vision's threads
// included. The first line on start is { ready, defaultMinimumTextHeight, revision }.
//
// Build once (the bench does it): swiftc -O small-text-arms.swift -o <scratch>/small-text-arms
import Foundation
import Vision

struct Job: Decodable {
    let id: Int
    let path: String
    let level: String
    let correction: Bool
    let languages: [String]
    let minimumTextHeight: Float?
    let regions: [[Double]]?
}

struct Line: Encodable {
    let text: String
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct Answer: Encodable {
    let id: Int
    let cpuMs: Double
    let wallMs: Double
    let lines: [Line]
    let error: String?
}

struct Ready: Encodable {
    let ready: Bool
    let defaultMinimumTextHeight: Float
    let revision: Int
}

func cpuMs() -> Double {
    var usage = rusage()
    getrusage(RUSAGE_SELF, &usage)
    let user = Double(usage.ru_utime.tv_sec) * 1000 + Double(usage.ru_utime.tv_usec) / 1000
    let system = Double(usage.ru_stime.tv_sec) * 1000 + Double(usage.ru_stime.tv_usec) / 1000
    return user + system
}

func request(for job: Job, region: CGRect?) -> VNRecognizeTextRequest {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = job.level == "fast" ? .fast : .accurate
    request.usesLanguageCorrection = job.correction
    request.recognitionLanguages = job.languages

    if let height = job.minimumTextHeight {
        request.minimumTextHeight = height
    }

    if let region {
        request.regionOfInterest = region
    }

    return request
}

func run(_ job: Job) -> Answer {
    // Top-left boxes from the bench become Vision's bottom-left regions of interest.
    let regions: [CGRect?] = job.regions.map { boxes in
        boxes.map { box in CGRect(x: box[0], y: 1 - box[1] - box[3], width: box[2], height: box[3]) }
    } ?? [nil]
    let requests = regions.map { request(for: job, region: $0) }
    let cpuBefore = cpuMs()
    let wallBefore = Date()
    var failure: String?

    do {
        try VNImageRequestHandler(url: URL(fileURLWithPath: job.path), options: [:]).perform(requests)
    } catch {
        failure = error.localizedDescription
    }

    let cpu = cpuMs() - cpuBefore
    let wall = Date().timeIntervalSince(wallBefore) * 1000
    var lines: [Line] = []

    for (request, region) in zip(requests, regions) {
        let frame = region ?? CGRect(x: 0, y: 0, width: 1, height: 1)

        for observation in request.results ?? [] {
            guard let text = observation.topCandidates(1).first?.string else {
                continue
            }

            let box = observation.boundingBox
            let bottom = frame.minY + box.minY * frame.height
            let height = box.height * frame.height
            lines.append(Line(
                text: text,
                x: frame.minX + box.minX * frame.width,
                y: 1 - bottom - height,
                width: box.width * frame.width,
                height: height
            ))
        }
    }

    return Answer(id: job.id, cpuMs: cpu, wallMs: wall, lines: lines, error: failure)
}

let encoder = JSONEncoder()
let decoder = JSONDecoder()

func emit<T: Encodable>(_ value: T) {
    if let data = try? encoder.encode(value), let line = String(data: data, encoding: .utf8) {
        print(line)
        fflush(stdout)
    }
}

let probe = VNRecognizeTextRequest()
emit(Ready(ready: true, defaultMinimumTextHeight: probe.minimumTextHeight, revision: probe.revision))

while let line = readLine() {
    guard let data = line.data(using: .utf8), let job = try? decoder.decode(Job.self, from: data) else {
        FileHandle.standardError.write("small-text-arms: a job that is not JSON\n".data(using: .utf8)!)
        continue
    }

    emit(run(job))
}
