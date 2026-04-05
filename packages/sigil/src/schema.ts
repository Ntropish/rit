/**
 * Sigil AST Entity Schema
 *
 * Defines how program AST nodes are stored as entities in a rit store.
 * Each AST node is a hash entity keyed as `ast:<nodeId>`. The `type`
 * field determines which other fields are used.
 *
 * Node references use the `ref` type pointing to other `ast` entities.
 * Node lists (e.g., function arguments) use comma-separated node IDs
 * in a string field.
 *
 * This schema covers TypeScript/JavaScript programs. It is designed to
 * be projected from TypeScript source via ts-morph and compiled back
 * to JavaScript for execution by standard runtimes.
 */

import type { EntitySchema } from '../../rit-schema/src/types.js';

// ── Node type enum ──────────────────────────────────────

/**
 * All AST node types supported by Sigil.
 *
 * Organized by category:
 * - Expressions: produce values
 * - Statements: perform actions
 * - Declarations: introduce names
 * - Patterns: destructuring targets
 * - Other: structural nodes
 */
export const AST_NODE_TYPES = [
  // Expressions
  'Literal',              // string, number, boolean, null, undefined, regex
  'Identifier',           // variable reference
  'BinaryExpression',     // a + b, a === b, a && b, a ?? b
  'UnaryExpression',      // !a, -a, typeof a, void a, delete a
  'UpdateExpression',     // a++, --a
  'MemberExpression',     // a.b, a[b], a?.b
  'CallExpression',       // fn(a, b), a?.()
  'NewExpression',        // new Foo(a)
  'ConditionalExpression',// a ? b : c
  'ArrowFunction',        // (a) => b, (a) => { ... }
  'FunctionExpression',   // function(a) { ... }
  'ArrayExpression',      // [a, b, c]
  'ObjectExpression',     // { key: value }
  'Property',             // key: value (inside ObjectExpression)
  'SpreadElement',        // ...a
  'TemplateLiteral',      // `hello ${name}`
  'TemplateSpan',         // ${expr} portion of template
  'TaggedTemplate',       // tag`hello ${name}`
  'AssignmentExpression', // a = b, a += b
  'SequenceExpression',   // a, b
  'AwaitExpression',      // await p
  'YieldExpression',      // yield v
  'AsExpression',         // x as Type (TS)
  'NonNullExpression',    // x! (TS)
  'ParenthesizedExpression', // (a)
  'ClassExpression',      // class { ... }
  'ThisExpression',       // this
  'SuperExpression',      // super

  // Statements
  'ExpressionStatement',  // expression;
  'BlockStatement',       // { ... }
  'ReturnStatement',      // return expr
  'IfStatement',          // if (cond) { ... } else { ... }
  'ForStatement',         // for (init; cond; update) { ... }
  'ForOfStatement',       // for (item of collection) { ... }
  'ForInStatement',       // for (key in object) { ... }
  'WhileStatement',       // while (cond) { ... }
  'DoWhileStatement',     // do { ... } while (cond)
  'SwitchStatement',      // switch (expr) { ... }
  'CaseClause',           // case expr: ...
  'DefaultClause',        // default: ...
  'TryStatement',         // try { ... } catch (e) { ... } finally { ... }
  'CatchClause',          // catch (e) { ... }
  'ThrowStatement',       // throw expr
  'BreakStatement',       // break, break label
  'ContinueStatement',    // continue, continue label
  'LabeledStatement',     // label: statement
  'EmptyStatement',       // ;

  // Declarations
  'VariableDeclaration',  // const/let/var x = expr
  'VariableDeclarator',   // x = expr (inside VariableDeclaration)
  'FunctionDeclaration',  // function name(params) { ... }
  'ClassDeclaration',     // class Name { ... }
  'MethodDefinition',     // method(params) { ... } (inside class)
  'PropertyDefinition',   // field = value (inside class)
  'ImportDeclaration',    // import { a } from 'b'
  'ImportSpecifier',      // { a as b } inside import
  'ExportDeclaration',    // export { a }, export default expr
  'ExportSpecifier',      // { a as b } inside export

  // Declarations (TypeScript)
  'InterfaceDeclaration', // interface Foo { ... }
  'TypeAliasDeclaration', // type Foo = ...
  'EnumDeclaration',      // enum Foo { ... }
  'EnumMember',           // A = 1 (inside enum)

  // Patterns
  'ArrayPattern',         // [a, b] = expr
  'ObjectPattern',        // { a, b } = expr
  'RestElement',          // ...rest

  // Other
  'Program',              // root node, contains body statements
  'Parameter',            // function parameter with optional type/default
  'TypeAnnotation',       // : Type (TS type annotation, stored as text for now)
  'ComputedPropertyName', // [expr] as property name
] as const;

