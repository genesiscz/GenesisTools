// cloudctl.js: the cloudctl helper without a compiler, for Macs that have no swiftc (no Xcode or Command Line
// Tools). The same verbs, output and refusal rule as cloudctl.swift, through osascript's JavaScript-to-Objective-C
// bridge, which ships with every macOS:
//
//   osascript -l JavaScript cloudctl.js status < paths
//   osascript -l JavaScript cloudctl.js evict  < paths
//
// Paths come on stdin, NUL-separated. The result is returned from run(), which osascript prints on stdout
// (console.log would go to stderr). Reading these resource values never reads file contents, so it cannot
// download anything; eviction removes the LOCAL copy only, after the state is read again here.

ObjC.import("Foundation");

const KEYS = {
    ubiquitous: $.NSURLIsUbiquitousItemKey,
    uploaded: $.NSURLUbiquitousItemIsUploadedKey,
    uploading: $.NSURLUbiquitousItemIsUploadingKey,
    uploadError: $.NSURLUbiquitousItemUploadingErrorKey,
    downloading: $.NSURLUbiquitousItemDownloadingStatusKey,
};

const DOWNLOADING = [
    [$.NSURLUbiquitousItemDownloadingStatusCurrent, "current"],
    [$.NSURLUbiquitousItemDownloadingStatusDownloaded, "downloaded"],
    [$.NSURLUbiquitousItemDownloadingStatusNotDownloaded, "notDownloaded"],
];

function errorText(ref, fallback) {
    const error = ref[0];
    return error && !error.isNil() ? ObjC.unwrap(error.localizedDescription) : fallback;
}

/** Every key in one call, as cloudctl.swift does: read one at a time, NSURL leaves the upload error out. */
function values(url) {
    const error = Ref();
    // A JS array does not bridge to the key array (NSURL then answers with an empty dictionary).
    const keys = $.NSMutableArray.array;
    for (const key of Object.values(KEYS)) {
        keys.addObject(key);
    }

    const found = url.resourceValuesForKeysError(keys, error);
    if (!found || found.isNil()) {
        throw new Error(errorText(error, "the item could not be read"));
    }

    return (key) => {
        const item = found.objectForKey(key);
        return item && !item.isNil() ? item : undefined;
    };
}

function flag(item) {
    return item ? ObjC.unwrap(item) === true || ObjC.unwrap(item) === 1 : false;
}

function status(path) {
    const result = { path };
    // A fresh URL each time: NSURL caches resource values per instance.
    const url = $.NSURL.fileURLWithPath(path);
    try {
        const read = values(url);
        result.ubiquitous = flag(read(KEYS.ubiquitous));
        result.uploaded = flag(read(KEYS.uploaded));
        result.uploading = flag(read(KEYS.uploading));
        const uploadError = read(KEYS.uploadError);
        if (uploadError) {
            result.uploadError = ObjC.unwrap(uploadError.localizedDescription);
        }

        const downloading = read(KEYS.downloading);
        if (downloading) {
            const raw = ObjC.unwrap(downloading);
            const named = DOWNLOADING.find(([constant]) => ObjC.unwrap(constant) === raw);
            result.downloading = named ? named[1] : raw;
        }
    } catch (error) {
        result.error = String(error.message || error);
    }

    return result;
}

/** The same rule as judgeEviction in evict.ts and refusal() in cloudctl.swift. */
function refusal(s) {
    if (s.error) {
        return `status unknown: ${s.error}`;
    }

    if (s.ubiquitous !== true) {
        return "not an iCloud item";
    }

    if (s.uploading === true) {
        return "upload in progress";
    }

    if (s.uploadError) {
        return `upload error: ${s.uploadError}`;
    }

    if (s.uploaded !== true) {
        return "not uploaded yet";
    }

    if (s.downloading !== "current") {
        return "local copy is not the current version";
    }

    return null;
}

function line(value) {
    // biome-ignore lint/style/noRestrictedGlobals: osascript runs this file, where SafeJSON cannot be loaded
    return JSON.stringify(value);
}

// biome-ignore lint/correctness/noUnusedVariables: osascript calls run() with the arguments
function run(argv) {
    const verb = argv[0];
    if (argv.length !== 1 || (verb !== "status" && verb !== "evict")) {
        throw new Error("usage: osascript -l JavaScript cloudctl.js status|evict < NUL-separated paths");
    }

    const data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
    const text = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)) || "";
    const lines = [];
    for (const path of text.split("\0").filter((p) => p.length > 0)) {
        const s = status(path);
        if (verb === "status") {
            lines.push(line(s));
            continue;
        }

        const why = refusal(s);
        if (why) {
            lines.push(line({ path, evicted: false, reason: why }));
            continue;
        }

        const error = Ref();
        const done = $.NSFileManager.defaultManager.evictUbiquitousItemAtURLError($.NSURL.fileURLWithPath(path), error);
        lines.push(
            line(done ? { path, evicted: true } : { path, evicted: false, reason: errorText(error, "evict failed") })
        );
    }

    return lines.join("\n");
}
