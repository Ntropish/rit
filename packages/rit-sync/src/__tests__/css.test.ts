import { describe, it, expect } from 'vitest';
import { cssPlugin } from '../plugins/css.js';
import type { FileEntities } from '../types.js';

describe('CSS plugin', () => {
  describe('ingest', () => {
    it('extracts @import declarations', () => {
      const source = `@import url("reset.css");
@import 'theme.css';
@import url(layout.css);

body { margin: 0; }`;
      const writes = cssPlugin.ingest(source, 'styles');

      const css = writes.find(w => w.schema.prefix === 'css');
      expect(css).toBeDefined();
      const imports = JSON.parse(css!.data.imports as string);
      expect(imports).toEqual(['reset.css', 'theme.css', 'layout.css']);
    });

    it('extracts custom properties from :root', () => {
      const source = `:root {
  --primary: #3b82f6;
  --bg-color: hsl(220, 15%, 10%);
  --spacing-md: 1rem;
}

body { color: var(--primary); }`;
      const writes = cssPlugin.ingest(source, 'vars');

      const css = writes.find(w => w.schema.prefix === 'css');
      expect(css).toBeDefined();
      const props = JSON.parse(css!.data.customProperties as string);
      expect(props['--primary']).toBe('#3b82f6');
      expect(props['--bg-color']).toBe('hsl(220, 15%, 10%)');
      expect(props['--spacing-md']).toBe('1rem');
    });

    it('stores full content', () => {
      const source = `body { margin: 0; }
h1 { color: red; }`;
      const writes = cssPlugin.ingest(source, 'simple');

      const css = writes.find(w => w.schema.prefix === 'css');
      expect(css!.data.content).toBe(source);
    });

    it('handles CSS with no imports or custom properties', () => {
      const source = `.card { border: 1px solid #ccc; padding: 16px; }`;
      const writes = cssPlugin.ingest(source, 'card');

      const css = writes.find(w => w.schema.prefix === 'css');
      expect(JSON.parse(css!.data.imports as string)).toEqual([]);
      expect(JSON.parse(css!.data.customProperties as string)).toEqual({});
    });
  });

  describe('round-trip', () => {
    function roundTrip(source: string, filePath: string): string {
      const writes = cssPlugin.ingest(source, filePath);

      const css = writes.find(w => w.schema.prefix === 'css')!;
      const entities: FileEntities = {
        root: css.data,
        children: {},
      };

      return cssPlugin.materialize(entities);
    }

    it('CSS with @import, custom properties, and regular rules round-trips', () => {
      const source = `@import url("reset.css");
@import 'components.css';

:root {
  --primary: #3b82f6;
  --font-size: 16px;
}

body {
  font-family: sans-serif;
  color: var(--primary);
  font-size: var(--font-size);
}

.container {
  max-width: 1200px;
  margin: 0 auto;
}`;
      const output = roundTrip(source, 'theme');
      expect(output).toBe(source);
    });

    it('plain CSS without imports or variables round-trips', () => {
      const source = `.btn {
  padding: 8px 16px;
  border-radius: 4px;
  cursor: pointer;
}

.btn:hover {
  opacity: 0.9;
}`;
      const output = roundTrip(source, 'buttons');
      expect(output).toBe(source);
    });
  });
});
