import minimist from "minimist";
import { basename, dirname, extname, join, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { minimatch } from "minimatch";
import logger from "../logger";
import type { FileSink } from "bun";

// --- Interfaces ---
interface Options {
  paths?: string[];
  extension?: string[];
  includeHidden?: boolean;
  ignoreFilesOnly?: boolean;
  ignoreGitignore?: boolean;
  ignore?: string[];
  output?: string;
  cxml?: boolean;
  markdown?: boolean;
  lineNumbers?: boolean;
  null?: boolean;
  help?: boolean;
  version?: boolean;
  // Aliases
  e?: string[];
  o?: string;
  c?: boolean;
  m?: boolean;
  n?: boolean;
  h?: boolean;
  0?: boolean;
}

interface Args extends Options {
  _: string[]; // Positional arguments
}

// --- Constants ---
let globalIndex = 1; // Used for XML index numbering

const EXT_TO_LANG: Record<string, string> = {
  py: "python",
  c: "c",
  cpp: "cpp",
  java: "java",
  js: "javascript",
  ts: "typescript",
  html: "html",
  css: "css",
  xml: "xml",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  sh: "bash",
  rb: "ruby",
};

// --- Helper Functions ---
function shouldIgnore(path: string, gitignoreRules: string[]): boolean {
  const baseFile = basename(path);
  // Check file match
  if (gitignoreRules.some(rule => minimatch(baseFile, rule, { dot: true }))) {
    return true;
  }
  // Check directory match (ensure it ends with / for directory-specific rules)
  try {
      if (statSync(path).isDirectory() && gitignoreRules.some(rule => minimatch(baseFile + '/', rule, { dot: true }))) {
        return true;
      }
  } catch (e) {
      // ignore stat errors if path disappears?
  }
  return false;
}

async function readGitignore(path: string): Promise<string[]> {
  const gitignorePath = join(path, ".gitignore");
  if (existsSync(gitignorePath)) {
    try {
      const content = await readFile(gitignorePath, { encoding: "utf-8" });
      return content
        .split("\n")
        .map(line => line.trim())
        .filter(line => line && !line.startsWith("#"));
    } catch (error) {
      logger.warn(`Could not read .gitignore at ${gitignorePath}: ${error}`);
      return [];
    }
  }
  return [];
}

function addLineNumbers(content: string): string {
  const lines = content.split("\n");
  const padding = String(lines.length).length;
  return lines
    .map((line, i) => `${String(i + 1).padStart(padding)}  ${line}`)
    .join("\n");
}

type WriterFunc = (s: string) => void;

function printPath(
  writer: WriterFunc,
  path: string,
  content: string,
  cxml: boolean,
  markdown: boolean,
  lineNumbers: boolean
): void {
  if (cxml) {
    printAsXml(writer, path, content, lineNumbers);
  } else if (markdown) {
    printAsMarkdown(writer, path, content, lineNumbers);
  } else {
    printDefault(writer, path, content, lineNumbers);
  }
}

function printDefault(
  writer: WriterFunc, 
  path: string, 
  content: string, 
  lineNumbers: boolean
): void {
  writer(path);
  writer("---");
  if (lineNumbers) {
    content = addLineNumbers(content);
  }
  writer(content);
  writer("");
  writer("---");
}

function printAsXml(
  writer: WriterFunc, 
  path: string, 
  content: string, 
  lineNumbers: boolean
): void {
  writer(`<document index="${globalIndex}">`);
  writer(`<source>${path}</source>`);
  writer("<document_content>");
  if (lineNumbers) {
    content = addLineNumbers(content);
  }
  writer(content);
  writer("</document_content>");
  writer("</document>");
  globalIndex += 1;
}

function printAsMarkdown(
  writer: WriterFunc, 
  path: string, 
  content: string, 
  lineNumbers: boolean
): void {
  const ext = extname(path).slice(1); // Remove leading dot
  const lang = EXT_TO_LANG[ext] || "";
  let backticks = "```";
  while (content.includes(backticks)) {
    backticks += "`";
  }
  writer(path);
  writer(`${backticks}${lang}`);
  if (lineNumbers) {
    content = addLineNumbers(content);
  }
  writer(content);
  writer(`${backticks}`);
}

async function processPath(
  path: string,
  extensions: string[],
  includeHidden: boolean,
  ignoreFilesOnly: boolean,
  ignoreGitignore: boolean,
  gitignoreRules: string[], // Rules from parent/initial directory
  ignorePatterns: string[],
  writer: WriterFunc,
  claudeXml: boolean,
  markdown: boolean,
  lineNumbers: boolean
): Promise<void> {
  if (!existsSync(path)) {
    logger.error(`Path does not exist: ${path}`);
    return;
  }

  try {
      const stats = statSync(path);
      
      // Handle file case directly if initial path is a file
      if (stats.isFile()) {
          // Need to apply checks here too for the single-file case
          if (!includeHidden && basename(path).startsWith('.')) return;
          if (!ignoreGitignore && shouldIgnore(path, gitignoreRules)) return;
          if (ignorePatterns.length > 0) {
              const baseName = basename(path);
              const matchesPattern = ignorePatterns.some(pattern => minimatch(baseName, pattern, { dot: true }));
              if (matchesPattern) return; // ignoreFilesOnly doesn't apply here
          }
          const ext = extname(path).slice(1).toLowerCase();
          if (extensions.length > 0 && !extensions.includes(ext)) return;

        try {
          const content = await readFile(path, { encoding: "utf-8" });
          printPath(writer, path, content, claudeXml, markdown, lineNumbers);
        } catch (error) {
          const message = `Warning: Skipping file ${path} due to error: ${error}`;
          logger.error(message);
        }
        return;
      }

      // Handle directory case
      if (stats.isDirectory()) {
          // Initial call to processDirectory starts with the initial gitignoreRules
        await processDirectory(path, gitignoreRules);
      }

  } catch (error: any) {
        logger.error(`Error accessing path ${path}: ${error.message}`);
        return;
  }

  // Renamed original processPath's dir logic to processDirectory
  // Added passedRules parameter
  async function processDirectory(dirPath: string, passedRules: string[]): Promise<void> {
    // Read .gitignore specifically for this directory
    let currentDirGitignoreRules = ignoreGitignore ? [] : await readGitignore(dirPath);
    // Combine passed rules with current dir's rules
    let effectiveGitignoreRules = [...passedRules, ...currentDirGitignoreRules]; 

    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const entryPath = join(dirPath, entry.name);

        // Skip hidden files/directories first (respect includeHidden)
        if (!includeHidden && entry.name.startsWith(".")) {
          continue;
        }

        // Apply gitignore rules if needed
        if (!ignoreGitignore && shouldIgnore(entryPath, effectiveGitignoreRules)) {
          continue;
        }

        // Apply ignore patterns if needed
        if (ignorePatterns.length > 0) {
          const matchesPattern = ignorePatterns.some(pattern =>
            minimatch(entry.name, pattern, { dot: true })
          );
          if (matchesPattern && (entry.isFile() || !ignoreFilesOnly)) {
            continue;
          }
        }

        if (entry.isDirectory()) {
          // Recursively process subdirectory, PASSING DOWN the effective rules
          await processDirectory(entryPath, effectiveGitignoreRules);
        } else if (entry.isFile()) {
          const ext = extname(entry.name).slice(1).toLowerCase();
          if (extensions.length > 0 && !extensions.includes(ext)) {
             continue;
          }
          try {
            const content = await readFile(entryPath, { encoding: "utf-8" });
            printPath(writer, entryPath, content, claudeXml, markdown, lineNumbers);
          } catch (error) {
            const message = `Warning: Skipping file ${entryPath} due to error: ${error}`;
            logger.error(message);
          }
        }
      }
    } catch (error: any) {
       logger.error(`Error reading directory ${dirPath}: ${error.message}`);
    }
  }
}

