/**
 * Sigil entity AST materializer.
 *
 * Walks entity AST nodes and emits JavaScript source text.
 * This is the compilation step: entity AST -> JS.
 *
 * The materializer reads from a flat map of entity writes (as produced
 * by the projector) rather than from a rit store directly. This keeps
 * it testable and decoupled from the store layer.
 */

import type { AstEntityWrite } from './projector.js';

// ── Types ───────────────────────────────────────────────

type NodeMap = Map<string, Record<string, string>>;

// ── Public API ──────────────────────────────────────────

/**
 * Materialize entity AST nodes into JavaScript source text.
 *
 * Takes the entity writes produced by `projectSource` and returns
 * the compiled JavaScript string.
 */
export function materialize(writes: AstEntityWrite[]): string {
  // Build a lookup map: nodeId -> fields
  const nodes: NodeMap = new Map();
  let programId: string | undefined;

  for (const write of writes) {
    if (write.key.startsWith('ast:')) {
      nodes.set(write.fields.nodeId, write.fields);
    }
    if (write.key.startsWith('module:')) {
      programId = write.fields.program;
    }
  }

  if (!programId) return '';

  const programNode = nodes.get(programId);
  if (!programNode) return '';

  return emitNode(programNode, nodes);
}

// ── Node emission ───────────────────────────────────────

function emitNode(node: Record<string, string>, nodes: NodeMap): string {
  const type = node.type;

  switch (type) {
    case 'Program':           return emitProgram(node, nodes);
    case 'Literal':           return emitLiteral(node);
    case 'Identifier':        return emitIdentifier(node);
    case 'BinaryExpression':  return emitBinary(node, nodes);
    case 'AssignmentExpression': return emitBinary(node, nodes);
    case 'UnaryExpression':   return emitUnary(node, nodes);
    case 'UpdateExpression':  return emitUpdate(node, nodes);
    case 'MemberExpression':  return emitMember(node, nodes);
    case 'CallExpression':    return emitCall(node, nodes);
    case 'NewExpression':     return emitNew(node, nodes);
    case 'ConditionalExpression': return emitConditional(node, nodes);
    case 'ArrowFunction':     return emitArrow(node, nodes);
    case 'FunctionExpression': return emitFunctionExpr(node, nodes);
    case 'ArrayExpression':   return emitArray(node, nodes);
    case 'ObjectExpression':  return emitObject(node, nodes);
    case 'Property':          return emitProperty(node, nodes);
    case 'SpreadElement':     return emitSpread(node, nodes);
    case 'TemplateLiteral':   return emitTemplate(node, nodes);
    case 'TaggedTemplate':    return emitTaggedTemplate(node, nodes);
    case 'AwaitExpression':   return emitPrefix(node, nodes, 'await ');
    case 'AsExpression':      return emitAs(node, nodes);
    case 'NonNullExpression':  return emitNonNull(node, nodes);
    case 'ThisExpression':    return 'this';
    case 'SuperExpression':   return 'super';

    case 'ExpressionStatement': return emitExpressionStmt(node, nodes);
    case 'BlockStatement':    return emitBlock(node, nodes);
    case 'ReturnStatement':   return emitReturn(node, nodes);
    case 'IfStatement':       return emitIf(node, nodes);
    case 'ForStatement':      return emitFor(node, nodes);
    case 'ForOfStatement':    return emitForOf(node, nodes);
    case 'ForInStatement':    return emitForIn(node, nodes);
    case 'WhileStatement':    return emitWhile(node, nodes);
    case 'DoWhileStatement':  return emitDoWhile(node, nodes);
    case 'SwitchStatement':   return emitSwitch(node, nodes);
    case 'CaseClause':        return emitCase(node, nodes);
    case 'DefaultClause':     return emitDefault(node, nodes);
    case 'TryStatement':      return emitTry(node, nodes);
    case 'CatchClause':       return emitCatch(node, nodes);
    case 'ThrowStatement':    return emitThrow(node, nodes);
    case 'BreakStatement':    return 'break;';
    case 'ContinueStatement': return 'continue;';

    case 'VariableDeclaration':  return emitVarDecl(node, nodes);
    case 'VariableDeclarator':   return emitVarDeclarator(node, nodes);
    case 'FunctionDeclaration':  return emitFunctionDecl(node, nodes);
    case 'ClassDeclaration':     return emitClassDecl(node);
    case 'ImportDeclaration':    return emitImport(node, nodes);
    case 'ExportDeclaration':    return emitExport(node, nodes);
    case 'ImportSpecifier':      return ''; // handled by ImportDeclaration
    case 'ExportSpecifier':      return ''; // handled by ExportDeclaration

    case 'InterfaceDeclaration':  return emitTypeDecl(node);
    case 'TypeAliasDeclaration':  return emitTypeDecl(node);
    case 'EnumDeclaration':       return emitTypeDecl(node);

    case 'Parameter':        return emitParameter(node, nodes);

    // JSX
    case 'JsxElement':           return emitJsxElement(node, nodes);
    case 'JsxSelfClosingElement': return emitJsxSelfClosing(node, nodes);
    case 'JsxFragment':          return emitJsxFragment(node, nodes);
    case 'JsxAttribute':         return emitJsxAttribute(node, nodes);
    case 'JsxSpreadAttribute':   return emitJsxSpreadAttribute(node, nodes);
    case 'JsxExpression':        return emitJsxExpression(node, nodes);
    case 'JsxText':              return node.text ?? '';

    default:
      return node.raw ?? node.value ?? '';
  }
}

