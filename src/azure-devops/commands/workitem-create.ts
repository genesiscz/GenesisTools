/**
 * Azure DevOps CLI Tool - Workitem Create Command
 *
 * Handles work item creation with multiple modes:
 * - Interactive wizard with 9-step prompts
 * - Template generation from query results
 * - Template generation from existing work items
 * - Creation from template files
 * - Quick non-interactive creation
 */

import { Command } from "commander";
import { existsSync, readFileSync } from "fs";

import logger from "@app/logger";
import { input, select, confirm, editor } from "@inquirer/prompts";
import { ExitPromptError } from "@inquirer/core";
import { Api } from "@app/azure-devops/api";
import {
  requireConfig,
  buildFieldSchema,
  extractQueryId,
  extractWorkItemIds,
  generateTemplateFromQuery,
  generateTemplateFromWorkItem,
  saveTemplate,
  extractUsedValues,
  mergeFieldsWithUsage,
} from "@app/azure-devops/utils";
import type {
  AzureConfig,
  WorkItemType,
  JsonPatchOperation,
  WorkItemTemplate,
  WorkItemFull,
} from "@app/azure-devops/types";
import { storage, CACHE_TTL } from "@app/azure-devops/cache";

// Common work item types to show first (others available via "Show all...")
const COMMON_WORK_ITEM_TYPES = ["Bug", "Task", "User Story", "Feature", "Epic", "Incident"];

// ============= Interfaces =============

/** Wizard state for interactive create */
interface WizardState {
  project?: { id: string; name: string };
  type?: WorkItemType;
  typeDef?: Awaited<ReturnType<Api["getWorkItemTypeDefinition"]>>;
  fieldSchema?: Map<string, { name: string; required: boolean; allowedValues?: string[]; helpText?: string; defaultValue?: string }>;
  title?: string;
  description?: string;
  additionalFields?: Map<string, string>;
  state?: string;
  tags?: string[];
  assignee?: string;
  parentId?: number;
}

/** Projects cache structure */
interface ProjectsCache {
  org: string;
  projects: Array<{ id: string; name: string }>;
  fetchedAt: string;
}

// ============= Cache Management =============

/** Load cached projects list */
async function loadProjectsCache(org: string): Promise<Array<{ id: string; name: string }> | null> {
  const cache = await storage.getCacheFile<ProjectsCache>("projects.json", CACHE_TTL.project);
  if (cache && cache.org === org) {
    return cache.projects;
  }
  return null;
}

/** Save projects to cache */
async function saveProjectsCache(org: string, projects: Array<{ id: string; name: string }>): Promise<void> {
  const cache: ProjectsCache = {
    org,
    projects,
    fetchedAt: new Date().toISOString(),
  };
  await storage.putCacheFile("projects.json", cache, CACHE_TTL.project);
}

// ============= Interactive Create Mode =============

/**
 * Run interactive work item creation flow with ESC-based back navigation
 */
