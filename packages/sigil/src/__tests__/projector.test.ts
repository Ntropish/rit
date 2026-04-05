import { describe, it, expect } from 'vitest';
import { projectSource } from '../projector.js';
import type { AstEntityWrite } from '../projector.js';

function findByType(writes: AstEntityWrite[], type: string): AstEntityWrite | undefined {
  return writes.find(w => w.fields.type === type);
}

function findAllByType(writes: AstEntityWrite[], type: string): AstEntityWrite[] {
  return writes.filter(w => w.fields.type === type);
}

describe('Sigil TS-to-entity-AST projector', () => {
  describe('module and program', () => {
    it('creates a module entity and a Program node', () => {
      const writes = projectSource('', 'test');
      const module = writes.find(w => w.key === 'module:test');
      expect(module).toBeDefined();
      expect(module!.fields.path).toBe('test');

      const program = findByType(writes, 'Program');
      expect(program).toBeDefined();
      expect(module!.fields.program).toBe(program!.fields.nodeId);
    });
  });

  describe('literals', () => {
    it('projects string literals', () => {
      const writes = projectSource('const x = "hello";', 'test');
      const lit = findByType(writes, 'Literal');
      expect(lit).toBeDefined();
      expect(lit!.fields.value).toBe('hello');
      expect(lit!.fields.literalType).toBe('string');
    });

    it('projects number literals', () => {
      const writes = projectSource('const x = 42;', 'test');
      const lit = writes.find(w => w.fields.type === 'Literal' && w.fields.literalType === 'number');
      expect(lit).toBeDefined();
      expect(lit!.fields.value).toBe('42');
    });

    it('projects boolean literals', () => {
      const writes = projectSource('const x = true;', 'test');
      const lit = writes.find(w => w.fields.type === 'Literal' && w.fields.literalType === 'boolean');
      expect(lit).toBeDefined();
      expect(lit!.fields.value).toBe('true');
    });

    it('projects null', () => {
      const writes = projectSource('const x = null;', 'test');
      const lit = writes.find(w => w.fields.type === 'Literal' && w.fields.literalType === 'null');
      expect(lit).toBeDefined();
    });
  });

  describe('identifiers', () => {
    it('projects identifier references', () => {
      const writes = projectSource('x;', 'test');
      const ident = findByType(writes, 'Identifier');
      expect(ident).toBeDefined();
      expect(ident!.fields.name).toBe('x');
    });
  });

  describe('binary expressions', () => {
    it('projects binary operations', () => {
      const writes = projectSource('const x = a + b;', 'test');
      const bin = findByType(writes, 'BinaryExpression');
      expect(bin).toBeDefined();
      expect(bin!.fields.op).toBe('+');
      expect(bin!.fields.left).toBeDefined();
      expect(bin!.fields.right).toBeDefined();
    });

    it('projects assignment as AssignmentExpression', () => {
      const writes = projectSource('x = 5;', 'test');
      const assign = findByType(writes, 'AssignmentExpression');
      expect(assign).toBeDefined();
      expect(assign!.fields.op).toBe('=');
    });
  });

  describe('call expressions', () => {
    it('projects function calls', () => {
      const writes = projectSource('foo(1, 2);', 'test');
      const call = findByType(writes, 'CallExpression');
      expect(call).toBeDefined();
      expect(call!.fields.callee).toBeDefined();
      expect(call!.fields.arguments).toBeDefined();
      // Two arguments
      expect(call!.fields.arguments.split(',').length).toBe(2);
    });
  });

  describe('member expressions', () => {
    it('projects property access', () => {
      const writes = projectSource('a.b;', 'test');
      const member = findByType(writes, 'MemberExpression');
      expect(member).toBeDefined();
      expect(member!.fields.computed).toBe('false');
    });

    it('projects computed access', () => {
      const writes = projectSource('a[0];', 'test');
      const member = findByType(writes, 'MemberExpression');
      expect(member).toBeDefined();
      expect(member!.fields.computed).toBe('true');
    });
  });

  describe('variable declarations', () => {
    it('projects const declarations', () => {
      const writes = projectSource('const x = 5;', 'test');
      const decl = findByType(writes, 'VariableDeclaration');
      expect(decl).toBeDefined();
      expect(decl!.fields.kind).toBe('const');
    });

    it('projects let declarations', () => {
      const writes = projectSource('let y = 10;', 'test');
      const decl = findByType(writes, 'VariableDeclaration');
      expect(decl).toBeDefined();
      expect(decl!.fields.kind).toBe('let');
    });

    it('projects declarators with initializers', () => {
      const writes = projectSource('const x = 42;', 'test');
      const declarator = findByType(writes, 'VariableDeclarator');
      expect(declarator).toBeDefined();
      expect(declarator!.fields.init).toBeDefined();
    });
  });

  describe('function declarations', () => {
    it('projects function declarations', () => {
      const writes = projectSource('function add(a: number, b: number): number { return a + b; }', 'test');
      const fn = findByType(writes, 'FunctionDeclaration');
      expect(fn).toBeDefined();
      expect(fn!.fields.name).toBe('add');
      expect(fn!.fields.params).toBeDefined();
      expect(fn!.fields.body).toBeDefined();
    });

    it('projects async functions', () => {
      const writes = projectSource('async function fetch() { }', 'test');
      const fn = findByType(writes, 'FunctionDeclaration');
      expect(fn!.fields.async).toBe('true');
    });

    it('projects exported functions', () => {
      const writes = projectSource('export function greet() { }', 'test');
      const fn = findByType(writes, 'FunctionDeclaration');
      expect(fn!.fields.exported).toBe('true');
    });
  });

  describe('arrow functions', () => {
    it('projects arrow functions with block body', () => {
      const writes = projectSource('const f = (x: number) => { return x; };', 'test');
      const arrow = findByType(writes, 'ArrowFunction');
      expect(arrow).toBeDefined();
      expect(arrow!.fields.body).toBeDefined();
    });
  });

  describe('control flow', () => {
    it('projects if statements', () => {
      const writes = projectSource('if (true) { x; } else { y; }', 'test');
      const ifStmt = findByType(writes, 'IfStatement');
      expect(ifStmt).toBeDefined();
      expect(ifStmt!.fields.test).toBeDefined();
      expect(ifStmt!.fields.consequent).toBeDefined();
      expect(ifStmt!.fields.alternate).toBeDefined();
    });

    it('projects return statements', () => {
      const writes = projectSource('function f() { return 42; }', 'test');
      const ret = findByType(writes, 'ReturnStatement');
      expect(ret).toBeDefined();
      expect(ret!.fields.argument).toBeDefined();
    });

    it('projects for-of loops', () => {
      const writes = projectSource('for (const x of items) { }', 'test');
      const forOf = findByType(writes, 'ForOfStatement');
      expect(forOf).toBeDefined();
      expect(forOf!.fields.left).toBeDefined();
      expect(forOf!.fields.right).toBeDefined();
      expect(forOf!.fields.body).toBeDefined();
    });

    it('projects try/catch', () => {
      const writes = projectSource('try { x; } catch (e) { y; }', 'test');
      const tryStmt = findByType(writes, 'TryStatement');
      expect(tryStmt).toBeDefined();
      expect(tryStmt!.fields.block).toBeDefined();
      expect(tryStmt!.fields.handler).toBeDefined();
    });
  });

  describe('imports and exports', () => {
    it('projects import declarations', () => {
      const writes = projectSource('import { foo, bar } from "./utils";', 'test');
      const imp = findByType(writes, 'ImportDeclaration');
      expect(imp).toBeDefined();
      expect(imp!.fields.source).toBe('./utils');
      expect(imp!.fields.specifiers.split(',').length).toBe(2);
    });

    it('projects default imports', () => {
      const writes = projectSource('import React from "react";', 'test');
      const specs = findAllByType(writes, 'ImportSpecifier');
      const defaultSpec = specs.find(s => s.fields.isDefault === 'true');
      expect(defaultSpec).toBeDefined();
      expect(defaultSpec!.fields.local).toBe('React');
    });

    it('projects export declarations', () => {
      const writes = projectSource('export { foo, bar };', 'test');
      const exp = findByType(writes, 'ExportDeclaration');
      expect(exp).toBeDefined();
    });
  });

  describe('objects and arrays', () => {
    it('projects object literals', () => {
      const writes = projectSource('const o = { a: 1, b: 2 };', 'test');
      const obj = findByType(writes, 'ObjectExpression');
      expect(obj).toBeDefined();
      expect(obj!.fields.properties.split(',').length).toBe(2);
    });

    it('projects array literals', () => {
      const writes = projectSource('const a = [1, 2, 3];', 'test');
      const arr = findByType(writes, 'ArrayExpression');
      expect(arr).toBeDefined();
      expect(arr!.fields.elements.split(',').length).toBe(3);
    });

    it('projects spread elements', () => {
      const writes = projectSource('const a = [...b];', 'test');
      const spread = findByType(writes, 'SpreadElement');
      expect(spread).toBeDefined();
      expect(spread!.fields.argument).toBeDefined();
    });
  });

  describe('TypeScript constructs', () => {
    it('projects interface declarations', () => {
      const writes = projectSource('export interface Foo { bar: string; }', 'test');
      const iface = findByType(writes, 'InterfaceDeclaration');
      expect(iface).toBeDefined();
      expect(iface!.fields.name).toBe('Foo');
      expect(iface!.fields.exported).toBe('true');
    });

    it('projects type alias declarations', () => {
      const writes = projectSource('type ID = string | number;', 'test');
      const typeAlias = findByType(writes, 'TypeAliasDeclaration');
      expect(typeAlias).toBeDefined();
      expect(typeAlias!.fields.name).toBe('ID');
    });

    it('projects as expressions', () => {
      const writes = projectSource('const x = y as string;', 'test');
      const asExpr = findByType(writes, 'AsExpression');
      expect(asExpr).toBeDefined();
      expect(asExpr!.fields.typeTarget).toBe('string');
    });
  });

  describe('determinism', () => {
    it('produces the same output for the same input', () => {
      const source = 'const x = 1 + 2; function f(a: number) { return a * 2; }';
      const writes1 = projectSource(source, 'test');
      const writes2 = projectSource(source, 'test');

      expect(writes1.length).toBe(writes2.length);
      for (let i = 0; i < writes1.length; i++) {
        expect(writes1[i].key).toBe(writes2[i].key);
        expect(writes1[i].fields).toEqual(writes2[i].fields);
      }
    });
  });
});