function resolve(nodeId: string, nodes: NodeMap): Record<string, string> {
  return nodes.get(nodeId) ?? { type: 'Literal', value: '', literalType: 'unknown' };
}

function emit(nodeId: string, nodes: NodeMap): string {
  return emitNode(resolve(nodeId, nodes), nodes);
}

function emitList(ids: string, nodes: NodeMap, separator = ', '): string {
  if (!ids) return '';
  return ids.split(',').map(id => emit(id.trim(), nodes)).join(separator);
}

// ── Expressions ─────────────────────────────────────────

function emitLiteral(node: Record<string, string>): string {
  return node.raw ?? node.value ?? '';
}

function emitIdentifier(node: Record<string, string>): string {
  return node.name ?? '';
}

function emitBinary(node: Record<string, string>, nodes: NodeMap): string {
  const left = emit(node.left, nodes);
  const right = emit(node.right, nodes);
  return `${left} ${node.op} ${right}`;
}

function emitUnary(node: Record<string, string>, nodes: NodeMap): string {
  const arg = emit(node.argument, nodes);
  const op = node.op;
  // Word operators need a space
  if (['typeof', 'void', 'delete'].includes(op)) {
    return `${op} ${arg}`;
  }
  return `${op}${arg}`;
}

function emitUpdate(node: Record<string, string>, nodes: NodeMap): string {
  const arg = emit(node.argument, nodes);
  return node.prefix === 'true' ? `${node.op}${arg}` : `${arg}${node.op}`;
}

function emitMember(node: Record<string, string>, nodes: NodeMap): string {
  const obj = emit(node.object, nodes);
  const prop = emit(node.property, nodes);
  const opt = node.optional === 'true' ? '?.' : '.';
  if (node.computed === 'true') {
    return `${obj}[${prop}]`;
  }
  return `${obj}${opt}${prop}`;
}

function emitCall(node: Record<string, string>, nodes: NodeMap): string {
  const callee = emit(node.callee, nodes);
  const args = emitList(node.arguments, nodes);
  return `${callee}(${args})`;
}

function emitNew(node: Record<string, string>, nodes: NodeMap): string {
  const callee = emit(node.callee, nodes);
  const args = emitList(node.arguments, nodes);
  return `new ${callee}(${args})`;
}

function emitConditional(node: Record<string, string>, nodes: NodeMap): string {
  const test = emit(node.test, nodes);
  const cons = emit(node.consequent, nodes);
  const alt = emit(node.alternate, nodes);
  return `${test} ? ${cons} : ${alt}`;
}

function emitArrow(node: Record<string, string>, nodes: NodeMap): string {
  const asyncKw = node.async === 'true' ? 'async ' : '';
  const params = emitParamList(node.params, nodes);
  const retType = node.returnType ? `: ${node.returnType}` : '';
  const bodyNode = resolve(node.body, nodes);
  const body = bodyNode.type === 'BlockStatement' ? ` ${emit(node.body, nodes)}` : ` ${emit(node.body, nodes)}`;
  return `${asyncKw}(${params})${retType} => ${emit(node.body, nodes)}`;
}

