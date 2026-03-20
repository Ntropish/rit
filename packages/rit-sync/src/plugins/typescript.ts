import { Project, SyntaxKind, Node } from 'ts-morph';
import type { LanguagePlugin, EntityWrite, FileEntities } from '../types.js';
import { ModuleSchema, FunctionSchema, TypeDefSchema, VariableSchema } from '../schemas.js';

function getTypeParamsText(node: { getTypeParameters(): { getText(): string }[] }): string | undefined {
  const params = node.getTypeParameters();
  if (params.length === 0) return undefined;
  return `<${params.map(p => p.getText()).join(', ')}>`;
}

function getBodyFromBraces(node: { getMembers(): { getText(): string }[]; getText(): string }): string {
  // Use AST to reconstruct body from members
  const fullText = node.getText();
  const firstBrace = fullText.indexOf('{');
  if (firstBrace === -1) return '{}';
  return fullText.slice(firstBrace);
}

export const typescriptPlugin: LanguagePlugin = {
  extensions: ['.ts', '.tsx', '.js', '.jsx'],

  ingest(source: string, modulePath: string): EntityWrite[] {
    const project = new Project({ useInMemoryFileSystem: true });
    // Use .tsx which is permissive enough to parse TS, TSX, JS, and JSX
    const sourceFile = project.createSourceFile('input.tsx', source);
    const writes: EntityWrite[] = [];
    const moduleKey = `mod:${modulePath}`;

    // Collect imports
    const importPaths: string[] = [];
    const importDeclarations: string[] = [];
    for (const imp of sourceFile.getImportDeclarations()) {
      const specifier = imp.getModuleSpecifierValue();
      importPaths.push(`mod:${specifier}`);
      importDeclarations.push(imp.getText());
    }

    // Collect re-export declarations
    const exportDeclarations: string[] = [];
    for (const exp of sourceFile.getExportDeclarations()) {
      exportDeclarations.push(exp.getText());
    }

    // Module entity
    writes.push({
      schema: ModuleSchema,
      data: {
        path: modulePath,
        imports: importPaths,
        importDeclarations,
        ...(exportDeclarations.length > 0 ? { exportDeclarations } : {}),
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
        const typeParams = getTypeParamsText(statement);
        const isDefault = statement.isDefaultExport();

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
            ...(typeParams ? { typeParams } : {}),
            ...(isDefault ? { isDefault } : {}),
          },
        });
        order++;
      } else if (Node.isInterfaceDeclaration(statement)) {
        const name = statement.getName();
        const body = getBodyFromBraces(statement);
        const typeParams = getTypeParamsText(statement);
        const isDefault = statement.isDefaultExport();

        // Heritage (extends)
        const extendsClause = statement.getExtends();
        const heritage = extendsClause.length > 0
          ? `extends ${extendsClause.map(e => e.getText()).join(', ')}`
          : undefined;

        writes.push({
          schema: TypeDefSchema,
          data: {
            module: moduleKey,
            name,
            exported: statement.isExported(),
            kind: 'interface',
            body,
            order,
            ...(typeParams ? { typeParams } : {}),
            ...(heritage ? { heritage } : {}),
            ...(isDefault ? { isDefault } : {}),
          },
        });
        order++;
      } else if (Node.isTypeAliasDeclaration(statement)) {
        const name = statement.getName();
        const typeNode = statement.getTypeNode();
        const body = typeNode ? typeNode.getText() : '';
        const typeParams = getTypeParamsText(statement);

        writes.push({
          schema: TypeDefSchema,
          data: {
            module: moduleKey,
            name,
            exported: statement.isExported(),
            kind: 'type',
            body,
            order,
            ...(typeParams ? { typeParams } : {}),
          },
        });
        order++;
      } else if (Node.isEnumDeclaration(statement)) {
        const name = statement.getName();
        const body = getBodyFromBraces(statement);

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
      } else if (Node.isClassDeclaration(statement)) {
        const name = statement.getName();
        if (!name) continue;

        const body = getBodyFromBraces(statement);
        const typeParams = getTypeParamsText(statement);
        const isDefault = statement.isDefaultExport();

        // Heritage (extends + implements)
        const heritageParts: string[] = [];
        const extendsExpr = statement.getExtends();
        if (extendsExpr) {
          heritageParts.push(`extends ${extendsExpr.getText()}`);
        }
        const implementsExprs = statement.getImplements();
        if (implementsExprs.length > 0) {
          heritageParts.push(`implements ${implementsExprs.map(i => i.getText()).join(', ')}`);
        }
        const heritage = heritageParts.length > 0 ? heritageParts.join(' ') : undefined;

        writes.push({
          schema: TypeDefSchema,
          data: {
            module: moduleKey,
            name,
            exported: statement.isExported(),
            kind: 'class',
            body,
            order,
            ...(typeParams ? { typeParams } : {}),
            ...(heritage ? { heritage } : {}),
            ...(isDefault ? { isDefault } : {}),
          },
        });
        order++;
      } else if (Node.isVariableStatement(statement)) {
        const exported = statement.isExported();
        const isDefault = statement.isDefaultExport();
        const declList = statement.getDeclarationList();
        const declKind = declList.getDeclarationKind();

        for (const decl of declList.getDeclarations()) {
          const name = decl.getName();
          const typeNode = decl.getTypeNode();
          const typeAnnotation = typeNode ? typeNode.getText() : undefined;
          const initializer = decl.getInitializer();
          const initText = initializer ? initializer.getText() : '';

          writes.push({
            schema: VariableSchema,
            data: {
              module: moduleKey,
              name,
              exported,
              declarationKind: declKind,
              initializer: initText,
              order,
              ...(typeAnnotation ? { typeAnnotation } : {}),
              ...(isDefault ? { isDefault } : {}),
            },
          });
          order++;
        }
      }
    }

    return writes;
  },

  materialize(entities: FileEntities): string {
    const lines: string[] = [];

    // Imports from root entity
    const importDecls = entities.root.importDeclarations as string[] | undefined;
    if (importDecls && importDecls.length > 0) {
      for (const decl of importDecls) {
        lines.push(decl);
      }
      lines.push('');
    }

    // Combine all declarations, sort by order
    type Declaration = { kind: 'function' | 'type' | 'variable'; data: Record<string, unknown>; order: number };
    const declarations: Declaration[] = [];

    for (const fn of (entities.children['fn'] ?? [])) {
      declarations.push({ kind: 'function', data: fn, order: fn.order as number });
    }
    for (const typ of (entities.children['typ'] ?? [])) {
      declarations.push({ kind: 'type', data: typ, order: typ.order as number });
    }
    for (const v of (entities.children['var'] ?? [])) {
      declarations.push({ kind: 'variable', data: v, order: v.order as number });
    }
    declarations.sort((a, b) => a.order - b.order);

    for (const decl of declarations) {
      if (decl.kind === 'function') {
        const d = decl.data;
        if (d.jsdoc) {
          lines.push(d.jsdoc as string);
        }
        const exportKw = d.isDefault ? 'export default ' : d.exported ? 'export ' : '';
        const asyncKw = d.async ? 'async ' : '';
        const typeParams = d.typeParams ? (d.typeParams as string) : '';
        const params = d.params as string;
        const returnType = d.returnType ? `: ${d.returnType}` : '';
        const body = d.body as string;
        lines.push(`${exportKw}${asyncKw}function ${d.name}${typeParams}(${params})${returnType} ${body}`);
        lines.push('');
      } else if (decl.kind === 'variable') {
        const d = decl.data;
        const exportKw = d.isDefault ? 'export default ' : d.exported ? 'export ' : '';
        const declKind = d.declarationKind as string;
        const typeAnn = d.typeAnnotation ? `: ${d.typeAnnotation}` : '';
        const init = d.initializer as string;
        lines.push(`${exportKw}${declKind} ${d.name}${typeAnn} = ${init};`);
        lines.push('');
      } else {
        const d = decl.data;
        const exportKw = d.isDefault ? 'export default ' : d.exported ? 'export ' : '';
        const kind = d.kind as string;
        const typeParams = d.typeParams ? (d.typeParams as string) : '';
        const heritage = d.heritage ? ` ${d.heritage}` : '';
        const body = d.body as string;

        if (kind === 'type') {
          lines.push(`${exportKw}type ${d.name}${typeParams} = ${body};`);
        } else if (kind === 'interface') {
          lines.push(`${exportKw}interface ${d.name}${typeParams}${heritage} ${body}`);
        } else if (kind === 'enum') {
          lines.push(`${exportKw}enum ${d.name} ${body}`);
        } else if (kind === 'class') {
          lines.push(`${exportKw}class ${d.name}${typeParams}${heritage} ${body}`);
        }
        lines.push('');
      }
    }

    // Export declarations (re-exports)
    const exportDecls = entities.root.exportDeclarations as string[] | undefined;
    if (exportDecls && exportDecls.length > 0) {
      for (const decl of exportDecls) {
        lines.push(decl);
      }
      lines.push('');
    }

    return lines.join('\n');
  },
};
