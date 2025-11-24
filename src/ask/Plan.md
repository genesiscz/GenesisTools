# ASK Tool - Multi-Router LLM Chat App Specification

## Overview

The `ask` tool is a comprehensive multi-provider LLM chat application that automatically detects available AI API keys from environment variables and provides an interactive interface for chatting with various AI models. It leverages the Vercel AI SDK's dynamic provider capabilities to route requests to different AI providers seamlessly.

## Core Requirements

### 1. Environment Analysis & API Key Detection

-   **Automatic Key Discovery**: Scan `process.env` for AI-related API keys
-   **Provider Mapping**: Map detected keys to corresponding AI providers
-   **Validation**: Verify API key validity before offering provider options
-   **Security**: Never expose API keys in logs or output

### 2. Dynamic Provider Configuration

-   **Runtime Provider Setup**: Use Vercel AI SDK's provider factories to configure providers at runtime
-   **Model Discovery**: Query available models for each provider using AI SDK introspection
-   **Provider Registry**: Maintain a registry of configured providers with their capabilities

### 3. Interactive Model Selection

-   **Provider Choice**: Present available providers based on detected API keys
-   **Model Selection**: Show available models for chosen provider
-   **Model Metadata**: Display model capabilities (context window, pricing, etc.)
-   **Fallback Options**: Handle cases where providers/models are unavailable

### 4. Chat Interface Modes

-   **Interactive Mode**: Real-time chat with streaming responses
-   **Non-Interactive Mode**: Single query/response for automation
-   **Multi-turn Conversations**: Maintain conversation history
-   **Streaming Support**: Real-time text streaming with progress indicators

## Technical Architecture

### Core Components

#### 1. Provider Manager (`ProviderManager.ts`)

```typescript
interface DetectedProvider {
    name: string;
    key: string;
    provider: AISDKProvider;
    models: ModelInfo[];
}

class ProviderManager {
    detectProviders(): DetectedProvider[];
    validateProvider(provider: DetectedProvider): Promise<boolean>;
    getAvailableModels(provider: DetectedProvider): Promise<ModelInfo[]>;
}
```

#### 2. Model Selector (`ModelSelector.ts`)

```typescript
interface ModelChoice {
    provider: string;
    model: string;
    contextWindow: number;
    costPerToken: number;
    capabilities: string[];
}

class ModelSelector {
    async selectModel(providers: DetectedProvider[]): Promise<ModelChoice>;
    async getModelDetails(modelId: string): Promise<ModelInfo>;
}
```

#### 3. Chat Engine (`ChatEngine.ts`)

```typescript
interface ChatConfig {
    model: ModelChoice;
    streaming: boolean;
    systemPrompt?: string;
    temperature?: number;
    maxTokens?: number;
}

interface ChatMessage {
    role: "user" | "assistant" | "system";
    content: string;
    timestamp: Date;
}

class ChatEngine {
    async startChat(config: ChatConfig): Promise<ChatSession>;
    async sendMessage(session: ChatSession, message: string): Promise<ChatMessage>;
    async endChat(session: ChatSession): Promise<void>;
}
```

#### 4. CLI Interface (`CLIInterface.ts`)

```typescript
interface CLIOptions {
    model?: string;
    provider?: string;
    message?: string;
    interactive?: boolean;
    streaming?: boolean;
    systemPrompt?: string;
    output?: "stdout" | "clipboard" | "file";
}

class CLIInterface {
    parseArgs(): CLIOptions;
    runInteractive(): Promise<void>;
    runNonInteractive(options: CLIOptions): Promise<void>;
}
```

### Provider Detection Logic

#### Environment Variable Mapping

```typescript
const PROVIDER_KEY_MAPPING = {
    // OpenAI
    OPENAI_API_KEY: { provider: "openai", import: "@ai-sdk/openai" },

    // Anthropic
    ANTHROPIC_API_KEY: { provider: "anthropic", import: "@ai-sdk/anthropic" },

    // xAI
    X_AI_API_KEY: { provider: "openai-compatible", baseURL: "https://api.x.ai/v1" },

    // Google
    GOOGLE_API_KEY: { provider: "google", import: "@ai-sdk/google" },

    // OpenRouter (aggregates many providers)
    OPENROUTER_API_KEY: { provider: "openai-compatible", baseURL: "https://openrouter.ai/api/v1" },

    // Jina AI
    JINA_AI_API_KEY: { provider: "openai-compatible", baseURL: "https://api.jina.ai/v1" },

    // And many more...
};
```

#### Dynamic Provider Configuration

```typescript
async function createDynamicProvider(providerConfig: ProviderConfig) {
    switch (providerConfig.type) {
        case "openai":
            const { openai } = await import("@ai-sdk/openai");
            return openai;

        case "openai-compatible":
            const { createOpenAI } = await import("@ai-sdk/openai");
            return createOpenAI({
                apiKey: providerConfig.key,
                baseURL: providerConfig.baseURL,
            });

        // Handle other provider types...
    }
}
```

### Model Discovery & Selection

#### Model Querying

```typescript
async function discoverModels(provider: AISDKProvider): Promise<ModelInfo[]> {
    // For OpenRouter and similar aggregators, we can query available models
    // For direct providers, use known model lists or API introspection

    if (provider.name === "openrouter") {
        const models = await fetch("https://openrouter.ai/api/v1/models", {
            headers: { Authorization: `Bearer ${provider.apiKey}` },
        });
        return models.data.map((m) => ({
            id: m.id,
            name: m.name,
            contextWindow: m.context_length,
            pricing: m.pricing,
        }));
    }

    // For direct providers, return known models
    return PROVIDER_MODELS[provider.name] || [];
}
```

#### Interactive Selection UI

```typescript
async function selectModel(providers: DetectedProvider[]) {
    // Use Enquirer for interactive selection
    const providerChoice = await prompter.prompt({
        type: "select",
        name: "provider",
        message: "Choose AI provider:",
        choices: providers.map((p) => ({
            name: p.name,
            message: `${p.name} (${p.models.length} models available)`,
        })),
    });

    const selectedProvider = providers.find((p) => p.name === providerChoice.provider);

    const modelChoice = await prompter.prompt({
        type: "autocomplete",
        name: "model",
        message: "Choose model:",
        choices: selectedProvider.models.map((m) => ({
            name: m.id,
            message: `${m.name} (${m.contextWindow} tokens, $${m.costPerToken}/1K tokens)`,
        })),
    });

    return { provider: selectedProvider, model: modelChoice.model };
}
```

