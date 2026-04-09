/**
 * Sigil TS-to-entity-AST projector.
 *
 * Parses TypeScript source via ts-morph and emits entity AST nodes.
 * Each ts-morph AST node becomes one or more hash entities keyed as
 * ast:<moduleId>.<counter>.
 *
 * Node IDs are deterministic within a module: same source always
 * produces the same entity keys.
 */

import { Project, SyntaxKind, Node, ts } from 'ts-morph';
import type { AstNodeType } from './schema.js';

// ── Types ───────────────────────────────────────────────

export interface AstEntityWrite {
  key: string;
  fields: Record<string, string>;
}

export interface ProjectionResult {
  /** The node ID assigned to the root of this subtree. */
  nodeId: string;
  /** All entity writes generated (this node + descendants). */
  writes: AstEntityWrite[];
}

interface ProjectionContext {
  moduleId: string;
  counter: number;
}

// ── Public API ──────────────────────────────────────────

/**
 * Project TypeScript source into entity AST nodes.
 *
 * Returns entity writes for all AST nodes plus a module entity
 * referencing the root Program node.
 */
export function projectSource(source: string, moduleId: string): AstEntityWrite[] {
  const project = new Project({ useInMemoryFileSystem: true });
  const sourceFile = project.createSourceFile('input.tsx', source);
  const ctx: ProjectionContext = { moduleId, counter: 0 };

  const result = projectNode(sourceFile, ctx);

  // Module entity
  const moduleWrite: AstEntityWrite = {
    key: `module:${moduleId}`,
    fields: {
      path: moduleId,
      program: result.nodeId,
    },
  };

  return [moduleWrite, ...result.writes];
}

// ── Node ID generation ──────────────────────────────────

function nextId(ctx: ProjectionContext): string {
  return `${ctx.moduleId}.${ctx.counter++}`;
}

// ── Recursive projector ─────────────────────────────────

function projectNode(node: Node, ctx: ProjectionContext): ProjectionResult {
  const kind = node.getKind();

  switch (kind) {
    case SyntaxKind.SourceFile:
      return projectProgram(node, ctx);

    // Declarations
    case SyntaxKind.VariableStatement:
      return projectVariableStatement(node, ctx);
    case SyntaxKind.VariableDeclaration:
      return projectVariableDeclarator(node, ctx);
    case SyntaxKind.FunctionDeclaration:
      return projectFunctionDeclaration(node, ctx);
    case SyntaxKind.ClassDeclaration:
      return projectClassDeclaration(node, ctx);
    case SyntaxKind.ImportDeclaration:
      return projectImportDeclaration(node, ctx);
    case SyntaxKind.ExportDeclaration:
      return projectExportDeclaration(node, ctx);
    case SyntaxKind.ExportAssignment:
      return projectExportAssignment(node, ctx);
    case SyntaxKind.InterfaceDeclaration:
      return projectInterfaceDeclaration(node, ctx);
    case SyntaxKind.TypeAliasDeclaration:
      return projectTypeAliasDeclaration(node, ctx);
    case SyntaxKind.EnumDeclaration:
      return projectEnumDeclaration(node, ctx);

    // Statements
    case SyntaxKind.ExpressionStatement:
      return projectExpressionStatement(node, ctx);
    case SyntaxKind.Block:
      return projectBlock(node, ctx);
    case SyntaxKind.ReturnStatement:
      return projectReturnStatement(node, ctx);
    case SyntaxKind.IfStatement:
      return projectIfStatement(node, ctx);
    case SyntaxKind.ForOfStatement:
      return projectForOfStatement(node, ctx);
    case SyntaxKind.ForInStatement:
      return projectForInStatement(node, ctx);
    case SyntaxKind.ForStatement:
      return projectForStatement(node, ctx);
    case SyntaxKind.WhileStatement:
      return projectWhileStatement(node, ctx);
    case SyntaxKind.DoStatement:
      return projectDoWhileStatement(node, ctx);
    case SyntaxKind.SwitchStatement:
      return projectSwitchStatement(node, ctx);
    case SyntaxKind.TryStatement:
      return projectTryStatement(node, ctx);
    case SyntaxKind.ThrowStatement:
      return projectThrowStatement(node, ctx);
    case SyntaxKind.BreakStatement:
      return projectSimpleStatement(node, ctx, 'BreakStatement');
    case SyntaxKind.ContinueStatement:
      return projectSimpleStatement(node, ctx, 'ContinueStatement');

    // Expressions
    case SyntaxKind.StringLiteral:
    case SyntaxKind.NoSubstitutionTemplateLiteral:
      return projectLiteral(node, ctx, 'string');
    case SyntaxKind.NumericLiteral:
      return projectLiteral(node, ctx, 'number');
    case SyntaxKind.TrueKeyword:
    case SyntaxKind.FalseKeyword:
      return projectLiteral(node, ctx, 'boolean');
    case SyntaxKind.NullKeyword:
      return projectLiteral(node, ctx, 'null');
    case SyntaxKind.UndefinedKeyword:
      return projectLiteral(node, ctx, 'undefined');

    case SyntaxKind.Identifier:
      return projectIdentifier(node, ctx);
    case SyntaxKind.BinaryExpression:
      return projectBinaryExpression(node, ctx);
    case SyntaxKind.PrefixUnaryExpression:
      return projectUnaryExpression(node, ctx, true);
    case SyntaxKind.PostfixUnaryExpression:
      return projectUnaryExpression(node, ctx, false);
    case SyntaxKind.PropertyAccessExpression:
      return projectMemberExpression(node, ctx, false);
    case SyntaxKind.ElementAccessExpression:
      return projectMemberExpression(node, ctx, true);
    case SyntaxKind.CallExpression:
      return projectCallExpression(node, ctx);
    case SyntaxKind.NewExpression:
      return projectNewExpression(node, ctx);
    case SyntaxKind.ConditionalExpression:
      return projectConditionalExpression(node, ctx);
    case SyntaxKind.ArrowFunction:
      return projectArrowFunction(node, ctx);
    case SyntaxKind.FunctionExpression:
      return projectFunctionExpression(node, ctx);
    case SyntaxKind.ArrayLiteralExpression:
      return projectArrayExpression(node, ctx);
    case SyntaxKind.ObjectLiteralExpression:
      return projectObjectExpression(node, ctx);
    case SyntaxKind.PropertyAssignment:
      return projectPropertyAssignment(node, ctx);
    case SyntaxKind.ShorthandPropertyAssignment:
      return projectShorthandProperty(node, ctx);
    case SyntaxKind.SpreadAssignment:
    case SyntaxKind.SpreadElement:
      return projectSpreadElement(node, ctx);
    case SyntaxKind.TemplateExpression:
      return projectTemplateLiteral(node, ctx);
    case SyntaxKind.AwaitExpression:
      return projectPrefixExpression(node, ctx, 'AwaitExpression');
    case SyntaxKind.TypeOfExpression:
      return projectPrefixExpression(node, ctx, 'UnaryExpression', 'typeof');
    case SyntaxKind.VoidExpression:
      return projectPrefixExpression(node, ctx, 'UnaryExpression', 'void');
    case SyntaxKind.DeleteExpression:
      return projectPrefixExpression(node, ctx, 'UnaryExpression', 'delete');
    case SyntaxKind.ParenthesizedExpression:
      return projectParenthesized(node, ctx);
    case SyntaxKind.AsExpression:
      return projectAsExpression(node, ctx);
    case SyntaxKind.NonNullExpression:
      return projectNonNullExpression(node, ctx);
    case SyntaxKind.ThisKeyword:
      return projectThisExpression(node, ctx);
    case SyntaxKind.SuperKeyword:
      return projectSuperExpression(node, ctx);
    case SyntaxKind.TaggedTemplateExpression:
      return projectTaggedTemplate(node, ctx);

    // JSX
    case SyntaxKind.JsxElement:
      return projectJsxElement(node, ctx);
    case SyntaxKind.JsxSelfClosingElement:
      return projectJsxSelfClosing(node, ctx);
    case SyntaxKind.JsxFragment:
      return projectJsxFragment(node, ctx);
    case SyntaxKind.JsxExpression:
      return projectJsxExpression(node, ctx);
    case SyntaxKind.JsxText:
      return projectJsxText(node, ctx);

    // Variable declaration list (wrapper)
    case SyntaxKind.VariableDeclarationList:
      // Handled by VariableStatement; shouldn't reach here directly
      return projectNode(node.getChildAtIndex(0), ctx);

    default:
      // Fallback: store as a literal with the source text
      return projectFallback(node, ctx);
  }
}

