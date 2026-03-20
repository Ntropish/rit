import { Project, SyntaxKind, Node } from 'ts-morph';
import type { LanguagePlugin, EntityWrite, ModuleEntities } from '../types.js';
import { ModuleSchema, FunctionSchema, TypeDefSchema } from '../schemas.js';

export const typescriptPlugin: LanguagePlugin = {
  extensions: ['.ts', '.tsx'],

  ingest(source: string, modulePath: string): EntityWrite[] {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile('input.ts', source);
    const writes: EntityWrite[] = [];
    const moduleKey = `mod:${modulePath}`;

    // Collect imports
    const importPaths: string[] = [];
    for (const imp of sourceFile.getImportDeclarations()) {
      const specifier = imp.getModuleSpecifierValue();
      importPaths.push(`mod:${specifier}`);
    }

    // Module entity
    writes.push({
      schema: ModuleSchema,
      data: {
        path: modulePath,
        imports: importPaths,
      },
    });

    // Track declaration order across all top-level items
    let order = 0;

    for (const statement of sourceFile.getStatements()) {
      // Skip import declarations (already handled)
      if (Node.isImportDeclaration(statement)) continue;

      if (Node.isFunctionDeclaration(statement)) {
        const name = statement.getName();
        if (!name) continue;

        const jsDocNodes = statement.getJsDocs();
        const jsdoc = jsDocNodes.length > 0 ? jsDocNodes.map(d => d.getText()).join('\n') : undefined;
        const bodyNode = statement.getBody();
        const body = bodyNode ? bodyNode.getText() : '{}';

        const params = statement.getParameters().map(p => p.getText()).join(', ');
        const returnType = statement.getReturnTypeNode()?.getText();

        writes.push({
          schema: FunctionSchema,
          data: {
            module: moduleKey,
            name,
            exported: statement.isExported(),
            async: statement.isAsync(),
            params,
            returnType: returnType ?? '',
            body,
            order,
            ...(jsdoc ? { jsdoc } : {}),
          },
        });
        order++;
      } else if (Node.isInterfaceDeclaration(statement)) {
        const name = statement.getName();
        // Get the body (everything between and including braces)
        const body = statement.getText().replace(/^export\s+/, '').replace(/^interface\s+\S+\s*/, '');

        writes.push({
          schema: TypeDefSchema,
          data: {
            module: moduleKey,
            name,
            exported: statement.isExported(),
            kind: 'interface',
            body,
            order,
          },
        });
        order++;
      } else if (Node.isTypeAliasDeclaration(statement)) {
        const name = statement.getName();
        const typeNode = statement.getTypeNode();
        const body = typeNode ? typeNode.getText() : '';

        writes.push({
          schema: TypeDefSchema,
          data: {
            module: moduleKey,
            name,
            exported: statement.isExported(),
            kind: 'type',
            body,
            order,
          },
        });
        order++;
      } else if (Node.isEnumDeclaration(statement)) {
        const name = statement.getName();
        const body = statement.getText().replace(/^export\s+/, '').replace(/^enum\s+\S+\s*/, '');

        writes.push({
          schema: TypeDefSchema,
          data: {
            module: moduleKey,
            name,
            exported: statement.isExported(),
            kind: 'enum',
            body,
            order,
          },
        });
        order++;
      }
    }

    return writes;
  },

  materialize(entities: ModuleEntities): string {
    const lines: string[] = [];

    // Imports from module entity
    const imports = entities.module.imports as string[] | undefined;
    if (imports && imports.length > 0) {
      for (const imp of imports) {
        // Strip 'mod:' prefix to get the module path
        const modPath = imp.startsWith('mod:') ? imp.slice(4) : imp;
        lines.push(`import '${modPath}';`);
      }
      lines.push('');
    }

    // Combine functions and types, sort by order
    type Declaration = { kind: 'function' | 'type'; data: Record<string, unknown>; order: number };
    const declarations: Declaration[] = [];

    for (const fn of entities.functions) {
      declarations.push({ kind: 'function', data: fn, order: fn.order as number });
    }
    for (const typ of entities.types) {
      declarations.push({ kind: 'type', data: typ, order: typ.order as number });
    }
    declarations.sort((a, b) => a.order - b.order);

    for (const decl of declarations) {
      if (decl.kind === 'function') {
        const d = decl.data;
        if (d.jsdoc) {
          lines.push(d.jsdoc as string);
        }
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
  },
};
