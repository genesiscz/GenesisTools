export interface DelimitedTable {
    headers: string[];
    rows: string[][];
}

export function parseDelimited({
    source,
    delimiter = ",",
    maxRows = 10000,
}: {
    source: string;
    delimiter?: "," | ";" | "\t";
    maxRows?: number;
}): DelimitedTable {
    if (source.length > 16 * 1024 * 1024 || !Number.isInteger(maxRows) || maxRows < 1 || maxRows > 100000) {
        throw new Error("The table exceeds its supported input size or row limit.");
    }

    const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
    const records: string[][] = [];
    let record: string[] = [];
    let field = "";
    let quoted = false;
    let closedQuote = false;
    const pushField = () => {
        record.push(field);
        field = "";
        closedQuote = false;

        if (record.length > 256) {
            throw new Error("A table may contain at most 256 columns.");
        }
    };
    const pushRecord = () => {
        pushField();

        if (record.length > 1 || record.some((value) => value.trim() !== "")) {
            records.push(record);
        }

        record = [];

        if (records.length > maxRows + 1) {
            throw new Error(`A table may contain at most ${maxRows} data rows.`);
        }
    };
    for (let index = 0; index < text.length; index++) {
        const char = text[index];

        if (quoted) {
            if (char === '"') {
                if (text[index + 1] === '"') {
                    field += '"';
                    index++;
                } else {
                    quoted = false;
                    closedQuote = true;
                }
            } else {
                field += char;
            }
        } else if (char === delimiter) {
            pushField();
        } else if (char === "\r" || char === "\n") {
            pushRecord();

            if (char === "\r" && text[index + 1] === "\n") {
                index++;
            }
        } else if (char === '"' && field === "" && !closedQuote) {
            quoted = true;
        } else if (closedQuote || char === '"') {
            throw new Error(`Unexpected character after a quoted field near character ${index + 1}.`);
        } else {
            field += char;
        }

        if (field.length > 65536) {
            throw new Error("A table cell may not exceed 65536 characters.");
        }
    }

    if (quoted) {
        throw new Error("The table ends inside a quoted field.");
    }

    if (field !== "" || record.length > 0 || closedQuote) {
        pushRecord();
    }

    const headers = records.shift()?.map((header) => header.trim()) ?? [];

    if (headers.length === 0 || headers.some((header) => !header) || new Set(headers).size !== headers.length) {
        throw new Error("The first row must contain unique, nonempty column names.");
    }

    const badRow = records.findIndex((row) => row.length !== headers.length);

    if (badRow !== -1) {
        throw new Error(`Data row ${badRow + 1} has ${records[badRow].length} cells; expected ${headers.length}.`);
    }

    return { headers, rows: records };
}