export type AstNodeType = (typeof AST_NODE_TYPES)[number];

// ── Entity schema ───────────────────────────────────────

/**
 * The AST entity schema. All AST nodes share this schema with a single
 * `type` enum. Type-specific fields are used based on the node type.
 *
 * Key pattern: ast:<nodeId>
 *
 * References between nodes use the `ref` type pointing to `ast` prefix.
 * Lists of nodes (e.g., arguments, body statements) use comma-separated
 * node IDs in a string field.
 */
export const astSchema: EntitySchema = {
  prefix: 'ast',
  identity: ['nodeId'],
  fields: {
    nodeId: { type: 'string', required: true },
    type:   { type: 'enum', required: true, values: AST_NODE_TYPES.join(',') },

    // ── Shared fields ──────────────────────────────────
    // Many node types use these common fields.

    /** Parent node reference. */
    parent: { type: 'ref', refTarget: 'ast' },

    // ── Literal ────────────────────────────────────────
    /** Literal value as string. */
    value:     { type: 'string' },
    /** Literal subtype: string, number, boolean, null, undefined, bigint, regex. */
    literalType: { type: 'string' },
    /** Raw source text of the literal (preserves quotes, regex flags). */
    raw:       { type: 'string' },

    // ── Identifier ─────────────────────────────────────
    /** Identifier name. Also used for label names, import/export names. */
    name:      { type: 'string' },

    // ── Binary / Unary / Update / Assignment ───────────
    /** Operator: +, -, *, /, ===, !==, &&, ||, ??, typeof, etc. */
    op:        { type: 'string' },
    /** Left operand (binary, assignment). */
    left:      { type: 'ref', refTarget: 'ast' },
    /** Right operand (binary, assignment). */
    right:     { type: 'ref', refTarget: 'ast' },
    /** Operand (unary, update, await, yield, throw, return, spread, typeof). */
    argument:  { type: 'ref', refTarget: 'ast' },
    /** Prefix vs postfix (update expressions). */
    prefix:    { type: 'boolean' },

    // ── Member access ──────────────────────────────────
    /** Object being accessed. */
    object:    { type: 'ref', refTarget: 'ast' },
    /** Property being accessed (Identifier or expression). */
    property:  { type: 'ref', refTarget: 'ast' },
    /** Computed access: a[b] vs a.b. */
    computed:  { type: 'boolean' },
    /** Optional chaining: a?.b, a?.() */
    optional:  { type: 'boolean' },

    // ── Call / New ──────────────────────────────────────
    /** Function being called. */
    callee:    { type: 'ref', refTarget: 'ast' },
    /** Comma-separated argument node IDs. */
    arguments: { type: 'string', label: 'Comma-separated argument node IDs' },

    // ── Conditional ────────────────────────────────────
    /** Test condition (if, conditional, while, for, switch). */
    test:      { type: 'ref', refTarget: 'ast' },
    /** Consequent branch (if true). */
    consequent: { type: 'ref', refTarget: 'ast' },
    /** Alternate branch (if false, else). */
    alternate: { type: 'ref', refTarget: 'ast' },

    // ── Function / Arrow / Method ──────────────────────
    /** Comma-separated parameter node IDs. */
    params:    { type: 'string', label: 'Comma-separated parameter node IDs' },
    /** Function/arrow/method body (BlockStatement or expression). */
    body:      { type: 'ref', refTarget: 'ast' },
    /** Whether the function is async. */
    async:     { type: 'boolean' },
    /** Whether the function is a generator. */
    generator: { type: 'boolean' },
    /** Return type annotation (TS, stored as text). */
    returnType: { type: 'string' },

    // ── Variable declaration ───────────────────────────
    /** Declaration kind: const, let, var. */
    kind:      { type: 'string' },
    /** Comma-separated declarator node IDs. */
    declarations: { type: 'string', label: 'Comma-separated declarator node IDs' },
    /** Initializer expression (declarator, property, enum member, default param). */
    init:      { type: 'ref', refTarget: 'ast' },

    // ── Class ──────────────────────────────────────────
    /** Superclass expression. */
    superClass: { type: 'ref', refTarget: 'ast' },
    /** Comma-separated class member node IDs (methods, properties). */
    members:   { type: 'string', label: 'Comma-separated member node IDs' },
    /** Static modifier (method, property). */
    static:    { type: 'boolean' },
    /** Accessibility: public, private, protected (TS). */
    accessibility: { type: 'string' },

    // ── Object / Property ──────────────────────────────
    /** Comma-separated property node IDs (object expression). */
    properties: { type: 'string', label: 'Comma-separated property node IDs' },
    /** Property key (Identifier, Literal, or ComputedPropertyName). */
    key:       { type: 'ref', refTarget: 'ast' },
    /** Property shorthand: { a } vs { a: a }. */
    shorthand: { type: 'boolean' },
    /** Method property: { fn() {} }. */
    method:    { type: 'boolean' },

    // ── Array ──────────────────────────────────────────
    /** Comma-separated element node IDs. */
    elements:  { type: 'string', label: 'Comma-separated element node IDs' },

    // ── Template literal ───────────────────────────────
    /** Comma-separated quasi (string part) node IDs. */
    quasis:    { type: 'string', label: 'Comma-separated quasi node IDs' },
    /** Comma-separated expression node IDs in template. */
    expressions: { type: 'string', label: 'Comma-separated expression node IDs' },
    /** Tag expression (tagged template). */
    tag:       { type: 'ref', refTarget: 'ast' },
    /** Cooked string value of a template quasi. */
    cooked:    { type: 'string' },

    // ── Control flow ───────────────────────────────────
    /** Comma-separated statement node IDs (block body, program body). */
    stmts:     { type: 'string', label: 'Comma-separated statement node IDs' },
    /** For-loop initializer. */
    forInit:   { type: 'ref', refTarget: 'ast' },
    /** For-loop update expression. */
    update:    { type: 'ref', refTarget: 'ast' },
    /** Switch case clauses (comma-separated node IDs). */
    cases:     { type: 'string', label: 'Comma-separated case clause node IDs' },
    /** Try block. */
    block:     { type: 'ref', refTarget: 'ast' },
    /** Catch handler. */
    handler:   { type: 'ref', refTarget: 'ast' },
    /** Finally block. */
    finalizer: { type: 'ref', refTarget: 'ast' },
    /** Catch clause parameter. */
    param:     { type: 'ref', refTarget: 'ast' },
    /** Label name (break, continue, labeled statement). */
    label:     { type: 'string' },

    // ── Import / Export ────────────────────────────────
    /** Module specifier string (import/export source). */
    source:    { type: 'string' },
    /** Comma-separated specifier node IDs. */
    specifiers: { type: 'string', label: 'Comma-separated specifier node IDs' },
    /** Local name (import specifier). */
    local:     { type: 'string' },
    /** Exported/imported name. */
    imported:  { type: 'string' },
    exported:  { type: 'string' },
    /** Default export flag. */
    isDefault: { type: 'boolean' },
    /** Export-all flag (export * from '...'). */
    isAll:     { type: 'boolean' },
    /** Declaration inside export (export const x = ...). */
    declaration: { type: 'ref', refTarget: 'ast' },

    // ── TypeScript-specific ────────────────────────────
    /** Type annotation text (stored as source text, not decomposed). */
    typeAnnotation: { type: 'string' },
    /** Type parameters text (generics). */
    typeParams: { type: 'string' },
    /** Implements clauses (class). */
    implements: { type: 'string' },
    /** Extends clause (interface, class). */
    extends:   { type: 'string' },
    /** Interface/type body (stored as source text for now). */
    typeBody:  { type: 'string' },
    /** Enum members (comma-separated node IDs). */
    enumMembers: { type: 'string', label: 'Comma-separated enum member node IDs' },
    /** As-expression type target. */
    typeTarget: { type: 'string' },

    // ── Pattern (destructuring) ────────────────────────
    /** Comma-separated pattern element node IDs. */
    patternElements: { type: 'string', label: 'Comma-separated pattern element node IDs' },

    // ── Parameter ──────────────────────────────────────
    /** Default value for parameter. */
    defaultValue: { type: 'ref', refTarget: 'ast' },
    /** Rest parameter flag. */
    rest:      { type: 'boolean' },

    // ── Yield ──────────────────────────────────────────
    /** Delegate flag (yield*). */
    delegate:  { type: 'boolean' },
  },
};

/**
 * Build an AST node entity key.
 */
export function astKey(nodeId: string): string {
  return `ast:${nodeId}`;
}

/**
 * Module entity schema. A module is the entry point that references
 * a Program AST node and tracks metadata (source path, imports/exports).
 */
export const moduleSchema: EntitySchema = {
  prefix: 'module',
  identity: ['path'],
  fields: {
    path:     { type: 'string', required: true },
    /** Reference to the root Program AST node. */
    program:  { type: 'ref', refTarget: 'ast' },
    /** Original source file path (for materialization). */
    sourcePath: { type: 'string' },
    /** Comma-separated import module paths. */
    imports:  { type: 'string', label: 'Comma-separated imported module paths' },
    /** Comma-separated exported names. */
    exports:  { type: 'string', label: 'Comma-separated exported names' },
  },
};
