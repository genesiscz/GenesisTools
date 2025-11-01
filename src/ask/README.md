# ASK Tool - Multi-Provider LLM Chat Application

A powerful CLI tool for interacting with multiple LLM providers through a unified interface, built for GenesisTools.

## Features

- **Multi-provider support**: OpenAI, Anthropic, Google, Groq, OpenRouter, xAI, JinaAI
- **Auto provider selection**: Automatically detects provider based on model name
- **Interactive and non-interactive modes**: Chat interactively or send single messages
- **Streaming responses**: Real-time response streaming
- **Audio transcription**: Speech-to-text with multiple providers
- **Dynamic pricing**: Real-time cost tracking from OpenRouter API
- **Type safety**: Full TypeScript with no `any` types
- **Comprehensive logging**: Debug support with logger

## Installation

```bash
# Install dependencies
bun install

# Install GenesisTools globally
./install.sh
source ~/.zshrc  # or ~/.bashrc
```

## Usage

### Basic Commands

```bash
# Interactive chat mode (auto-selects model)
tools ask

# Single message with auto provider selection
tools ask --model gpt-4o "What is the capital of France?"

# Single message with explicit provider
tools ask --model gpt-4o --provider openai "Explain quantum computing"

# Use OpenRouter models
tools ask --model anthropic/claude-3.5-sonnet-20240620 "Hello"

# Verbose/debug mode
tools ask -v --model gpt-4o "Debug message"
```

### Audio Transcription

```bash
# Transcribe audio file
tools ask --sst recording.mp3

# Transcribe with specific output format
tools ask --sst recording.wav --output json
```

### Output Options

```bash
# Save to file
tools ask --output file response.txt "Generate a story"

# Copy to clipboard
tools ask --output clipboard "Summarize this topic"

# JSON output
tools ask --output json "What is 2+2?"
```

## Configuration

### Environment Variables

Set API keys for the providers you want to use:

```bash
# Core providers
export OPENAI_API_KEY="your-openai-key"
export ANTHROPIC_API_KEY="your-anthropic-key"
export GOOGLE_API_KEY="your-google-key"

# Alternative providers
export GROQ_API_KEY="your-groq-key"
export OPENROUTER_API_KEY="your-openrouter-key"
export X_AI_API_KEY="your-xai-key"
export JINA_AI_API_KEY="your-jinaai-key"

# Optional features
export BRAVE_API_KEY="your-brave-key"  # For web search
export ASK_CONVERSATIONS_DIR="./conversations"  # Custom conversation directory

# Logging
export LOG_DEBUG=1  # Enable debug logging
export LOG_TRACE=1  # Enable trace logging
```

### Provider Auto-Selection

The tool automatically detects which provider to use based on the model name:

- `gpt-4o` → OpenAI
- `claude-3-5-sonnet-20241022` → Anthropic (if available)
- `anthropic/claude-3.5-sonnet-20240620` → OpenRouter

## Command Line Options

```
Options:
  -s, --sst <file>        Transcribe audio file
  -m, --model <model>     Specify model (e.g., gpt-4-turbo)
  -p, --provider <prov>   Specify provider (e.g., openai)
  -o, --output <format>   Output format (text/json/markdown/clipboard/file)
  -i, --interactive       Start interactive chat mode (default: true)
  -t, --temperature <n>   Set temperature (0.0-2.0)
  -k, --maxTokens <n>     Set maximum tokens
  --systemPrompt <text>   Set system prompt
  --streaming             Enable streaming responses (default: true)
  --no-streaming          Disable streaming responses
  -v, --verbose            Enable verbose logging
  --silent                Silent mode
  -h, --help              Show this help message
  -V, --version           Show version information
```

## Architecture

### Key Components

- **`index.ts`**: Main CLI entry point with argument parsing
- **`ChatEngine.ts`**: Core chat logic and streaming implementation
- **`ProviderManager.ts`**: Multi-provider detection and management
- **`ModelSelector.ts`**: Interactive model selection and auto-detection
- **`TranscriptionManager.ts`**: Audio transcription with multiple providers
- **`types/`**: Centralized TypeScript type definitions

### Type Safety

All code uses strict TypeScript with no `any` types:

```typescript
// Instead of: const data: any = response;
// Use: const data: KnownType = response as KnownType;

// Provider types are properly defined
export interface DetectedProvider {
  name: string;
  type: string;
  key: string;
  provider: ProviderV1;
  models: ModelInfo[];
  config: ProviderConfig;
}
```

### AI SDK Usage Pattern

**CRITICAL**: When using the Vercel AI SDK v6, use the `prompt` parameter for simple single-turn conversations, NOT the `messages` array:

```typescript
// ✅ CORRECT - Use prompt for single messages
const result = await generateText({
  model: this.config.model,
  prompt: message,
  system: this.config.systemPrompt,
  temperature: this.config.temperature,
  maxTokens: this.config.maxTokens,
});

// ❌ INCORRECT - Using messages array causes cryptic errors
const result = await generateText({
  model: this.config.model,
  messages: [{ role: "user", content: message }], // This fails with "def.typeName" error
});
```

The same pattern applies to `streamText()`:

