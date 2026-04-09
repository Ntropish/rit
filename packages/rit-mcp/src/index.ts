#!/usr/bin/env bun
/**
 * MCP server for rit entity editing.
 *
 * Exposes rit's Redis-like operations (HSET, HGET, HGETALL, etc.) as MCP tools.
 * Takes a .rit file path as a command-line argument.
 *
 * Usage:
 *   bun packages/rit-mcp/src/index.ts /path/to/.rit
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { resolve } from "node:path";
import { openSqliteStore } from '../../../src/store/sqlite.js';
import { Repository } from '../../../src/repo/index.js';
import { projectSource, type AstEntityWrite } from '../../sigil/src/projector.js';
import { materialize } from '../../sigil/src/materializer.js';

// ── Setup ───────────────────────────────────────────────

const ritPath = process.argv[2];
if (!ritPath) {
  console.error('Usage: rit-mcp <path-to-.rit>');
  process.exit(1);
}

const resolvedPath = resolve(ritPath);
const { store, refStore, close } = openSqliteStore(resolvedPath);
let repo = await Repository.init(store, refStore);

// ── Sigil helpers ───────────────────────────────────────

async function writeAstEntities(writes: AstEntityWrite[]): Promise<void> {
  for (const write of writes) {
    for (const [field, value] of Object.entries(write.fields)) {
      await repo.hset(write.key, field, value);
    }
  }
}

async function readAstEntities(prefix: string): Promise<AstEntityWrite[]> {
  const writes: AstEntityWrite[] = [];
  for await (const key of repo.keys(`ast:${prefix}.*`)) {
    const fields = await repo.hgetall(key);
    if (Object.keys(fields).length > 0) writes.push({ key, fields });
  }
  const moduleKey = `module:${prefix}`;
  const moduleFields = await repo.hgetall(moduleKey);
  if (Object.keys(moduleFields).length > 0) {
    writes.unshift({ key: moduleKey, fields: moduleFields });
  }
  return writes;
}

async function clearAstEntities(prefix: string): Promise<void> {
  for await (const key of repo.keys(`ast:${prefix}.*`)) {
    await repo.del(key);
  }
  await repo.del(`module:${prefix}`);
}

const server = new Server(
  { name: "rit-mcp", version: "0.0.1" },
  { capabilities: { tools: {} } }
);

// ── Tools ───────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "rit_hset",
      description: "Set one or more fields on a hash entity. Fields are key-value pairs.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Entity key (e.g., component:Counter)" },
          fields: {
            type: "object",
            additionalProperties: { type: "string" },
            description: "Field-value pairs to set",
          },
        },
        required: ["key", "fields"],
      },
    },
    {
      name: "rit_hget",
      description: "Get a single field from a hash entity.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Entity key" },
          field: { type: "string", description: "Field name" },
        },
        required: ["key", "field"],
      },
    },
    {
      name: "rit_hgetall",
      description: "Get all fields from a hash entity.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Entity key" },
        },
        required: ["key"],
      },
    },
    {
      name: "rit_hdel",
      description: "Delete a field from a hash entity.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Entity key" },
          field: { type: "string", description: "Field name to delete" },
        },
        required: ["key", "field"],
      },
    },
    {
      name: "rit_set",
      description: "Set a string value.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Key" },
          value: { type: "string", description: "Value" },
        },
        required: ["key", "value"],
      },
    },
    {
      name: "rit_get",
      description: "Get a string value.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Key" },
        },
        required: ["key"],
      },
    },
    {
      name: "rit_del",
      description: "Delete a key.",
      inputSchema: {
        type: "object",
        properties: {
          key: { type: "string", description: "Key to delete" },
        },
        required: ["key"],
      },
    },
    {
      name: "rit_keys",
      description: "List keys matching a glob pattern.",
      inputSchema: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern (default: *)", default: "*" },
        },
      },
    },
    {
      name: "rit_project",
      description: "Project a code string through Sigil into entity AST. Stores AST entities in the store under the given module ID.",
      inputSchema: {
        type: "object",
        properties: {
          moduleId: { type: "string", description: "Module ID for the AST entities (e.g., comp-Counter-body)" },
          code: { type: "string", description: "TypeScript/TSX code to project" },
        },
        required: ["moduleId", "code"],
      },
    },
    {
      name: "rit_materialize",
      description: "Materialize Sigil entity AST back to source code.",
      inputSchema: {
        type: "object",
        properties: {
          moduleId: { type: "string", description: "Module ID to read and materialize" },
        },
        required: ["moduleId"],
      },
    },
    {
      name: "rit_commit",
      description: "Commit the current working tree state.",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string", description: "Commit message" },
        },
        required: ["message"],
      },
    },
    {
      name: "rit_log",
      description: "Show commit history.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max entries (default: 10)", default: 10 },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "rit_hset": {
        const { key, fields } = args as { key: string; fields: Record<string, string> };
        for (const [field, value] of Object.entries(fields)) {
          await repo.hset(key, field, value);
        }
        return { content: [{ type: "text", text: `Set ${Object.keys(fields).length} field(s) on ${key}` }] };
      }

      case "rit_hget": {
        const { key, field } = args as { key: string; field: string };
        const value = await repo.hget(key, field);
        return { content: [{ type: "text", text: value ?? "(nil)" }] };
      }

      case "rit_hgetall": {
        const { key } = args as { key: string };
        const all = await repo.hgetall(key);
        const entries = Object.entries(all);
        if (entries.length === 0) {
          return { content: [{ type: "text", text: "(empty)" }] };
        }
        const text = entries.map(([f, v]) => `${f}: ${v}`).join('\n');
        return { content: [{ type: "text", text }] };
      }

      case "rit_hdel": {
        const { key, field } = args as { key: string; field: string };
        await repo.hdel(key, field);
        return { content: [{ type: "text", text: `Deleted ${field} from ${key}` }] };
      }

      case "rit_set": {
        const { key, value } = args as { key: string; value: string };
        await repo.set(key, value);
        return { content: [{ type: "text", text: "OK" }] };
      }

      case "rit_get": {
        const { key } = args as { key: string };
        const value = await repo.get(key);
        return { content: [{ type: "text", text: value ?? "(nil)" }] };
      }

      case "rit_del": {
        const { key } = args as { key: string };
        await repo.del(key);
        return { content: [{ type: "text", text: "OK" }] };
      }

      case "rit_keys": {
        const { pattern } = args as { pattern?: string };
        const keys: string[] = [];
        for await (const k of repo.keys(pattern ?? '*')) {
          keys.push(k);
        }
        return { content: [{ type: "text", text: keys.length > 0 ? keys.join('\n') : "(empty)" }] };
      }

      case "rit_project": {
        const { moduleId, code } = args as { moduleId: string; code: string };
        // Clear any existing AST entities for this module
        await clearAstEntities(moduleId);
        // Project through Sigil
        const writes = projectSource(code, moduleId);
        await writeAstEntities(writes);
        const astCount = writes.filter(w => w.key.startsWith('ast:')).length;
        return { content: [{ type: "text", text: `Projected ${astCount} AST entities for module ${moduleId}` }] };
      }

      case "rit_materialize": {
        const { moduleId } = args as { moduleId: string };
        const writes = await readAstEntities(moduleId);
        if (writes.length === 0) {
          return { content: [{ type: "text", text: "(no AST entities found)" }] };
        }
        const code = materialize(writes);
        return { content: [{ type: "text", text: code }] };
      }

      case "rit_commit": {
        const { message } = args as { message: string };
        const hash = await repo.commit(message);
        return { content: [{ type: "text", text: `Committed: ${hash.slice(0, 12)}` }] };
      }

      case "rit_log": {
        const { limit } = args as { limit?: number };
        const max = limit ?? 10;
        const entries: string[] = [];
        let count = 0;
        for await (const { hash, commit } of repo.log()) {
          if (count >= max) break;
          const date = new Date(commit.timestamp).toISOString().replace('T', ' ').slice(0, 19);
          entries.push(`${hash.slice(0, 8)} ${date} ${commit.message}`);
          count++;
        }
        return { content: [{ type: "text", text: entries.length > 0 ? entries.join('\n') : "(no commits)" }] };
      }

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

// ── Start ───────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
