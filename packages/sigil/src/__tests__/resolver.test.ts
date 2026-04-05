import { describe, it, expect } from 'vitest';
import { projectSource } from '../projector.js';
import { buildModuleGraph, topologicalOrder, resolveSpecifier } from '../resolver.js';

describe('Sigil module resolver', () => {
  describe('resolveSpecifier', () => {
    const known = new Map<string, unknown>([
      ['src/utils', {}],
      ['src/utils.ts', {}],
      ['src/components/button', {}],
      ['src/index.ts', {}],
    ]);

    it('resolves relative specifiers', () => {
      expect(resolveSpecifier('./utils', 'src/main', known)).toBe('src/utils');
    });

    it('resolves relative specifiers with extensions', () => {
      expect(resolveSpecifier('./utils', 'src/main', known)).toBe('src/utils');
    });

    it('resolves parent directory specifiers', () => {
      expect(resolveSpecifier('../utils', 'src/components/button', known)).toBe('src/utils');
    });

    it('returns null for bare/external specifiers', () => {
      expect(resolveSpecifier('react', 'src/main', known)).toBeNull();
      expect(resolveSpecifier('@rit/schema', 'src/main', known)).toBeNull();
    });

    it('returns path as-is for unknown relative imports', () => {
      const result = resolveSpecifier('./unknown', 'src/main', known);
      expect(result).toBe('src/unknown');
    });
  });

  describe('buildModuleGraph', () => {
    it('builds a graph from a single module', () => {
      const writes = projectSource('const x = 1;', 'main');
      const graph = buildModuleGraph(writes);

      expect(graph.modules.size).toBe(1);
      expect(graph.modules.has('main')).toBe(true);
      expect(graph.entryPoints).toEqual(['main']);
    });

    it('builds a graph with imports between modules', () => {
      const mainWrites = projectSource('import { foo } from "./utils";\nfoo();', 'src/main');
      const utilsWrites = projectSource('export function foo() { return 1; }', 'src/utils');
      const allWrites = [...mainWrites, ...utilsWrites];

      const graph = buildModuleGraph(allWrites);

      expect(graph.modules.size).toBe(2);
      const main = graph.modules.get('src/main')!;
      expect(main.imports.length).toBe(1);
      expect(main.imports[0].specifier).toBe('./utils');
      expect(main.imports[0].resolvedPath).toBe('src/utils');
      expect(main.imports[0].names[0].local).toBe('foo');
    });

    it('identifies entry points (modules not imported by others)', () => {
      const mainWrites = projectSource('import { foo } from "./utils";', 'src/main');
      const utilsWrites = projectSource('export const foo = 1;', 'src/utils');
      const allWrites = [...mainWrites, ...utilsWrites];

      const graph = buildModuleGraph(allWrites);

      expect(graph.entryPoints).toEqual(['src/main']);
    });

    it('tracks exported names', () => {
      const writes = projectSource('export function greet() { }\nexport const x = 1;', 'lib');
      const graph = buildModuleGraph(writes);

      const mod = graph.modules.get('lib')!;
      expect(mod.exports).toContain('greet');
    });

    it('handles external imports', () => {
      const writes = projectSource('import React from "react";', 'app');
      const graph = buildModuleGraph(writes);

      const mod = graph.modules.get('app')!;
      expect(mod.imports[0].specifier).toBe('react');
      expect(mod.imports[0].resolvedPath).toBeNull();
    });
  });

  describe('topologicalOrder', () => {
    it('returns single module', () => {
      const writes = projectSource('const x = 1;', 'main');
      const graph = buildModuleGraph(writes);
      const order = topologicalOrder(graph);

      expect(order).toEqual(['main']);
    });

    it('returns dependencies before dependents', () => {
      const mainWrites = projectSource('import { foo } from "./utils";', 'src/main');
      const utilsWrites = projectSource('export const foo = 1;', 'src/utils');
      const allWrites = [...mainWrites, ...utilsWrites];

      const graph = buildModuleGraph(allWrites);
      const order = topologicalOrder(graph);

      const mainIdx = order.indexOf('src/main');
      const utilsIdx = order.indexOf('src/utils');
      expect(utilsIdx).toBeLessThan(mainIdx);
    });

    it('handles diamond dependencies', () => {
      const aWrites = projectSource('import { b } from "./b";\nimport { c } from "./c";', 'a');
      const bWrites = projectSource('import { d } from "./d";\nexport const b = 1;', 'b');
      const cWrites = projectSource('import { d } from "./d";\nexport const c = 1;', 'c');
      const dWrites = projectSource('export const d = 1;', 'd');
      const allWrites = [...aWrites, ...bWrites, ...cWrites, ...dWrites];

      const graph = buildModuleGraph(allWrites);
      const order = topologicalOrder(graph);

      // d must come before b and c; b and c must come before a
      const aIdx = order.indexOf('a');
      const bIdx = order.indexOf('b');
      const cIdx = order.indexOf('c');
      const dIdx = order.indexOf('d');

      expect(dIdx).toBeLessThan(bIdx);
      expect(dIdx).toBeLessThan(cIdx);
      expect(bIdx).toBeLessThan(aIdx);
      expect(cIdx).toBeLessThan(aIdx);
    });
  });
});
