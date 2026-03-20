import type { BunPlugin } from 'bun';
import { Repository } from '../../../src/repo/index.js';
import { SchemaRegistry, EntityStore } from '../../../packages/rit-schema/src/index.js';
import { ModuleSchema, FunctionSchema, TypeDefSchema } from '../../../packages/rit-sync/src/schemas.js';
import type { FileEntities } from '../../../packages/rit-sync/src/types.js';
import { openSqliteStore } from '../../../src/store/sqlite.js';

/**
 * Materialize a module's TypeScript source from its entities.
 * This is a standalone materializer that doesn't require ts-morph.
 */
function materializeTypeScript(entities: FileEntities): string {
  const lines: string[] = [];

  // Imports from root entity
  const imports = entities.root.imports as string[] | undefined;
  if (imports && imports.length > 0) {
    for (const imp of imports) {
      const modPath = imp.startsWith('mod:') ? imp.slice(4) : imp;
      lines.push(`import '${modPath}';`);
    }
    lines.push('');
  }

  // Combine functions and types, sort by order
  type Declaration = { kind: 'function' | 'type'; data: Record<string, unknown>; order: number };
  const declarations: Declaration[] = [];

  for (const fn of (entities.children['fn'] ?? [])) {
    declarations.push({ kind: 'function', data: fn, order: fn.order as number });
  }
  for (const typ of (entities.children['typ'] ?? [])) {
    declarations.push({ kind: 'type', data: typ, order: typ.order as number });
  }
  declarations.sort((a, b) => a.order - b.order);

  for (const decl of declarations) {
    if (decl.kind === 'function') {
      const d = decl.data;
      if (d.jsdoc) lines.push(d.jsdoc as string);
      const exportKw = d.exported ? 'export ' : '';
      const asyncKw = d.async ? 'async ' : '';
      const params = d.params as string;
      const returnType = d.returnType ? `: ${d.returnType}` : '';
      const body = d.body as string;
      lines.push(`${exportKw}${asyncKw}function ${d.name}(${params})${returnType} ${body}`);
      lines.push('');
    } else {
      const d = decl.data;
      const exportKw = d.exported ? 'export ' : '';
      const kind = d.kind as string;
      const body = d.body as string;

      if (kind === 'type') {
        lines.push(`${exportKw}type ${d.name} = ${body};`);
      } else if (kind === 'interface') {
        lines.push(`${exportKw}interface ${d.name} ${body}`);
      } else if (kind === 'enum') {
        lines.push(`${exportKw}enum ${d.name} ${body}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Bun plugin that resolves and loads TypeScript modules from a .rit file.
 *
 * Imports prefixed with "rit:" are resolved from the store.
 * For example: import { add } from "rit:utils"
 * resolves to the "mod:utils" entity and materializes its functions/types.
 */
export function ritBuildPlugin(ritFilePath: string): BunPlugin {
  let entityStore: EntityStore | null = null;
  let closeStore: (() => void) | null = null;

  return {
    name: 'rit-build',

    setup(build) {
      // Resolve rit: imports
      build.onResolve({ filter: /^rit:/ }, (args) => {
        return {
          path: args.path.slice(4), // strip "rit:" prefix
          namespace: 'rit',
        };
      });

      // Load modules from the .rit file
      build.onLoad({ filter: /.*/, namespace: 'rit' }, async (args) => {
        // Lazily initialize the store
        if (!entityStore) {
          const { store, refStore, close } = openSqliteStore(ritFilePath);
          closeStore = close;
          const repo = await Repository.init(store, refStore);
          const registry = new SchemaRegistry();
          registry.register(ModuleSchema);
          registry.register(FunctionSchema);
          registry.register(TypeDefSchema);
          entityStore = new EntityStore(repo, registry);
        }

        const moduleKey = `mod:${args.path}`;
        const mod = await entityStore.get(ModuleSchema, { path: args.path });
        if (!mod) throw new Error(`Module '${args.path}' not found in rit store`);

        const functions = await entityStore.list(FunctionSchema, { module: moduleKey });
        const types = await entityStore.list(TypeDefSchema, { module: moduleKey });

        const source = materializeTypeScript({ root: mod, children: { fn: functions, typ: types } });

        return {
          contents: source,
          loader: 'ts',
        };
      });
    },
  };
}
