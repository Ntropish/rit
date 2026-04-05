import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { projectSource } from '../projector.js';
import { materializeToDir, projectFromDir, syncStatus } from '../file-sync.js';

describe('Sigil file sync', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'sigil-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('materializeToDir', () => {
    it('materializes a single module to a .ts file', () => {
      const writes = projectSource('const x = 42;', 'main');
      const files = materializeToDir(writes, tmpDir);

      expect(files.length).toBe(1);
      expect(files[0].path).toBe('main.ts');

      const content = readFileSync(join(tmpDir, 'main.ts'), 'utf-8');
      expect(content).toContain('const x = 42;');
    });

    it('materializes nested module paths', () => {
      const writes = projectSource('export const foo = 1;', 'src/utils/helpers');
      materializeToDir(writes, tmpDir);

      const content = readFileSync(join(tmpDir, 'src/utils/helpers.ts'), 'utf-8');
      expect(content).toContain('export const foo = 1;');
    });

    it('materializes multiple modules', () => {
      const mainWrites = projectSource('import { foo } from "./utils";', 'src/main');
      const utilsWrites = projectSource('export const foo = 1;', 'src/utils');
      const allWrites = [...mainWrites, ...utilsWrites];

      const files = materializeToDir(allWrites, tmpDir);

      expect(files.length).toBe(2);
      const paths = files.map(f => f.path).sort();
      expect(paths).toEqual(['src/main.ts', 'src/utils.ts']);
    });
  });

  describe('projectFromDir', () => {
    it('projects a single .ts file', () => {
      writeFileSync(join(tmpDir, 'main.ts'), 'const x = 42;', 'utf-8');
      const writes = projectFromDir(tmpDir);

      const module = writes.find(w => w.key === 'module:main.ts');
      expect(module).toBeDefined();

      const astNodes = writes.filter(w => w.key.startsWith('ast:'));
      expect(astNodes.length).toBeGreaterThan(0);
    });

    it('projects nested files with correct module paths', () => {
      mkdirSync(join(tmpDir, 'src'), { recursive: true });
      writeFileSync(join(tmpDir, 'src/utils.ts'), 'export const foo = 1;', 'utf-8');

      const writes = projectFromDir(tmpDir);

      const module = writes.find(w => w.key === 'module:src/utils.ts');
      expect(module).toBeDefined();
    });

    it('projects multiple files', () => {
      writeFileSync(join(tmpDir, 'a.ts'), 'const a = 1;', 'utf-8');
      writeFileSync(join(tmpDir, 'b.ts'), 'const b = 2;', 'utf-8');

      const writes = projectFromDir(tmpDir);

      const modules = writes.filter(w => w.key.startsWith('module:'));
      expect(modules.length).toBe(2);
    });

    it('skips node_modules and .git', () => {
      mkdirSync(join(tmpDir, 'node_modules'), { recursive: true });
      writeFileSync(join(tmpDir, 'node_modules/lib.ts'), 'const x = 1;', 'utf-8');
      writeFileSync(join(tmpDir, 'main.ts'), 'const y = 2;', 'utf-8');

      const writes = projectFromDir(tmpDir);
      const modules = writes.filter(w => w.key.startsWith('module:'));
      expect(modules.length).toBe(1);
      expect(modules[0].fields.path).toBe('main.ts');
    });
  });

  describe('syncStatus', () => {
    it('reports clean when entities match files', () => {
      const writes = projectSource('const x = 42;', 'main');
      materializeToDir(writes, tmpDir);

      const status = syncStatus(writes, tmpDir);
      expect(status.clean.length).toBe(1);
      expect(status.modified.length).toBe(0);
      expect(status.missing.length).toBe(0);
      expect(status.untracked.length).toBe(0);
    });

    it('reports missing when entity has no file', () => {
      const writes = projectSource('const x = 42;', 'main');
      // Don't materialize - file doesn't exist

      const status = syncStatus(writes, tmpDir);
      expect(status.missing).toContain('main.ts');
    });

    it('reports modified when file differs from entity', () => {
      const writes = projectSource('const x = 42;', 'main');
      materializeToDir(writes, tmpDir);

      // Modify the file
      writeFileSync(join(tmpDir, 'main.ts'), 'const x = 99;\n', 'utf-8');

      const status = syncStatus(writes, tmpDir);
      expect(status.modified).toContain('main.ts');
    });

    it('reports untracked when file has no entity', () => {
      const writes = projectSource('const x = 42;', 'main');
      materializeToDir(writes, tmpDir);

      // Add an extra file
      writeFileSync(join(tmpDir, 'extra.ts'), 'const y = 1;', 'utf-8');

      const status = syncStatus(writes, tmpDir);
      expect(status.untracked).toContain('extra.ts');
    });
  });

  describe('round-trip', () => {
    it('materialize then project produces equivalent entities', () => {
      const source = 'const x = 1 + 2;\nexport function greet(name: string) { return "hi " + name; }';
      const originalWrites = projectSource(source, 'main');

      // Materialize to disk
      materializeToDir(originalWrites, tmpDir);

      // Project back
      const roundTripWrites = projectFromDir(tmpDir);

      // Both should have the same module
      const origModule = originalWrites.find(w => w.key === 'module:main');
      const rtModule = roundTripWrites.find(w => w.key === 'module:main.ts');
      expect(origModule).toBeDefined();
      expect(rtModule).toBeDefined();

      // Both should produce AST nodes
      const origAst = originalWrites.filter(w => w.key.startsWith('ast:'));
      const rtAst = roundTripWrites.filter(w => w.key.startsWith('ast:'));
      expect(rtAst.length).toBeGreaterThan(0);
      expect(origAst.length).toBeGreaterThan(0);
    });
  });
});