## Usage Modes

### 1. Interactive Chat Mode

```bash
# Start interactive chat
tools ask

# Interactive chat with specific provider
tools ask --provider openai

# Interactive chat with specific model
tools ask --model gpt-4-turbo
```

### 2. Non-Interactive Single Query

```bash
# Single question
tools ask "What is the capital of France?"

# Single question with specific model
tools ask --model claude-3-sonnet "Explain quantum computing"

# Output to clipboard
tools ask --output clipboard "Generate a todo list for learning React"
```

### 3. Batch Processing

```bash
# Process multiple questions from file
tools ask --input questions.txt --output results.json

# Stream responses to stdout for piping
tools ask --streaming "Tell me a story" | grep "moral"
```

## Implementation Phases

### Phase 1: Core Infrastructure

1. **Provider Detection**: Scan env vars and validate keys
2. **Basic Provider Setup**: Configure OpenAI, Anthropic, xAI providers
3. **Simple Model Selection**: Hardcoded model lists for known providers
4. **Basic Chat Interface**: Non-streaming single-turn conversations

### Phase 2: Advanced Features

1. **Dynamic Model Discovery**: Query provider APIs for available models
2. **Streaming Support**: Real-time text streaming
3. **Conversation History**: Multi-turn conversations with context
4. **Tool Integration**: Add GenesisTools as callable tools

### Phase 3: Enhanced UX

1. **Rich Interactive UI**: Better prompts with model details and costs
2. **Output Options**: Clipboard, file, stdout with formatting
3. **Configuration Persistence**: Save preferred models/providers
4. **Error Handling & Recovery**: Graceful handling of API failures

### Phase 4: Advanced Capabilities

1. **Multi-Modal Support**: Image generation, analysis
2. **Tool Calling**: Integrate with external APIs and tools
3. **Agent Mode**: Autonomous multi-step reasoning
4. **Cost Tracking**: Monitor and limit API usage

## Dependencies & Requirements

### Core Dependencies

-   `ai`: Vercel AI SDK core
-   `@ai-sdk/openai`: OpenAI provider
-   `@ai-sdk/anthropic`: Anthropic provider
-   `@ai-sdk/google`: Google provider
-   `@ai-sdk/groq`: Groq provider (very fast inference)
-   `@ai-sdk/openai-compatible`: For xAI, OpenRouter, Jina, etc.

### Transcription Dependencies

-   `@ai-sdk/assemblyai`: AssemblyAI transcription (large file support)
-   `@ai-sdk/deepgram`: Deepgram transcription (real-time, large files)
-   `@ai-sdk/gladia`: Gladia transcription (large file support)
-   `@ai-sdk/revai`: Rev.ai transcription (enterprise-grade)
-   `@ai-sdk/fal`: Fal AI transcription

### Audio Processing Dependencies

-   `fluent-ffmpeg`: Audio file format conversion and chunking
-   `ffprobe`: Audio metadata extraction
-   `mime-types`: MIME type detection for audio files

### UI Dependencies

-   `enquirer`: Interactive prompts
-   `chalk`: Terminal colors
-   `ora`: Loading spinners
-   `clipboardy`: Clipboard operations

### Utility Dependencies

-   `minimist`: CLI argument parsing
-   `zod`: Schema validation
-   `pino`: Structured logging

## Configuration & Environment

### Environment Variables

The tool automatically detects these AI API keys:

#### Core Chat & Text Generation

-   `OPENAI_API_KEY` - OpenAI models (GPT-4, GPT-3.5, Whisper)
-   `ANTHROPIC_API_KEY` - Claude models
-   `X_AI_API_KEY` - xAI Grok models
-   `GOOGLE_API_KEY` - Google Gemini models
-   `OPENROUTER_API_KEY` - 100+ models via OpenRouter
-   `GROQ_API_KEY` - Groq models (very fast inference)

#### Transcription & Audio

-   `ASSEMBLYAI_API_KEY` - AssemblyAI transcription (supports 100MB+ files)
-   `DEEPGRAM_API_KEY` - Deepgram transcription (supports 100MB+ files)
-   `GLADIA_API_KEY` - Gladia transcription (supports 100MB+ files)
-   `REVAII_API_KEY` - Rev.ai transcription (supports 100MB+ files)
-   `FAL_API_KEY` - Fal AI transcription

#### Search & Tools

-   `BRAVE_API_KEY` - Brave Search API for web search
-   `PEXELS_API_KEY` - Pexels image search
-   `ELEVENLABS_API_KEY` - ElevenLabs text-to-speech
-   `JINA_AI_API_KEY` - Jina AI for embeddings/search

#### Provider Priority Order

1. **Groq** (fastest, lowest cost for transcription)
2. **OpenRouter** (most model variety)
3. **OpenAI** (reliable fallback)
4. **AssemblyAI/Deepgram** (large file support)
5. **Other providers** (as available)

### Configuration File (Optional)

```json
{
    "defaultProvider": "openai",
    "defaultModel": "gpt-4-turbo",
    "maxTokens": 4096,
    "temperature": 0.7,
    "costLimit": 5.0,
    "streaming": true
}
```

## Error Handling & Edge Cases

### API Key Issues

-   Invalid keys: Show clear error messages
-   Missing keys: Graceful degradation, skip provider
-   Rate limits: Implement exponential backoff
-   Quota exceeded: Fallback to other providers

### Model Availability

-   Model not found: Suggest alternatives
-   Model deprecated: Update to newer versions
-   Provider outage: Automatic failover

### Network Issues

-   Timeout handling: Configurable timeouts
-   Retry logic: Exponential backoff with jitter
-   Offline mode: Cache responses for offline use

## Testing Strategy

### Unit Tests

-   Provider detection logic
-   Model parsing and validation
-   Chat engine state management
-   CLI argument parsing

### Integration Tests

-   Real API calls (with mock keys)
-   Streaming response handling
-   Multi-turn conversation flow
-   Error recovery scenarios

### E2E Tests

-   Full interactive sessions
-   Batch processing workflows
-   Output format validation
-   Cross-platform compatibility

## Security Considerations

### API Key Management

-   Never log API keys
-   Use environment variables only
-   Validate key formats before use
-   Implement key rotation support

### Data Privacy

-   Don't persist conversation history without consent
-   Clear sensitive data from memory
-   Implement conversation encryption for storage

### Rate Limiting & Cost Control

-   Track API usage per provider
-   Implement spending limits
-   Warn on high-cost operations
-   Support budget alerts

## Core Features & Requirements