function emitFunctionExpr(node: Record<string, string>, nodes: NodeMap): string {
  const asyncKw = node.async === 'true' ? 'async ' : '';
  const genStar = node.generator === 'true' ? '*' : '';
  const name = node.name ? ` ${node.name}` : '';
  const params = emitParamList(node.params, nodes);
  const body = emit(node.body, nodes);
  return `${asyncKw}function${genStar}${name}(${params}) ${body}`;
}

function emitArray(node: Record<string, string>, nodes: NodeMap): string {
  const elements = emitList(node.elements, nodes);
  return `[${elements}]`;
}

function emitObject(node: Record<string, string>, nodes: NodeMap): string {
  const props = emitList(node.properties, nodes);
  if (!props) return '{}';
  return `{ ${props} }`;
}

function emitProperty(node: Record<string, string>, nodes: NodeMap): string {
  if (node.shorthand === 'true') {
    return emit(node.key, nodes);
  }
  const key = emit(node.key, nodes);
  const value = emit(node.value, nodes);
  return `${key}: ${value}`;
}

function emitSpread(node: Record<string, string>, nodes: NodeMap): string {
  return `...${emit(node.argument, nodes)}`;
}

function emitTemplate(node: Record<string, string>, nodes: NodeMap): string {
  const quasiIds = node.quasis?.split(',').filter(Boolean) ?? [];
  const exprIds = node.expressions?.split(',').filter(Boolean) ?? [];

  let result = '`';
  for (let i = 0; i < quasiIds.length; i++) {
    const quasi = resolve(quasiIds[i].trim(), nodes);
    result += quasi.value ?? '';
    if (i < exprIds.length) {
      result += '${' + emit(exprIds[i].trim(), nodes) + '}';
    }
  }
  result += '`';
  return result;
}

function emitTaggedTemplate(node: Record<string, string>, nodes: NodeMap): string {
  const tag = emit(node.tag, nodes);
  const template = emit(node.body, nodes);
  return `${tag}${template}`;
}

function emitPrefix(node: Record<string, string>, nodes: NodeMap, prefix: string): string {
  return `${prefix}${emit(node.argument, nodes)}`;
}

function emitAs(node: Record<string, string>, nodes: NodeMap): string {
  return `${emit(node.argument, nodes)} as ${node.typeTarget}`;
}

function emitNonNull(node: Record<string, string>, nodes: NodeMap): string {
  return `${emit(node.argument, nodes)}!`;
}

// ── Statements ──────────────────────────────────────────

function emitProgram(node: Record<string, string>, nodes: NodeMap): string {
  if (!node.stmts) return '';
  return node.stmts.split(',').map(id => emit(id.trim(), nodes)).join('\n');
}

function emitExpressionStmt(node: Record<string, string>, nodes: NodeMap): string {
  return `${emit(node.argument, nodes)};`;
}

function emitBlock(node: Record<string, string>, nodes: NodeMap): string {
  if (!node.stmts) return '{}';
  const stmts = node.stmts.split(',').map(id => '  ' + emit(id.trim(), nodes)).join('\n');
  return `{\n${stmts}\n}`;
}

function emitReturn(node: Record<string, string>, nodes: NodeMap): string {
  if (!node.argument) return 'return;';
  return `return ${emit(node.argument, nodes)};`;
}

function emitIf(node: Record<string, string>, nodes: NodeMap): string {
  const test = emit(node.test, nodes);
  const cons = emit(node.consequent, nodes);
  let result = `if (${test}) ${cons}`;
  if (node.alternate) {
    const alt = emit(node.alternate, nodes);
    result += ` else ${alt}`;
  }
  return result;
}

function emitFor(node: Record<string, string>, nodes: NodeMap): string {
  const init = node.forInit ? emit(node.forInit, nodes) : '';
  const test = node.test ? emit(node.test, nodes) : '';
  const update = node.update ? emit(node.update, nodes) : '';
  const body = emit(node.body, nodes);
  return `for (${init}; ${test}; ${update}) ${body}`;
}

function emitForOf(node: Record<string, string>, nodes: NodeMap): string {
  const left = emit(node.left, nodes);
  const right = emit(node.right, nodes);
  const body = emit(node.body, nodes);
  return `for (${left} of ${right}) ${body}`;
}

function emitForIn(node: Record<string, string>, nodes: NodeMap): string {
  const left = emit(node.left, nodes);
  const right = emit(node.right, nodes);
  const body = emit(node.body, nodes);
  return `for (${left} in ${right}) ${body}`;
}

