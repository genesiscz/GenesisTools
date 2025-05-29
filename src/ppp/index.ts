#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "child_process";

// Create an MCP server
const server = new Server(
  {
    name: "cursor-user-input",
    version: "1.0.0"
  },
  {
    capabilities: {
      tools: {}  // Enable tools capability
    }
  }
);

/**
 * Show a GUI dialog to get user input
 * Works on both macOS and Linux
 */
async function showDialog(message: string, type: string = "input", options?: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const isLinux = process.platform === "linux";
    const isMac = process.platform === "darwin";
    const isWindows = process.platform === "win32";

    let command: string;
    let args: string[] = [];

    try {
      if (type === "confirm") {
        if (isMac) {
          command = "osascript";
          args = [
            "-e",
            `display dialog "${message}" buttons {"No", "Yes"} default button "Yes"`
          ];
        } else if (isLinux) {
          command = "zenity";
          args = ["--question", "--text", message];
        } else if (isWindows) {
          command = "powershell";
          args = [
            "-Command",
            `[System.Windows.Forms.MessageBox]::Show("${message}", "Confirmation", [System.Windows.Forms.MessageBoxButtons]::YesNo)`
          ];
        } else {
          throw new Error("Unsupported platform");
        }
      } else if (type === "select" && options) {
        if (isMac) {
          const choiceList = options.map(opt => `"${opt}"`).join(", ");
          command = "osascript";
          args = [
            "-e",
            `choose from list {${choiceList}} with prompt "${message}"`
          ];
        } else if (isLinux) {
          command = "zenity";
          args = ["--list", "--text", message, "--column", "Options", ...options];
        } else if (isWindows) {
          // Windows implementation would need a more complex PowerShell script
          throw new Error("Select dialog not implemented for Windows yet");
        } else {
          throw new Error("Unsupported platform");
        }
      } else {
        // Default text input
        if (isMac) {
          command = "osascript";
          args = [
            "-e",
            `display dialog "${message}" default answer "" buttons {"Cancel", "OK"} default button "OK"`
          ];
        } else if (isLinux) {
          command = "zenity";
          args = ["--entry", "--text", message];
        } else if (isWindows) {
          command = "powershell";
          args = [
            "-Command",
            `[Microsoft.VisualBasic.Interaction]::InputBox("${message}", "Input Required")`
          ];
        } else {
          throw new Error("Unsupported platform");
        }
      }

      const child = spawn(command, args);
      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (data) => {
        stdout += data.toString();
      });

      child.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      child.on("close", (code) => {
        if (code === 0) {
          let result = stdout.trim();
          
          // Handle different dialog types and platforms
          if (type === "confirm") {
            if (isMac) {
              resolve(result.includes("Yes") ? "yes" : "no");
            } else if (isLinux) {
              resolve("yes"); // zenity returns 0 for Yes
            } else if (isWindows) {
              resolve(result.includes("Yes") ? "yes" : "no");
            }
          } else if (type === "select") {
            if (isMac) {
              // Remove "false" prefix and clean up the result
              result = result.replace(/^false$/, "").trim();
              resolve(result || "[User cancelled]");
            } else {
              resolve(result || "[User cancelled]");
            }
          } else {
            // Text input
            if (isMac) {
              // Extract text from AppleScript result format
              const match = result.match(/text returned:(.+?)(?:,|$)/);
              resolve(match ? match[1].trim() : "");
            } else {
              resolve(result);
            }
          }
        } else {
          if (code === 1 && (isLinux || isMac)) {
            // User cancelled
            resolve("[User cancelled]");
          } else {
            reject(new Error(`Dialog failed: ${stderr || `Exit code ${code}`}`));
          }
        }
      });

      child.on("error", (error) => {
        reject(new Error(`Failed to show dialog: ${error.message}`));
      });

    } catch (error) {
      reject(error);
    }
  });
}

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "ask-user",
        description: "Ask the user a question and get their response via GUI dialog",
        inputSchema: {
          type: "object",
          properties: {
            question: { 
              type: "string", 
              description: "The question to ask the user" 
            },
            type: { 
              type: "string", 
              description: "Type of input: 'input' (default), 'confirm', 'select'",
              enum: ["input", "confirm", "select"]
            },
            choices: {
              type: "array",
              items: { type: "string" },
              description: "Available choices for select type"
            }
          },
          required: ["question"]
        }
      },
      {
        name: "confirm-action",
        description: "Ask the user to confirm an action with yes/no via GUI dialog",
        inputSchema: {
          type: "object",
          properties: {
            message: { 
              type: "string", 
              description: "The confirmation message to show the user" 
            }
          },
          required: ["message"]
        }
      },
      {
        name: "get-user-choice",
        description: "Present the user with multiple choices via GUI dialog",
        inputSchema: {
          type: "object",
          properties: {
            question: { 
              type: "string", 
              description: "The question to ask the user" 
            },
            choices: {
              type: "array",
              items: { type: "string" },
              description: "List of choices for the user to select from"
            }
          },
          required: ["question", "choices"]
        }
      }
    ]
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const toolName = request.params.name;
  
  if (!["ask-user", "confirm-action", "get-user-choice"].includes(toolName)) {
    return Object.create(null);
  }
  
  try {
    const args = request.params.arguments || {};
    
    switch (toolName) {
      case "ask-user": {
        const question = String(args.question || "");
        const type = String(args.type || "input");
        const choices = Array.isArray(args.choices) ? args.choices.map(String) : undefined;
        
        if (!question) {
          return {
            isError: true,
            content: [{ type: "text", text: "Error: Question is required" }]
          };
        }
        
        console.error(`Showing dialog to user: ${question}`);
        const userResponse = await showDialog(question, type, choices);
        
        return {
          content: [
            {
              type: "text",
              text: userResponse
            }
          ]
        };
      }
      
      case "confirm-action": {
        const message = String(args.message || "");
        
        if (!message) {
          return {
            isError: true,
            content: [{ type: "text", text: "Error: Message is required" }]
          };
        }
        
        console.error(`Asking for confirmation: ${message}`);
        const confirmed = await showDialog(message, "confirm");
        
        return {
          content: [
            {
              type: "text",
              text: confirmed
            }
          ]
        };
      }
      
      case "get-user-choice": {
        const question = String(args.question || "");
        const choices = Array.isArray(args.choices) ? args.choices.map(String) : [];
        
        if (!question) {
          return {
            isError: true,
            content: [{ type: "text", text: "Error: Question is required" }]
          };
        }
        
        if (choices.length === 0) {
          return {
            isError: true,
            content: [{ type: "text", text: "Error: At least one choice is required" }]
          };
        }
        
        console.error(`Presenting choices to user: ${question}`);
        const userResponse = await showDialog(question, "select", choices);
        
        return {
          content: [
            {
              type: "text",
              text: userResponse
            }
          ]
        };
      }
      
      default:
        return {
          isError: true,
          content: [{ type: "text", text: `Unknown tool: ${toolName}` }]
        };
    }
  } catch (error: any) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Error: ${error.message}`
        }
      ]
    };
  }
});

async function main() {
  // Start receiving messages on stdin and sending messages on stdout
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Cursor User Input MCP Server running");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});