### 1. Chat Mode Selection (After Model Choice)

After model selection, the user enters an **interactive chat session** with the selected model. The chat supports:

#### Special Commands

-   **`/model`**: Re-trigger model selection with autocomplete
-   **`/output`**: Change output format (see Output Formats below)
-   **`/help`**: Show available commands
-   **`/quit`** or **`/exit`**: End the session
-   **`/clear`**: Clear conversation history
-   **`/save`**: Manually save current conversation

#### Interactive Chat Flow

1. User selects model via autocomplete prompt
2. User enters chat mode with the selected model
3. Each message is sent to the model with full conversation history
4. Responses stream in real-time as fast as possible
5. Special commands can be entered at any time during chat

### 2. Output Format Selection

The `/output` command allows switching between output formats:

#### Available Formats

-   **`text`** (default): Plain text output
-   **`json`**: Structured JSON responses
-   **`markdown`**: Markdown formatted output
-   **`clipboard`**: Auto-copy responses to clipboard
-   **`file <filename>`**: Save responses to specified file

#### Format Switching

```typescript
// During chat session
/output json    // Switch to JSON output
/output clipboard // Auto-copy to clipboard
/output file responses.txt // Save to file
```

### 3. Web Search Tool Integration

The tool includes built-in web search capabilities:

#### Search Implementation

```typescript
// Uses BRAVE_API_KEY from environment
const searchTool = {
    description: "Search the web for current information",
    parameters: z.object({
        query: z.string().describe("Search query"),
        numResults: z.number().optional().default(5),
    }),
    execute: async ({ query, numResults }) => {
        // Implementation using Brave Search API
        // https://api.search.brave.com/res/v1/web/search
        const response = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}`, {
            headers: { "X-Subscription-Token": process.env.BRAVE_API_KEY },
        });
        return response.json();
    },
};
```

#### Usage in Chat

Users can request searches naturally:

-   "Search for recent AI news"
-   "What's the weather in Tokyo?"
-   "Find tutorials for React hooks"

### 4. Streaming Output

All responses stream as fast as possible:

#### Streaming Implementation

```typescript
const result = streamText({
    model: selectedModel,
    prompt: userMessage,
    // No artificial delays - stream chunks immediately
});

for await (const chunk of result.textStream) {
    process.stdout.write(chunk); // Immediate output
}
```

#### Performance Requirements

-   **Chunk latency**: <50ms between chunks
-   **First chunk**: <200ms from API response
-   **No buffering**: Chunks displayed immediately as received

### 5. Conversation Persistence

Conversations saved as JSON files on disk:

#### File Format

```json
{
    "sessionId": "2025-10-22_14-30-15_abc123",
    "model": "openai/gpt-4-turbo",
    "provider": "openai",
    "startTime": "2025-10-22T14:30:15Z",
    "endTime": "2025-10-22T14:45:22Z",
    "messages": [
        {
            "role": "user",
            "content": "Hello",
            "timestamp": "2025-10-22T14:30:16Z",
            "tokens": 1
        },
        {
            "role": "assistant",
            "content": "Hi there! How can I help you today?",
            "timestamp": "2025-10-22T14:30:18Z",
            "tokens": 8,
            "usage": {
                "inputTokens": 10,
                "outputTokens": 8,
                "totalTokens": 18,
                "cachedInputTokens": 0
            }
        }
    ],
    "totalUsage": {
        "inputTokens": 25,
        "outputTokens": 45,
        "totalTokens": 70,
        "cachedInputTokens": 5
    },
    "totalCost": 0.0028
}
```

#### File Naming Convention

-   **Format**: `YYYY-MM-DD_HH-MM-SS_<random-id>.json`
-   **Location**: `./conversations/` directory
-   **Auto-save**: Every 5 messages or when session ends
-   **Load**: Support loading previous conversations

### 6. Speech-to-Text (SST) Support

#### Command Line Usage

```bash
# Transcribe audio file
tools ask --sst audio.mp3
tools ask /sst recording.wav

# In chat mode
/sst my-recording.m4a
```

#### Implementation

```typescript
import { experimental_transcribe as transcribe } from "ai";
import { openai } from "@ai-sdk/openai";
import { groq } from "@ai-sdk/groq";
import { assemblyai } from "@ai-sdk/assemblyai";
import { deepgram } from "@ai-sdk/deepgram";
import { gladia } from "@ai-sdk/gladia";
import { revai } from "@ai-sdk/revai";
import { fal } from "@ai-sdk/fal";

async function transcribeAudio(filePath: string): Promise<string> {
    const audioBuffer = await Bun.file(filePath).arrayBuffer();
    const fileSize = audioBuffer.byteLength;

    // Select best model based on file size and available providers
    const selectedModel = await selectBestTranscriptionModel(fileSize);

    console.log(`Chosen model: ${selectedModel.provider}/${selectedModel.modelId}`);

    const result = await transcribe({
        model: selectedModel.model,
        audio: audioBuffer,
        ...selectedModel.options, // Provider-specific options
    });

    return result.text;
}