function emitWhile(node: Record<string, string>, nodes: NodeMap): string {
  const test = emit(node.test, nodes);
  const body = emit(node.body, nodes);
  return `while (${test}) ${body}`;
}

function emitDoWhile(node: Record<string, string>, nodes: NodeMap): string {
  const body = emit(node.body, nodes);
  const test = emit(node.test, nodes);
  return `do ${body} while (${test});`;
}

function emitSwitch(node: Record<string, string>, nodes: NodeMap): string {
  const test = emit(node.test, nodes);
  const cases = node.cases?.split(',').map(id => '  ' + emit(id.trim(), nodes)).join('\n') ?? '';
  return `switch (${test}) {\n${cases}\n}`;
}

function emitCase(node: Record<string, string>, nodes: NodeMap): string {
  const test = emit(node.test, nodes);
  const stmts = node.stmts ? node.stmts.split(',').map(id => '    ' + emit(id.trim(), nodes)).join('\n') : '';
  return `case ${test}:\n${stmts}`;
}

function emitDefault(node: Record<string, string>, nodes: NodeMap): string {
  const stmts = node.stmts ? node.stmts.split(',').map(id => '    ' + emit(id.trim(), nodes)).join('\n') : '';
  return `default:\n${stmts}`;
}

function emitTry(node: Record<string, string>, nodes: NodeMap): string {
  let result = `try ${emit(node.block, nodes)}`;
  if (node.handler) {
    result += ` ${emit(node.handler, nodes)}`;
  }
  if (node.finalizer) {
    result += ` finally ${emit(node.finalizer, nodes)}`;
  }
  return result;
}

function emitCatch(node: Record<string, string>, nodes: NodeMap): string {
  const param = node.param ? `(${emit(node.param, nodes)})` : '';
  const body = emit(node.body, nodes);
  return `catch ${param} ${body}`;
}

function emitThrow(node: Record<string, string>, nodes: NodeMap): string {
  if (!node.argument) return 'throw;';
  return `throw ${emit(node.argument, nodes)};`;
}

// ── Declarations ────────────────────────────────────────

function emitVarDecl(node: Record<string, string>, nodes: NodeMap): string {
  const exportKw = node.exported === 'true' ? 'export ' : '';
  const declarators = node.declarations?.split(',').map(id => emit(id.trim(), nodes)).join(', ') ?? '';
  return `${exportKw}${node.kind} ${declarators};`;
}

function emitVarDeclarator(node: Record<string, string>, nodes: NodeMap): string {
  const name = emit(node.name, nodes);
  const typeAnn = node.typeAnnotation ? `: ${node.typeAnnotation}` : '';
  if (!node.init) return `${name}${typeAnn}`;
  const init = emit(node.init, nodes);
  return `${name}${typeAnn} = ${init}`;
}

function emitFunctionDecl(node: Record<string, string>, nodes: NodeMap): string {
  const exportKw = node.isDefault === 'true' ? 'export default ' : node.exported === 'true' ? 'export ' : '';
  const asyncKw = node.async === 'true' ? 'async ' : '';
  const typeParams = node.typeParams ?? '';
  const params = emitParamList(node.params, nodes);
  const retType = node.returnType ? `: ${node.returnType}` : '';
  const body = node.body ? ` ${emit(node.body, nodes)}` : ' {}';
  return `${exportKw}${asyncKw}function ${node.name}${typeParams}(${params})${retType}${body}`;
}

function emitClassDecl(node: Record<string, string>): string {
  // Class bodies are stored as full text for now
  return node.typeBody ?? '';
}

function emitImport(node: Record<string, string>, nodes: NodeMap): string {
  const specIds = node.specifiers?.split(',').filter(Boolean) ?? [];
  if (specIds.length === 0) {
    return `import "${node.source}";`;
  }

  const specs = specIds.map(id => resolve(id.trim(), nodes));
  const defaultSpec = specs.find(s => s.isDefault === 'true');
  const nsSpec = specs.find(s => s.imported === '*');
  const namedSpecs = specs.filter(s => s.isDefault !== 'true' && s.imported !== '*');

  const parts: string[] = [];
  if (defaultSpec) {
    parts.push(defaultSpec.local);
  }
  if (nsSpec) {
    parts.push(`* as ${nsSpec.local}`);
  }
  if (namedSpecs.length > 0) {
    const named = namedSpecs.map(s => {
      if (s.imported && s.imported !== s.local) {
        return `${s.local} as ${s.imported}`;
      }
      return s.local;
    }).join(', ');
    parts.push(`{ ${named} }`);
  }

  return `import ${parts.join(', ')} from "${node.source}";`;
}

