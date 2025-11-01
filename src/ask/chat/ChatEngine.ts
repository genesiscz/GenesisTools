import { streamText, generateText } from "ai";
import { LanguageModel } from "ai";
import chalk from "chalk";
import logger from "../../logger";
import type { ChatConfig, ChatMessage, LanguageModelUsage } from "../types";
import { dynamicPricingManager } from "../providers/DynamicPricing";

export interface ChatResponse {
  content: string;
  usage?: LanguageModelUsage;
  cost?: number;
  toolCalls?: Array<{
    toolCallType: "function" | "provider";
    toolCallId: string;
    args?: Record<string, unknown>;
  }>;
}

export class ChatEngine {
  private config: ChatConfig;
  private conversationHistory: ChatMessage[] = [];

  constructor(config: ChatConfig) {
    this.config = config;
  }

  async sendMessage(message: string, tools?: Record<string, any>): Promise<ChatResponse> {
    // Add user message to history
    const userMessage: ChatMessage = {
      role: "user",
      content: message,
      timestamp: new Date(),
      tokens: this.estimateTokens(message),
    };

    this.conversationHistory.push(userMessage);

    try {
      let response: ChatResponse;

      if (this.config.streaming) {
        response = await this.sendStreamingMessage(message, tools);
      } else {
        response = await this.sendNonStreamingMessage(message, tools);
      }

      // Add assistant response to history
      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: response.content,
        timestamp: new Date(),
        tokens: this.estimateTokens(response.content),
        usage: response.usage,
      };

      this.conversationHistory.push(assistantMessage);

      return response;

    } catch (error) {
      // Remove the user message if the request failed
      this.conversationHistory.pop();
      throw error;
    }
  }

  private async sendStreamingMessage(message: string, tools?: Record<string, any>): Promise<ChatResponse> {
    const result = await streamText({
      model: this.config.model,
      prompt: message, // Use prompt instead of messages array
      system: this.config.systemPrompt,
      temperature: this.config.temperature,
      maxTokens: this.config.maxTokens,
      onFinish: async ({ usage, toolCalls }) => {
        // This is called when the stream completes
        if (usage) {
          const cost = await dynamicPricingManager.calculateCost(
            this.config.provider,
            this.config.modelName,
            usage
          );
          // We'll handle cost display outside of this method
        }
      },
    });

    let fullResponse = "";
    const startTime = Date.now();

    // Stream output immediately without artificial delays
    for await (const chunk of result.textStream) {
      process.stdout.write(chunk);
      fullResponse += chunk;
    }

    const endTime = Date.now();
    const duration = endTime - startTime;

    // Add a newline after streaming
    process.stdout.write("\n");

    // Calculate cost if usage is available
    let cost: number | undefined;
    if (result.usage) {
      cost = await dynamicPricingManager.calculateCost(
        this.config.provider,
        this.config.modelName,
        result.usage
      );
    }

    return {
      content: fullResponse,
      usage: result.usage,
      cost,
      toolCalls: result.toolCalls,
    };
  }

  private async sendNonStreamingMessage(message: string, tools?: Record<string, any>): Promise<ChatResponse> {
    const result = await generateText({
      model: this.config.model,
      prompt: message, // Use prompt instead of messages array
      system: this.config.systemPrompt,
      temperature: this.config.temperature,
      maxTokens: this.config.maxTokens,
    });

    // Calculate cost
    let cost: number | undefined;
    if (result.usage) {
      cost = await dynamicPricingManager.calculateCost(
        this.config.provider,
        this.config.modelName,
        result.usage
      );
    }

    return {
      content: result.text,
      usage: result.usage,
      cost,
      toolCalls: result.toolCalls,
    };
  }

  private getMessagesForAPI(): Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }> {
    return this.conversationHistory.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));
  }

  updateConfig(newConfig: Partial<ChatConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  getConversationHistory(): ChatMessage[] {
    return [...this.conversationHistory];
  }

  clearConversation(): void {
    this.conversationHistory = [];
  }

  getConversationLength(): number {
    return this.conversationHistory.length;
  }

  getTotalTokens(): number {
    return this.conversationHistory.reduce((total, msg) => total + (msg.tokens || 0), 0);
  }

  // Simple token estimation (rough approximation)
  private estimateTokens(text: string): number {
    // Rough estimation: ~4 characters per token for English
    return Math.ceil(text.length / 4);
  }

  async switchModel(newModel: LanguageModel, provider: string, modelName: string): Promise<void> {
    this.config.model = newModel;
    this.config.provider = provider;
    this.config.modelName = modelName;

    logger.info(`Switched to ${provider}/${modelName}`);
  }

  setSystemPrompt(systemPrompt: string): void {
    this.config.systemPrompt = systemPrompt;
  }

  setTemperature(temperature: number): void {
    this.config.temperature = temperature;
  }

  setMaxTokens(maxTokens: number): void {
    this.config.maxTokens = maxTokens;
  }

  setStreaming(streaming: boolean): void {
    this.config.streaming = streaming;
  }

  getConfig(): ChatConfig {
    return { ...this.config };
  }

  // Export conversation for saving
  exportConversation(): ChatMessage[] {
    return this.conversationHistory.map(msg => ({
      ...msg,
      timestamp: new Date(msg.timestamp), // Ensure timestamp is a Date object
    }));
  }

  // Import conversation (for loading saved conversations)
  importConversation(messages: ChatMessage[]): void {
    this.conversationHistory = messages.map(msg => ({
      ...msg,
      timestamp: new Date(msg.timestamp), // Ensure timestamp is a Date object
    }));
  }

  // Get conversation summary for display
  getConversationSummary(): string {
    if (this.conversationHistory.length === 0) {
      return "No messages yet";
    }

    const userMessages = this.conversationHistory.filter(msg => msg.role === "user").length;
    const assistantMessages = this.conversationHistory.filter(msg => msg.role === "assistant").length;
    const totalTokens = this.getTotalTokens();

    return `${userMessages} user messages, ${assistantMessages} assistant responses, ${dynamicPricingManager.formatTokens(totalTokens)} total tokens`;
  }

  // Get last N messages for context limiting
  getLastMessages(count: number): ChatMessage[] {
    return this.conversationHistory.slice(-count);
  }

  // Remove old messages to keep within context window
  trimToContextWindow(maxTokens: number): void {
    let currentTokens = this.getTotalTokens();

    while (currentTokens > maxTokens && this.conversationHistory.length > 2) {
      // Remove oldest message pair (user + assistant), but always keep the first message if it's a system message
      if (this.conversationHistory[0].role === "system") {
        // Remove the second message if first is system
        const removed = this.conversationHistory.splice(1, 1)[0];
        currentTokens -= removed.tokens || 0;
      } else {
        // Remove the first message
        const removed = this.conversationHistory.shift();
        currentTokens -= removed?.tokens || 0;
      }
    }

    if (this.conversationHistory.length < this.getConversationLength()) {
      logger.info(`Trimmed conversation to fit within ${dynamicPricingManager.formatTokens(maxTokens)} token limit`);
    }
  }
}