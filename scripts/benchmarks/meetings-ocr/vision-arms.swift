// Vision OCR of each image with language correction on and off, the arms interleaved per image (on, off, then off, on
// for the next image). Prints one JSON line per image and arm: { path, arm, cpuMs, wallMs, text }.
// cpuMs is this process's user + system CPU over the request (getrusage), which includes Vision's own threads.
//
// Build once (the bench does it): swiftc -O vision-arms.swift -o <scratch>/vision-arms
// Run: vision-arms <language,language> <image>...
import Foundation
import Vision

func cpuMs() -> Double {
    var usage = rusage()
    getrusage(RUSAGE_SELF, &usage)
    let user = Double(usage.ru_utime.tv_sec) * 1000 + Double(usage.ru_utime.tv_usec) / 1000
    let system = Double(usage.ru_stime.tv_sec) * 1000 + Double(usage.ru_stime.tv_usec) / 1000
    return user + system
}

func read(_ url: URL, languages: [String], correction: Bool) throws -> (text: String, cpu: Double, wall: Double) {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = correction
    request.recognitionLanguages = languages
    let cpuBefore = cpuMs()
    let wallBefore = Date()
    let handler = VNImageRequestHandler(url: url, options: [:])
    try handler.perform([request])
    let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
    return (lines.joined(separator: "\n"), cpuMs() - cpuBefore, Date().timeIntervalSince(wallBefore) * 1000)
}

let args = CommandLine.arguments.dropFirst()
guard let languageArg = args.first else {
    FileHandle.standardError.write("usage: vision-arms <languages> <image>...\n".data(using: .utf8)!)
    exit(2)
}

let languages = languageArg.split(separator: ",").map(String.init)
let encoder = JSONEncoder()

for (index, path) in args.dropFirst().enumerated() {
    let url = URL(fileURLWithPath: path)
    let order = index % 2 == 0 ? [true, false] : [false, true]

    for correction in order {
        let result = try read(url, languages: languages, correction: correction)
        let row: [String: String] = [
            "path": path,
            "arm": correction ? "on" : "off",
            "cpuMs": String(format: "%.1f", result.cpu),
            "wallMs": String(format: "%.1f", result.wall),
            "text": result.text,
        ]
        if let data = try? encoder.encode(row), let line = String(data: data, encoding: .utf8) {
            print(line)
        }
    }
}
