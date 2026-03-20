import type { SemanticChange } from './types.js';

export type FormatMode = 'text' | 'markdown';

/**
 * Renders SemanticChange[] as human-readable output.
 */
export class DiffFormatter {
  format(changes: SemanticChange[], mode: FormatMode = 'text'): string {
    return changes.map(c => this.formatOne(c, mode)).join('\n');
  }

  private formatOne(change: SemanticChange, mode: FormatMode): string {
    switch (mode) {
      case 'markdown': return this.formatMarkdown(change);
      default: return this.formatText(change);
    }
  }

  private formatText(c: SemanticChange): string {
    const verb = this.verb(c.changeType);
    const base = `${verb} ${c.entityType} ${c.entityIdentity}`;

    if (c.changeType === 'renamed' && c.renamedFrom) {
      return `Renamed ${c.entityType} ${c.renamedFrom} to ${c.entityIdentity}`;
    }

    if (c.fields && c.fields.length > 0 && c.changeType === 'modified') {
      const details = c.fields
        .map(f => {
          if (f.from !== undefined && f.to !== undefined) return `${f.field}: ${f.from} -> ${f.to}`;
          if (f.to !== undefined) return `${f.field}: added ${f.to}`;
          return `${f.field}: removed`;
        })
        .join(', ');
      return `${base}: ${details}`;
    }

    return base;
  }

  private formatMarkdown(c: SemanticChange): string {
    const verb = this.verb(c.changeType);
    const base = `- **${verb}** ${c.entityType} \`${c.entityIdentity}\``;

    if (c.changeType === 'renamed' && c.renamedFrom) {
      return `- **Renamed** ${c.entityType} \`${c.renamedFrom}\` to \`${c.entityIdentity}\``;
    }

    if (c.fields && c.fields.length > 0 && c.changeType === 'modified') {
      const details = c.fields
        .map(f => {
          if (f.from !== undefined && f.to !== undefined) return `\`${f.field}\`: ${f.from} -> ${f.to}`;
          if (f.to !== undefined) return `\`${f.field}\`: added ${f.to}`;
          return `\`${f.field}\`: removed`;
        })
        .join(', ');
      return `${base}: ${details}`;
    }

    return base;
  }

  private verb(changeType: string): string {
    switch (changeType) {
      case 'created': return 'Created';
      case 'deleted': return 'Deleted';
      case 'modified': return 'Modified';
      case 'renamed': return 'Renamed';
      case 'moved': return 'Moved';
      default: return changeType;
    }
  }
}
