import * as watchman from "fb-watchman";
import readline from "readline";

const client = new watchman.Client();

// Mapping of project names to directories
const Directories: Map<string, string> = new Map<string, string>([
	["col-fe", "/Users/Martin/Tresors/Projects/CEZ/col-fe/"],
	["col-fe2", "/Users/Martin/Tresors/Projects/CEZ/col-fe2/"],
	["col-fe-native-upgrade", "/Users/Martin/Tresors/Projects/CEZ/col-fe-native-upgrade/"],
	["ReservineBack", "/Users/Martin/Tresors/Projects/ReservineBack"],
]);

// Get directory of interest based on input argument
let dirOfInterest = Directories.get(process.argv[2]);
if (!dirOfInterest) {
	console.error("Invalid project name provided:", process.argv[2]);
	console.log("Error provide one of ", Array.from(Directories.keys()).join("\n - "));
	console.error("Or just give the path to the dir");
	dirOfInterest = process.argv[2];
	if (dirOfInterest.startsWith(".") || dirOfInterest.startsWith("/")) {

	} else {
		console.error("Invalid project name provided:", process.argv[2]);
		console.log("Error provide one of ", Array.from(Directories.keys()).join("\n - "));
		console.error("Or just give the path to the dir");
		process.exit(1);
	}
}

console.log("Directory of interest:", dirOfInterest, "based on input", process.argv[2]);

// `makeSubscription` function declaration
function makeSubscription(client: watchman.Client, watch: string, relativePath: string | undefined): void {
	const subscription: Record<string, unknown> = {
		// Match all files
		expression: ["allof", ["type", "f"]],
		// Interested fields
		fields: ["name", "size", "mtime_ms", "exists", "type"],
	};

	if (relativePath) {
		subscription["relative_root"] = relativePath;
	}

	client.command(["subscribe", watch, "mysubscription", subscription], (error, resp) => {
		if (error) {
			console.error("Failed to subscribe:", error);
			return;
		}
		console.log("Subscription", resp.subscribe, "established");
	});

	// Listen to subscription events
	client.on("subscription", (resp: any) => {
		if (resp.subscription !== "mysubscription") return;

		resp.files.forEach((file: any) => {
			const mtimeMs = +file.mtime_ms; // Convert Int64 to a JavaScript number
			console.log("File changed:", file.name, new Date(mtimeMs).toLocaleTimeString());
		});
	});
}

// Capability check and watch initialization
client.capabilityCheck({ optional: [], required: ["relative_root"] }, (capabilityError, capabilityResp) => {
	if (capabilityError) {
		console.error("Capability check failed:", capabilityError);
		client.end();
		return;
	}

	client.command(["watch-project", dirOfInterest], (watchError, watchResp: any) => {
		if (watchError) {
			console.error("Error initiating watch:", watchError);
			client.end();
			return;
		}

		if ("warning" in watchResp) {
			console.warn("Warning:", watchResp.warning);
		}

		console.log("Watch established on", watchResp.watch, "relative_path:", watchResp.relative_path);
		makeSubscription(client, watchResp.watch, watchResp.relative_path);
	});
});

function askQuestion(query: string): Promise<string> {
	console.log(""); // Add a new line
	const readline = require("readline");
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	return new Promise((resolve) => {
		rl.question(query, (answer: string) => {
			rl.close();
			resolve(answer);
		});
	});
}