async function runInteractiveCreate(api: Api, config: AzureConfig): Promise<void> {
  logger.debug(`[create] Starting interactive wizard for ${config.org}/${config.project}`);
  console.log("\n🆕 Create New Work Item\n");
  console.log(`🏢 Organization: ${config.org}`);
  console.log(`📁 Default project: ${config.project}\n`);
  console.log("💡 Press Ctrl+C to cancel, ESC to go back\n");

  const state: WizardState = {};
  let currentStep = 0;
  let activeApi = api;
  let activeConfig = config;

  // Wizard steps as functions that return their value
  const steps: Array<{
    name: string;
    run: () => Promise<boolean>; // Returns true if step completed, false if cancelled/back
  }> = [
    // Step 0: Project selection
    {
      name: "project",
      run: async () => {
        // Load or fetch projects
        let projects = await loadProjectsCache(config.org);
        if (!projects) {
          console.log("📥 Fetching projects...");
          const fetchedProjects = await Api.getProjects(config.org);
          await saveProjectsCache(config.org, fetchedProjects);
          projects = fetchedProjects;
        }

        // Find configured project and put it first
        const configuredProject = projects.find(p => p.name === config.project);
        const otherProjects = projects.filter(p => p.name !== config.project);
        const sortedProjects = configuredProject
          ? [configuredProject, ...otherProjects]
          : projects;

        const choices = sortedProjects.map(p => ({
          value: p,
          name: p.name === config.project ? `${p.name} (configured)` : p.name,
        }));

        const selected = await select({
          message: "Select project:",
          choices,
        });

        state.project = selected;

        // If different project selected, create new API instance
        if (selected.name !== config.project) {
          activeConfig = { ...config, project: selected.name, projectId: selected.id };
          activeApi = new Api(activeConfig);
          console.log(`\n📁 Switched to project: ${selected.name}\n`);
        }

        return true;
      },
    },
    // Step 1: Work item type
    {
      name: "type",
      run: async () => {
        const allTypes = await activeApi.getAvailableWorkItemTypes();
        const commonTypes = allTypes.filter((t: string) => COMMON_WORK_ITEM_TYPES.includes(t));
        const otherTypes = allTypes.filter((t: string) => !COMMON_WORK_ITEM_TYPES.includes(t));

        const typeChoices: Array<{ value: string; name: string }> = [
          ...commonTypes.map((t: string) => ({ value: t, name: t })),
        ];

        if (otherTypes.length > 0) {
          typeChoices.push({ value: "__show_all__", name: `Show all types (${otherTypes.length} more)...` });
        }

        const selectedType = await select({
          message: "Select work item type:",
          choices: typeChoices,
        });

        let type: WorkItemType;
        if (selectedType === "__show_all__") {
          const allTypeSelection = await select({
            message: "Select work item type (all available):",
            choices: allTypes.sort().map((t: string) => ({ value: t, name: t })),
          });
          type = allTypeSelection as WorkItemType;
        } else {
          type = selectedType as WorkItemType;
        }

        state.type = type;

        // Get type definition
        const typeDef = await activeApi.getWorkItemTypeDefinition(type);
        state.typeDef = typeDef;
        state.fieldSchema = buildFieldSchema(typeDef);

        return true;
      },
    },
    // Step 2: Title
    {
      name: "title",
      run: async () => {
        const title = await input({
          message: "Title (required):",
          default: state.title || "",
          validate: (value) => value.trim().length > 0 || "Title is required",
        });
        state.title = title;
        return true;
      },
    },
    // Step 3: Description
    {
      name: "description",
      run: async () => {
        const descriptionField = state.fieldSchema?.get("System.Description");
        const descriptionTemplate = descriptionField?.helpText || "";
        const isRequired = descriptionField?.required || false;

        const useDescription = await confirm({
          message: isRequired ? "Add description? (required)" : "Add description?",
          default: isRequired || !!state.description,
        });

        if (useDescription || isRequired) {
          state.description = await editor({
            message: isRequired ? "Description (required, opens editor):" : "Description (opens editor):",
            default: state.description || descriptionTemplate,
            validate: isRequired ? ((value) => value.trim() ? true : "Description is required") : undefined,
          });
        } else {
          state.description = "";
        }
        return true;
      },
    },
    // Step 4: Required fields
    {
      name: "requiredFields",
      run: async () => {
        if (!state.fieldSchema || !state.type) return true;

        const handledFields = new Set(["System.Title", "System.Description", "System.State", "System.Tags", "System.AssignedTo"]);
        const additionalFields: Map<string, string> = state.additionalFields || new Map();

        const requiredFields: Array<{ refName: string; name: string; allowedValues?: string[]; helpText?: string }> = [];
        for (const [refName, fieldInfo] of state.fieldSchema) {
          if (fieldInfo.required && !handledFields.has(refName)) {
            requiredFields.push({
              refName,
              name: fieldInfo.name,
              allowedValues: fieldInfo.allowedValues,
              helpText: fieldInfo.helpText,
            });
          }
        }

        if (requiredFields.length > 0) {
          console.log(`\n📋 Required fields for ${state.type}:\n`);
          for (const field of requiredFields) {
            let value: string;
            const existingValue = additionalFields.get(field.refName);

            if (field.allowedValues && field.allowedValues.length > 0) {
              value = await select({
                message: `${field.name} (required):`,
                choices: field.allowedValues.map((v: string) => ({ value: v, name: v })),
                default: existingValue,
              });
            } else {
              value = await input({
                message: `${field.name} (required):`,
                default: existingValue || "",
                validate: (v) => v.trim().length > 0 || `${field.name} is required`,
              });
            }
            additionalFields.set(field.refName, value);
          }
        }

        state.additionalFields = additionalFields;
        return true;
      },
    },
    // Step 5: State
    {
      name: "state",
      run: async () => {
        const stateField = state.fieldSchema?.get("System.State");
        const stateValue = await select({
          message: "Initial state:",
          choices: stateField?.allowedValues?.map((v: string) => ({ value: v, name: v })) || [
            { value: "New", name: "New" },
          ],
          default: state.state || stateField?.defaultValue || "New",
        });
        state.state = stateValue;
        return true;
      },
    },
    // Step 6: Tags
    {
      name: "tags",
      run: async () => {
        const addTags = await confirm({
          message: "Add tags?",
          default: (state.tags?.length || 0) > 0,
        });

        if (addTags) {
          const tagInput = await input({
            message: "Tags (comma-separated):",
            default: state.tags?.join(", ") || "",
          });
          state.tags = tagInput.split(",").map(t => t.trim()).filter(Boolean);
        } else {
          state.tags = [];
        }
        return true;
      },
    },
    // Step 7: Assignee
    {
      name: "assignee",
      run: async () => {
        state.assignee = await input({
          message: "Assignee email (or press Enter to skip):",
          default: state.assignee || "",
        });
        return true;
      },
    },
    // Step 8: Parent
    {
      name: "parent",
      run: async () => {
        const addParent = await confirm({
          message: "Link to parent work item?",
          default: state.parentId !== undefined,
        });

        if (addParent) {
          const parentInput = await input({
            message: "Parent work item ID:",
            default: state.parentId?.toString() || "",
            validate: (value) => {
              if (!value) return true;
              const num = parseInt(value, 10);
              return !isNaN(num) && num > 0 || "Enter a valid work item ID";
            },
          });
          if (parentInput) {
            state.parentId = parseInt(parentInput, 10);
          }
        } else {
          state.parentId = undefined;
        }
        return true;
      },
    },
    // Step 9: Confirm and create
    {
      name: "confirm",
      run: async () => {
        console.log("\n📋 Summary:");
        console.log(`  Project: ${state.project?.name || activeConfig.project}`);
        console.log(`  Type: ${state.type}`);
        console.log(`  Title: ${state.title}`);
        console.log(`  State: ${state.state}`);
        if (state.additionalFields) {
          for (const [refName, value] of state.additionalFields) {
            const fieldInfo = state.fieldSchema?.get(refName);
            console.log(`  ${fieldInfo?.name || refName}: ${value}`);
          }
        }
        if (state.tags && state.tags.length > 0) console.log(`  Tags: ${state.tags.join(", ")}`);
        if (state.assignee) console.log(`  Assignee: ${state.assignee}`);
        if (state.parentId) console.log(`  Parent: #${state.parentId}`);
        console.log("");

        const confirmed = await confirm({
          message: "Create this work item?",
          default: true,
        });

        if (!confirmed) {
          // Go back to allow editing
          return false;
        }

        // Build JSON Patch operations
        const operations: JsonPatchOperation[] = [
          { op: "add", path: "/fields/System.Title", value: state.title! },
        ];

        if (state.description) {
          operations.push({ op: "add", path: "/fields/System.Description", value: state.description });
        }

        if (state.state && state.state !== "New") {
          operations.push({ op: "add", path: "/fields/System.State", value: state.state });
        }

        if (state.additionalFields) {
          for (const [refName, value] of state.additionalFields) {
            operations.push({ op: "add", path: `/fields/${refName}`, value });
          }
        }

        if (state.tags && state.tags.length > 0) {
          operations.push({ op: "add", path: "/fields/System.Tags", value: state.tags.join("; ") });
        }

        if (state.assignee) {
          operations.push({ op: "add", path: "/fields/System.AssignedTo", value: state.assignee });
        }

        // Add parent relation if specified
        if (state.parentId) {
          operations.push({
            op: "add",
            path: "/relations/-",
            value: {
              rel: "System.LinkTypes.Hierarchy-Reverse",
              url: `${activeConfig.org}/_apis/wit/workItems/${state.parentId}`,
              attributes: { comment: "Created via CLI" },
            },
          });
        }

        console.log("\n⏳ Creating work item...");
        logger.debug(`[create] Creating ${state.type} with ${operations.length} operations`);
        logger.debug(`[create] Operations: ${JSON.stringify(operations.map(o => o.path))}`);
        const created = await activeApi.createWorkItem(state.type!, operations);
        logger.debug(`[create] Created work item #${created.id}`);

        console.log(`\n✅ Created work item #${created.id}: ${created.title}`);
        console.log(`   URL: ${created.url}`);
        return true;
      },
    },
  ];

  // Run wizard with back navigation
  try {
    while (currentStep < steps.length) {
      try {
        const step = steps[currentStep];
        const result = await step.run();

        if (result) {
          currentStep++;
        } else if (currentStep > 0) {
          // Go back if not confirmed
          currentStep--;
        }
      } catch (error) {
        if (error instanceof ExitPromptError) {
          // User cancelled (Ctrl+C or closed prompt)
          if (currentStep > 0) {
            console.log("\n⬅️  Going back...\n");
            currentStep--;
          } else {
            console.log("\n❌ Creation cancelled.");
            return;
          }
        } else {
          throw error;
        }
      }
    }
  } catch (error) {
    if (error instanceof ExitPromptError) {
      console.log("\n❌ Creation cancelled.");
      return;
    }
    throw error;
  }
}

