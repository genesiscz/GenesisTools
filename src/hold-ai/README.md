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
tools hold-ai/server
```

### Step 2: Have the AI Start the Client
When interacting with the AI, prompt it to run:
```
Run `tools hold-ai/client` and wait until it ends. If you see any return output, use it as instructions on what to do next. After finishing, 
```

### Step 3: Provide Your Messages
The server will open an editor for multiline input. You can:
- Type or paste multiline content
- Save and exit the editor to submit the message
- The message will be sent to all connected clients
- Repeat for additional messages

### Step 4: Complete the Session
When you're finished, type `OK` (alone) in the editor and save/exit to signal completion.

The AI will receive the combined output of all your messages and can process them as instructions.

## Features

- **Multiline Input**: Uses an editor interface for rich, multiline message composition
- **Real-time Broadcasting**: Messages are sent to connected clients immediately
- **Session Management**: Type "OK" to complete sessions and reset for new cycles
- **Persistent Messages**: New clients receive all messages from the current session

## Example

1. You ask the AI to handle a task
2. AI starts the client and waits for your input
3. You provide additional context or instructions through the server's editor interface
4. You can send multiple multiline messages
5. You type "OK" when done to complete the session
6. AI receives your instructions and continues processing

## Requirements

- Bun.js runtime
- ws (WebSocket) package
- enquirer package 