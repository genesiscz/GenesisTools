import { OutputFormat, TranscriptionOptions, SearchResult, WebSearchOptions } from "./chat";

export interface CLIOptions {
  sst?: string; // Speech-to-text file
  model?: string; // Specific model
  provider?: string; // Specific provider
  output?: string; // Output format
  interactive?: boolean;
  streaming?: boolean;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  help?: boolean;
  version?: boolean;
  verbose?: boolean;
  silent?: boolean;
  // Aliases
  s?: string;
  m?: string;
  p?: string;
  o?: string;
  h?: boolean;
  v?: boolean;
}

export interface Args extends CLIOptions {
  _: string[]; // Message to send
}

export interface AppConfig {
  defaultProvider?: string;
  defaultModel?: string;
  maxTokens?: number;
  temperature?: number;
  costLimit?: number;
  streaming?: boolean;
  conversationsDir?: string;
}