// ============= From-File Creation =============

/**
 * Convert a WorkItemTemplate to JSON Patch operations for the API
 */
function templateToOperations(template: WorkItemTemplate): JsonPatchOperation[] {
  const operations: JsonPatchOperation[] = [];
  const fields = template.fields as Record<string, unknown>;

  // Map simple field names to Azure DevOps field reference names
  const fieldMapping: Record<string, string> = {
    title: "System.Title",
    description: "System.Description",
    severity: "Microsoft.VSTS.Common.Severity",
    areaPath: "System.AreaPath",
    iterationPath: "System.IterationPath",
    assignedTo: "System.AssignedTo",
    state: "System.State",
    priority: "Microsoft.VSTS.Common.Priority",
    activity: "Microsoft.VSTS.Common.Activity",
    effort: "Microsoft.VSTS.Scheduling.Effort",
    remainingWork: "Microsoft.VSTS.Scheduling.RemainingWork",
    originalEstimate: "Microsoft.VSTS.Scheduling.OriginalEstimate",
    valueArea: "Microsoft.VSTS.Common.ValueArea",
    risk: "Microsoft.VSTS.Common.Risk",
    businessValue: "Microsoft.VSTS.Common.BusinessValue",
  };

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === "") continue;

    // Handle tags array specially
    if (key === "tags") {
      const tagValue = Array.isArray(value) ? value.join("; ") : value;
      if (tagValue) {
        operations.push({
          op: "add",
          path: "/fields/System.Tags",
          value: tagValue,
        });
      }
      continue;
    }

    // Map simple field name to reference name
    let refName = fieldMapping[key];

    if (!refName) {
      // Check if key already looks like a reference name (contains '.')
      if (key.includes(".")) {
        refName = key;
      } else {
        // Try to infer reference name for custom fields
        // Common patterns: "application" -> "Custom.Application"
        // Check template hints for the original reference name
        const hint = template._hints?.[key];
        if (hint?.description?.includes("(") && hint?.description?.includes(")")) {
          // Extract reference name from description like "Pre-filled from source work item (Custom.Application)"
          const match = hint.description.match(/\(([^)]+)\)/);
          if (match && match[1].includes(".")) {
            refName = match[1];
          }
        }
        // If still no refName, skip unknown fields (don't guess)
        if (!refName) {
          continue;
        }
      }
    }

    operations.push({
      op: "add",
      path: `/fields/${refName}`,
      value,
    });
  }

  return operations;
}

