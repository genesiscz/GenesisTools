import Foundation

@main
enum RouterCli {
    static func main() {
        let args = Array(CommandLine.arguments.dropFirst())
        guard args.count == 2 else {
            FileHandle.standardError.write(Data("usage: router-cli <config.json> <url>\n".utf8))
            exit(2)
        }
        do {
            let data = try Data(contentsOf: URL(fileURLWithPath: args[0]))
            let decision = try routeURL(args[1], configData: data)
            print(try decisionJSON(decision))
        } catch {
            FileHandle.standardError.write(Data("\(error)\n".utf8))
            exit(1)
        }
    }
}
