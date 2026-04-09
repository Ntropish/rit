#!/usr/bin/env bun
/**
 * MCP server for rit entity editing.
 *
 * Exposes rit's Redis-like operations as MCP tools.
 * Supports plugins for additional tools (e.g., Sigil, fr-router).
 *
 * Usage:
 *   bun rit-mcp /path/to/.rit [--plugin sigil] [--plugin fr-router]
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
import type { RitMcpPlugin, McpToolDef } from './plugin.js';

// ── Argument parsing ────────────────────────────────────

const args = process.argv.slice(2);
let ritPath: string | undefined;
const pluginNames: string[] = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--plugin' && i + 1 < args.length) {
    pluginNames.push(args[++i]);
  } else if (!ritPath) {
    ritPath = args[i];
  }
}

if (!ritPath) {
  console.error('Usage: rit-mcp <path-to-.rit> [--plugin name ...]');
  process.exit(1);
}

// ── Plugin loading ──────────────────────────────────────

const BUILTIN_PLUGINS: Record<string, () => Promise<RitMcpPlugin>> = {
  sigil: async () => {
    const mod = await import('./plugins/sigil.js');
    return mod.sigilPlugin();
  },
};

const plugins: RitMcpPlugin[] = [];
for (const name of pluginNames) {
  const loader = BUILTIN_PLUGINS[name];
  if (loader) {
    plugins.push(await loader());
  } else {
    console.error(`Unknown plugin: ${name}`);
    process.exit(1);
  }
}

// ── Setup ───────────────────────────────────────────────

const resolvedPath = resolve(ritPath);
const { store, refStore, db, close } = openSqliteStore(resolvedPath);
let repo = await Repository.init(store, refStore);

const server = new Server(
  { name: "rit-mcp", version: "0.0.1" },
  { capabilities: { tools: {} } }
);

// ── Core tools ──────────────────────────────────────────

const coreTools: McpToolDef[] = [
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
  {
    name: "rit_gc",
    description: "Garbage collect unreachable blocks and compact the .rit file.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

// ── Tool registration ───────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const allTools = [...coreTools];
  for (const plugin of plugins) {
    allTools.push(...plugin.tools());
  }
  return { tools: allTools };
});

// ── Tool dispatch ───────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: toolArgs } = request.params;

  try {
    // Try plugins first
    for (const plugin of plugins) {
      const result = await plugin.handle(name, toolArgs as Record<string, any>, repo);
      if (result) return result;
    }

    // Core handlers
    switch (name) {
      case "rit_hset": {
        const { key, fields } = toolArgs as { key: string; fields: Record<string, string> };
        for (const [field, value] of Object.entries(fields)) {
          await repo.hset(key, field, value);
        }
        return { content: [{ type: "text", text: `Set ${Object.keys(fields).length} field(s) on ${key}` }] };
      }

      case "rit_hget": {
        const { key, field } = toolArgs as { key: string; field: string };
        const value = await repo.hget(key, field);
        return { content: [{ type: "text", text: value ?? "(nil)" }] };
      }

      case "rit_hgetall": {
        const { key } = toolArgs as { key: string };
        const all = await repo.hgetall(key);
        const entries = Object.entries(all);
        if (entries.length === 0) {
          return { content: [{ type: "text", text: "(empty)" }] };
        }
        const text = entries.map(([f, v]) => `${f}: ${v}`).join('\n');
        return { content: [{ type: "text", text }] };
      }

      case "rit_hdel": {
        const { key, field } = toolArgs as { key: string; field: string };
        await repo.hdel(key, field);
        return { content: [{ type: "text", text: `Deleted ${field} from ${key}` }] };
      }

      case "rit_set": {
        const { key, value } = toolArgs as { key: string; value: string };
        await repo.set(key, value);
        return { content: [{ type: "text", text: "OK" }] };
      }

      case "rit_get": {
        const { key } = toolArgs as { key: string };
        const value = await repo.get(key);
        return { content: [{ type: "text", text: value ?? "(nil)" }] };
      }

      case "rit_del": {
        const { key } = toolArgs as { key: string };
        await repo.del(key);
        return { content: [{ type: "text", text: "OK" }] };
      }

      case "rit_keys": {
        const { pattern } = toolArgs as { pattern?: string };
        const keys: string[] = [];
        for await (const k of repo.keys(pattern ?? '*')) {
          keys.push(k);
        }
        return { content: [{ type: "text", text: keys.length > 0 ? keys.join('\n') : "(empty)" }] };
      }

      case "rit_commit": {
        const { message } = toolArgs as { message: string };
        const hash = await repo.commit(message);
        return { content: [{ type: "text", text: `Committed: ${hash.slice(0, 12)}` }] };
      }

      case "rit_log": {
        const { limit } = toolArgs as { limit?: number };
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

      case "rit_gc": {
        await repo.flush();
        const result = await repo.gc();
        db.run('PRAGMA wal_checkpoint(TRUNCATE)');
        db.exec('VACUUM');
        const sizeResult = db.query('SELECT page_count * page_size as size FROM pragma_page_count(), pragma_page_size()').get() as any;
        const sizeKB = Math.round((sizeResult?.size ?? 0) / 1024);
        return { content: [{ type: "text", text: `Removed ${result.blocksRemoved} block(s), reclaimed ${result.bytesReclaimed} bytes. File compacted to ${sizeKB}KB.` }] };
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
