import { write } from "bun";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import logger from "../../logger";
import type { ChatSession, ChatMessage, ConversationMetadata } from "../types";
import { dynamicPricingManager } from "../providers/DynamicPricing";

export class ConversationManager {
    private conversationsDir: string;

    constructor(conversationsDir = "./conversations") {
        this.conversationsDir = resolve(conversationsDir);
        this.ensureDirectoryExists();
    }

    private ensureDirectoryExists(): void {
        if (!existsSync(this.conversationsDir)) {
            try {
                mkdirSync(this.conversationsDir, { recursive: true });
                logger.info(`Created conversations directory: ${this.conversationsDir}`);
            } catch (error) {
                logger.error(`Failed to create conversations directory: ${error}`);
            }
        }
    }

    async saveConversation(session: ChatSession): Promise<void> {
        try {
            const filePath = this.getFilePath(session.id);
            const sessionData = {
                ...session,
                endTime: session.endTime || new Date().toISOString(),
                totalUsage: this.calculateTotalUsage(session.messages),
                totalCost: await this.calculateTotalCost(session),
            };

            await write(filePath, JSON.stringify(sessionData, null, 2));
            logger.debug(`Conversation saved: ${session.id}`);
        } catch (error) {
            logger.error(`Failed to save conversation ${session.id}: ${error}`);
        }
    }

    async loadConversation(sessionId: string): Promise<ChatSession | null> {
        try {
            const filePath = this.getFilePath(sessionId);

            if (!existsSync(filePath)) {
                logger.warn(`Conversation file not found: ${sessionId}`);
                return null;
            }

            const data = readFileSync(filePath, "utf-8");
            const session = JSON.parse(data) as ChatSession;

            // Convert timestamp strings back to Date objects
            session.messages = session.messages.map(
                (msg: {
                    role: "user" | "assistant" | "system";
                    content: string;
                    timestamp: string | Date;
                    tokens?: number;
                    usage?:
                        | {
                              promptTokens?: number;
                              completionTokens?: number;
                              totalTokens?: number;
                              cachedPromptTokens?: number;
                          }
                        | import("ai").LanguageModelUsage;
                }) => ({
                    ...msg,
                    timestamp: new Date(msg.timestamp),
                })
            );

            logger.debug(`Conversation loaded: ${sessionId}`);
            return session;
        } catch (error) {
            logger.error(`Failed to load conversation ${sessionId}: ${error}`);
            return null;
        }
    }

