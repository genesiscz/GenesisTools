#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';

// Environment variables for Jenkins authentication
const JENKINS_URL = process.env.JENKINS_URL || '';
const JENKINS_USER = process.env.JENKINS_USER || '';
const JENKINS_TOKEN = process.env.JENKINS_TOKEN || '';

// Validate required environment variables at startup
if (!JENKINS_URL || !JENKINS_USER || !JENKINS_TOKEN) {
  const missing = [
    !JENKINS_URL && 'JENKINS_URL',
    !JENKINS_USER && 'JENKINS_USER',
    !JENKINS_TOKEN && 'JENKINS_TOKEN',
  ].filter(Boolean).join(', ');
  console.error(`Error: Missing required environment variables: ${missing}`);
  console.error('Please set JENKINS_URL, JENKINS_USER, and JENKINS_TOKEN environment variables.');
  process.exit(1);
}

// Interface for build status information
interface BuildStatus {
  building: boolean;
  result: string | null;
  timestamp: number;
  duration: number;
  url: string;
}

// Interface for detailed build information
interface BuildInfo {
  number: number;
  result: string | null;
  timestamp: number;
  duration: number;
  building: boolean;
  url: string;
}

// Interface for job information
interface JobInfo {
  name: string;
  url: string;
  color: string;
  buildable: boolean;
  lastBuild?: {
    number: number;
    url: string;
  };
}

// Interface for queue items
interface QueueItem {
  id: number;
  task: {
    name: string;
    url: string;
  };
  why: string;
  inQueueSince: number;
  stuck: boolean;
}

/**
 * Jenkins MCP Server class
 * Provides various Jenkins operations through the Model Context Protocol
 */
class JenkinsServer {
  private server: Server;
  private axiosInstance;