async function readPathsFromStdin(useNullSeparator: boolean): Promise<string[]> {
  let input = "";
  for await (const chunk of Bun.stdin.stream()) {
    input += Buffer.from(chunk).toString();
  }
  if (!input) {
    return [];
  }
  const separator = useNullSeparator ? '\0' : '\n';
  return input.split(separator).map(s => s.trim()).filter(Boolean);
}

function showVersion(): void {
    const VERSION = "1.0.0"; // Placeholder
    logger.info(`files-to-prompt v${VERSION}`);
}

function showHelp(): void {
    showVersion(); // Add version info to help output
    logger.info(`
Files-to-Prompt: Convert files to a prompt format for AI systems

Usage: files-to-prompt [options] [paths...]

Arguments:
  paths                   One or more paths to files or directories

Options:
  -e, --extension EXT     File extensions to include (can use multiple times)
  --include-hidden        Include files and folders starting with .
  --ignore-files-only     --ignore option only ignores files
  --ignore-gitignore      Ignore .gitignore files and include all files
  --ignore PATTERN        List of patterns to ignore (can use multiple times)
  -o, --output FILE       Output to a file instead of stdout
  -c, --cxml              Output in XML-ish format suitable for Claude
  -m, --markdown          Output Markdown with fenced code blocks
  -n, --line-numbers      Add line numbers to the output
  -0, --null              Use NUL character as separator when reading from stdin
  -h, --help              Show this help message
  --version               Show version information

Examples:
  files-to-prompt src/components
  files-to-prompt -e js -e ts src/
  files-to-prompt --markdown -o output.md project/
  find . -name "*.py" | files-to-prompt -0
`);
}

