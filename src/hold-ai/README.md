# Hold-AI Tool

A WebSocket-based tool that allows holding AI responses until you provide your confirmation. This is useful when you want to provide instructions to an AI and wait for its processing, then provide additional context before the AI completes its response.

## How It Works

The system consists of two parts:
1. **Server** - Collects messages from you and broadcasts them to any connected clients
2. **Client** - Connects to the server and waits for messages, displaying them when complete

## Usage

### Step 1: Start the Server
In one terminal window, start the server:
```bash
bun src/tools/hold-ai/server.ts
```

### Step 2: Have the AI Start the Client
When interacting with the AI, prompt it to run:
```
Run "bun src/tools/hold-ai/client.ts" and wait until it ends. If you see any return output, use it as instructions on what to do next.
```

### Step 3: Provide Your Messages
In the server terminal, type your messages and press Enter after each one.

### Step 4: Complete the Session
When you're finished, type `OK` in the server terminal to signal completion.

The AI will receive the combined output of all your messages and can process them as instructions.

## Example

1. You ask the AI to handle a task
2. AI starts the client and waits for your input
3. You provide additional context or instructions through the server
4. You type "OK" when done
5. AI receives your instructions and continues processing

## Requirements

- Bun.js runtime
- ws (WebSocket) package 