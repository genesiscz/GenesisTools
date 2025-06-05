import { z, ZodRawShape } from 'zod';
import {
  ToolDefinition,
  ToolCapabilityInfo,
  ToolRegistrationDescription,
} from './types.js'; // Import the types

// Define capability conforming to ToolCapabilityInfo
const capabilityInfo: ToolCapabilityInfo = {
  description: 'Notify when a response has completed via OS notification.',
  parameters: {
    type: 'object',
    properties: {
      projectName: {
        type: 'string',
        description:
          'Identifies the context/project making the notification (appears in notification title)',
      },
      message: {
        type: 'string',
        description: 'The specific notification text (appears in the body)',
      },
    },
    required: ['projectName', 'message'],
  },
};

// Define description conforming to ToolRegistrationDescription
const registrationDescription: ToolRegistrationDescription = `<description>
Notify when a response has completed. Use this tool **once** at the end of **each and every** message to signal completion to the user.
</description>

<importantNotes>
- (!important!) **MANDATORY:** ONLY use this tool exactly once per message to signal completion. **Do not forget this step.**
</importantNotes>

<whenToUseThisTool>
- When you've completed answering a user's query
- When you've finished executing a task or a sequence of tool calls
- When a multi-step process is complete
- When you want to provide a summary of completed actions just before ending the response
</whenToUseThisTool>

<features>
- Cross-platform OS notifications (Windows, macOS, Linux)
- Reusable tool to signal end of message
- Should be called exactly once per LLM response
</features>

<bestPractices>
- Keep messages concise
- Use projectName consistently to group notifications by context
</bestPractices>

<parameters>
- projectName: Identifies the context/project making the notification (appears in notification title)
- message: The specific notification text (appears in the body)
</parameters>

<examples>
- { "projectName": "MyApp", "message": "Feature implementation complete. All tests passing." }
- { "projectName": "MyLib", "message": "Analysis complete: 3 issues found and fixed." }
</examples>`;

// Define the Zod schema (as a raw shape object)
const rawSchema: ZodRawShape = {
  projectName: z.string().describe('Notification title'),
  message: z.string().describe('Notification body'),
};

// Combine into a single ToolDefinition object
export const messageCompleteNotificationTool: ToolDefinition = {
  capability: capabilityInfo,
  description: registrationDescription,
  schema: rawSchema, // Use the raw shape here
};