async function main(): Promise<void> {
 try { // Wrap main logic
    const argv = minimist<Args>(process.argv.slice(2), {
        alias: {
            e: "extension",
            o: "output",
            c: "cxml",
            m: "markdown",
            h: "help",
            v: "version",
            '0': "null"
        },
        boolean: [
            "includeHidden",
            "ignoreFilesOnly",
            "ignoreGitignore",
            "cxml",
            "markdown",
            "lineNumbers", // IMPORTANT: Treat -n as boolean if no value given
            "null",
            "help",
            "version"
        ],
        string: ["output"],
        // Declare potentially multi-value args explicitly if needed by minimist typing/parsing
        // minimist might need hints for array types if they aren't consistently used with multiple flags
        // For now, assuming basic parsing works for -e val1 -e val2
    });

    if (argv.help) {
        showHelp();
        process.exit(0);
    }
    if (argv.version) {
        showVersion();
        process.exit(0);
    }


    const paths = argv._;
    if (paths.length === 0 && process.stdin.isTTY) {
        logger.error("Error: No input paths provided.");
        showHelp();
        process.exit(1);
    }

    const extensions = (Array.isArray(argv.extension) ? argv.extension : typeof argv.extension === 'string' ? [argv.extension] : [])
                       .map(ext => ext.toLowerCase().replace(/^\./, '')); // Normalize extensions
    const includeHidden = !!argv.includeHidden;
    const ignoreFilesOnly = !!argv.ignoreFilesOnly;
    const ignoreGitignore = !!argv.ignoreGitignore;
    const ignorePatterns = Array.isArray(argv.ignore) ? argv.ignore : typeof argv.ignore === 'string' ? [argv.ignore] : [];
    const outputFile = argv.output;
    const claudeXml = !!argv.cxml;
    const markdown = !!argv.markdown;
    const lineNumbers = !!argv.lineNumbers; // Now correctly uses boolean flag value
    const readStdinNull = !!argv.null;


    let writer: WriterFunc = (s: string) => { process.stdout.write(s + "\n"); };
    let fileSink: FileSink | null = null;

    if (outputFile) {
        try {
            const outputDir = dirname(outputFile);
            if (!existsSync(outputDir)) {
                await mkdir(outputDir, { recursive: true });
            }
            fileSink = Bun.file(outputFile).writer();
            writer = (s: string) => { (fileSink as FileSink).write(s + "\n"); };
        } catch (error: any) {
            logger.error(`Error setting up output file ${outputFile}: ${error.message}`);
            process.exit(1);
        }
    }

    let processedPaths: string[] = [];
    if (paths.length > 0) {
        processedPaths = paths.map(p => resolve(p)); // Resolve initial paths
    } else {
        processedPaths = await readPathsFromStdin(readStdinNull);
        processedPaths = processedPaths.map(p => resolve(p));
    }

    // Process each path
    for (const path of processedPaths) {
        let initialGitignoreRules = ignoreGitignore ? [] : await readGitignore(dirname(path));

        await processPath(
            path,
            extensions,
            includeHidden,
            ignoreFilesOnly,
            ignoreGitignore,
            initialGitignoreRules, // Pass initial rules
            ignorePatterns,
            writer,
            claudeXml,
            markdown,
            lineNumbers
        );
    }

    if (fileSink) {
        await fileSink.end();
    }
 } catch (error: any) { // Catch errors in main
    logger.error(`An unexpected error occurred: ${error.message}`);
    // Optionally log stack trace for debugging
    // console.error(error.stack);
    process.exit(1);
 }
}

main();
