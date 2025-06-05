import { z } from 'zod';
import {
  ToolDefinition,
  ToolCapabilityInfo,
  ToolRegistrationDescription,
} from './types.js'; // Import the types

// Define capability conforming to ToolCapabilityInfo
const capabilityInfo: ToolCapabilityInfo = {
  description:
    'Send a question to the user via a pop-up command prompt and await their reply.',
  parameters: {
    type: 'object',
    properties: {
      projectName: {
        type: 'string',
        description:
          'Identifies the context/project making the request (used in prompt formatting)',
      },
      message: {
        type: 'string',
        description:
          'The specific question for the user (appears in the prompt)',
      },
      predefinedOptions: {
        type: 'array',
        items: { type: 'string' },
        optional: true, // Mark as optional here too for consistency
        description:
          'Predefined options for the user to choose from (optional)',
      },
    },
    required: ['projectName', 'message'],
  },
};

// Define description conforming to ToolRegistrationDescription
const registrationDescription: ToolRegistrationDescription = (
  globalTimeoutSeconds: number,
) => `<description>
Send a question to the user via a pop-up command prompt. **Crucial for clarifying requirements, confirming plans, or resolving ambiguity.**
You should call this tool whenever it has **any** uncertainty or needs clarification or confirmation, even for trivial or silly questions.
Feel free to ask anything! **Proactive questioning is preferred over making assumptions.**
</description>

<importantNotes>
- (!important!) **Use this tool FREQUENTLY** for any question that requires user input or confirmation.
- (!important!) Continue to generate existing messages after user answers.
- (!important!) Provide predefined options for quick selection if applicable.
- (!important!) **Essential for validating assumptions before proceeding with significant actions (e.g., code edits, running commands).**
</importantNotes>

<whenToUseThisTool>
- When you need clarification on user requirements or preferences
- When multiple implementation approaches are possible and user input is needed
- **Before making potentially impactful changes (code edits, file operations, complex commands)**
- When you need to confirm assumptions before proceeding
- When you need additional information not available in the current context
- When validating potential solutions before implementation
- When facing ambiguous instructions that require clarification
- When seeking feedback on generated code or solutions
- When needing permission to modify critical files or functionality
- **Whenever you feel even slightly unsure about the user's intent or the correct next step.**
</whenToUseThisTool>

<features>
- Pop-up command prompt display for user input
- Returns user response or timeout notification (timeout defaults to ${globalTimeoutSeconds} seconds))
- Maintains context across user interactions
- Handles empty responses gracefully
- Properly formats prompt with project context
</features>

<bestPractices>
- Keep questions concise and specific
- Provide clear options when applicable
- Do not ask the question if you have another tool that can answer the question
  - e.g. when you searching file in the current repository, do not ask the question "Do you want to search for a file in the current repository?"
  - e.g. prefer to use other tools to find the answer (Cursor tools or other MCP Server tools)
- Limit questions to only what's necessary **to resolve the uncertainty**
- Format complex questions into simple choices
- Reference specific code or files when relevant
- Indicate why the information is needed
- Use appropriate urgency based on importance
</bestPractices>

<parameters>
- projectName: Identifies the context/project making the request (used in prompt formatting)
- message: The specific question for the user (appears in the prompt)
- predefinedOptions: Predefined options for the user to choose from (optional)
</parameters>

<examples>
- "Should I implement the authentication using JWT or OAuth?"
- "Do you want to use TypeScript interfaces or type aliases for this component?"
- "I found three potential bugs. Should I fix them all or focus on the critical one first?"
- "Can I refactor the database connection code to use connection pooling?"
- "Is it acceptable to add React Router as a dependency?"
- "I plan to modify function X in file Y. Is that correct?"
</examples>`;

// Define the Zod schema (as a raw shape object)
const rawSchema: z.ZodRawShape = {
  projectName: z
    .string()
    .describe(
      'Identifies the context/project making the request (used in prompt formatting)',
    ),
  message: z
    .string()
    .describe('The specific question for the user (appears in the prompt)'),
  predefinedOptions: z
    .array(z.string())
    .optional()
    .describe('Predefined options for the user to choose from (optional)'),
};

// Combine into a single ToolDefinition object
export const requestUserInputTool: ToolDefinition = {
  capability: capabilityInfo,
  description: registrationDescription,
  schema: rawSchema, // Use the raw shape here
};