async function selectBestTranscriptionModel(fileSize: number) {
    // Priority order: best quality, then file size support, then speed

    // 1. Check for providers that support large files (>25MB)
    if (fileSize > 25 * 1024 * 1024) {
        // Try AssemblyAI (supports large files)
        if (process.env.ASSEMBLYAI_API_KEY) {
            const { assemblyai } = await import("@ai-sdk/assemblyai");
            return {
                provider: "assemblyai",
                modelId: "best",
                model: assemblyai.transcription("best"),
            };
        }

        // Try Deepgram (supports large files)
        if (process.env.DEEPGRAM_API_KEY) {
            const { deepgram } = await import("@ai-sdk/deepgram");
            return {
                provider: "deepgram",
                modelId: "nova-3",
                model: deepgram.transcription("nova-3"),
            };
        }

        // Try Gladia (supports large files)
        if (process.env.GLADIA_API_KEY) {
            const { gladia } = await import("@ai-sdk/gladia");
            return {
                provider: "gladia",
                modelId: "default",
                model: gladia.transcription(),
            };
        }
    }

    // 2. For smaller files, prefer quality/speed
    // Try Groq Whisper Large V3 (fast and high quality)
    if (process.env.GROQ_API_KEY) {
        const { groq } = await import("@ai-sdk/groq");
        return {
            provider: "groq",
            modelId: "whisper-large-v3",
            model: groq.transcription("whisper-large-v3"),
            options: { groq: { language: "en" } },
        };
    }

    // Try OpenRouter with premium Whisper models
    if (process.env.OPENROUTER_API_KEY) {
        const { createOpenAI } = await import("@ai-sdk/openai");
        const openrouter = createOpenAI({
            apiKey: process.env.OPENROUTER_API_KEY,
            baseURL: "https://openrouter.ai/api/v1",
        });
        return {
            provider: "openrouter",
            modelId: "openai/whisper-1",
            model: openrouter.transcription("openai/whisper-1"),
        };
    }

    // Fallback to OpenAI Whisper-1 (25MB limit)
    if (process.env.OPENAI_API_KEY) {
        const { openai } = await import("@ai-sdk/openai");
        return {
            provider: "openai",
            modelId: "whisper-1",
            model: openai.transcription("whisper-1"),
        };
    }

    throw new Error("No suitable transcription provider available");
}
```

#### Transcription Model Capabilities

| Provider       | Model            | File Size Limit | Speed     | Quality   | Languages | Cost     |
| -------------- | ---------------- | --------------- | --------- | --------- | --------- | -------- |
| **Groq**       | whisper-large-v3 | 25MB            | Very Fast | Excellent | 50+       | Low      |
| **AssemblyAI** | best             | **100MB+**      | Fast      | Excellent | 100+      | Medium   |
| **Deepgram**   | nova-3           | **100MB+**      | Very Fast | Excellent | 50+       | Medium   |
| **Gladia**     | default          | **100MB+**      | Fast      | Very Good | 100+      | Medium   |
| **Rev.ai**     | machine          | **100MB+**      | Medium    | Very Good | 50+       | Medium   |
| **OpenRouter** | whisper-1        | 25MB            | Medium    | Good      | 50+       | Variable |
| **OpenAI**     | whisper-1        | **25MB**        | Medium    | Good      | 50+       | Low      |

#### Streaming Transcription

-   **Supported formats**: MP3, WAV, M4A, FLAC, OGG, WebM, AAC
-   **Real-time streaming**: AssemblyAI, Deepgram, Gladia support real-time streaming
-   **Progress indication**: Show transcription progress for long files
-   **Large file handling**: Automatic chunking for files >25MB with compatible providers
-   **Language detection**: Automatic language detection for most providers

#### File Size Handling

````typescript
// For files >25MB, use chunking with compatible providers
async function handleLargeAudioFile(filePath: string): Promise<string> {
  const fileSize = await getFileSize(filePath);

  if (fileSize <= 25 * 1024 * 1024) {
    // Use standard transcription
    return await transcribeAudio(filePath);
  }

  // For larger files, use providers that support chunking
  const selectedModel = await selectLargeFileModel();

  if (selectedModel.provider === 'assemblyai' || selectedModel.provider === 'deepgram') {
    // These providers handle large files natively
    return await transcribeAudio(filePath);
  }

  // For other providers, implement chunking
  return await transcribeWithChunking(filePath, selectedModel);
}

async function transcribeWithChunking(filePath: string, model: any): Promise<string> {
  const chunks = await splitAudioFile(filePath, 24 * 1024 * 1024); // 24MB chunks
  const transcripts: string[] = [];

  for (let i = 0; i < chunks.length; i++) {
    console.log(`Transcribing chunk ${i + 1}/${chunks.length}...`);
    const transcript = await transcribe({ model, audio: chunks[i] });
    transcripts.push(transcript.text);
  }

  return transcripts.join(' ');
}

#### Audio File Format Support

```typescript
// MIME type detection for different audio formats
function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();

  const mimeTypes: Record<string, string> = {
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.m4a': 'audio/m4a',
    '.aac': 'audio/aac',
    '.ogg': 'audio/ogg',
    '.flac': 'audio/flac',
    '.webm': 'audio/webm',
    '.mp4': 'audio/mp4'
  };

  return mimeTypes[ext] || 'audio/mpeg'; // Default fallback
}

// Audio format validation
function validateAudioFile(filePath: string): boolean {
  const supportedFormats = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.webm', '.mp4'];
  const ext = path.extname(filePath).toLowerCase();
  return supportedFormats.includes(ext);
}

// File size checking
async function getFileSize(filePath: string): Promise<number> {
  const stats = await Bun.stat(filePath);
  return stats.size;
}

// Provider-specific audio format support
const AUDIO_FORMAT_SUPPORT = {
  groq: ['.mp3', '.wav', '.m4a', '.flac', '.ogg'],
  assemblyai: ['.mp3', '.wav', '.m4a', '.flac', '.aac', '.ogg', '.webm'],
  deepgram: ['.mp3', '.wav', '.m4a', '.flac', '.aac', '.ogg', '.webm', '.mp4'],
  openai: ['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.aac', '.webm'],
  openrouter: ['.mp3', '.wav', '.m4a', '.flac', '.ogg', '.aac', '.webm']
};
````

#### Transcription Error Handling

```typescript
async function transcribeWithErrorRecovery(filePath: string): Promise<string> {
    const fileSize = await getFileSize(filePath);

    try {
        return await transcribeAudio(filePath);
    } catch (error) {
        console.warn(`Transcription failed with primary model: ${error.message}`);

        // Try fallback providers for large files
        if (fileSize > 25 * 1024 * 1024) {
            console.log("Trying fallback providers for large file...");
            return await transcribeAudioWithFallback(filePath);
        }

        throw error;
    }
}

async function transcribeAudioWithFallback(filePath: string): Promise<string> {
    const fallbackProviders = [
        { env: "ASSEMBLYAI_API_KEY", provider: "assemblyai" },
        { env: "DEEPGRAM_API_KEY", provider: "deepgram" },
        { env: "GLADIA_API_KEY", provider: "gladia" },
    ];

    for (const { env, provider } of fallbackProviders) {
        if (process.env[env]) {
            try {
                console.log(`Trying fallback provider: ${provider}`);
                const model = await getProviderTranscriptionModel(provider);
                const result = await transcribe({ model, audio: await Bun.file(filePath).arrayBuffer() });
                return result.text;
            } catch (error) {
                console.warn(`Fallback provider ${provider} failed: ${error.message}`);
                continue;
            }
        }
    }

    throw new Error("All transcription providers failed");
}
```

### 7. Cost Tracking & Billing

#### Token Display Format

All token counts displayed in thousands ("k"):

-   **Input tokens**: 1.2k (1,200 tokens)
-   **Output tokens**: 0.8k (800 tokens)
-   **Cached input**: 0.3k (300 tokens)
-   **Total**: 2.3k (2,300 tokens)