// ── Program ─────────────────────────────────────────────

function projectProgram(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];
  const stmtIds: string[] = [];

  for (const child of node.getChildren()) {
    if (child.getKind() === SyntaxKind.SyntaxList) {
      for (const stmt of child.getChildren()) {
        if (stmt.getKind() === SyntaxKind.EndOfFileToken) continue;
        const result = projectNode(stmt, ctx);
        stmtIds.push(result.nodeId);
        writes.push(...result.writes);
      }
    }
  }

  writes.unshift({
    key: `ast:${nodeId}`,
    fields: {
      nodeId,
      type: 'Program',
      stmts: stmtIds.join(','),
    },
  });

  return { nodeId, writes };
}

// ── Literals ────────────────────────────────────────────

function projectLiteral(node: Node, ctx: ProjectionContext, literalType: string): ProjectionResult {
  const nodeId = nextId(ctx);
  const text = node.getText();
  // Strip quotes for string literals
  let value = text;
  if (literalType === 'string') {
    value = text.slice(1, -1); // remove surrounding quotes
  } else if (literalType === 'boolean') {
    value = text; // 'true' or 'false'
  }

  return {
    nodeId,
    writes: [{
      key: `ast:${nodeId}`,
      fields: {
        nodeId,
        type: 'Literal',
        value,
        literalType,
        raw: text,
      },
    }],
  };
}

// ── Identifier ──────────────────────────────────────────

function projectIdentifier(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  return {
    nodeId,
    writes: [{
      key: `ast:${nodeId}`,
      fields: {
        nodeId,
        type: 'Identifier',
        name: node.getText(),
      },
    }],
  };
}

// ── Binary expression ───────────────────────────────────

function projectBinaryExpression(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];

  const children = node.getChildren();
  // BinaryExpression has exactly 3 children: left, operator, right
  const leftResult = projectNode(children[0], ctx);
  writes.push(...leftResult.writes);

  const op = children[1].getText();

  const rightResult = projectNode(children[2], ctx);
  writes.push(...rightResult.writes);

  // Check if this is an assignment (=, +=, etc.)
  const assignOps = ['=', '+=', '-=', '*=', '/=', '%=', '**=', '<<=', '>>=', '>>>=', '&=', '|=', '^=', '&&=', '||=', '??='];
  const nodeType: AstNodeType = assignOps.includes(op) ? 'AssignmentExpression' : 'BinaryExpression';

  writes.unshift({
    key: `ast:${nodeId}`,
    fields: {
      nodeId,
      type: nodeType,
      op,
      left: leftResult.nodeId,
      right: rightResult.nodeId,
    },
  });

  return { nodeId, writes };
}

// ── Unary expression ────────────────────────────────────

function projectUnaryExpression(node: Node, ctx: ProjectionContext, isPrefix: boolean): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];

  const children = node.getChildren();
  let op: string;
  let operandNode: Node;

  if (isPrefix) {
    op = children[0].getText();
    operandNode = children[1];
  } else {
    operandNode = children[0];
    op = children[1].getText();
  }

  const argResult = projectNode(operandNode, ctx);
  writes.push(...argResult.writes);

  // ++ and -- are UpdateExpression, others are UnaryExpression
  const isUpdate = op === '++' || op === '--';

  writes.unshift({
    key: `ast:${nodeId}`,
    fields: {
      nodeId,
      type: isUpdate ? 'UpdateExpression' : 'UnaryExpression',
      op,
      argument: argResult.nodeId,
      prefix: String(isPrefix),
    },
  });

  return { nodeId, writes };
}

// ── Member expression ───────────────────────────────────

function projectMemberExpression(node: Node, ctx: ProjectionContext, isComputed: boolean): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];

  const children = node.getChildren();
  const objResult = projectNode(children[0], ctx);
  writes.push(...objResult.writes);

  // PropertyAccessExpression: [object, dot, property] or [object, ?., property]
  // ElementAccessExpression:   [object, [, expr, ]] or [object, ?., [, expr, ]]
  // Optional chaining inserts a QuestionDotToken, shifting indices.
  const isOptional = children.some(c => c.getKind() === SyntaxKind.QuestionDotToken);
  let propResult: ProjectionResult;
  if (isComputed) {
    // Find the expression between brackets
    const openIdx = children.findIndex(c => c.getKind() === SyntaxKind.OpenBracketToken);
    propResult = projectNode(children[openIdx + 1], ctx);
  } else {
    // Property is the last child
    propResult = projectNode(children[children.length - 1], ctx);
  }
  writes.push(...propResult.writes);

  writes.unshift({
    key: `ast:${nodeId}`,
    fields: {
      nodeId,
      type: 'MemberExpression',
      object: objResult.nodeId,
      property: propResult.nodeId,
      computed: String(isComputed),
      ...(isOptional ? { optional: 'true' } : {}),
    },
  });

  return { nodeId, writes };
}

// ── Call expression ─────────────────────────────────────

