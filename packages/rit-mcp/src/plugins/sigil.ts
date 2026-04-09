/**
 * Sigil MCP plugin.
 *
 * Adds rit_project and rit_materialize tools for projecting TypeScript/TSX
 * through Sigil's entity AST and materializing it back.
 */

import type { RitMcpPlugin, McpToolDef, McpToolResult } from '../plugin.js';
import type { Repository } from '../../../../src/repo/index.js';
import { projectSource, type AstEntityWrite } from '../../../sigil/src/projector.js';
import { materialize } from '../../../sigil/src/materializer.js';

async function writeAstEntities(repo: Repository, writes: AstEntityWrite[]): Promise<void> {
  for (const write of writes) {
    for (const [field, value] of Object.entries(write.fields)) {
      await repo.hset(write.key, field, value);
    }
  }
}

async function readAstEntities(repo: Repository, prefix: string): Promise<AstEntityWrite[]> {
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

async function clearAstEntities(repo: Repository, prefix: string): Promise<void> {
  for await (const key of repo.keys(`ast:${prefix}.*`)) {
    await repo.del(key);
  }
  await repo.del(`module:${prefix}`);
}

export function sigilPlugin(): RitMcpPlugin {
  return {
    name: 'sigil',

    tools(): McpToolDef[] {
      return [
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
      ];
    },

    async handle(toolName: string, args: Record<string, any>, repo: Repository): Promise<McpToolResult | null> {
      switch (toolName) {
        case "rit_project": {
          const { moduleId, code } = args as { moduleId: string; code: string };
          await clearAstEntities(repo, moduleId);
          const writes = projectSource(code, moduleId);
          await writeAstEntities(repo, writes);
          const astCount = writes.filter(w => w.key.startsWith('ast:')).length;
          return { content: [{ type: "text", text: `Projected ${astCount} AST entities for module ${moduleId}` }] };
        }

        case "rit_materialize": {
          const { moduleId } = args as { moduleId: string };
          const writes = await readAstEntities(repo, moduleId);
          if (writes.length === 0) {
            return { content: [{ type: "text", text: "(no AST entities found)" }] };
          }
          const code = materialize(writes);
          return { content: [{ type: "text", text: code }] };
        }

        default:
          return null;
      }
    },
  };
}
