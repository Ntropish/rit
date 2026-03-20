import { parse } from 'node-html-parser';
import type { LanguagePlugin, EntityWrite, FileEntities } from '../types.js';
import { DocumentSchema, ScriptBlockSchema, StyleBlockSchema } from '../html-schemas.js';

export const htmlPlugin: LanguagePlugin = {
  extensions: ['.html', '.htm'],

  ingest(source: string, filePath: string): EntityWrite[] {
    const root = parse(source, { comment: true });
    const writes: EntityWrite[] = [];
    const docKey = `doc:${filePath}`;

    // Extract metadata
    const htmlEl = root.querySelector('html');
    const lang = htmlEl?.getAttribute('lang') ?? undefined;

    const titleEl = root.querySelector('title');
    const title = titleEl?.textContent ?? undefined;

    const charsetMeta = root.querySelector('meta[charset]');
    const charset = charsetMeta?.getAttribute('charset') ?? undefined;

    // Find and replace script/style elements with placeholders
    let scriptOrder = 0;
    let styleOrder = 0;

    const scripts = root.querySelectorAll('script');
    for (const script of scripts) {
      const src = script.getAttribute('src') ?? undefined;
      const body = src ? undefined : script.textContent;
      const type = script.getAttribute('type') ?? undefined;

      writes.push({
        schema: ScriptBlockSchema,
        data: {
          document: docKey,
          order: scriptOrder,
          ...(src ? { src } : {}),
          ...(body ? { body } : {}),
          ...(type ? { type } : {}),
        },
      });

      script.replaceWith(`<!-- rit:scr:${scriptOrder} -->`);
      scriptOrder++;
    }

    const styles = root.querySelectorAll('style');
    for (const style of styles) {
      const body = style.textContent;
      const media = style.getAttribute('media') ?? undefined;

      writes.push({
        schema: StyleBlockSchema,
        data: {
          document: docKey,
          body,
          order: styleOrder,
          ...(media ? { media } : {}),
        },
      });

      style.replaceWith(`<!-- rit:sty:${styleOrder} -->`);
      styleOrder++;
    }

    // Store the modified HTML as the document body
    const modifiedHtml = root.toString();

    writes.unshift({
      schema: DocumentSchema,
      data: {
        path: filePath,
        body: modifiedHtml,
        ...(title ? { title } : {}),
        ...(lang ? { lang } : {}),
        ...(charset ? { charset } : {}),
      },
    });

    return writes;
  },

  materialize(entities: FileEntities): string {
    const doc = entities.root;
    let html = doc.body as string;

    // Reconstruct script blocks
    const scripts = (entities.children['scr'] ?? [])
      .slice()
      .sort((a, b) => (a.order as number) - (b.order as number));

    for (const script of scripts) {
      const order = script.order as number;
      const placeholder = `<!-- rit:scr:${order} -->`;

      let tag: string;
      if (script.src) {
        const type = script.type ? ` type="${script.type}"` : '';
        tag = `<script${type} src="${script.src}"></script>`;
      } else {
        const type = script.type ? ` type="${script.type}"` : '';
        tag = `<script${type}>${script.body ?? ''}</script>`;
      }

      html = html.replace(placeholder, tag);
    }

    // Reconstruct style blocks
    const styles = (entities.children['sty'] ?? [])
      .slice()
      .sort((a, b) => (a.order as number) - (b.order as number));

    for (const style of styles) {
      const order = style.order as number;
      const placeholder = `<!-- rit:sty:${order} -->`;

      const media = style.media ? ` media="${style.media}"` : '';
      const tag = `<style${media}>${style.body ?? ''}</style>`;

      html = html.replace(placeholder, tag);
    }

    return html;
  },
};