function projectCallExpression(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];

  const children = node.getChildren();
  const calleeResult = projectNode(children[0], ctx);
  writes.push(...calleeResult.writes);

  // Arguments are inside parentheses: SyntaxList between ( and )
  const argIds: string[] = [];
  for (const child of children) {
    if (child.getKind() === SyntaxKind.SyntaxList) {
      for (const arg of child.getChildren()) {
        if (arg.getKind() === SyntaxKind.CommaToken) continue;
        const argResult = projectNode(arg, ctx);
        argIds.push(argResult.nodeId);
        writes.push(...argResult.writes);
      }
    }
  }

  writes.unshift({
    key: `ast:${nodeId}`,
    fields: {
      nodeId,
      type: 'CallExpression',
      callee: calleeResult.nodeId,
      arguments: argIds.join(','),
    },
  });

  return { nodeId, writes };
}

// ── New expression ──────────────────────────────────────

function projectNewExpression(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];

  const children = node.getChildren();
  // children[0] is 'new' keyword, children[1] is the expression
  const calleeResult = projectNode(children[1], ctx);
  writes.push(...calleeResult.writes);

  const argIds: string[] = [];
  for (const child of children) {
    if (child.getKind() === SyntaxKind.SyntaxList) {
      for (const arg of child.getChildren()) {
        if (arg.getKind() === SyntaxKind.CommaToken) continue;
        const argResult = projectNode(arg, ctx);
        argIds.push(argResult.nodeId);
        writes.push(...argResult.writes);
      }
    }
  }

  writes.unshift({
    key: `ast:${nodeId}`,
    fields: {
      nodeId,
      type: 'NewExpression',
      callee: calleeResult.nodeId,
      arguments: argIds.join(','),
    },
  });

  return { nodeId, writes };
}

// ── Conditional expression ──────────────────────────────

function projectConditionalExpression(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];

  const children = node.getChildren();
  // children: [test, ?, consequent, :, alternate]
  const testResult = projectNode(children[0], ctx);
  writes.push(...testResult.writes);
  const consResult = projectNode(children[2], ctx);
  writes.push(...consResult.writes);
  const altResult = projectNode(children[4], ctx);
  writes.push(...altResult.writes);

  writes.unshift({
    key: `ast:${nodeId}`,
    fields: {
      nodeId,
      type: 'ConditionalExpression',
      test: testResult.nodeId,
      consequent: consResult.nodeId,
      alternate: altResult.nodeId,
    },
  });

  return { nodeId, writes };
}

// ── Arrow function ──────────────────────────────────────

function projectArrowFunction(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];

  const children = node.getChildren();
  const paramIds: string[] = [];
  let bodyResult: ProjectionResult | null = null;
  let isAsync = false;
  let returnType: string | undefined;

  for (const child of children) {
    if (child.getKind() === SyntaxKind.AsyncKeyword) {
      isAsync = true;
    } else if (child.getKind() === SyntaxKind.SyntaxList) {
      // SyntaxList may contain AsyncKeyword or parameters
      const listChildren = child.getChildren();
      if (listChildren.length === 1 && listChildren[0].getKind() === SyntaxKind.AsyncKeyword) {
        isAsync = true;
      } else {
        for (const param of listChildren) {
          if (param.getKind() === SyntaxKind.CommaToken) continue;
          if (param.getKind() === SyntaxKind.AsyncKeyword) { isAsync = true; continue; }
          const paramResult = projectParameter(param, ctx);
          paramIds.push(paramResult.nodeId);
          writes.push(...paramResult.writes);
        }
      }
    } else if (child.getKind() === SyntaxKind.Block || child.getKind() === SyntaxKind.EqualsGreaterThanToken) {
      // Skip arrow token
    } else if (child.getKind() === SyntaxKind.ColonToken) {
      // Skip colon before return type
    } else if (child.getKind() !== SyntaxKind.OpenParenToken &&
               child.getKind() !== SyntaxKind.CloseParenToken &&
               child.getKind() !== SyntaxKind.EqualsGreaterThanToken) {
      // Could be the body (expression or block) or return type
      if (!bodyResult && child.getStart() > node.getChildren().find(c => c.getKind() === SyntaxKind.EqualsGreaterThanToken)?.getEnd()!) {
        bodyResult = projectNode(child, ctx);
        writes.push(...bodyResult.writes);
      }
    }
  }

  // Get body: last significant child after =>
  if (!bodyResult) {
    const lastChild = children[children.length - 1];
    bodyResult = projectNode(lastChild, ctx);
    writes.push(...bodyResult.writes);
  }

  // Get return type from the node if available
  if (Node.isArrowFunction(node)) {
    const retType = node.getReturnTypeNode();
    if (retType) returnType = retType.getText();
  }

  writes.unshift({
    key: `ast:${nodeId}`,
    fields: {
      nodeId,
      type: 'ArrowFunction',
      params: paramIds.join(','),
      body: bodyResult.nodeId,
      ...(isAsync ? { async: 'true' } : {}),
      ...(returnType ? { returnType } : {}),
    },
  });

  return { nodeId, writes };
}

// ── Function expression ─────────────────────────────────

function projectFunctionExpression(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];

  if (!Node.isFunctionExpression(node)) return projectFallback(node, ctx);

  const name = node.getName();
  const isAsync = node.isAsync();
  const isGenerator = node.isAsteriskToken() !== undefined;

  const paramIds: string[] = [];
  for (const param of node.getParameters()) {
    const paramResult = projectParameter(param, ctx);
    paramIds.push(paramResult.nodeId);
    writes.push(...paramResult.writes);
  }

  const bodyNode = node.getBody();
  const bodyResult = projectNode(bodyNode, ctx);
  writes.push(...bodyResult.writes);

  writes.unshift({
    key: `ast:${nodeId}`,
    fields: {
      nodeId,
      type: 'FunctionExpression',
      params: paramIds.join(','),
      body: bodyResult.nodeId,
      ...(name ? { name } : {}),
      ...(isAsync ? { async: 'true' } : {}),
      ...(isGenerator ? { generator: 'true' } : {}),
    },
  });

  return { nodeId, writes };
}

// ── Array expression ────────────────────────────────────

function projectArrayExpression(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];
  const elementIds: string[] = [];

  for (const child of node.getChildren()) {
    if (child.getKind() === SyntaxKind.SyntaxList) {
      for (const elem of child.getChildren()) {
        if (elem.getKind() === SyntaxKind.CommaToken) continue;
        const elemResult = projectNode(elem, ctx);
        elementIds.push(elemResult.nodeId);
        writes.push(...elemResult.writes);
      }
    }
  }

  writes.unshift({
    key: `ast:${nodeId}`,
    fields: {
      nodeId,
      type: 'ArrayExpression',
      elements: elementIds.join(','),
    },
  });

  return { nodeId, writes };
}

// ── Object expression ───────────────────────────────────

