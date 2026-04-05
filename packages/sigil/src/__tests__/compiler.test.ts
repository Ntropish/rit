import { describe, it, expect } from 'vitest';
import { projectSource } from '../projector.js';
import { compile, compileModule } from '../compiler.js';

describe('Sigil compiler', () => {
  describe('single module compilation', () => {
    it('compiles a simple module', () => {
      const writes = projectSource('const x = 1 + 2;', 'main');
      const result = compile(writes);

      expect(result.modules.length).toBe(1);
      expect(result.modules[0].path).toBe('main');
      expect(result.modules[0].source).toContain('const x = 1 + 2;');
    });

    it('compiles a module with functions', () => {
      const writes = projectSource(
        'function add(a: number, b: number): number { return a + b; }',
        'math'
      );
      const result = compile(writes);

      expect(result.modules[0].source).toContain('function add(');
      expect(result.modules[0].source).toContain('return a + b;');
    });

    it('compileModule convenience function works', () => {
      const writes = projectSource('const x = 42;', 'test');
      const source = compileModule(writes);

      expect(source).toContain('const x = 42;');
    });
  });

  describe('multi-module compilation', () => {
    it('compiles multiple modules', () => {
      const mainWrites = projectSource(
        'import { add } from "./math";\nconst result = add(1, 2);',
        'src/main'
      );
      const mathWrites = projectSource(
        'export function add(a: number, b: number): number { return a + b; }',
        'src/math'
      );
      const allWrites = [...mainWrites, ...mathWrites];
      const result = compile(allWrites);

      expect(result.modules.length).toBe(2);
      expect(result.modules.map(m => m.path)).toContain('src/main');
      expect(result.modules.map(m => m.path)).toContain('src/math');
    });

    it('orders dependencies before dependents', () => {
      const mainWrites = projectSource('import { foo } from "./utils";', 'src/main');
      const utilsWrites = projectSource('export const foo = 1;', 'src/utils');
      const allWrites = [...mainWrites, ...utilsWrites];

      const result = compile(allWrites);

      const mainIdx = result.modules.findIndex(m => m.path === 'src/main');
      const utilsIdx = result.modules.findIndex(m => m.path === 'src/utils');
      expect(utilsIdx).toBeLessThan(mainIdx);
    });

    it('handles diamond dependencies', () => {
      const aWrites = projectSource('import { b } from "./b";\nimport { c } from "./c";', 'a');
      const bWrites = projectSource('import { d } from "./d";\nexport const b = 1;', 'b');
      const cWrites = projectSource('import { d } from "./d";\nexport const c = 1;', 'c');
      const dWrites = projectSource('export const d = 1;', 'd');
      const allWrites = [...aWrites, ...bWrites, ...cWrites, ...dWrites];

      const result = compile(allWrites);

      expect(result.modules.length).toBe(4);
      const dIdx = result.modules.findIndex(m => m.path === 'd');
      const aIdx = result.modules.findIndex(m => m.path === 'a');
      expect(dIdx).toBeLessThan(aIdx);
    });
  });

  describe('entry point filtering', () => {
    it('compiles only reachable modules from entry point', () => {
      const mainWrites = projectSource('import { foo } from "./utils";', 'src/main');
      const utilsWrites = projectSource('export const foo = 1;', 'src/utils');
      const unrelatedWrites = projectSource('const y = 99;', 'src/unrelated');
      const allWrites = [...mainWrites, ...utilsWrites, ...unrelatedWrites];

      const result = compile(allWrites, { entry: 'src/main' });

      const paths = result.modules.map(m => m.path);
      expect(paths).toContain('src/main');
      expect(paths).toContain('src/utils');
      expect(paths).not.toContain('src/unrelated');
    });
  });

  describe('bundle output', () => {
    it('produces a bundle with all modules', () => {
      const mainWrites = projectSource('const x = 1;', 'main');
      const result = compile(mainWrites);

      expect(result.bundle).toContain('const x = 1;');
    });

    it('includes module boundary comments by default', () => {
      const mainWrites = projectSource('const x = 1;', 'main');
      const result = compile(mainWrites);

      expect(result.bundle).toContain('// === main ===');
    });

    it('omits module comments when disabled', () => {
      const mainWrites = projectSource('const x = 1;', 'main');
      const result = compile(mainWrites, { moduleComments: false });

      expect(result.bundle).not.toContain('// ===');
    });

    it('concatenates modules in dependency order', () => {
      const mainWrites = projectSource('import { foo } from "./utils";\nfoo();', 'src/main');
      const utilsWrites = projectSource('export function foo() { }', 'src/utils');
      const allWrites = [...mainWrites, ...utilsWrites];

      const result = compile(allWrites);

      const utilsPos = result.bundle.indexOf('src/utils');
      const mainPos = result.bundle.indexOf('src/main');
      expect(utilsPos).toBeLessThan(mainPos);
    });
  });

  describe('module graph in result', () => {
    it('includes the module graph', () => {
      const writes = projectSource('const x = 1;', 'main');
      const result = compile(writes);

      expect(result.graph).toBeDefined();
      expect(result.graph.modules.size).toBe(1);
      expect(result.graph.entryPoints).toEqual(['main']);
    });
  });

  describe('end-to-end', () => {
    it('compiles a realistic multi-file program', () => {
      const indexWrites = projectSource(`
import { greet } from "./greeting";
import { format } from "./format";
const message = greet("World");
console.log(format(message));
      `.trim(), 'src/index');

      const greetingWrites = projectSource(`
export function greet(name: string): string {
  return "Hello, " + name + "!";
}
      `.trim(), 'src/greeting');

      const formatWrites = projectSource(`
export function format(s: string): string {
  return "[" + s + "]";
}
      `.trim(), 'src/format');

      const allWrites = [...indexWrites, ...greetingWrites, ...formatWrites];
      const result = compile(allWrites, { entry: 'src/index' });

      // All three modules compiled
      expect(result.modules.length).toBe(3);

      // Dependencies come first
      const indexIdx = result.modules.findIndex(m => m.path === 'src/index');
      const greetIdx = result.modules.findIndex(m => m.path === 'src/greeting');
      const formatIdx = result.modules.findIndex(m => m.path === 'src/format');
      expect(greetIdx).toBeLessThan(indexIdx);
      expect(formatIdx).toBeLessThan(indexIdx);

      // Bundle contains all code
      expect(result.bundle).toContain('greet');
      expect(result.bundle).toContain('format');
      expect(result.bundle).toContain('console.log');
      expect(result.bundle).toContain('Hello');
    });
  });
});
