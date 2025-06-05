import { z, ZodRawShape } from 'zod';
import {
  ToolDefinition,
  IntensiveChatToolDefinitions,
  ToolCapabilityInfo,
  ToolRegistrationDescription,
} from './types.js';

// === Start Intensive Chat Definition ===

const startCapability: ToolCapabilityInfo = {
  description:
    'Start an intensive chat session for gathering multiple answers quickly.',
  parameters: {
    type: 'object',
    properties: {
      sessionTitle: {
        type: 'string',
        description: 'Title for the intensive chat session',
      },
    },
    required: ['sessionTitle'],
  },
};

const startDescription: ToolRegistrationDescription = (
  globalTimeoutSeconds: number,
) => `<description>
Start an intensive chat session for gathering multiple answers quickly from the user.
**Highly recommended** for scenarios requiring a sequence of related inputs or confirmations.
Very useful for gathering multiple answers from the user in a short period of time.
Especially useful for brainstorming ideas or discussing complex topics with the user.
</description>

<importantNotes>
- (!important!) Opens a persistent console window that stays open for multiple questions.
- (!important!) Returns a session ID that **must** be used for subsequent questions via 'ask_intensive_chat'.
- (!important!) **Must** be closed with 'stop_intensive_chat' when finished gathering all inputs.
- (!important!) After starting a session, **immediately** continue asking all necessary questions using 'ask_intensive_chat' within the **same response message**. Do not end the response until the chat is closed with 'stop_intensive_chat'. This creates a seamless conversational flow for the user.
</importantNotes>

<whenToUseThisTool>
- When you need to collect a series of quick answers from the user (more than 2-3 questions)
- When setting up a project with multiple configuration options
- When guiding a user through a multi-step process requiring input at each stage
- When gathering sequential user preferences
- When you want to maintain context between multiple related questions efficiently
- When brainstorming ideas with the user interactively
</whenToUseThisTool>

<features>
- Opens a persistent console window for continuous interaction
- Supports starting with an initial question
- Configurable timeout for each question (set via -t/--timeout, defaults to ${globalTimeoutSeconds} seconds)
- Returns a session ID for subsequent interactions
- Keeps full chat history visible to the user
- Maintains state between questions
</features>

<bestPractices>
- Use a descriptive session title related to the task
- Start with a clear initial question when possible
- Do not ask the question if you have another tool that can answer the question
  - e.g. when you searching file in the current repository, do not ask the question "Do you want to search for a file in the current repository?"
  - e.g. prefer to use other tools to find the answer (Cursor tools or other MCP Server tools)
- Always store the returned session ID for later use
- Always close the session when you're done with stop_intensive_chat
</bestPractices>

<parameters>
- sessionTitle: Title for the intensive chat session (appears at the top of the console)
</parameters>

<examples>
- Start session for project setup: { "sessionTitle": "Project Configuration" }
</examples>`;

const startSchema: ZodRawShape = {
  sessionTitle: z.string().describe('Title for the intensive chat session'),
};

const startToolDefinition: ToolDefinition = {
  capability: startCapability,
  description: startDescription,
  schema: startSchema,
};

// === Ask Intensive Chat Definition ===

const askCapability: ToolCapabilityInfo = {
  description: 'Ask a question in an active intensive chat session.',
  parameters: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'ID of the intensive chat session',
      },
      question: {
        type: 'string',
        description: 'Question to ask the user',
      },
      predefinedOptions: {
        type: 'array',
        items: { type: 'string' },
        optional: true,
        description:
          'Predefined options for the user to choose from (optional)',
      },
    },
    required: ['sessionId', 'question'],
  },
};

const askDescription: ToolRegistrationDescription = `<description>
Ask a new question in an active intensive chat session previously started with 'start_intensive_chat'.
</description>

<importantNotes>
- (!important!) Requires a valid session ID from 'start_intensive_chat'.
- (!important!) Supports predefined options for quick selection.
- (!important!) Returns the user's answer or indicates if they didn't respond.
- (!important!) **Use this repeatedly within the same response message** after 'start_intensive_chat' until all questions are asked.
</importantNotes>

<whenToUseThisTool>
- When continuing a series of questions in an intensive chat session.
- When you need the next piece of information in a multi-step process initiated via 'start_intensive_chat'.
- When offering multiple choice options to the user within the session.
- When gathering sequential information from the user within the session.
</whenToUseThisTool>

<features>
- Adds a new question to an existing chat session
- Supports predefined options for quick selection
- Returns the user's response
- Maintains the chat history in the console
</features>

<bestPractices>
- Ask one clear question at a time
- Provide predefined options when applicable
- Don't ask overly complex questions
- Keep questions focused on a single piece of information
</bestPractices>

<parameters>
- sessionId: ID of the intensive chat session (from start_intensive_chat)
- question: The question text to display to the user
- predefinedOptions: Array of predefined options for the user to choose from (optional)
</parameters>

<examples>
- Simple question: { "sessionId": "abcd1234", "question": "What is your project named?" }
- With predefined options: { "sessionId": "abcd1234", "question": "Would you like to use TypeScript?", "predefinedOptions": ["Yes", "No"] }
</examples>`;

const askSchema: ZodRawShape = {
  sessionId: z.string().describe('ID of the intensive chat session'),
  question: z.string().describe('Question to ask the user'),
  predefinedOptions: z
    .array(z.string())
    .optional()
    .describe('Predefined options for the user to choose from (optional)'),
};

const askToolDefinition: ToolDefinition = {
  capability: askCapability,
  description: askDescription,
  schema: askSchema,
};

// === Stop Intensive Chat Definition ===

const stopCapability: ToolCapabilityInfo = {
  description: 'Stop and close an active intensive chat session.',
  parameters: {
    type: 'object',
    properties: {
      sessionId: {
        type: 'string',
        description: 'ID of the intensive chat session to stop',
      },
    },
    required: ['sessionId'],
  },
};

const stopDescription: ToolRegistrationDescription = `<description>
  Stop and close an active intensive chat session. **Must be called** after all questions have been asked using 'ask_intensive_chat'.
</description>

<importantNotes>
- (!important!) Closes the console window for the intensive chat.
- (!important!) Frees up system resources.
- (!important!) **Should always be called** as the final step when finished with an intensive chat session, typically at the end of the response message where 'start_intensive_chat' was called.
</importantNotes>

<whenToUseThisTool>
- When you've completed gathering all needed information via 'ask_intensive_chat'.
- When the multi-step process requiring intensive chat is complete.
- When you're ready to move on to processing the collected information.
- When the user indicates they want to end the session (if applicable).
- As the final action related to the intensive chat flow within a single response message.
</whenToUseThisTool>

<features>
- Gracefully closes the console window
- Cleans up system resources
- Marks the session as complete
</features>

<bestPractices>
- Always stop sessions when you're done to free resources
- Provide a summary of the information collected before stopping
</bestPractices>

<parameters>
- sessionId: ID of the intensive chat session to stop
</parameters>

<examples>
- { "sessionId": "abcd1234" }
</examples>`;

const stopSchema: ZodRawShape = {
  sessionId: z.string().describe('ID of the intensive chat session to stop'),
};

const stopToolDefinition: ToolDefinition = {
  capability: stopCapability,
  description: stopDescription,
  schema: stopSchema,
};

// === Export Combined Intensive Chat Definitions ===

export const intensiveChatTools: IntensiveChatToolDefinitions = {
  start: startToolDefinition,
  ask: askToolDefinition,
  stop: stopToolDefinition,
};