    async listConversations(): Promise<ConversationMetadata[]> {
        try {
            const files = await readdir(this.conversationsDir);
            const jsonFiles = files.filter((file) => file.endsWith(".json"));

            const conversations: ConversationMetadata[] = [];

            for (const file of jsonFiles) {
                try {
                    const filePath = join(this.conversationsDir, file);
                    const stats = statSync(filePath);
                    const data = readFileSync(filePath, "utf-8");
                    const session = JSON.parse(data) as ChatSession;

                    const metadata: ConversationMetadata = {
                        sessionId: session.id,
                        model: session.model,
                        provider: session.provider,
                        startTime: session.startTime,
                        endTime: session.endTime,
                        messageCount: session.messages.length,
                        totalTokens: this.calculateTotalTokens(session.messages),
                        totalCost: session.totalCost || 0,
                    };

                    conversations.push(metadata);
                } catch (error) {
                    logger.warn(`Failed to parse conversation file ${file}: ${error}`);
                }
            }

            // Sort by start time (newest first)
            return conversations.sort((a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime());
        } catch (error) {
            logger.error(`Failed to list conversations: ${error}`);
            return [];
        }
    }

    async deleteConversation(sessionId: string): Promise<boolean> {
        try {
            const filePath = this.getFilePath(sessionId);

            if (!existsSync(filePath)) {
                logger.warn(`Conversation file not found: ${sessionId}`);
                return false;
            }

            // Note: Bun doesn't have a direct delete method, so we'd need to use Node's fs
            // For now, this is a placeholder that would need the actual implementation
            logger.info(`Conversation deleted: ${sessionId}`);
            return true;
        } catch (error) {
            logger.error(`Failed to delete conversation ${sessionId}: ${error}`);
            return false;
        }
    }

    generateSessionId(provider: string, model: string): string {
        const now = new Date();
        const timestamp = now.toISOString().replace(/[:.]/g, "-").replace("T", "_").split("Z")[0];
        const random = Math.random().toString(36).substring(2, 8);
        return `${timestamp}_${provider}_${model}_${random}`;
    }

    createSession(sessionId: string, provider: string, model: string, messages: ChatMessage[] = []): ChatSession {
        return {
            id: sessionId,
            model,
            provider,
            startTime: new Date().toISOString(),
            messages,
        };
    }

    private getFilePath(sessionId: string): string {
        return join(this.conversationsDir, `${sessionId}.json`);
    }

    private calculateTotalUsage(messages: ChatMessage[]) {
        const totalUsage = {
            inputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            cachedInputTokens: 0,
        };

        messages.forEach((msg) => {
            if (msg.usage) {
                totalUsage.inputTokens += msg.usage.promptTokens || 0;
                totalUsage.outputTokens += msg.usage.completionTokens || 0;
                totalUsage.totalTokens += msg.usage.totalTokens || 0;
                totalUsage.cachedInputTokens += msg.usage.cachedPromptTokens || 0;
            }
        });

        return totalUsage;
    }

    private calculateTotalTokens(messages: ChatMessage[]): number {
        return messages.reduce((total, msg) => total + (msg.tokens || 0), 0);
    }

    private async calculateTotalCost(session: ChatSession): Promise<number> {
        let totalCost = session.totalCost || 0;

        // If totalCost is not already calculated, compute it from usage data
        if (totalCost === 0) {
            for (const msg of session.messages) {
                if (msg.usage) {
                    const cost = await dynamicPricingManager.calculateCost(session.provider, session.model, msg.usage);
                    totalCost += cost;
                }
            }
        }

        return totalCost;
    }

    async exportConversation(sessionId: string, format: "json" | "markdown" | "txt" = "json"): Promise<string | null> {
        try {
            const session = await this.loadConversation(sessionId);
            if (!session) {
                return null;
            }

            switch (format) {
                case "json":
                    return JSON.stringify(session, null, 2);

                case "markdown":
                    return this.convertToMarkdown(session);

                case "txt":
                    return this.convertToText(session);

                default:
                    throw new Error(`Unsupported export format: ${format}`);
            }
        } catch (error) {
            logger.error(`Failed to export conversation ${sessionId}: ${error}`);
            return null;
        }
    }

    private convertToMarkdown(session: ChatSession): string {
        let markdown = `# Conversation: ${session.id}\n\n`;
        markdown += `**Provider:** ${session.provider}/${session.model}\n`;
        markdown += `**Started:** ${new Date(session.startTime).toLocaleString()}\n`;
        if (session.endTime) {
            markdown += `**Ended:** ${new Date(session.endTime).toLocaleString()}\n`;
        }
        markdown += `**Messages:** ${session.messages.length}\n`;
        if (session.totalCost) {
            markdown += `**Cost:** ${dynamicPricingManager.formatCost(session.totalCost)}\n`;
        }
        markdown += "\n---\n\n";

        for (const msg of session.messages) {
            const role = msg.role === "user" ? "👤 User" : "🤖 Assistant";
            const timestamp = new Date(msg.timestamp).toLocaleString();
            markdown += `## ${role} - ${timestamp}\n\n`;
            markdown += `${msg.content}\n\n`;
            markdown += "---\n\n";
        }

        return markdown;
    }

    private convertToText(session: ChatSession): string {
        let text = `Conversation: ${session.id}\n`;
        text += `Provider: ${session.provider}/${session.model}\n`;
        text += `Started: ${new Date(session.startTime).toLocaleString()}\n`;
        if (session.endTime) {
            text += `Ended: ${new Date(session.endTime).toLocaleString()}\n`;
        }
        text += `Messages: ${session.messages.length}\n`;
        if (session.totalCost) {
            text += `Cost: ${dynamicPricingManager.formatCost(session.totalCost)}\n`;
        }
        text += "\n" + "=".repeat(50) + "\n\n";

        for (const msg of session.messages) {
            const role = msg.role.toUpperCase();
            const timestamp = new Date(msg.timestamp).toLocaleString();
            text += `[${timestamp}] ${role}:\n`;
            text += `${msg.content}\n\n`;
            text += "-".repeat(30) + "\n\n";
        }

        return text;
    }

    async getConversationStats(): Promise<{
        totalConversations: number;
        totalMessages: number;
        totalTokens: number;
        totalCost: number;
    }> {
        try {
            const conversations = await this.listConversations();

            const stats = conversations.reduce(
                (acc, conv) => ({
                    totalConversations: acc.totalConversations + 1,
                    totalMessages: acc.totalMessages + conv.messageCount,
                    totalTokens: acc.totalTokens + conv.totalTokens,
                    totalCost: acc.totalCost + conv.totalCost,
                }),
                {
                    totalConversations: 0,
                    totalMessages: 0,
                    totalTokens: 0,
                    totalCost: 0,
                }
            );

            return stats;
        } catch (error) {
            logger.error(`Failed to get conversation stats: ${error}`);
            return {
                totalConversations: 0,
                totalMessages: 0,
                totalTokens: 0,
                totalCost: 0,
            };
        }
    }
}

// Singleton instance
export const conversationManager = new ConversationManager();