```typescript
// ✅ CORRECT
const result = await streamText({
  model: this.config.model,
  prompt: message,
});

// ❌ INCORRECT
const result = await streamText({
  model: this.config.model,
  messages: messagesArray, // This hangs/fails
});
```

**Note**: For multi-turn conversations with history, you should still use the `messages` array, but ensure each message object has the correct structure as per AI SDK v6 specifications.

### Error Handling

Comprehensive error handling with user-friendly messages:

- Provider unavailable → Lists available providers
- Model not found → Shows available models by provider
- API errors → Clear error messages with context
- Network issues → Retry logic and graceful degradation

## Development

### Code Style Requirements

1. **No `any` types**: All code must use proper TypeScript types
2. **Centralized types**: Use types from `src/ask/types/` for reusability
3. **Error handling**: Comprehensive try-catch with meaningful messages
4. **Logging**: Use `logger.debug()` for debug output, not `console.error`
5. **Type imports**: Use `type` imports for type-only imports

### Adding New Providers

1. Add provider configuration to `providers/providers.ts`
2. Add supported models to `KNOWN_MODELS`
3. Import and register in `ProviderManager.createProvider()`
4. Test with both interactive and non-interactive modes

### Running Tests

```bash
# Test individual components
bun run src/ask/index.ts --help
bun run src/ask/index.ts --model gpt-4o "test"

# Test with verbose logging
LOG_DEBUG=1 bun run src/ask/index.ts -v --model gpt-4o "test"
```

## Troubleshooting

### Debug Mode

Enable debug logging:

```bash
# Method 1: Environment variable
LOG_DEBUG=1 tools ask --model gpt-4o "test"

# Method 2: Verbose flag
tools ask -v --model gpt-4o "test"
```

### Common Issues

1. **"No AI providers available"** → Set environment variables for API keys
2. **"Model not found"** → Check available models with debug logging
3. **Command hangs** → Check for argument parsing conflicts in logs
4. **Type errors** → Ensure all types are properly imported from `types/`

### Log Files

Logs are stored in the project logs directory at `../../logs/YYYY-MM-DD.log` (relative to `src/ask/`).

#### Viewing Logs

```bash
# View today's logs in real-time (from project root)
tail -f logs/$(date +%Y-%m-%d).log

# View last 20 lines of today's logs
tail -n 20 logs/$(date +%Y-%m-%d).log

# View all logs for today
cat logs/$(date +%Y-%m-%d).log
```

#### Using jq to Parse Logs

The logs are in JSON format, use `jq` for powerful querying:

```bash
# Get last 10 log entries
tail -n 10 logs/$(date +%Y-%m-%d).log | jq -r '.'

# Get last 10 error messages only
tail -n 100 logs/$(date +%Y-%m-%d).log | jq -r 'select(.level >= 50) | .msg'

# Get last 20 debug messages (when running with -v flag)
tail -n 50 logs/$(date +%Y-%m-%d).log | jq -r 'select(.level == 20) | .msg'

# Get formatted output with timestamp and message
tail -n 20 logs/$(date +%Y-%m-%d).log | jq -r '[.time, .level, .msg] | @tsv'

# Filter logs by specific provider detection
tail -n 100 logs/$(date +%Y-%m-%d).log | jq -r 'select(.msg | contains("Detected")) | .msg'

# Get all errors with full context
tail -n 200 logs/$(date +%Y-%m-%d).log | jq -r 'select(.level >= 50)'
```

#### Log Levels

- `10` = TRACE (most verbose)
- `20` = DEBUG (enabled with `-v` flag)
- `30` = INFO (default)
- `40` = WARN (warnings)
- `50` = ERROR (errors)
- `60` = FATAL (fatal errors)

#### Searching Logs

```bash
# Search for specific error messages
grep "ASK tool failed" logs/$(date +%Y-%m-%d).log

# Search for all errors today
jq -r 'select(.level >= 50) | .msg' logs/$(date +%Y-%m-%d).log

# Search for provider detection issues
jq -r 'select(.msg | contains("provider")) | .msg' logs/$(date +%Y-%m-%d).log

# Get chat engine debug messages
jq -r 'select(.msg | contains("ChatEngine")) | .msg' logs/$(date +%Y-%m-%d).log
```

## Provider-Specific Notes

### OpenAI
- Models: `gpt-4o`, `gpt-4`, `gpt-3.5-turbo`, etc.
- Environment: `OPENAI_API_KEY`

### OpenRouter
- Models: `anthropic/claude-3.5-sonnet-20240620`, etc.
- Environment: `OPENROUTER_API_KEY`
- Dynamic pricing supported

### Anthropic
- Models: `claude-3-5-sonnet-20241022`, etc.
- Environment: `ANTHROPIC_API_KEY`

### Google
- Models: `gemini-pro`, etc.
- Environment: `GOOGLE_API_KEY`

### Groq
- Models: `llama-3.1-70b-versatile`, etc.
- Environment: `GROQ_API_KEY`

### xAI
- Models: `grok-beta`
- Environment: `X_AI_API_KEY`

### JinaAI
- Models: `jina-r1`
- Environment: `JINA_AI_API_KEY`