/**
 * Validate a WorkItemTemplate before creation
 */
function validateTemplate(template: WorkItemTemplate): void {
  if (!template.$schema || template.$schema !== "azure-devops-workitem-v1") {
    throw new Error("Invalid template: missing or incorrect $schema");
  }

  if (!template.type) {
    throw new Error("Invalid template: missing work item type");
  }

  if (!template.fields) {
    throw new Error("Invalid template: missing fields");
  }

  const title = (template.fields as Record<string, unknown>).title;
  if (!title || (typeof title === "string" && !title.trim())) {
    throw new Error("Invalid template: title is required");
  }
}

/**
 * Create a work item from a template file
 */
async function createFromFile(api: Api, config: AzureConfig, filePath: string): Promise<void> {
  console.log(`\n📄 Loading template from: ${filePath}\n`);

  if (!existsSync(filePath)) {
    throw new Error(`Template file not found: ${filePath}`);
  }

  const content = readFileSync(filePath, "utf-8");
  let template: WorkItemTemplate;

  try {
    template = JSON.parse(content);
  } catch {
    throw new Error(`Invalid JSON in template file: ${filePath}`);
  }

  // Validate template
  validateTemplate(template);

  const fields = template.fields as Record<string, unknown>;

  console.log("📋 Template contents:");
  console.log(`  Type: ${template.type}`);
  console.log(`  Title: ${fields.title}`);
  if (fields.severity) console.log(`  Severity: ${fields.severity}`);
  if (fields.assignedTo) console.log(`  Assignee: ${fields.assignedTo}`);
  if (fields.tags) {
    const tags = Array.isArray(fields.tags) ? fields.tags : [fields.tags];
    if (tags.length > 0) console.log(`  Tags: ${tags.join(", ")}`);
  }
  if (template.relations?.parent) console.log(`  Parent: #${template.relations.parent}`);
  console.log("");

  // Convert template to operations
  const operations = templateToOperations(template);

  // Add parent relation if specified
  if (template.relations?.parent) {
    operations.push({
      op: "add",
      path: "/relations/-",
      value: {
        rel: "System.LinkTypes.Hierarchy-Reverse",
        url: `${config.org}/_apis/wit/workItems/${template.relations.parent}`,
        attributes: { comment: "Created via CLI" },
      },
    });
  }

  // Create the work item
  console.log("⏳ Creating work item...");
  const created = await api.createWorkItem(template.type, operations);

  console.log(`\n✅ Created work item #${created.id}: ${created.title}`);
  console.log(`   URL: ${created.url}`);
}

