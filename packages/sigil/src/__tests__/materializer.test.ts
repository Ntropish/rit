import { describe, it, expect } from 'vitest';
import { projectSource } from '../projector.js';
import { materialize } from '../materializer.js';

/**
 * Helper: project TS source to entity AST, then materialize back to JS.
 * Returns the materialized output for comparison.
 */
function roundTrip(source: string): string {
  const writes = projectSource(source, 'test');
  return materialize(writes);
}

describe('Sigil entity AST materializer', () => {
  describe('literals', () => {
    it('materializes string literals', () => {
      const out = roundTrip('const x = "hello";');
      expect(out).toContain('"hello"');
    });

    it('materializes number literals', () => {
      const out = roundTrip('const x = 42;');
      expect(out).toContain('42');
    });

    it('materializes boolean literals', () => {
      const out = roundTrip('const x = true;');
      expect(out).toContain('true');
    });

    it('materializes null', () => {
      const out = roundTrip('const x = null;');
      expect(out).toContain('null');
    });
  });

  describe('expressions', () => {
    it('materializes binary expressions', () => {
      const out = roundTrip('const x = a + b;');
      expect(out).toContain('a + b');
    });

    it('materializes member access', () => {
      const out = roundTrip('a.b;');
      expect(out).toContain('a.b');
    });

    it('materializes computed access', () => {
      const out = roundTrip('a[0];');
      expect(out).toContain('a[0]');
    });

    it('materializes function calls', () => {
      const out = roundTrip('foo(1, 2);');
      expect(out).toContain('foo(1, 2)');
    });

    it('materializes new expressions', () => {
      const out = roundTrip('new Foo(1);');
      expect(out).toContain('new Foo(1)');
    });

    it('materializes conditional expressions', () => {
      const out = roundTrip('const x = a ? b : c;');
      expect(out).toContain('a ? b : c');
    });

    it('materializes array literals', () => {
      const out = roundTrip('const x = [1, 2, 3];');
      expect(out).toContain('[1, 2, 3]');
    });

    it('materializes object literals', () => {
      const out = roundTrip('const x = { a: 1, b: 2 };');
      expect(out).toContain('a: 1');
      expect(out).toContain('b: 2');
    });

    it('materializes spread elements', () => {
      const out = roundTrip('const x = [...a];');
      expect(out).toContain('...a');
    });

    it('materializes assignment expressions', () => {
      const out = roundTrip('x = 5;');
      expect(out).toContain('x = 5');
    });

    it('materializes await expressions', () => {
      const out = roundTrip('async function f() { await p; }');
      expect(out).toContain('await p');
    });

    it('materializes typeof expressions', () => {
      const out = roundTrip('typeof x;');
      expect(out).toContain('typeof x');
    });
  });

  describe('statements', () => {
    it('materializes expression statements with semicolons', () => {
      const out = roundTrip('foo();');
      expect(out).toContain('foo();');
    });

    it('materializes return statements', () => {
      const out = roundTrip('function f() { return 42; }');
      expect(out).toContain('return 42;');
    });

    it('materializes if/else statements', () => {
      const out = roundTrip('if (x) { a; } else { b; }');
      expect(out).toContain('if (x)');
      expect(out).toContain('else');
    });

    it('materializes while loops', () => {
      const out = roundTrip('while (true) { x; }');
      expect(out).toContain('while (true)');
    });

    it('materializes for-of loops', () => {
      const out = roundTrip('for (const x of items) { }');
      expect(out).toContain('for (');
      expect(out).toContain('of');
    });

    it('materializes try/catch', () => {
      const out = roundTrip('try { x; } catch (e) { y; }');
      expect(out).toContain('try');
      expect(out).toContain('catch');
    });

    it('materializes throw statements', () => {
      const out = roundTrip('throw new Error("oops");');
      expect(out).toContain('throw');
      expect(out).toContain('Error');
    });
  });

  describe('declarations', () => {
    it('materializes const declarations', () => {
      const out = roundTrip('const x = 5;');
      expect(out).toContain('const x = 5;');
    });

    it('materializes let declarations', () => {
      const out = roundTrip('let y = 10;');
      expect(out).toContain('let y = 10;');
    });

    it('materializes function declarations', () => {
      const out = roundTrip('function add(a, b) { return a + b; }');
      expect(out).toContain('function add(');
      expect(out).toContain('return a + b;');
    });

    it('materializes async function declarations', () => {
      const out = roundTrip('async function fetch() { }');
      expect(out).toContain('async function fetch');
    });

    it('materializes exported functions', () => {
      const out = roundTrip('export function greet() { }');
      expect(out).toContain('export function greet');
    });

    it('materializes function parameters with types', () => {
      const out = roundTrip('function f(x: number, y: string) { }');
      expect(out).toContain('x: number');
      expect(out).toContain('y: string');
    });

    it('materializes arrow functions', () => {
      const out = roundTrip('const f = (x) => x + 1;');
      expect(out).toContain('=>');
    });
  });

  describe('imports and exports', () => {
    it('materializes named imports', () => {
      const out = roundTrip('import { foo, bar } from "./utils";');
      expect(out).toContain('import');
      expect(out).toContain('foo');
      expect(out).toContain('bar');
      expect(out).toContain('./utils');
    });

    it('materializes default imports', () => {
      const out = roundTrip('import React from "react";');
      expect(out).toContain('React');
      expect(out).toContain('react');
    });

    it('materializes named exports', () => {
      const out = roundTrip('export { foo, bar };');
      expect(out).toContain('export');
      expect(out).toContain('foo');
    });

    it('materializes export default', () => {
      const out = roundTrip('export default 42;');
      expect(out).toContain('export default');
    });
  });

  describe('TypeScript constructs', () => {
    it('materializes as expressions', () => {
      const out = roundTrip('const x = y as string;');
      expect(out).toContain('as string');
    });

    it('materializes interface declarations', () => {
      const out = roundTrip('interface Foo { bar: string; }');
      expect(out).toContain('interface Foo');
    });

    it('materializes type aliases', () => {
      const out = roundTrip('type ID = string | number;');
      expect(out).toContain('string | number');
    });
  });

  describe('round-trip integrity', () => {
    it('preserves a simple program through round-trip', () => {
      const source = 'const x = 1 + 2;';
      const out = roundTrip(source);
      expect(out).toContain('const');
      expect(out).toContain('x');
      expect(out).toContain('1 + 2');
    });

    it('preserves a multi-statement program', () => {
      const source = `import { foo } from "./bar";
const x = foo(1);
export { x };`;
      const out = roundTrip(source);
      expect(out).toContain('import');
      expect(out).toContain('foo');
      expect(out).toContain('const x');
      expect(out).toContain('export');
    });
  });
});