function projectObjectExpression(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];
  const propIds: string[] = [];

  for (const child of node.getChildren()) {
    if (child.getKind() === SyntaxKind.SyntaxList) {
      for (const prop of child.getChildren()) {
        if (prop.getKind() === SyntaxKind.CommaToken) continue;
        const propResult = projectNode(prop, ctx);
        propIds.push(propResult.nodeId);
        writes.push(...propResult.writes);
      }
    }
  }

  writes.unshift({
    key: `ast:${nodeId}`,
    fields: {
      nodeId,
      type: 'ObjectExpression',
      properties: propIds.join(','),
    },
  });

  return { nodeId, writes };
}

// ── Property assignment ─────────────────────────────────

function projectPropertyAssignment(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];

  const children = node.getChildren();
  // [key, colon, value]
  const keyResult = projectNode(children[0], ctx);
  writes.push(...keyResult.writes);
  const valueResult = projectNode(children[2], ctx);
  writes.push(...valueResult.writes);

  writes.unshift({
    key: `ast:${nodeId}`,
    fields: {
      nodeId,
      type: 'Property',
      key: keyResult.nodeId,
      value: valueResult.nodeId,
    },
  });

  return { nodeId, writes };
}

function projectShorthandProperty(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];

  const nameNode = node.getChildAtIndex(0);
  const nameResult = projectNode(nameNode, ctx);
  writes.push(...nameResult.writes);

  writes.unshift({
    key: `ast:${nodeId}`,
    fields: {
      nodeId,
      type: 'Property',
      key: nameResult.nodeId,
      value: nameResult.nodeId,
      shorthand: 'true',
    },
  });

  return { nodeId, writes };
}

// ── Spread element ──────────────────────────────────────

function projectSpreadElement(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];

  const children = node.getChildren();
  // [dotDotDot, expression]
  const argResult = projectNode(children[1], ctx);
  writes.push(...argResult.writes);

  writes.unshift({
    key: `ast:${nodeId}`,
    fields: {
      nodeId,
      type: 'SpreadElement',
      argument: argResult.nodeId,
    },
  });

  return { nodeId, writes };
}

// ── Template literal ────────────────────────────────────