// ============= Helper Functions =============

/** Infer work item type from raw fields */
function inferWorkItemTypeFromRawFields(item: WorkItemFull): WorkItemType | undefined {
  const rawType = item.rawFields?.["System.WorkItemType"];
  if (typeof rawType === "string") {
    return rawType as WorkItemType;
  }
  return undefined;
}

// ============= Create Handler =============

/**
 * Handle the create command with various modes
 */
async function handleCreate(options: {
  interactive?: boolean;
  fromFile?: string;
  type?: string;
  sourceInput?: string;  // Query URL or work item URL
  title?: string;
  severity?: string;
  tags?: string;
  assignee?: string;
  parent?: string;
}): Promise<void> {
  // Check if any actual mode is specified - show help before requiring config
  const hasValidMode = options.interactive ||
    options.fromFile ||
    options.sourceInput ||
    (options.type && options.title);

  if (!hasValidMode) {
    // No valid mode specified - show help without requiring config
    console.log(`
Usage: tools azure-devops workitem-create [options]

Modes:
  -i, --interactive             Interactive mode with prompts
  --from-file <path>            Create from template file
  <query-url> --type <type>     Generate template from query
  <workitem-url>                Generate template from work item
  --type <type> --title <text>  Quick non-interactive creation

Examples:
  tools azure-devops workitem-create -i
  tools azure-devops workitem-create --from-file template.json
  tools azure-devops workitem-create "https://.../_queries/query/abc" --type Bug
  tools azure-devops workitem-create "https://.../_workitems/edit/123"
  tools azure-devops workitem-create --type Task --title "Fix bug"
`);
    return;
  }

  const config = requireConfig();
  logger.debug(`[create] Config loaded: org=${config.org}, project=${config.project}`);
  const api = new Api(config);

  // Mode 1: Interactive mode (-i or --interactive)
  if (options.interactive) {
    logger.debug("[create] Mode: interactive wizard");
    await runInteractiveCreate(api, config);
    return;
  }

  // Mode 2: Create from template file (--from-file)
  if (options.fromFile) {
    logger.debug(`[create] Mode: from-file (${options.fromFile})`);
    await createFromFile(api, config, options.fromFile);
    return;
  }

  // Mode 3: Generate template from query URL
  // Match /_queries/query/ path or a bare GUID (query ID)
  if (options.sourceInput && (options.sourceInput.includes("/_queries/") || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.sourceInput))) {
    const queryId = extractQueryId(options.sourceInput);
    const type = (options.type || "Bug") as WorkItemType;

    console.log(`\n📊 Generating template from query: ${queryId}`);
    console.log(`   Work item type: ${type}\n`);

    // Run query to get items
    const items = await api.runQuery(queryId);
    console.log(`   Found ${items.length} work items to analyze`);

    // Get type definition for field hints
    const typeDef = await api.getWorkItemTypeDefinition(type);
    const fieldSchema = buildFieldSchema(typeDef);
    const hints = mergeFieldsWithUsage(fieldSchema, extractUsedValues(items, config.project, queryId));

    // Generate template
    const template = generateTemplateFromQuery(items, type, config.project, queryId, hints);

    // Save template
    const filePath = saveTemplate(template);

    console.log(`\n✅ Template generated: ${filePath}`);
    console.log(`\n📝 Hints from ${items.length} analyzed items:`);

    // Show field hints
    if (template._hints) {
      const hintFields = ["severity", "tags", "assignedTo"];
      for (const field of hintFields) {
        const hint = template._hints[field];
        if (hint?.usedValues?.length) {
          console.log(`   ${field}: ${hint.usedValues.slice(0, 5).join(", ")}`);
        }
      }
    }

    console.log(`\n💡 Fill the template and run:`);
    console.log(`   tools azure-devops workitem-create --from-file "${filePath}"`);
    return;
  }

  // Mode 4: Generate template from work item URL
  if (options.sourceInput && options.sourceInput.match(/workitems?|edit\/\d+/i)) {
    const ids = extractWorkItemIds(options.sourceInput);
    if (ids.length !== 1) {
      throw new Error("Please specify exactly one work item URL for template generation");
    }

    const id = ids[0];
    console.log(`\n📋 Generating template from work item #${id}\n`);

    // Get the source work item
    const sourceItem = await api.getWorkItem(id);

    // Determine type and get type definition for allowedValues
    const type = (options.type as WorkItemType) || inferWorkItemTypeFromRawFields(sourceItem) || "Bug";
    console.log(`   Type: ${type}`);

    // Fetch type definition to get allowedValues for each field
    const typeDef = await api.getWorkItemTypeDefinition(type);
    const fieldSchema = buildFieldSchema(typeDef);

    // Generate template with field schema for allowedValues
    const template = generateTemplateFromWorkItem(sourceItem, type, fieldSchema);

    // Save template
    const filePath = saveTemplate(template);

    console.log(`✅ Template generated: ${filePath}`);
    console.log(`\n📝 Pre-filled from source work item #${id}:`);
    console.log(`   Type: ${template.type}`);
    if (template.fields.severity) console.log(`   Severity: ${template.fields.severity}`);
    if (template.relations?.parent) console.log(`   Parent: #${template.relations.parent}`);

    console.log(`\n💡 Fill the template and run:`);
    console.log(`   tools azure-devops workitem-create --from-file "${filePath}"`);
    return;
  }

  // Mode 5: Quick non-interactive creation (--type + --title required)
  if (options.type && options.title) {
    const type = options.type as WorkItemType;

    console.log(`\n🆕 Quick create: ${type}\n`);

    const operations: JsonPatchOperation[] = [
      { op: "add", path: "/fields/System.Title", value: options.title },
    ];

    if (options.severity) {
      operations.push({ op: "add", path: "/fields/Microsoft.VSTS.Common.Severity", value: options.severity });
    }

    if (options.tags) {
      operations.push({ op: "add", path: "/fields/System.Tags", value: options.tags.replace(/,/g, "; ") });
    }

    if (options.assignee) {
      operations.push({ op: "add", path: "/fields/System.AssignedTo", value: options.assignee });
    }

    console.log("⏳ Creating work item...");
    const created = await api.createWorkItem(type, operations);

    console.log(`\n✅ Created work item #${created.id}: ${created.title}`);
    console.log(`   URL: ${created.url}`);
    return;
  }
}

// ============= Command Registration =============

/**
 * Register the workitem-create command on the Commander program
 */
export function registerWorkitemCreateCommand(program: Command): void {
  program
    .command("workitem-create")
    .alias("create")
    .description("Create a new work item")
    .option("-i, --interactive", "Interactive mode with prompts")
    .option("--from-file <path>", "Create from template file")
    .option("--type <type>", "Work item type (Bug, Task, etc.)")
    .option("--title <text>", "Work item title")
    .option("--severity <sev>", "Severity level")
    .option("--tags <tags>", "Tags (comma-separated)")
    .option("--assignee <email>", "Assignee email")
    .option("--parent <id>", "Parent work item ID")
    .argument("[source]", "Query URL or work item URL for template generation")
    .action(async (source, options) => {
      await handleCreate({ ...options, sourceInput: source });
    });
}