#### Dynamic Cost Calculation System

All pricing is loaded dynamically from provider APIs. If dynamic loading fails, fallback to OpenRouter pricing as the most comprehensive and up-to-date source.

##### Provider Pricing APIs

````typescript
interface PricingInfo {
    input: number;    // Cost per 1K input tokens
    output: number;   // Cost per 1K output tokens
    cachedInput?: number; // Cost per 1K cached input tokens (if applicable)
}

class DynamicPricingManager {
    private pricingCache = new Map<string, { pricing: PricingInfo; timestamp: number }>();
    private readonly CACHE_DURATION = 1000 * 60 * 60; // 1 hour

    async getPricing(provider: string, modelId: string): Promise<PricingInfo | null> {
        const cacheKey = `${provider}/${modelId}`;
        const cached = this.pricingCache.get(cacheKey);

        if (cached && Date.now() - cached.timestamp < this.CACHE_DURATION) {
            return cached.pricing;
        }

        const pricing = await this.fetchPricing(provider, modelId);
        if (pricing) {
            this.pricingCache.set(cacheKey, { pricing, timestamp: Date.now() });
        }

        return pricing;
    }

    private async fetchPricing(provider: string, modelId: string): Promise<PricingInfo | null> {
        try {
            switch (provider) {
                case 'openai':
                    return await this.fetchOpenAIPricing(modelId);
                case 'anthropic':
                    return await this.fetchAnthropicPricing(modelId);
                case 'google':
                    return await this.fetchGooglePricing(modelId);
                case 'groq':
                    return await this.fetchGroqPricing(modelId);
                case 'xai':
                    return await this.fetchXAIPricing(modelId);
                default:
                    // Fallback to OpenRouter for all other providers
                    return await this.fetchOpenRouterPricing(`${provider}/${modelId}`);
            }
        } catch (error) {
            console.warn(`Failed to fetch pricing for ${provider}/${modelId}, falling back to OpenRouter:`, error);
            return await this.fetchOpenRouterPricing(`${provider}/${modelId}`);
        }
    }

    private async fetchOpenRouterPricing(modelId: string): Promise<PricingInfo | null> {
        try {
            const response = await fetch('https://openrouter.ai/api/v1/models');
            const data = await response.json();

            const model = data.data.find((m: any) => m.id === modelId);
            if (!model?.pricing) return null;

            return {
                input: model.pricing.prompt / 1000000, // Convert from per-million to per-thousand
                output: model.pricing.completion / 1000000,
                cachedInput: model.pricing.cache_read ? model.pricing.cache_read / 1000000 : undefined
            };
        } catch {
            return null;
        }
    }

    private async fetchOpenAIPricing(modelId: string): Promise<PricingInfo | null> {
        // OpenAI doesn't have a public pricing API, so fallback to OpenRouter
        return await this.fetchOpenRouterPricing(`openai/${modelId}`);
    }

    private async fetchAnthropicPricing(modelId: string): Promise<PricingInfo | null> {
        // Anthropic doesn't have a public pricing API, fallback to OpenRouter
        return await this.fetchOpenRouterPricing(`anthropic/${modelId}`);
    }

    private async fetchGooglePricing(modelId: string): Promise<PricingInfo | null> {
        // Google doesn't have a public pricing API, fallback to OpenRouter
        return await this.fetchOpenRouterPricing(`google/${modelId}`);
    }

    private async fetchGroqPricing(modelId: string): Promise<PricingInfo | null> {
        // Groq pricing, fallback to OpenRouter
        return await this.fetchOpenRouterPricing(`groq/${modelId}`);
    }

    private async fetchXAIPricing(modelId: string): Promise<PricingInfo | null> {
        // xAI pricing, fallback to OpenRouter
        return await this.fetchOpenRouterPricing(`xai/${modelId}`);
    }
}

##### Cost Calculation with Dynamic Pricing

```typescript
async function calculateCost(provider: string, model: string, usage: LanguageModelUsage): Promise<number> {
    const pricingManager = new DynamicPricingManager();
    const pricing = await pricingManager.getPricing(provider, model);

    if (!pricing) {
        console.warn(`Could not determine pricing for ${provider}/${model}`);
        return 0;
    }

    const inputCost = ((usage.inputTokens || 0) * pricing.input) / 1000;
    const outputCost = ((usage.outputTokens || 0) * pricing.output) / 1000;
    const cachedInputCost = pricing.cachedInput
        ? ((usage.cachedInputTokens || 0) * pricing.cachedInput) / 1000
        : 0;

    return inputCost + outputCost + cachedInputCost;
}
````

##### Cost Display & Alerts

```typescript
interface CostBreakdown {
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    totalTokens: number;
    cost: number;
    currency: string;
}

function displayCostBreakdown(breakdowns: CostBreakdown[]) {
    console.log("\n=== Cost Breakdown ===");

    breakdowns.forEach((bd) => {
        console.log(`${bd.provider}/${bd.model}:`);
        console.log(
            `  Input: ${formatTokens(bd.inputTokens)} (${formatCost(bd.cost * (bd.inputTokens / bd.totalTokens))})`
        );
        console.log(
            `  Output: ${formatTokens(bd.outputTokens)} (${formatCost(bd.cost * (bd.outputTokens / bd.totalTokens))})`
        );
        console.log(`  Cached: ${formatTokens(bd.cachedInputTokens)}`);
        console.log(`  Total: ${formatTokens(bd.totalTokens)} (${formatCost(bd.cost)})`);
    });

    const totalCost = breakdowns.reduce((sum, bd) => sum + bd.cost, 0);
    console.log(`\nGrand Total: ${formatCost(totalCost)}`);

    // Cost alerts
    if (totalCost > 0.1) {
        // $0.10 threshold
        console.log("⚠️  High cost alert: This session has exceeded $0.10");
    }
}

function formatTokens(tokens: number): string {
    return `${(tokens / 1000).toFixed(1)}k`;
}

function formatCost(cost: number): string {
    return `$${cost.toFixed(4)}`;
}
```

#### Cost Tracking Implementation

```typescript
class CostTracker {
    private sessionCosts = new Map<string, CostBreakdown>();

    async trackUsage(provider: string, model: string, usage: LanguageModelUsage) {
        const key = `${provider}/${model}`;
        const existing = this.sessionCosts.get(key) || {
            provider,
            model,
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            totalTokens: 0,
            cost: 0,
            currency: "USD",
        };

        existing.inputTokens += usage.inputTokens || 0;
        existing.outputTokens += usage.outputTokens || 0;
        existing.cachedInputTokens += usage.cachedInputTokens || 0;
        existing.totalTokens += usage.totalTokens || 0;
        existing.cost += await this.calculateCost(provider, model, usage);

        this.sessionCosts.set(key, existing);
    }

