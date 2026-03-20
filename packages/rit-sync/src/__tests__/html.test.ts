import { describe, it, expect } from 'vitest';
import { htmlPlugin } from '../plugins/html.js';
import type { FileEntities } from '../types.js';

describe('HTML plugin', () => {
  describe('ingest', () => {
    it('extracts document metadata', () => {
      const source = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>My Page</title>
</head>
<body>
  <h1>Hello</h1>
</body>
</html>`;
      const writes = htmlPlugin.ingest(source, 'index');

      const doc = writes.find(w => w.schema.prefix === 'doc');
      expect(doc).toBeDefined();
      expect(doc!.data.path).toBe('index');
      expect(doc!.data.title).toBe('My Page');
      expect(doc!.data.lang).toBe('en');
      expect(doc!.data.charset).toBe('utf-8');
    });

    it('extracts inline scripts as ScriptBlock entities', () => {
      const source = `<html>
<head><script>console.log('hello');</script></head>
<body><script type="module">import './app.js';</script></body>
</html>`;
      const writes = htmlPlugin.ingest(source, 'page');

      const scripts = writes.filter(w => w.schema.prefix === 'scr');
      expect(scripts).toHaveLength(2);

      expect(scripts[0].data.body).toBe("console.log('hello');");
      expect(scripts[0].data.order).toBe(0);

      expect(scripts[1].data.body).toBe("import './app.js';");
      expect(scripts[1].data.type).toBe('module');
      expect(scripts[1].data.order).toBe(1);
    });

    it('extracts external scripts with src attribute', () => {
      const source = `<html>
<head><script src="https://cdn.example.com/lib.js"></script></head>
<body></body>
</html>`;
      const writes = htmlPlugin.ingest(source, 'page');

      const scripts = writes.filter(w => w.schema.prefix === 'scr');
      expect(scripts).toHaveLength(1);
      expect(scripts[0].data.src).toBe('https://cdn.example.com/lib.js');
      expect(scripts[0].data.body).toBeUndefined();
    });

    it('extracts style blocks', () => {
      const source = `<html>
<head>
  <style>body { margin: 0; }</style>
  <style media="print">.no-print { display: none; }</style>
</head>
<body></body>
</html>`;
      const writes = htmlPlugin.ingest(source, 'page');

      const styles = writes.filter(w => w.schema.prefix === 'sty');
      expect(styles).toHaveLength(2);

      expect(styles[0].data.body).toBe('body { margin: 0; }');
      expect(styles[0].data.order).toBe(0);

      expect(styles[1].data.body).toBe('.no-print { display: none; }');
      expect(styles[1].data.media).toBe('print');
      expect(styles[1].data.order).toBe(1);
    });

    it('replaces scripts and styles with placeholders in body', () => {
      const source = `<html>
<head><script>alert(1);</script><style>h1 { color: red; }</style></head>
<body></body>
</html>`;
      const writes = htmlPlugin.ingest(source, 'page');

      const doc = writes.find(w => w.schema.prefix === 'doc');
      expect(doc!.data.body).toContain('<!-- rit:scr:0 -->');
      expect(doc!.data.body).toContain('<!-- rit:sty:0 -->');
      expect(doc!.data.body).not.toContain('alert(1)');
      expect(doc!.data.body).not.toContain('color: red');
    });
  });

  describe('round-trip', () => {
    function roundTrip(source: string, filePath: string): string {
      const writes = htmlPlugin.ingest(source, filePath);

      const doc = writes.find(w => w.schema.prefix === 'doc')!;
      const scripts = writes.filter(w => w.schema.prefix === 'scr').map(w => w.data);
      const styles = writes.filter(w => w.schema.prefix === 'sty').map(w => w.data);

      const entities: FileEntities = {
        root: doc.data,
        children: {
          scr: scripts as Record<string, unknown>[],
          sty: styles as Record<string, unknown>[],
        },
      };

      return htmlPlugin.materialize(entities);
    }

    it('HTML with inline script and style round-trips', () => {
      const source = `<html lang="en">
<head>
  <title>Test</title>
  <style>body { font-family: sans-serif; }</style>
</head>
<body>
  <h1>Hello</h1>
  <script>document.querySelector('h1').textContent = 'World';</script>
</body>
</html>`;
      const output = roundTrip(source, 'test');

      expect(output).toContain('<style>body { font-family: sans-serif; }</style>');
      expect(output).toContain("<script>document.querySelector('h1').textContent = 'World';</script>");
      expect(output).toContain('<h1>Hello</h1>');
      expect(output).not.toContain('rit:scr');
      expect(output).not.toContain('rit:sty');
    });

    it('multiple scripts and styles preserved in order', () => {
      const source = `<html>
<head>
  <style>h1 { color: red; }</style>
  <style>h2 { color: blue; }</style>
</head>
<body>
  <script>console.log('first');</script>
  <script>console.log('second');</script>
</body>
</html>`;
      const output = roundTrip(source, 'multi');

      const firstStyleIdx = output.indexOf('color: red');
      const secondStyleIdx = output.indexOf('color: blue');
      expect(firstStyleIdx).toBeLessThan(secondStyleIdx);

      const firstScriptIdx = output.indexOf("'first'");
      const secondScriptIdx = output.indexOf("'second'");
      expect(firstScriptIdx).toBeLessThan(secondScriptIdx);
    });

    it('external script (src attribute) round-trips', () => {
      const source = `<html>
<head>
  <script src="https://cdn.example.com/lib.js"></script>
</head>
<body></body>
</html>`;
      const output = roundTrip(source, 'external');

      expect(output).toContain('<script src="https://cdn.example.com/lib.js"></script>');
    });

    it('HTML without scripts or styles round-trips', () => {
      const source = `<html>
<head><title>Simple</title></head>
<body><p>Just text.</p></body>
</html>`;
      const output = roundTrip(source, 'simple');

      expect(output).toContain('<title>Simple</title>');
      expect(output).toContain('<p>Just text.</p>');
    });
  });
});