function emitExport(node: Record<string, string>, nodes: NodeMap): string {
  if (node.isDefault === 'true') {
    if (node.declaration) {
      return `export default ${emit(node.declaration, nodes)};`;
    }
    return 'export default;';
  }

  if (node.isAll === 'true') {
    return node.source ? `export * from "${node.source}";` : '';
  }

  const specIds = node.specifiers?.split(',').filter(Boolean) ?? [];
  if (specIds.length > 0) {
    const specs = specIds.map(id => {
      const s = resolve(id.trim(), nodes);
      if (s.exported && s.exported !== s.local) {
        return `${s.local} as ${s.exported}`;
      }
      return s.local;
    });
    const from = node.source ? ` from "${node.source}"` : '';
    return `export { ${specs.join(', ')} }${from};`;
  }

  return '';
}

function emitTypeDecl(node: Record<string, string>): string {
  // TypeScript declarations stored as full text
  return node.typeBody ?? '';
}

// ── Parameters ──────────────────────────────────────────

function emitParameter(node: Record<string, string>, nodes: NodeMap): string {
  const rest = node.rest === 'true' ? '...' : '';
  const name = node.name;
  const typeAnn = node.typeAnnotation ? `: ${node.typeAnnotation}` : '';
  const defaultVal = node.defaultValue ? ` = ${emit(node.defaultValue, nodes)}` : '';
  return `${rest}${name}${typeAnn}${defaultVal}`;
}

function emitParamList(paramIds: string | undefined, nodes: NodeMap): string {
  if (!paramIds) return '';
  return paramIds.split(',').filter(Boolean).map(id => {
    const node = resolve(id.trim(), nodes);
    if (node.type === 'Parameter') {
      return emitParameter(node, nodes);
    }
    return emitNode(node, nodes);
  }).join(', ');
}

// ── JSX emission ───────────────────────────────────────

function emitJsxAttributes(attrIds: string, nodes: NodeMap): string {
  if (!attrIds) return '';
  const attrs = attrIds.split(',').filter(Boolean).map(id => emit(id.trim(), nodes));
  return attrs.length > 0 ? ' ' + attrs.join(' ') : '';
}

function emitJsxChildren(childIds: string, nodes: NodeMap): string {
  if (!childIds) return '';
  return childIds.split(',').filter(Boolean).map(id => emit(id.trim(), nodes)).join('');
}

function emitJsxElement(node: Record<string, string>, nodes: NodeMap): string {
  const tag = node.tagName ?? 'div';
  const attrs = emitJsxAttributes(node.attributes, nodes);
  const children = emitJsxChildren(node.jsxChildren, nodes);
  return `<${tag}${attrs}>${children}</${tag}>`;
}

function emitJsxSelfClosing(node: Record<string, string>, nodes: NodeMap): string {
  const tag = node.tagName ?? 'br';
  const attrs = emitJsxAttributes(node.attributes, nodes);
  return `<${tag}${attrs} />`;
}

function emitJsxFragment(node: Record<string, string>, nodes: NodeMap): string {
  const children = emitJsxChildren(node.jsxChildren, nodes);
  return `<>${children}</>`;
}

function emitJsxAttribute(node: Record<string, string>, nodes: NodeMap): string {
  const name = node.name ?? '';
  if (!node.init) return name;
  const valueNode = resolve(node.init, nodes);
  if (valueNode.type === 'Literal' && valueNode.literalType === 'string') {
    return `${name}=${emitLiteral(valueNode)}`;
  }
  if (valueNode.type === 'JsxExpression') {
    return `${name}=${emitJsxExpression(valueNode, nodes)}`;
  }
  return `${name}={${emit(node.init, nodes)}}`;
}

function emitJsxSpreadAttribute(node: Record<string, string>, nodes: NodeMap): string {
  return `{...${node.argument ? emit(node.argument, nodes) : ''}}`;
}

function emitJsxExpression(node: Record<string, string>, nodes: NodeMap): string {
  if (!node.argument) return '{}';
  return `{${emit(node.argument, nodes)}}`;
}
