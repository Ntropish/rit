import { describe, it, expect } from 'vitest';
import { astSchema, moduleSchema, astKey, AST_NODE_TYPES } from '../schema.js';

describe('Sigil AST Schema', () => {
  describe('astSchema', () => {
    it('has correct prefix and identity', () => {
      expect(astSchema.prefix).toBe('ast');
      expect(astSchema.identity).toEqual(['nodeId']);
    });

    it('requires nodeId and type fields', () => {
      expect(astSchema.fields.nodeId.required).toBe(true);
      expect(astSchema.fields.type.required).toBe(true);
    });

    it('type field is an enum covering all node types', () => {
      expect(astSchema.fields.type.type).toBe('enum');
      const enumValues = astSchema.fields.type.values!.split(',');
      expect(enumValues).toEqual(expect.arrayContaining(AST_NODE_TYPES as unknown as string[]));
      expect(enumValues.length).toBe(AST_NODE_TYPES.length);
    });

    it('has ref fields pointing to ast prefix', () => {
      const refFields = Object.entries(astSchema.fields)
        .filter(([_, def]) => def.type === 'ref');
      for (const [name, def] of refFields) {
        expect(def.refTarget).toBe('ast');
      }
      // Verify key ref fields exist
      expect(astSchema.fields.left.type).toBe('ref');
      expect(astSchema.fields.right.type).toBe('ref');
      expect(astSchema.fields.callee.type).toBe('ref');
      expect(astSchema.fields.body.type).toBe('ref');
      expect(astSchema.fields.test.type).toBe('ref');
      expect(astSchema.fields.argument.type).toBe('ref');
    });

    it('covers expression node types', () => {
      const exprTypes = [
        'Literal', 'Identifier', 'BinaryExpression', 'UnaryExpression',
        'MemberExpression', 'CallExpression', 'ConditionalExpression',
        'ArrowFunction', 'ArrayExpression', 'ObjectExpression',
        'AwaitExpression', 'TemplateLiteral', 'AssignmentExpression',
      ];
      for (const t of exprTypes) {
        expect(AST_NODE_TYPES).toContain(t);
      }
    });

    it('covers statement node types', () => {
      const stmtTypes = [
        'ExpressionStatement', 'BlockStatement', 'ReturnStatement',
        'IfStatement', 'ForStatement', 'ForOfStatement', 'WhileStatement',
        'SwitchStatement', 'TryStatement', 'ThrowStatement',
        'BreakStatement', 'ContinueStatement',
      ];
      for (const t of stmtTypes) {
        expect(AST_NODE_TYPES).toContain(t);
      }
    });

    it('covers declaration node types', () => {
      const declTypes = [
        'VariableDeclaration', 'FunctionDeclaration', 'ClassDeclaration',
        'ImportDeclaration', 'ExportDeclaration',
        'InterfaceDeclaration', 'TypeAliasDeclaration', 'EnumDeclaration',
      ];
      for (const t of declTypes) {
        expect(AST_NODE_TYPES).toContain(t);
      }
    });
  });

  describe('moduleSchema', () => {
    it('has correct prefix and identity', () => {
      expect(moduleSchema.prefix).toBe('module');
      expect(moduleSchema.identity).toEqual(['path']);
    });

    it('has a ref to the program AST node', () => {
      expect(moduleSchema.fields.program.type).toBe('ref');
      expect(moduleSchema.fields.program.refTarget).toBe('ast');
    });
  });

  describe('astKey', () => {
    it('builds correct entity key', () => {
      expect(astKey('abc123')).toBe('ast:abc123');
    });
  });

  describe('node type field coverage', () => {
    it('Literal has value, literalType, raw fields', () => {
      expect(astSchema.fields.value).toBeDefined();
      expect(astSchema.fields.literalType).toBeDefined();
      expect(astSchema.fields.raw).toBeDefined();
    });

    it('BinaryExpression has op, left, right fields', () => {
      expect(astSchema.fields.op).toBeDefined();
      expect(astSchema.fields.left).toBeDefined();
      expect(astSchema.fields.right).toBeDefined();
    });

    it('CallExpression has callee and arguments fields', () => {
      expect(astSchema.fields.callee).toBeDefined();
      expect(astSchema.fields.arguments).toBeDefined();
    });

    it('FunctionDeclaration has name, params, body, async, generator', () => {
      expect(astSchema.fields.name).toBeDefined();
      expect(astSchema.fields.params).toBeDefined();
      expect(astSchema.fields.body).toBeDefined();
      expect(astSchema.fields.async).toBeDefined();
      expect(astSchema.fields.generator).toBeDefined();
    });

    it('ImportDeclaration has source and specifiers', () => {
      expect(astSchema.fields.source).toBeDefined();
      expect(astSchema.fields.specifiers).toBeDefined();
    });

    it('VariableDeclaration has kind and declarations', () => {
      expect(astSchema.fields.kind).toBeDefined();
      expect(astSchema.fields.declarations).toBeDefined();
    });
  });
});