    getBreakdown(): CostBreakdown[] {
        return Array.from(this.sessionCosts.values());
    }

    private async calculateCost(provider: string, model: string, usage: LanguageModelUsage): Promise<number> {
        return await calculateCost(provider, model, usage);
    }
}
```

#### Cost Alert System

-   **Per-session alerts**: Warn when session exceeds $0.10
-   **Daily limits**: Optional daily spending caps
-   **Provider-specific limits**: Different limits per provider
-   **Cost prediction**: Show estimated cost before long operations

## Implementation Details & Gotchas

### Vercel AI SDK Specifics

#### Provider Setup with Dynamic Imports

```typescript
// Dynamic provider imports to avoid bundling unused providers
const PROVIDER_MODULES = {
    openai: () => import("@ai-sdk/openai"),
    anthropic: () => import("@ai-sdk/anthropic"),
    google: () => import("@ai-sdk/google"),
    "openai-compatible": () => import("@ai-sdk/openai"),
};

async function createProvider(providerName: string, apiKey?: string, baseURL?: string) {
    const moduleFactory = PROVIDER_MODULES[providerName];
    if (!moduleFactory) throw new Error(`Unsupported provider: ${providerName}`);

    const module = await moduleFactory();

    switch (providerName) {
        case "openai":
            return module.openai(apiKey);
        case "openai-compatible":
            return module.createOpenAI({ apiKey, baseURL });
        // Handle other providers...
    }
}
```

#### Streaming with Tool Calls

```typescript
// The AI SDK handles tool calling automatically in streamText
const result = streamText({
    model: selectedModel,
    messages: conversationHistory,
    tools: {
        searchWeb: searchTool, // Web search tool
        // Other tools...
    },
    onFinish: async ({ usage, toolCalls }) => {
        // Track usage and tool calls for cost calculation
        await costTracker.trackUsage(provider, model, usage);
        toolCalls?.forEach((call) => {
            console.log(`Tool executed: ${call.toolName}`);
        });
    },
});

// Stream output immediately
for await (const chunk of result.textStream) {
    process.stdout.write(chunk);
}
```

#### Speech-to-Text Implementation

```typescript
// Note: OpenAI Whisper doesn't support streaming transcription
// For streaming STT, would need to use a different provider or chunking

async function transcribeAudio(filePath: string): Promise<string> {
    const audioData = await Bun.file(filePath).arrayBuffer();

    // Check file size (Whisper has 25MB limit)
    if (audioData.byteLength > 25 * 1024 * 1024) {
        throw new Error("Audio file too large (max 25MB)");
    }

    const result = await generateText({
        model: openai("whisper-1"),
        messages: [
            {
                role: "user",
                content: [
                    {
                        type: "file",
                        data: audioData,
                        mimeType: getMimeType(filePath), // 'audio/mpeg', 'audio/wav', etc.
                    },
                ],
            },
        ],
    });

    return result.text;
}

// For streaming transcription (if needed):
// Would require chunking audio and transcribing segments
// This is complex and may not be necessary for initial implementation
```

#### Conversation File Management

```typescript
class ConversationManager {
    private conversationsDir = "./conversations";

    async saveConversation(session: ChatSession): Promise<void> {
        await Bun.write(this.getFilePath(session.id), JSON.stringify(session, null, 2));
    }

    async loadConversation(sessionId: string): Promise<ChatSession | null> {
        try {
            const data = await Bun.file(this.getFilePath(sessionId)).text();
            return JSON.parse(data);
        } catch {
            return null;
        }
    }

    private getFilePath(sessionId: string): string {
        return `${this.conversationsDir}/${sessionId}.json`;
    }

    async listConversations(): Promise<string[]> {
        const files = await glob(`${this.conversationsDir}/*.json`);
        return files.map((f) => path.basename(f, ".json"));
    }
}
```

### Special Commands Implementation

```typescript
const SPECIAL_COMMANDS = {
    "/model": async () => {
        const newModel = await selectModel(providers);
        currentModel = newModel;
        console.log(`Switched to ${newModel.provider}/${newModel.model}`);
    },

    "/output": async (format?: string) => {
        if (!format) {
            // Show available formats
            console.log("Available formats: text, json, markdown, clipboard, file <name>");
            return;
        }

        if (format.startsWith("file ")) {
            outputFormat = { type: "file", filename: format.slice(5) };
        } else {
            outputFormat = { type: format as OutputFormat };
        }
    },

    "/quit": () => {
        shouldExit = true;
    },

    "/clear": () => {
        conversationHistory.length = 0;
        console.log("Conversation history cleared");
    },

    "/save": async () => {
        await conversationManager.saveConversation(currentSession);
        console.log("Conversation saved");
    },

    "/help": () => {
        console.log(`
Available commands:
/model - Switch model
/output <format> - Change output format (text/json/markdown/clipboard/file <name>)
/clear - Clear conversation history
/save - Save current conversation
/sst <file> - Transcribe audio file
/help - Show this help
/quit - Exit chat
    `);
    },
};
```

### Error Handling Patterns

```typescript
// API Key validation
async function validateApiKey(provider: string, key: string): Promise<boolean> {
    try {
        // Quick validation by making a minimal request
        const testModel = getTestModelForProvider(provider);
        await generateText({
            model: testModel,
            prompt: "test",
            maxTokens: 1,
        });
        return true;
    } catch (error) {
        logger.warn(`API key validation failed for ${provider}: ${error.message}`);
        return false;
    }
}

// Rate limit handling
function withRetry<T>(operation: () => Promise<T>, maxRetries = 3): Promise<T> {
    return operation().catch((error) => {
        if (maxRetries > 0 && isRetryableError(error)) {
            const delay = Math.pow(2, 4 - maxRetries) * 1000; // Exponential backoff
            return new Promise((resolve) => setTimeout(resolve, delay)).then(() =>
                withRetry(operation, maxRetries - 1)
            );
        }
        throw error;
    });
}

