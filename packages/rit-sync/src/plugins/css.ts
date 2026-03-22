import type { LanguagePlugin, EntityWrite, FileEntities } from '../types.js';
import { CssFileSchema } from '../css-schemas.js';

/**
 * Extract @import declarations from CSS source.
 * Matches: @import url("..."); @import url('...'); @import "..."; @import '...';
 */
function extractImports(source: string): string[] {
  const imports: string[] = [];
  const re = /^@import\s+(?:url\(\s*['"]?([^'")]+)['"]?\s*\)|['"]([^'"]+)['"]).*/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    imports.push(match[1] ?? match[2]);
  }
  return imports;
}

/**
 * Extract custom properties (CSS variables) from :root blocks.
 * Returns an object mapping --var-name to its value.
 */
function extractCustomProperties(source: string): Record<string, string> {
  const props: Record<string, string> = {};
  const rootRe = /:root\s*\{([^}]*)\}/gs;
  let rootMatch: RegExpExecArray | null;
  while ((rootMatch = rootRe.exec(source)) !== null) {
    const block = rootMatch[1];
    const propRe = /(--[\w-]+)\s*:\s*([^;]+);/g;
    let propMatch: RegExpExecArray | null;
    while ((propMatch = propRe.exec(block)) !== null) {
      props[propMatch[1]] = propMatch[2].trim();
    }
  }
  return props;
}

export const cssPlugin: LanguagePlugin = {
  extensions: ['.css'],

  ingest(source: string, filePath: string): EntityWrite[] {
    const imports = extractImports(source);
    const customProperties = extractCustomProperties(source);

    return [
      {
        schema: CssFileSchema,
        data: {
          path: filePath,
          imports: JSON.stringify(imports),
          customProperties: JSON.stringify(customProperties),
          content: source,
        },
      },
    ];
  },

  materialize(entities: FileEntities): string {
    return entities.root.content as string;
  },
};
