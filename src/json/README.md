# json - JSON/TOON Converter Tool

Convert data between JSON and TOON (Token-Oriented Object Notation) formats. TOON is a compact, schema-aware format that can reduce token usage by 30-60% compared to standard JSON, making it ideal for LLM applications where token costs matter.

## Features

-   ✅ **Auto-Detection**: Automatically detects JSON or TOON format
-   ✅ **Bidirectional Conversion**: Convert JSON ↔ TOON seamlessly
-   ✅ **Size Comparison**: Compares TOON with compact JSON and returns the smaller format
-   ✅ **File & Stdin Support**: Works with files or piped input
-   ✅ **Verbose Mode**: Shows format detection, size comparison, and savings statistics
-   ✅ **Error Handling**: Clear, LLM-readable error messages

## CLI Usage

### Basic Examples

```bash
# Auto-detect format and convert (file)
tools json data.json
tools json data.toon

# Auto-detect format and convert (stdin)
cat data.json | tools json
echo '{"key":"value"}' | tools json

# Force conversion to TOON
tools json data.json --to-toon
cat data.json | tools json --to-toon

# Force conversion to JSON
tools json data.toon --to-json
cat data.toon | tools json --to-json

# Verbose mode (shows statistics)
tools json data.json --verbose
```

### Options

```bash
--to-toon, -t    # Force conversion to TOON format
--to-json, -j    # Force conversion to JSON format
--verbose, -v    # Enable verbose logging (shows format detection, size comparison, etc.)
--help, -h       # Show help message
```

## How It Works

### Auto-Detection Mode

When no format flags are provided, the tool:

1. **Detects Input Format**: Tries to parse as JSON first, then TOON
2. **Converts Automatically**: Converts to the opposite format
3. **Size Comparison** (JSON → TOON only): Compares TOON output with compact JSON and returns the smaller format

### Forced Conversion Mode

When `--to-toon` or `--to-json` is specified:

-   **Validates Input**: Ensures input is in the correct format
-   **Error Handling**: Provides clear error messages if format doesn't match
-   **Returns Result**: Outputs the converted format

### Size Comparison

When converting JSON to TOON, the tool:

1. Converts to TOON format
2. Creates compact JSON (no whitespace)
3. Compares byte sizes
4. Returns the smaller format automatically
5. Logs statistics in verbose mode

## Examples

### Example 1: JSON to TOON

**Input (JSON):**

```json
{
    "users": [
        { "id": 1, "name": "Alice", "role": "admin" },
        { "id": 2, "name": "Bob", "role": "user" }
    ]
}
```

**Output (TOON):**

```
users[2]{id,name,role}:
  1,Alice,admin
  2,Bob,user
```

### Example 2: TOON to JSON

**Input (TOON):**

```
users[2]{id,name,role}:
  1,Alice,admin
  2,Bob,user
```

**Output (JSON):**

```json
{
    "users": [
        { "id": 1, "name": "Alice", "role": "admin" },
        { "id": 2, "name": "Bob", "role": "user" }
    ]
}
```

### Example 3: Verbose Mode

```bash
$ tools json data.json --verbose
Detected format: JSON
Compact JSON size: 86 bytes
TOON size: 52 bytes
✓ TOON is 39.5% smaller (34 bytes saved)
Returning TOON format
users[2]{id,name,role}:
  1,Alice,admin
  2,Bob,user
```

## Error Handling

The tool provides clear, LLM-readable error messages:

-   **Format Mismatch**: `"Error: Input is already in TOON format. Use --to-json to convert to JSON..."`
-   **Invalid Input**: `"Error: Input is neither valid JSON nor TOON format..."`
-   **File Not Found**: `"Error: File not found: /path/to/file"`

## Use Cases

### For LLM Applications

1. **Before Sending Data**: Convert JSON to TOON to reduce token usage

    ```bash
    cat data.json | tools json > data.toon
    ```

2. **After Receiving Data**: Convert TOON responses back to JSON

    ```bash
    cat response.toon | tools json --to-json > response.json
    ```

3. **In Pipelines**: Automatically optimize data format
    ```bash
    curl -s https://api.example.com/data.json | tools json | llm-process
    ```

### For Development

1. **Format Comparison**: See which format is more compact

    ```bash
    tools json large-data.json --verbose
    ```

2. **Data Transformation**: Convert between formats for different tools
    ```bash
    tools json config.json --to-toon > config.toon
    ```

## Best Practices

1. **Use TOON for**: Flat data structures, uniform arrays, tabular data, lists of records
2. **Use JSON for**: Deeply nested structures, irregular data, when human readability is more important
3. **Always Compare**: The tool automatically compares sizes and returns the optimal format
4. **Check Verbose Output**: Use `--verbose` to understand why a particular format was chosen

## Technical Details

### Format Detection

The tool uses a two-step detection process:

1. **JSON Detection**: Attempts `JSON.parse()` - if successful, input is JSON
2. **TOON Detection**: Attempts `decode()` from `@toon-format/toon` - if successful, input is TOON
3. **Unknown**: If both fail, returns error

### Size Calculation

-   Uses `Buffer.byteLength()` for accurate UTF-8 byte counting
-   Compares TOON output against compact JSON (no whitespace)
-   Returns the format with fewer bytes

### Output Handling

-   **Result**: Always output to stdout (for piping)
-   **Verbose Info**: Output to stderr (doesn't interfere with piping)
-   **Errors**: Output to stderr with clear messages

## Dependencies

-   `@toon-format/toon`: Official TOON format library for encoding/decoding
-   `commander`: Command-line argument parsing

## Related Tools

-   `files-to-prompt`: Convert files to AI-friendly formats
-   `collect-files-for-ai`: Aggregate project files for AI analysis

## References

-   TOON Format Guide: https://toonformat.dev/guide/llm-prompts
-   Official TOON Repository: https://github.com/toon-format/toon



