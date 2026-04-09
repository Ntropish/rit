/**
 * Plugin interface for the rit MCP server.
 *
 * Plugins register additional MCP tools beyond the core rit operations.
 * Each plugin provides tool definitions and a handler function.
 */

import type { Repository } from '../../../src/repo/index.js';

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, any>;
}

export interface McpToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

export interface RitMcpPlugin {
  name: string;
  tools(): McpToolDef[];
  handle(toolName: string, args: Record<string, any>, repo: Repository): Promise<McpToolResult | null>;
}