function isRetryableError(error: any): boolean {
    return error?.status === 429 || error?.status >= 500;
}
```

### Performance Optimizations

-   **Lazy provider loading**: Only import provider SDKs when needed
-   **Connection pooling**: Reuse HTTP connections where possible
-   **Caching**: Cache model lists and pricing data (1 hour TTL)
-   **Chunked output**: No artificial delays in streaming
-   **Memory management**: Clear large objects when not needed
-   **Audio chunking**: Smart splitting for large files
-   **Cost prediction**: Pre-calculate costs for operations

## Complete Implementation Architecture

### Main Entry Point (`index.ts`)

```typescript
#!/usr/bin/env bun
import minimist from "minimist";
import Enquirer from "enquirer";
import chalk from "chalk";
import clipboardy from "clipboardy";
import logger from "../logger";

interface Options {
    sst?: string; // Speech-to-text file
    model?: string; // Specific model
    provider?: string; // Specific provider
    output?: string; // Output format
    help?: boolean; // Show help
    version?: boolean; // Show version
}

interface Args extends Options {
    _: string[]; // Message to send
}

const prompter = new Enquirer();

async function main() {
    const argv = minimist<Args>(process.argv.slice(2), {
        alias: {
            s: "sst",
            m: "model",
            p: "provider",
            o: "output",
            h: "help",
            v: "version",
        },
        boolean: ["help", "version"],
        string: ["sst", "model", "provider", "output"],
    });

    // Show help if requested
    if (argv.help) {
        showHelp();
        process.exit(0);
    }

    if (argv.version) {
        console.log("ASK Tool v1.0.0");
        process.exit(0);
    }

    // Handle speech-to-text
    if (argv.sst) {
        await handleSpeechToText(argv.sst, argv.output);
        return;
    }

    // Handle single message
    if (argv._.length > 0) {
        await handleSingleMessage(argv);
        return;
    }

    // Start interactive chat
    await startInteractiveChat(argv);
}

async function handleSpeechToText(filePath: string, outputFormat?: string) {
    try {
        console.log(chalk.blue("🎤 Transcribing audio..."));

        if (!validateAudioFile(filePath)) {
            throw new Error(`Unsupported audio format. Supported: MP3, WAV, M4A, AAC, OGG, FLAC, WebM, MP4`);
        }

        const transcript = await transcribeWithErrorRecovery(filePath);

        // Handle output
        if (outputFormat === "clipboard") {
            await clipboardy.write(transcript);
            console.log(chalk.green("✅ Transcript copied to clipboard!"));
        } else if (outputFormat?.startsWith("file ")) {
            const filename = outputFormat.slice(5);
            await Bun.write(filename, transcript);
            console.log(chalk.green(`✅ Transcript saved to ${filename}`));
        } else {
            console.log(chalk.green("\n=== TRANSCRIPT ===\n"));
            console.log(transcript);
        }
    } catch (error) {
        logger.error(`Speech-to-text failed: ${error}`);
        process.exit(1);
    }
}

async function handleSingleMessage(options: Args) {
    try {
        const message = options._.join(" ");
        const provider = await determineProvider(options.provider);
        const model = await determineModel(provider, options.model);

        console.log(chalk.blue(`🤖 Using ${provider.name}/${model.name}`));

        const result = await streamText({
            model: model.model,
            prompt: message,
            tools: getAvailableTools(),
        });

        // Stream response
        let fullResponse = "";
        for await (const chunk of result.textStream) {
            process.stdout.write(chunk);
            fullResponse += chunk;
        }

        console.log(); // New line

        // Show cost if available
        if (result.usage) {
            await displayCostBreakdown([
                {
                    provider: provider.name,
                    model: model.name,
                    ...result.usage,
                    cost: await calculateCost(provider.name, model.name, result.usage),
                    currency: "USD",
                },
            ]);
        }
    } catch (error) {
        logger.error(`Chat failed: ${error}`);
        process.exit(1);
    }
}

async function startInteractiveChat(options: Args) {
    console.log(chalk.green("🚀 Starting interactive chat mode"));
    console.log(chalk.gray("Type /help for available commands, /quit to exit\n"));

    const provider = await determineProvider(options.provider);
    let currentModel = await determineModel(provider, options.model);

    console.log(chalk.blue(`🤖 Starting with ${provider.name}/${currentModel.name}`));

    let conversationHistory: ChatMessage[] = [];
    let outputFormat: OutputFormat = "text";

    while (true) {
        try {
            const { message } = await prompter.prompt({
                type: "input",
                name: "message",
                message: chalk.cyan("You:"),
                validate: (input: string) => {
                    if (input.startsWith("/")) {
                        return isValidCommand(input) || "Unknown command. Type /help for available commands.";
                    }
                    return input.trim().length > 0 || "Please enter a message or command.";
                },
            });

            // Handle special commands
            if (message.startsWith("/")) {
                const handled = await handleCommand(message, provider, currentModel, conversationHistory, outputFormat);
                if (handled.provider) provider = handled.provider;
                if (handled.model) currentModel = handled.model;
                if (handled.outputFormat) outputFormat = handled.outputFormat;
                if (handled.shouldExit) break;
                continue;
            }

            // Regular chat message
            conversationHistory.push({
                role: "user",
                content: message,
                timestamp: new Date(),
                tokens: estimateTokens(message),
            });

            console.log(chalk.yellow("\nAssistant:"));

            const result = await streamText({
                model: currentModel.model,
                messages: conversationHistory.map((msg) => ({
                    role: msg.role,
                    content: msg.content,
                })),
                tools: getAvailableTools(),
            });

            let fullResponse = "";
            for await (const chunk of result.textStream) {
                process.stdout.write(chunk);
                fullResponse += chunk;
            }

            console.log(); // New line

            // Add assistant response to history
            conversationHistory.push({
                role: "assistant",
                content: fullResponse,
                timestamp: new Date(),
                tokens: estimateTokens(fullResponse),
                usage: result.usage,
            });

            // Auto-save conversation periodically
            if (conversationHistory.length % 5 === 0) {
                await saveConversation(conversationHistory, currentModel);
            }

            // Show cost if available
            if (result.usage) {
                await displayCostBreakdown([
                    {
                        provider: provider.name,
                        model: currentModel.name,
                        ...result.usage,
                        cost: await calculateCost(provider.name, currentModel.name, result.usage),
                        currency: "USD",
                    },
                ]);
            }
        } catch (error) {
            logger.error(`Chat error: ${error}`);
            console.log(chalk.red("💥 Error occurred. Type /quit to exit or continue chatting."));
        }
    }
}