  constructor() {
    // Initialize the MCP server with basic configuration
    this.server = new Server(
      {
        name: 'jenkins-server',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Create axios instance with Jenkins authentication
    this.axiosInstance = axios.create({
      baseURL: JENKINS_URL,
      auth: {
        username: JENKINS_USER,
        password: JENKINS_TOKEN,
      },
    });

    // Set up tool handlers for various Jenkins operations
    this.setupToolHandlers();

    // Error handling and graceful shutdown
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  /**
   * Set up all tool handlers for Jenkins operations
   */
  private setupToolHandlers() {
    // Register available tools with their schemas
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'get_build_status',
          description: 'Get the status of a Jenkins build',
          inputSchema: {
            type: 'object',
            properties: {
              jobPath: {
                type: 'string',
                description: 'Path to the Jenkins job (e.g., "job/QA/job/QA-stopServer")',
              },
              buildNumber: {
                type: 'string',
                description: 'Build number (use "lastBuild" for most recent)',
              },
            },
            required: ['jobPath'],
          },
        },
        {
          name: 'trigger_build',
          description: 'Trigger a new Jenkins build',
          inputSchema: {
            type: 'object',
            properties: {
              jobPath: {
                type: 'string',
                description: 'Path to the Jenkins job',
              },
              parameters: {
                type: 'object',
                description: 'Build parameters (optional)',
                additionalProperties: true,
              },
            },
            required: ['jobPath'],
          },
        },
        {
          name: 'get_build_log',
          description: 'Get the console output of a Jenkins build',
          inputSchema: {
            type: 'object',
            properties: {
              jobPath: {
                type: 'string',
                description: 'Path to the Jenkins job',
              },
              buildNumber: {
                type: 'string',
                description: 'Build number (use "lastBuild" for most recent)',
              },
            },
            required: ['jobPath', 'buildNumber'],
          },
        },
        {
          name: 'list_jobs',
          description: 'List all Jenkins jobs',
          inputSchema: {
            type: 'object',
            properties: {
              folderPath: {
                type: 'string',
                description: 'Path to folder or view (optional, empty for root level). Use "job/FolderName" format for folders',
              },
            },
            required: [],
          },
        },
        {
          name: 'get_build_history',
          description: 'Get build history for a Jenkins job',
          inputSchema: {
            type: 'object',
            properties: {
              jobPath: {
                type: 'string',
                description: 'Path to the Jenkins job',
              },
              limit: {
                type: 'number',
                description: 'Number of recent builds to retrieve (default: 10)',
              },
            },
            required: ['jobPath'],
          },
        },
        {
          name: 'stop_build',
          description: 'Stop a running Jenkins build',
          inputSchema: {
            type: 'object',
            properties: {
              jobPath: {
                type: 'string',
                description: 'Path to the Jenkins job',
              },
              buildNumber: {
                type: 'string',
                description: 'Build number to stop (use "lastBuild" for most recent)',
              },
            },
            required: ['jobPath', 'buildNumber'],
          },
        },
        {
          name: 'get_queue',
          description: 'Get the current Jenkins build queue',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
          },
        },
        {
          name: 'get_job_config',
          description: 'Get the configuration of a Jenkins job',
          inputSchema: {
            type: 'object',
            properties: {
              jobPath: {
                type: 'string',
                description: 'Path to the Jenkins job',
              },
            },
            required: ['jobPath'],
          },
        },
      ],
    }));

    // Handle tool execution requests
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        // Route to appropriate handler based on tool name
        switch (request.params.name) {
          case 'get_build_status':
            return await this.getBuildStatus(request.params.arguments);
          case 'trigger_build':
            return await this.triggerBuild(request.params.arguments);
          case 'get_build_log':
            return await this.getBuildLog(request.params.arguments);
          case 'list_jobs':
            return await this.listJobs(request.params.arguments);
          case 'get_build_history':
            return await this.getBuildHistory(request.params.arguments);
          case 'stop_build':
            return await this.stopBuild(request.params.arguments);
          case 'get_queue':
            return await this.getQueue(request.params.arguments);
          case 'get_job_config':
            return await this.getJobConfig(request.params.arguments);
          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${request.params.name}`
            );
        }
      } catch (error) {
        // Handle different types of errors appropriately
        if (error instanceof McpError) {
          throw error;
        }
        if (axios.isAxiosError(error)) {
          throw new McpError(
            ErrorCode.InternalError,
            `Jenkins API error: ${error.response?.data?.message || error.message}`
          );
        }
        throw new McpError(ErrorCode.InternalError, 'Unknown error occurred');
      }
    });
  }

  /**
   * Get the status of a specific Jenkins build
   * @param args - Contains jobPath and optional buildNumber
   */
  private async getBuildStatus(args: any) {
    const buildNumber = args.buildNumber || 'lastBuild';
    const response = await this.axiosInstance.get<BuildStatus>(
      `/${args.jobPath}/${buildNumber}/api/json`
    );

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            building: response.data.building,
            result: response.data.result,
            timestamp: response.data.timestamp,
            duration: response.data.duration,
            url: response.data.url,
          }, null, 2),
        },
      ],
    };
  }

  /**
   * Trigger a new Jenkins build
   * @param args - Contains jobPath and optional parameters
   */
  private async triggerBuild(args: any) {
    const params = new URLSearchParams();
    // Add build parameters if provided
    if (args.parameters) {
      Object.entries(args.parameters).forEach(([key, value]) => {
        params.append(key, String(value));
      });
    }

    // Use different endpoint based on whether parameters are provided
    const endpoint = args.parameters
      ? `/${args.jobPath}/buildWithParameters`
      : `/${args.jobPath}/build`;

    await this.axiosInstance.post(endpoint, params);

    return {
      content: [
        {
          type: 'text',
          text: 'Build triggered successfully',
        },
      ],
    };
  }

  /**
   * Get the console output of a specific build
   * @param args - Contains jobPath and buildNumber
   */
  private async getBuildLog(args: any) {
    const response = await this.axiosInstance.get(
      `/${args.jobPath}/${args.buildNumber}/consoleText`
    );

    return {
      content: [
        {
          type: 'text',
          text: response.data,
        },
      ],
    };
  }

  /**
   * List all Jenkins jobs in a folder or at root level
   * @param args - Contains optional folderPath
   */
  private async listJobs(args: any) {
    const folderPath = args.folderPath || '';
    const apiPath = folderPath ? `/${folderPath}/api/json` : '/api/json';

    const response = await this.axiosInstance.get(apiPath);
    const jobs: JobInfo[] = response.data.jobs || [];

    // Transform job data to include relevant information
    const jobList = jobs.map(job => ({
      name: job.name,
      url: job.url,
      color: job.color,
      buildable: job.buildable,
      lastBuildNumber: job.lastBuild?.number,
      lastBuildUrl: job.lastBuild?.url,
    }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            folderPath: folderPath || 'root',
            totalJobs: jobList.length,
            jobs: jobList,
          }, null, 2),
        },
      ],
    };
  }

  /**
   * Get build history for a specific Jenkins job
   * @param args - Contains jobPath and optional limit
   */
  private async getBuildHistory(args: any) {
    const limit = args.limit || 10;
    // Use Jenkins Tree API to efficiently fetch build data
    const treeQuery = `builds[number,result,timestamp,duration,building,url]{0,${limit}}`;

    const response = await this.axiosInstance.get(
      `/${args.jobPath}/api/json?tree=${treeQuery}`
    );

    const builds: BuildInfo[] = response.data.builds || [];

    // Transform build data to include formatted date
    const buildHistory = builds.map(build => ({
      number: build.number,
      result: build.result,
      timestamp: build.timestamp,
      duration: build.duration,
      building: build.building,
      url: build.url,
      date: new Date(build.timestamp).toISOString(),
    }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            jobPath: args.jobPath,
            totalBuilds: buildHistory.length,
            builds: buildHistory,
          }, null, 2),
        },
      ],
    };
  }

  /**
   * Stop a running Jenkins build
   * @param args - Contains jobPath and buildNumber
   */
  private async stopBuild(args: any) {
    const buildNumber = args.buildNumber === 'lastBuild' ? 'lastBuild' : args.buildNumber;

    await this.axiosInstance.post(
      `/${args.jobPath}/${buildNumber}/stop`
    );

    return {
      content: [
        {
          type: 'text',
          text: `Build ${buildNumber} stopped successfully`,
        },
      ],
    };
  }

  /**
   * Get the current Jenkins build queue
   * @param args - Empty object (no parameters required)
   */
  private async getQueue(args: any) {
    const response = await this.axiosInstance.get('/queue/api/json');
    const queueItems: QueueItem[] = response.data.items || [];

    // Transform queue data to include readable timestamps
    const queue = queueItems.map(item => ({
      id: item.id,
      taskName: item.task.name,
      taskUrl: item.task.url,
      reason: item.why,
      inQueueSince: item.inQueueSince,
      inQueueSinceDate: new Date(item.inQueueSince).toISOString(),
      stuck: item.stuck,
    }));

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            totalQueueItems: queue.length,
            queue: queue,
          }, null, 2),
        },
      ],
    };
  }

  /**
   * Get the configuration of a Jenkins job
   * @param args - Contains jobPath
   */
  private async getJobConfig(args: any) {
    // Get job information in JSON format
    const response = await this.axiosInstance.get(`/${args.jobPath}/api/json`);
    const jobInfo = response.data;

    // Extract key configuration information
    const config = {
      name: jobInfo.name,
      url: jobInfo.url,
      description: jobInfo.description,
      buildable: jobInfo.buildable,
      color: jobInfo.color,
      inQueue: jobInfo.inQueue,
      keepDependencies: jobInfo.keepDependencies,
      nextBuildNumber: jobInfo.nextBuildNumber,
      property: jobInfo.property,
      scm: jobInfo.scm,
      triggers: jobInfo.triggers,
      upstreamProjects: jobInfo.upstreamProjects,
      downstreamProjects: jobInfo.downstreamProjects,
      lastBuild: jobInfo.lastBuild,
      lastCompletedBuild: jobInfo.lastCompletedBuild,
      lastFailedBuild: jobInfo.lastFailedBuild,
      lastStableBuild: jobInfo.lastStableBuild,
      lastSuccessfulBuild: jobInfo.lastSuccessfulBuild,
      lastUnstableBuild: jobInfo.lastUnstableBuild,
      lastUnsuccessfulBuild: jobInfo.lastUnsuccessfulBuild,
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(config, null, 2),
        },
      ],
    };
  }

  /**
   * Start the MCP server
   */
  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Jenkins MCP server running on stdio');
  }
}

// Initialize and start the server
const server = new JenkinsServer();
server.run().catch(console.error);