function projectTemplateLiteral(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];
  const quasiIds: string[] = [];
  const exprIds: string[] = [];

  // Flatten SyntaxList wrappers: TemplateSpan nodes may be inside a SyntaxList
  const children: Node[] = [];
  for (const child of node.getChildren()) {
    if (child.getKind() === SyntaxKind.SyntaxList) {
      for (const inner of child.getChildren()) children.push(inner);
    } else {
      children.push(child);
    }
  }

  for (const child of children) {
    if (child.getKind() === SyntaxKind.TemplateHead ||
        child.getKind() === SyntaxKind.TemplateMiddle ||
        child.getKind() === SyntaxKind.TemplateTail) {
      const quasiId = nextId(ctx);
      const text = child.getText();
      // Remove template delimiters (head: `...${, middle: }...${, tail: }...`)
      const cooked = text.replace(/^[`}]/, '').replace(/\$\{$|`$/, '');
      quasiIds.push(quasiId);
      writes.push({
        key: `ast:${quasiId}`,
        fields: { nodeId: quasiId, type: 'Literal', value: cooked, literalType: 'string', raw: text },
      });
    } else if (child.getKind() === SyntaxKind.TemplateSpan) {
      // TemplateSpan contains expression + literal portion
      for (const spanChild of child.getChildren()) {
        if (spanChild.getKind() === SyntaxKind.TemplateMiddle ||
            spanChild.getKind() === SyntaxKind.TemplateTail) {
          const quasiId = nextId(ctx);
          const text = spanChild.getText();
          const cooked = text.replace(/^[}]/, '').replace(/\$\{$|`$/, '');
          quasiIds.push(quasiId);
          writes.push({
            key: `ast:${quasiId}`,
            fields: { nodeId: quasiId, type: 'Literal', value: cooked, literalType: 'string', raw: text },
          });
        } else {
          const exprResult = projectNode(spanChild, ctx);
          exprIds.push(exprResult.nodeId);
          writes.push(...exprResult.writes);
        }
      }
    }
  }

  writes.unshift({
    key: `ast:${nodeId}`,
    fields: {
      nodeId,
      type: 'TemplateLiteral',
      quasis: quasiIds.join(','),
      expressions: exprIds.join(','),
    },
  });

  return { nodeId, writes };
}

// ── Prefix expressions (await, typeof, void, delete) ────

function projectPrefixExpression(node: Node, ctx: ProjectionContext, type: AstNodeType, op?: string): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];

  const children = node.getChildren();
  const argResult = projectNode(children[1], ctx);
  writes.push(...argResult.writes);

  writes.unshift({
    key: `ast:${nodeId}`,
    fields: {
      nodeId,
      type,
      argument: argResult.nodeId,
      ...(op ? { op } : {}),
    },
  });

  return { nodeId, writes };
}

// ── Parenthesized expression ────────────────────────────

function projectParenthesized(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];
  const children = node.getChildren();
  const innerResult = projectNode(children[1], ctx); // skip ( and )
  writes.push(...innerResult.writes);
  writes.unshift({
    key: `ast:${nodeId}`,
    fields: { nodeId, type: 'ParenthesizedExpression', expression: innerResult.nodeId },
  });
  return { nodeId, writes };
}

// ── As expression (TS) ──────────────────────────────────

function projectAsExpression(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];

  const children = node.getChildren();
  const exprResult = projectNode(children[0], ctx);
  writes.push(...exprResult.writes);

  const typeTarget = children[2]?.getText() ?? '';

  writes.unshift({
    key: `ast:${nodeId}`,
    fields: {
      nodeId,
      type: 'AsExpression',
      argument: exprResult.nodeId,
      typeTarget,
    },
  });

  return { nodeId, writes };
}

// ── Non-null expression (TS) ────────────────────────────

function projectNonNullExpression(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];

  const children = node.getChildren();
  const exprResult = projectNode(children[0], ctx);
  writes.push(...exprResult.writes);

  writes.unshift({
    key: `ast:${nodeId}`,
    fields: {
      nodeId,
      type: 'NonNullExpression',
      argument: exprResult.nodeId,
    },
  });

  return { nodeId, writes };
}

// ── This / Super ────────────────────────────────────────

function projectThisExpression(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  return {
    nodeId,
    writes: [{ key: `ast:${nodeId}`, fields: { nodeId, type: 'ThisExpression' } }],
  };
}

function projectSuperExpression(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  return {
    nodeId,
    writes: [{ key: `ast:${nodeId}`, fields: { nodeId, type: 'SuperExpression' } }],
  };
}

// ── Tagged template ─────────────────────────────────────

function projectTaggedTemplate(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];

  const children = node.getChildren();
  const tagResult = projectNode(children[0], ctx);
  writes.push(...tagResult.writes);
  const templateResult = projectNode(children[1], ctx);
  writes.push(...templateResult.writes);

  writes.unshift({
    key: `ast:${nodeId}`,
    fields: {
      nodeId,
      type: 'TaggedTemplate',
      tag: tagResult.nodeId,
      // Template result contains the quasis/expressions
      body: templateResult.nodeId,
    },
  });

  return { nodeId, writes };
}

// ── Statements ──────────────────────────────────────────

function projectExpressionStatement(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];

  const children = node.getChildren();
  const exprResult = projectNode(children[0], ctx);
  writes.push(...exprResult.writes);

  writes.unshift({
    key: `ast:${nodeId}`,
    fields: {
      nodeId,
      type: 'ExpressionStatement',
      argument: exprResult.nodeId,
    },
  });

  return { nodeId, writes };
}

function projectBlock(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];
  const stmtIds: string[] = [];

  for (const child of node.getChildren()) {
    if (child.getKind() === SyntaxKind.SyntaxList) {
      for (const stmt of child.getChildren()) {
        const result = projectNode(stmt, ctx);
        stmtIds.push(result.nodeId);
        writes.push(...result.writes);
      }
    }
  }

  writes.unshift({
    key: `ast:${nodeId}`,
    fields: {
      nodeId,
      type: 'BlockStatement',
      stmts: stmtIds.join(','),
    },
  });

  return { nodeId, writes };
}

function projectReturnStatement(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];

  const children = node.getChildren();
  // [return, expression?, ;]
  let argId: string | undefined;
  for (const child of children) {
    if (child.getKind() !== SyntaxKind.ReturnKeyword && child.getKind() !== SyntaxKind.SemicolonToken) {
      const argResult = projectNode(child, ctx);
      argId = argResult.nodeId;
      writes.push(...argResult.writes);
      break;
    }
  }

  writes.unshift({
    key: `ast:${nodeId}`,
    fields: {
      nodeId,
      type: 'ReturnStatement',
      ...(argId ? { argument: argId } : {}),
    },
  });

  return { nodeId, writes };
}

function projectIfStatement(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];

  if (!Node.isIfStatement(node)) return projectFallback(node, ctx);

  const testResult = projectNode(node.getExpression(), ctx);
  writes.push(...testResult.writes);

  const thenResult = projectNode(node.getThenStatement(), ctx);
  writes.push(...thenResult.writes);

  let altId: string | undefined;
  const elseStmt = node.getElseStatement();
  if (elseStmt) {
    const altResult = projectNode(elseStmt, ctx);
    altId = altResult.nodeId;
    writes.push(...altResult.writes);
  }

  writes.unshift({
    key: `ast:${nodeId}`,
    fields: {
      nodeId,
      type: 'IfStatement',
      test: testResult.nodeId,
      consequent: thenResult.nodeId,
      ...(altId ? { alternate: altId } : {}),
    },
  });

  return { nodeId, writes };
}

function projectForOfStatement(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];

  if (!Node.isForOfStatement(node)) return projectFallback(node, ctx);

  const initResult = projectNode(node.getInitializer(), ctx);
  writes.push(...initResult.writes);

  const exprResult = projectNode(node.getExpression(), ctx);
  writes.push(...exprResult.writes);

  const bodyResult = projectNode(node.getStatement(), ctx);
  writes.push(...bodyResult.writes);

  writes.unshift({
    key: `ast:${nodeId}`,
    fields: {
      nodeId,
      type: 'ForOfStatement',
      left: initResult.nodeId,
      right: exprResult.nodeId,
      body: bodyResult.nodeId,
    },
  });

  return { nodeId, writes };
}

function projectForInStatement(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];

  if (!Node.isForInStatement(node)) return projectFallback(node, ctx);

  const initResult = projectNode(node.getInitializer(), ctx);
  writes.push(...initResult.writes);

  const exprResult = projectNode(node.getExpression(), ctx);
  writes.push(...exprResult.writes);

  const bodyResult = projectNode(node.getStatement(), ctx);
  writes.push(...bodyResult.writes);

  writes.unshift({
    key: `ast:${nodeId}`,
    fields: {
      nodeId,
      type: 'ForInStatement',
      left: initResult.nodeId,
      right: exprResult.nodeId,
      body: bodyResult.nodeId,
    },
  });

  return { nodeId, writes };
}

function projectForStatement(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];

  if (!Node.isForStatement(node)) return projectFallback(node, ctx);

  const fields: Record<string, string> = { nodeId, type: 'ForStatement' };

  const init = node.getInitializer();
  if (init) {
    const initResult = projectNode(init, ctx);
    fields.forInit = initResult.nodeId;
    writes.push(...initResult.writes);
  }

  const cond = node.getCondition();
  if (cond) {
    const condResult = projectNode(cond, ctx);
    fields.test = condResult.nodeId;
    writes.push(...condResult.writes);
  }

  const incr = node.getIncrementor();
  if (incr) {
    const incrResult = projectNode(incr, ctx);
    fields.update = incrResult.nodeId;
    writes.push(...incrResult.writes);
  }

  const bodyResult = projectNode(node.getStatement(), ctx);
  fields.body = bodyResult.nodeId;
  writes.push(...bodyResult.writes);

  writes.unshift({ key: `ast:${nodeId}`, fields });

  return { nodeId, writes };
}

function projectWhileStatement(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];

  if (!Node.isWhileStatement(node)) return projectFallback(node, ctx);

  const testResult = projectNode(node.getExpression(), ctx);
  writes.push(...testResult.writes);

  const bodyResult = projectNode(node.getStatement(), ctx);
  writes.push(...bodyResult.writes);

  writes.unshift({
    key: `ast:${nodeId}`,
    fields: {
      nodeId,
      type: 'WhileStatement',
      test: testResult.nodeId,
      body: bodyResult.nodeId,
    },
  });

  return { nodeId, writes };
}

function projectDoWhileStatement(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];

  if (!Node.isDoStatement(node)) return projectFallback(node, ctx);

  const bodyResult = projectNode(node.getStatement(), ctx);
  writes.push(...bodyResult.writes);

  const testResult = projectNode(node.getExpression(), ctx);
  writes.push(...testResult.writes);

  writes.unshift({
    key: `ast:${nodeId}`,
    fields: {
      nodeId,
      type: 'DoWhileStatement',
      test: testResult.nodeId,
      body: bodyResult.nodeId,
    },
  });

  return { nodeId, writes };
}

function projectSwitchStatement(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];

  if (!Node.isSwitchStatement(node)) return projectFallback(node, ctx);

  const testResult = projectNode(node.getExpression(), ctx);
  writes.push(...testResult.writes);

  const caseIds: string[] = [];
  for (const clause of node.getCaseBlock().getClauses()) {
    const clauseId = nextId(ctx);
    const clauseWrites: AstEntityWrite[] = [];
    const stmtIds: string[] = [];

    for (const stmt of clause.getStatements()) {
      const stmtResult = projectNode(stmt, ctx);
      stmtIds.push(stmtResult.nodeId);
      clauseWrites.push(...stmtResult.writes);
    }

    if (Node.isCaseClause(clause)) {
      const exprResult = projectNode(clause.getExpression(), ctx);
      clauseWrites.push(...exprResult.writes);
      clauseWrites.unshift({
        key: `ast:${clauseId}`,
        fields: {
          nodeId: clauseId,
          type: 'CaseClause',
          test: exprResult.nodeId,
          stmts: stmtIds.join(','),
        },
      });
    } else {
      clauseWrites.unshift({
        key: `ast:${clauseId}`,
        fields: {
          nodeId: clauseId,
          type: 'DefaultClause',
          stmts: stmtIds.join(','),
        },
      });
    }

    caseIds.push(clauseId);
    writes.push(...clauseWrites);
  }

  writes.unshift({
    key: `ast:${nodeId}`,
    fields: {
      nodeId,
      type: 'SwitchStatement',
      test: testResult.nodeId,
      cases: caseIds.join(','),
    },
  });

  return { nodeId, writes };
}

function projectTryStatement(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];

  if (!Node.isTryStatement(node)) return projectFallback(node, ctx);

  const tryResult = projectNode(node.getTryBlock(), ctx);
  writes.push(...tryResult.writes);

  const fields: Record<string, string> = {
    nodeId,
    type: 'TryStatement',
    block: tryResult.nodeId,
  };

  const catchClause = node.getCatchClause();
  if (catchClause) {
    const catchId = nextId(ctx);
    const catchWrites: AstEntityWrite[] = [];
    const catchFields: Record<string, string> = { nodeId: catchId, type: 'CatchClause' };

    const catchParam = catchClause.getVariableDeclaration();
    if (catchParam) {
      const paramResult = projectNode(catchParam.getNameNode(), ctx);
      catchFields.param = paramResult.nodeId;
      catchWrites.push(...paramResult.writes);
    }

    const catchBody = projectNode(catchClause.getBlock(), ctx);
    catchFields.body = catchBody.nodeId;
    catchWrites.push(...catchBody.writes);

    catchWrites.unshift({ key: `ast:${catchId}`, fields: catchFields });
    writes.push(...catchWrites);
    fields.handler = catchId;
  }

  const finallyBlock = node.getFinallyBlock();
  if (finallyBlock) {
    const finallyResult = projectNode(finallyBlock, ctx);
    writes.push(...finallyResult.writes);
    fields.finalizer = finallyResult.nodeId;
  }

  writes.unshift({ key: `ast:${nodeId}`, fields });

  return { nodeId, writes };
}

function projectThrowStatement(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];

  const children = node.getChildren();
  let argId: string | undefined;
  for (const child of children) {
    if (child.getKind() !== SyntaxKind.ThrowKeyword && child.getKind() !== SyntaxKind.SemicolonToken) {
      const result = projectNode(child, ctx);
      argId = result.nodeId;
      writes.push(...result.writes);
      break;
    }
  }

  writes.unshift({
    key: `ast:${nodeId}`,
    fields: {
      nodeId,
      type: 'ThrowStatement',
      ...(argId ? { argument: argId } : {}),
    },
  });

  return { nodeId, writes };
}

function projectSimpleStatement(node: Node, ctx: ProjectionContext, type: AstNodeType): ProjectionResult {
  const nodeId = nextId(ctx);
  return {
    nodeId,
    writes: [{
      key: `ast:${nodeId}`,
      fields: { nodeId, type },
    }],
  };
}

// ── Declarations ────────────────────────────────────────

function projectVariableStatement(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];

  if (!Node.isVariableStatement(node)) return projectFallback(node, ctx);

  const declList = node.getDeclarationList();
  const kind = declList.getDeclarationKind();
  const exported = node.isExported();

  const declIds: string[] = [];
  for (const decl of declList.getDeclarations()) {
    const declResult = projectVariableDeclarator(decl, ctx);
    declIds.push(declResult.nodeId);
    writes.push(...declResult.writes);
  }

  writes.unshift({
    key: `ast:${nodeId}`,
    fields: {
      nodeId,
      type: 'VariableDeclaration',
      kind,
      declarations: declIds.join(','),
      ...(exported ? { exported: 'true' } : {}),
    },
  });

  return { nodeId, writes };
}

function projectVariableDeclarator(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];

  if (!Node.isVariableDeclaration(node)) return projectFallback(node, ctx);

  const nameResult = projectNode(node.getNameNode(), ctx);
  writes.push(...nameResult.writes);

  const fields: Record<string, string> = {
    nodeId,
    type: 'VariableDeclarator',
    name: nameResult.nodeId,
  };

  const init = node.getInitializer();
  if (init) {
    const initResult = projectNode(init, ctx);
    fields.init = initResult.nodeId;
    writes.push(...initResult.writes);
  }

  const typeNode = node.getTypeNode();
  if (typeNode) {
    fields.typeAnnotation = typeNode.getText();
  }

  writes.unshift({ key: `ast:${nodeId}`, fields });

  return { nodeId, writes };
}

function projectFunctionDeclaration(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];

  if (!Node.isFunctionDeclaration(node)) return projectFallback(node, ctx);

  const name = node.getName() ?? '';
  const isAsync = node.isAsync();
  // Check the function's own modifiers for export/default keywords,
  // not ts-morph's isExported() which also considers separate export statements
  const modifiers = node.getModifiers() ?? [];
  const hasExportKeyword = modifiers.some(m => m.getKind() === SyntaxKind.ExportKeyword);
  const hasDefaultKeyword = modifiers.some(m => m.getKind() === SyntaxKind.DefaultKeyword);
  const exported = hasExportKeyword;
  const isDefault = hasExportKeyword && hasDefaultKeyword;

  const paramIds: string[] = [];
  for (const param of node.getParameters()) {
    const paramResult = projectParameter(param, ctx);
    paramIds.push(paramResult.nodeId);
    writes.push(...paramResult.writes);
  }

  const bodyNode = node.getBody();
  let bodyId: string | undefined;
  if (bodyNode) {
    const bodyResult = projectNode(bodyNode, ctx);
    bodyId = bodyResult.nodeId;
    writes.push(...bodyResult.writes);
  }

  const retType = node.getReturnTypeNode();
  const typeParams = node.getTypeParameters();
  const typeParamsText = typeParams.length > 0 ? `<${typeParams.map(p => p.getText()).join(', ')}>` : undefined;

  writes.unshift({
    key: `ast:${nodeId}`,
    fields: {
      nodeId,
      type: 'FunctionDeclaration',
      name,
      params: paramIds.join(','),
      ...(bodyId ? { body: bodyId } : {}),
      ...(isAsync ? { async: 'true' } : {}),
      ...(exported ? { exported: 'true' } : {}),
      ...(isDefault ? { isDefault: 'true' } : {}),
      ...(retType ? { returnType: retType.getText() } : {}),
      ...(typeParamsText ? { typeParams: typeParamsText } : {}),
    },
  });

  return { nodeId, writes };
}

function projectClassDeclaration(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];

  if (!Node.isClassDeclaration(node)) return projectFallback(node, ctx);

  const name = node.getName() ?? '';
  const exported = node.isExported();

  // Store class body as text for now (full class member projection is a later bead)
  const bodyText = node.getText();

  writes.unshift({
    key: `ast:${nodeId}`,
    fields: {
      nodeId,
      type: 'ClassDeclaration',
      name,
      typeBody: bodyText,
      ...(exported ? { exported: 'true' } : {}),
    },
  });

  return { nodeId, writes };
}

function projectImportDeclaration(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];

  if (!Node.isImportDeclaration(node)) return projectFallback(node, ctx);

  const source = node.getModuleSpecifierValue();
  const specifierIds: string[] = [];

  // Default import
  const defaultImport = node.getDefaultImport();
  if (defaultImport) {
    const specId = nextId(ctx);
    specifierIds.push(specId);
    writes.push({
      key: `ast:${specId}`,
      fields: {
        nodeId: specId,
        type: 'ImportSpecifier',
        local: defaultImport.getText(),
        isDefault: 'true',
      },
    });
  }

  // Named imports
  for (const spec of node.getNamedImports()) {
    const specId = nextId(ctx);
    specifierIds.push(specId);
    const local = spec.getName();
    const imported = spec.getAliasNode()?.getText();
    writes.push({
      key: `ast:${specId}`,
      fields: {
        nodeId: specId,
        type: 'ImportSpecifier',
        local,
        ...(imported ? { imported } : {}),
      },
    });
  }

  // Namespace import
  const nsImport = node.getNamespaceImport();
  if (nsImport) {
    const specId = nextId(ctx);
    specifierIds.push(specId);
    writes.push({
      key: `ast:${specId}`,
      fields: {
        nodeId: specId,
        type: 'ImportSpecifier',
        local: nsImport.getText(),
        imported: '*',
      },
    });
  }

  writes.unshift({
    key: `ast:${nodeId}`,
    fields: {
      nodeId,
      type: 'ImportDeclaration',
      source,
      specifiers: specifierIds.join(','),
    },
  });

  return { nodeId, writes };
}

function projectExportDeclaration(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];

  if (!Node.isExportDeclaration(node)) return projectFallback(node, ctx);

  const source = node.getModuleSpecifierValue();
  const specifierIds: string[] = [];

  for (const spec of node.getNamedExports()) {
    const specId = nextId(ctx);
    specifierIds.push(specId);
    const local = spec.getName();
    const alias = spec.getAliasNode()?.getText();
    writes.push({
      key: `ast:${specId}`,
      fields: {
        nodeId: specId,
        type: 'ExportSpecifier',
        local,
        ...(alias ? { exported: alias } : {}),
      },
    });
  }

  const isAll = node.isNamespaceExport() || (specifierIds.length === 0 && source);

  writes.unshift({
    key: `ast:${nodeId}`,
    fields: {
      nodeId,
      type: 'ExportDeclaration',
      specifiers: specifierIds.join(','),
      ...(source ? { source } : {}),
      ...(isAll ? { isAll: 'true' } : {}),
    },
  });

  return { nodeId, writes };
}

function projectExportAssignment(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];

  const children = node.getChildren();
  // Find the expression (skip 'export', 'default', '=')
  let exprResult: ProjectionResult | null = null;
  for (const child of children) {
    if (child.getKind() !== SyntaxKind.ExportKeyword &&
        child.getKind() !== SyntaxKind.DefaultKeyword &&
        child.getKind() !== SyntaxKind.EqualsToken &&
        child.getKind() !== SyntaxKind.SemicolonToken) {
      exprResult = projectNode(child, ctx);
      writes.push(...exprResult.writes);
      break;
    }
  }

  writes.unshift({
    key: `ast:${nodeId}`,
    fields: {
      nodeId,
      type: 'ExportDeclaration',
      isDefault: 'true',
      ...(exprResult ? { declaration: exprResult.nodeId } : {}),
    },
  });

  return { nodeId, writes };
}

// ── TypeScript declarations (stored as text for now) ────

function projectInterfaceDeclaration(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  if (!Node.isInterfaceDeclaration(node)) return projectFallback(node, ctx);

  return {
    nodeId,
    writes: [{
      key: `ast:${nodeId}`,
      fields: {
        nodeId,
        type: 'InterfaceDeclaration',
        name: node.getName(),
        typeBody: node.getText(),
        ...(node.isExported() ? { exported: 'true' } : {}),
      },
    }],
  };
}

function projectTypeAliasDeclaration(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  if (!Node.isTypeAliasDeclaration(node)) return projectFallback(node, ctx);

  return {
    nodeId,
    writes: [{
      key: `ast:${nodeId}`,
      fields: {
        nodeId,
        type: 'TypeAliasDeclaration',
        name: node.getName(),
        typeBody: node.getTypeNode()?.getText() ?? '',
        ...(node.isExported() ? { exported: 'true' } : {}),
      },
    }],
  };
}

function projectEnumDeclaration(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  if (!Node.isEnumDeclaration(node)) return projectFallback(node, ctx);

  return {
    nodeId,
    writes: [{
      key: `ast:${nodeId}`,
      fields: {
        nodeId,
        type: 'EnumDeclaration',
        name: node.getName(),
        typeBody: node.getText(),
        ...(node.isExported() ? { exported: 'true' } : {}),
      },
    }],
  };
}

// ── Parameter ───────────────────────────────────────────

function projectParameter(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];

  if (!Node.isParameterDeclaration(node)) {
    // Simple identifier parameter
    return projectNode(node, ctx);
  }

  const name = node.getName();
  const isRest = node.isRestParameter();
  const typeNode = node.getTypeNode();
  const defaultValue = node.getInitializer();

  const fields: Record<string, string> = {
    nodeId,
    type: 'Parameter',
    name,
    ...(isRest ? { rest: 'true' } : {}),
    ...(typeNode ? { typeAnnotation: typeNode.getText() } : {}),
  };

  if (defaultValue) {
    const defaultResult = projectNode(defaultValue, ctx);
    fields.defaultValue = defaultResult.nodeId;
    writes.push(...defaultResult.writes);
  }

  writes.unshift({ key: `ast:${nodeId}`, fields });

  return { nodeId, writes };
}

// ── Fallback ────────────────────────────────────────────

// ── JSX ────────────────────────────────────────────────

function projectJsxElement(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];
  const children = node.getChildren();

  // First child is JsxOpeningElement, last is JsxClosingElement
  const opening = children[0];
  const openChildren = opening.getChildren();

  // Tag name
  let tagName = '';
  for (const c of openChildren) {
    if (c.getKind() === SyntaxKind.Identifier || c.getKind() === SyntaxKind.PropertyAccessExpression) {
      tagName = c.getText();
      break;
    }
  }

  // Attributes
  const attrIds: string[] = [];
  for (const c of openChildren) {
    if (c.getKind() === SyntaxKind.JsxAttributes) {
      for (const inner of c.getChildren()) {
        const attrs = inner.getKind() === SyntaxKind.SyntaxList ? inner.getChildren() : [inner];
        for (const attr of attrs) {
          if (attr.getKind() === SyntaxKind.JsxAttribute) {
            const attrResult = projectJsxAttribute(attr, ctx);
            attrIds.push(attrResult.nodeId);
            writes.push(...attrResult.writes);
          } else if (attr.getKind() === SyntaxKind.JsxSpreadAttribute) {
            const spreadResult = projectJsxSpreadAttribute(attr, ctx);
            attrIds.push(spreadResult.nodeId);
            writes.push(...spreadResult.writes);
          }
        }
      }
    }
  }

  // Children (between opening and closing)
  const childIds: string[] = [];
  for (let i = 1; i < children.length - 1; i++) {
    const child = children[i];
    if (child.getKind() === SyntaxKind.SyntaxList) {
      for (const grandchild of child.getChildren()) {
        const childResult = projectNode(grandchild, ctx);
        childIds.push(childResult.nodeId);
        writes.push(...childResult.writes);
      }
    } else {
      const childResult = projectNode(child, ctx);
      childIds.push(childResult.nodeId);
      writes.push(...childResult.writes);
    }
  }

  writes.unshift({
    key: `ast:${nodeId}`,
    fields: {
      nodeId,
      type: 'JsxElement',
      tagName,
      attributes: attrIds.join(','),
      jsxChildren: childIds.join(','),
    },
  });

  return { nodeId, writes };
}

function projectJsxSelfClosing(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];
  const children = node.getChildren();

  let tagName = '';
  const attrIds: string[] = [];

  for (const c of children) {
    if (c.getKind() === SyntaxKind.Identifier || c.getKind() === SyntaxKind.PropertyAccessExpression) {
      tagName = c.getText();
    } else if (c.getKind() === SyntaxKind.JsxAttributes) {
      // JsxAttributes -> SyntaxList -> JsxAttribute[]
      for (const inner of c.getChildren()) {
        const attrs = inner.getKind() === SyntaxKind.SyntaxList ? inner.getChildren() : [inner];
        for (const attr of attrs) {
          if (attr.getKind() === SyntaxKind.JsxAttribute) {
            const attrResult = projectJsxAttribute(attr, ctx);
            attrIds.push(attrResult.nodeId);
            writes.push(...attrResult.writes);
          } else if (attr.getKind() === SyntaxKind.JsxSpreadAttribute) {
            const spreadResult = projectJsxSpreadAttribute(attr, ctx);
            attrIds.push(spreadResult.nodeId);
            writes.push(...spreadResult.writes);
          }
        }
      }
    }
  }

  writes.unshift({
    key: `ast:${nodeId}`,
    fields: {
      nodeId,
      type: 'JsxSelfClosingElement',
      tagName,
      attributes: attrIds.join(','),
    },
  });

  return { nodeId, writes };
}

function projectJsxAttribute(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];
  const children = node.getChildren();

  let attrName = '';
  let valueId = '';

  for (const c of children) {
    if (c.getKind() === SyntaxKind.Identifier) {
      attrName = c.getText();
    } else if (c.getKind() === SyntaxKind.StringLiteral) {
      const valResult = projectNode(c, ctx);
      valueId = valResult.nodeId;
      writes.push(...valResult.writes);
    } else if (c.getKind() === SyntaxKind.JsxExpression) {
      const valResult = projectJsxExpression(c, ctx);
      valueId = valResult.nodeId;
      writes.push(...valResult.writes);
    }
  }

  const fields: Record<string, string> = {
    nodeId,
    type: 'JsxAttribute',
    name: attrName,
  };
  if (valueId) fields.init = valueId;

  writes.unshift({ key: `ast:${nodeId}`, fields });
  return { nodeId, writes };
}

function projectJsxSpreadAttribute(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];

  // The expression is inside { ... }
  const exprNode = node.getChildren().find(c =>
    c.getKind() !== SyntaxKind.OpenBraceToken &&
    c.getKind() !== SyntaxKind.CloseBraceToken &&
    c.getKind() !== SyntaxKind.DotDotDotToken
  );

  let argId = '';
  if (exprNode) {
    const result = projectNode(exprNode, ctx);
    argId = result.nodeId;
    writes.push(...result.writes);
  }

  writes.unshift({
    key: `ast:${nodeId}`,
    fields: {
      nodeId,
      type: 'JsxSpreadAttribute',
      argument: argId,
    },
  });

  return { nodeId, writes };
}

function projectJsxExpression(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];

  // Find the expression inside { }
  let exprId = '';
  for (const c of node.getChildren()) {
    if (c.getKind() !== SyntaxKind.OpenBraceToken && c.getKind() !== SyntaxKind.CloseBraceToken) {
      const result = projectNode(c, ctx);
      exprId = result.nodeId;
      writes.push(...result.writes);
      break;
    }
  }

  writes.unshift({
    key: `ast:${nodeId}`,
    fields: {
      nodeId,
      type: 'JsxExpression',
      argument: exprId,
    },
  });

  return { nodeId, writes };
}

function projectJsxText(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  // Use getFullText to preserve leading whitespace (trivia) between JSX expressions
  const text = node.getFullText();

  return {
    nodeId,
    writes: [{
      key: `ast:${nodeId}`,
      fields: {
        nodeId,
        type: 'JsxText',
        text,
      },
    }],
  };
}

function projectJsxFragment(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  const writes: AstEntityWrite[] = [];
  const childIds: string[] = [];

  for (const child of node.getChildren()) {
    if (child.getKind() === SyntaxKind.SyntaxList) {
      for (const grandchild of child.getChildren()) {
        const result = projectNode(grandchild, ctx);
        childIds.push(result.nodeId);
        writes.push(...result.writes);
      }
    }
  }

  writes.unshift({
    key: `ast:${nodeId}`,
    fields: {
      nodeId,
      type: 'JsxFragment',
      jsxChildren: childIds.join(','),
    },
  });

  return { nodeId, writes };
}

// ── Fallback ───────────────────────────────────────────

function projectFallback(node: Node, ctx: ProjectionContext): ProjectionResult {
  const nodeId = nextId(ctx);
  return {
    nodeId,
    writes: [{
      key: `ast:${nodeId}`,
      fields: {
        nodeId,
        type: 'Literal',
        value: node.getText(),
        literalType: 'unknown',
        raw: node.getText(),
      },
    }],
  };
}