function showHelp() {
    console.log(`
ASK Tool - Multi-Router LLM Chat Application

Usage:
  tools ask [options] [message]

Options:
  -s, --sst <file>     Transcribe audio file
  -m, --model <model>  Specify model (e.g., gpt-4-turbo)
  -p, --provider <prov> Specify provider (e.g., openai)
  -o, --output <format> Output format (text/json/clipboard/file)
  -h, --help           Show this help
  -v, --version        Show version

Examples:
  tools ask "What is AI?"                              # Single question
  tools ask --model gpt-4-turbo "Explain quantum computing"
  tools ask --sst recording.mp3                        # Transcribe audio
  tools ask --output clipboard "Generate todo list"    # Copy to clipboard

Interactive Mode:
  tools ask                                            # Start interactive chat

Available Commands in Chat:
  /model              Switch model
  /output <format>    Change output format
  /clear              Clear conversation history
  /save               Save conversation
  /sst <file>         Transcribe audio file
  /help               Show available commands
  /quit               Exit chat
  `);
}

// Run the tool
main().catch((err) => {
    logger.error(`Unexpected error: ${err}`);
    process.exit(1);
});
```

## Implementation Priority Matrix

### Phase 1: Core Infrastructure (MVP)

#### Must-Have for First Working Version

-   [x] Environment scanning for API keys ✅ **COMPLETED** - Implemented in `ProviderManager.ts`
-   [x] Basic provider setup (OpenAI, xAI, OpenRouter) ✅ **COMPLETED** - Implemented in `providers.ts` with 7 providers
-   [x] Interactive model selection with autocomplete ✅ **COMPLETED** - Implemented in `ModelSelector.ts`
-   [x] Interactive chat mode with special commands (/model, /output, /quit, etc.) ✅ **COMPLETED** - Implemented in `CommandHandler.ts`
-   [x] CLI argument parsing (including --sst for speech-to-text) ✅ **COMPLETED** - Implemented in `cli.ts`
-   [x] Streaming responses (fast as possible) ✅ **COMPLETED** - Implemented in `ChatEngine.ts`
-   [x] Output format selection (/output command) ✅ **COMPLETED** - Implemented in `OutputManager.ts`
-   [x] Conversation persistence (JSON files on disk) ✅ **COMPLETED** - Implemented in `ConversationManager.ts`
-   [x] Basic cost tracking (token counts in "k" format) ✅ **COMPLETED** - Implemented in `CostTracker.ts` and `DynamicPricing.ts`

### Phase 2: Enhanced Features

#### Core Chat Experience

-   [x] Web search tool integration (Brave Search API) ✅ **COMPLETED** - Implemented in `websearch.ts` with Brave Search API
-   [x] Speech-to-text support (Whisper via OpenAI) ✅ **COMPLETED** - Implemented in `TranscriptionManager.ts` with multiple providers (Groq, OpenAI, AssemblyAI, Deepgram, Gladia)
-   [x] Multi-turn conversations with history ✅ **COMPLETED** - Implemented in `ChatEngine.ts` with conversation history management
-   [x] Dynamic model discovery (query provider APIs) ✅ **COMPLETED** - Implemented in `ProviderManager.ts` for OpenRouter, known models for others
-   [x] Error handling & recovery ✅ **COMPLETED** - Error handling implemented throughout, fallback providers for transcription
-   [x] More providers (Anthropic, Google, Jina) ✅ **COMPLETED** - All 7 providers implemented: OpenAI, Groq, OpenRouter, Anthropic, Google, xAI, Jina

#### Cost & Analytics

-   [x] Advanced cost tracking (per-provider breakdown with $) ✅ **COMPLETED** - Implemented in `CostTracker.ts` and `DynamicPricing.ts` with dynamic pricing from OpenRouter
-   [x] Cost alerts and spending limits ✅ **COMPLETED** - Implemented in `CostTracker.ts` with daily/session limits and warnings
-   [x] Cost prediction before operations ✅ **COMPLETED** - Implemented in `CostPredictor.ts`, use `--predict-cost` flag
-   [x] Usage analytics and reporting ✅ **COMPLETED** - Implemented in `usage` tool with SQLite database at `~/.genesis-tools/ask.sqlite`

### Phase 3: Advanced Capabilities

#### Extended Functionality

-   [ ] Tool calling integration (GenesisTools integration) ❌ **NOT IMPLEMENTED** - Only web search tool exists, no GenesisTools integration
-   [ ] Agent modes (autonomous multi-step workflows) ❌ **NOT IMPLEMENTED**
-   [ ] Multi-modal support (image generation/analysis) ❌ **NOT IMPLEMENTED**
-   [ ] Batch processing (multiple questions from files) ❌ **NOT IMPLEMENTED**
-   [x] Conversation loading and management ✅ **PARTIALLY COMPLETED** - Can load/list conversations via `ConversationManager.ts`, but no CLI commands for loading
-   [ ] Configuration persistence (preferred models/settings) ❌ **NOT IMPLEMENTED** - No config file persistence

#### Quality of Life

-   [ ] Progress indicators for long operations ❌ **NOT IMPLEMENTED** - No progress spinners/indicators for long operations
-   [ ] Conversation search and filtering ❌ **NOT IMPLEMENTED** - Can list conversations but no search/filter
-   [x] Export conversations to different formats ✅ **COMPLETED** - Implemented in `ConversationManager.ts` (JSON, Markdown, TXT)
-   [ ] Keyboard shortcuts and advanced commands ❌ **NOT IMPLEMENTED** - Only basic commands exist
-   [ ] Plugin system for custom tools/providers ❌ **NOT IMPLEMENTED**

## Success Metrics

### Functional Metrics

-   **Provider Detection**: Successfully detect 90%+ of available API keys
-   **Model Availability**: 95%+ of detected providers have working models
-   **Response Quality**: All responses complete without errors
-   **Streaming Performance**: <100ms latency for streaming chunks

### UX Metrics

-   **Time to First Response**: <3 seconds for model selection + first response
-   **Error Rate**: <5% of interactions result in errors
-   **User Satisfaction**: Intuitive interface requiring minimal documentation

### Performance Metrics

-   **Memory Usage**: <100MB for typical chat sessions
-   **API Efficiency**: Minimize unnecessary API calls
-   **Startup Time**: <500ms tool initialization

## Conclusion

The `ask` tool will be a powerful, flexible multi-provider LLM chat application that leverages the Vercel AI SDK's capabilities to provide a unified interface to dozens of AI models. The modular architecture will allow for easy extension and maintenance while providing both simple CLI usage and rich interactive experiences.

The implementation should start with core functionality (provider detection, basic chat) and incrementally add advanced features based on user feedback and requirements clarification.
