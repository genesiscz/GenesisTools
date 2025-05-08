import minimist from "minimist";
import { basename, dirname, extname, join, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { minimatch } from "minimatch";
import logger from "../logger";

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
  const baseFileWithSlash = baseFile + "/";
  
  for (const rule of gitignoreRules) {
    if (minimatch(baseFile, rule)) {
      return true;
    }
    
    // For directories, check with trailing slash
    if (statSync(path).isDirectory() && minimatch(baseFileWithSlash, rule)) {
      return true;
    }
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
  
  // Figure out how many backticks to use
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
  gitignoreRules: string[],
  ignorePatterns: string[],
  writer: WriterFunc,
  claudeXml: boolean,
  markdown: boolean,
  lineNumbers: boolean
): Promise<void> {
  // Handle file case
  if (statSync(path).isFile()) {
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
  async function processDirectory(dirPath: string): Promise<void> {
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      
      // Filter and process files
      for (const entry of entries) {
        const entryPath = join(dirPath, entry.name);
        
        // Skip hidden files/directories if needed
        if (!includeHidden && entry.name.startsWith(".")) {
          continue;
        }
        
        // Apply gitignore rules if needed
        if (!ignoreGitignore && shouldIgnore(entryPath, gitignoreRules)) {
          continue;
        }
        
        // Apply ignore patterns if needed
        if (ignorePatterns.length > 0) {
          const matchesPattern = ignorePatterns.some(pattern => 
            minimatch(entry.name, pattern)
          );
          
          if (matchesPattern && (entry.isFile() || !ignoreFilesOnly)) {
            continue;
          }
        }
        
        if (entry.isDirectory()) {
          // Read gitignore in this directory
          if (!ignoreGitignore) {
            const newRules = await readGitignore(entryPath);
            if (newRules.length > 0) {
              gitignoreRules.push(...newRules);
            }
          }
          
          await processDirectory(entryPath);
        } else if (entry.isFile()) {
          // Skip if not matching extensions (if specified)
          if (extensions.length > 0 && !extensions.some(ext => entry.name.endsWith(ext))) {
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
    } catch (error) {
      logger.error(`Error processing directory ${dirPath}: ${error}`);
    }
  }
  
  await processDirectory(path);
}

async function readPathsFromStdin(useNullSeparator: boolean): Promise<string[]> {
  // Check if there's input from stdin
  if (process.stdin.isTTY) {
    // No input from stdin, don't block for input
    return [];
  }
  
  return new Promise((resolve) => {
    let data = "";
    
    process.stdin.on("data", (chunk) => {
      data += chunk.toString();
    });
    
    process.stdin.on("end", () => {
      if (useNullSeparator) {
        resolve(data.split("\0").filter(Boolean));
      } else {
        resolve(data.split(/\s+/).filter(Boolean));
      }
    });
  });
}

// --- Help Function ---
function showHelp(): void {
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

// --- Main Function ---
async function main(): Promise<void> {
  const argv = minimist<Args>(process.argv.slice(2), {
    boolean: [
      "include-hidden",
      "ignore-files-only",
      "ignore-gitignore",
      "cxml",
      "markdown",
      "line-numbers",
      "null",
      "help",
      "version"
    ],
    string: ["output", "ignore", "extension"],
    alias: {
      e: "extension",
      o: "output",
      c: "cxml",
      m: "markdown",
      n: "line-numbers",
      h: "help",
      0: "null"
    },
    // Allow arrays for these options
    array: ["extension", "ignore"]
  });
  
  // Handle help and version
  if (argv.help) {
    showHelp();
    process.exit(0);
  }
  
  if (argv.version) {
    // Version from package.json could be used here
    logger.info("files-to-prompt v1.0.0");
    process.exit(0);
  }
  
  // Get paths from arguments and stdin
  const argPaths = argv._.map(String);
  const stdinPaths = await readPathsFromStdin(Boolean(argv.null));
  const paths = [...argPaths, ...stdinPaths];
  
  if (paths.length === 0) {
    logger.error("No paths provided. Use --help for usage information.");
    process.exit(1);
  }
  
  // Extract and validate options
  const {
    extension = [],
    includeHidden = false,
    ignoreFilesOnly = false,
    ignoreGitignore = false,
    ignore = [],
    output,
    cxml = false,
    markdown = false,
    lineNumbers = false
  } = argv;
  
  // Normalize extensions (add leading dot if missing)
  const extensions = extension.map(ext => ext.startsWith(".") ? ext : `.${ext}`);
  
  // Set up writer function
  let writer: WriterFunc;
  let outputStream: any = null;
  
  if (output) {
    try {
      // Ensure the directory exists
      await mkdir(dirname(resolve(output)), { recursive: true });
      
      // Create a function that appends to the file
      writer = async (s: string) => {
        await writeFile(resolve(output), s + "\n", { encoding: "utf-8", flag: "a" });
      };
      
      // Clear the file to start
      await writeFile(resolve(output), "", { encoding: "utf-8" });
    } catch (error) {
      logger.error(`Error opening output file ${output}: ${error}`);
      process.exit(1);
    }
  } else {
    writer = (s: string) => console.log(s);
  }
  
  // Reset global counter for tests
  globalIndex = 1;
  
  // Process each path
  let gitignoreRules: string[] = [];
  
  if (cxml && paths.length > 0) {
    writer("<documents>");
  }
  
  for (const path of paths) {
    if (!existsSync(path)) {
      logger.error(`Path does not exist: ${path}`);
      continue;
    }
    
    if (!ignoreGitignore) {
      const dirPath = statSync(path).isDirectory() ? path : dirname(path);
      const newRules = await readGitignore(dirPath);
      gitignoreRules.push(...newRules);
    }
    
    await processPath(
      path,
      extensions,
      includeHidden,
      ignoreFilesOnly,
      ignoreGitignore,
      gitignoreRules,
      ignore,
      writer,
      cxml,
      markdown,
      lineNumbers
    );
  }
  
  if (cxml) {
    writer("</documents>");
  }
}

// --- Run Main ---
main().catch((err) => {
  logger.error("\n✖ An unexpected error occurred:", err);
  process.exit(1);
});
