/**
 * Template parser: converts template strings into a renderable AST.
 *
 * Template syntax:
 *   - HTML elements: <div class="x">...</div>
 *   - Self-closing: <br />, <my-component key="x" />
 *   - Text: plain text content
 *   - Expressions: {expr} where expr is evaluated against the store
 *   - Dynamic attributes: attr={expr}
 *
 * The parser produces a tree of TemplateNode objects. Expression nodes
 * contain raw expression strings; evaluation is deferred to the renderer.
 */

// ── AST Types ────────────────────────────────────────────

export type TemplateNode = ElementNode | TextNode | ExpressionNode;

export interface ElementNode {
  type: 'element';
  tag: string;
  attrs: Attribute[];
  children: TemplateNode[];
  selfClosing: boolean;
}

export interface TextNode {
  type: 'text';
  value: string;
}

export interface ExpressionNode {
  type: 'expression';
  expr: string;
}

export interface Attribute {
  name: string;
  value: string | ExpressionNode;
}

// ── Void elements (self-closing in HTML) ─────────────────

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

// ── Parser ───────────────────────────────────────────────

export function parseTemplate(template: string): TemplateNode[] {
  const parser = new TemplateParser(template);
  return parser.parseNodes();
}

class TemplateParser {
  private pos = 0;

  constructor(private src: string) {}

  parseNodes(stopTag?: string): TemplateNode[] {
    const nodes: TemplateNode[] = [];

    while (this.pos < this.src.length) {
      // Check for closing tag
      if (stopTag && this.lookingAt('</')) {
        const saved = this.pos;
        this.pos += 2;
        this.skipWhitespace();
        const tag = this.readTagName();
        this.skipWhitespace();
        if (tag === stopTag && this.peek() === '>') {
          this.pos++; // consume '>'
          return nodes;
        }
        // Not our closing tag; backtrack and treat as text
        this.pos = saved;
      }

      if (this.lookingAt('<')) {
        if (this.lookingAt('</')) {
          // Unexpected closing tag; stop and let parent handle it
          break;
        }
        const element = this.parseElement();
        if (element) nodes.push(element);
      } else if (this.peek() === '{') {
        nodes.push(this.parseExpression());
      } else {
        const text = this.parseText();
        if (text.value.length > 0) nodes.push(text);
      }
    }

    return nodes;
  }

  private parseElement(): ElementNode | null {
    if (!this.consume('<')) return null;

    const tag = this.readTagName();
    if (!tag) {
      // Malformed; return as text
      return null;
    }

    const attrs = this.parseAttributes();
    this.skipWhitespace();

    const selfClosing = this.consume('/');
    if (!this.consume('>')) {
      // Try to recover
      while (this.pos < this.src.length && this.peek() !== '>') this.pos++;
      this.pos++;
    }

    if (selfClosing || VOID_ELEMENTS.has(tag)) {
      return { type: 'element', tag, attrs, children: [], selfClosing: true };
    }

    const children = this.parseNodes(tag);
    return { type: 'element', tag, attrs, children, selfClosing: false };
  }

  private parseAttributes(): Attribute[] {
    const attrs: Attribute[] = [];

    while (this.pos < this.src.length) {
      this.skipWhitespace();
      const ch = this.peek();
      if (ch === '>' || ch === '/' || ch === undefined) break;

      const name = this.readAttrName();
      if (!name) break;

      if (this.consume('=')) {
        if (this.peek() === '{') {
          // Dynamic attribute: attr={expr}
          attrs.push({ name, value: this.parseExpression() });
        } else if (this.peek() === '"') {
          attrs.push({ name, value: this.readQuotedString('"') });
        } else if (this.peek() === "'") {
          attrs.push({ name, value: this.readQuotedString("'") });
        } else {
          // Unquoted value
          attrs.push({ name, value: this.readUnquotedValue() });
        }
      } else {
        // Boolean attribute
        attrs.push({ name, value: 'true' });
      }
    }

    return attrs;
  }

  private parseExpression(): ExpressionNode {
    this.pos++; // consume '{'
    let depth = 1;
    let expr = '';

    while (this.pos < this.src.length && depth > 0) {
      const ch = this.src[this.pos];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { this.pos++; break; }
      }
      expr += ch;
      this.pos++;
    }

    return { type: 'expression', expr: expr.trim() };
  }

  private parseText(): TextNode {
    let value = '';
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch === '<' || ch === '{') break;
      value += ch;
      this.pos++;
    }
    return { type: 'text', value };
  }

  // ── Low-level helpers ──────────────────────────────────

  private peek(): string | undefined {
    return this.src[this.pos];
  }

  private consume(ch: string): boolean {
    if (this.src[this.pos] === ch) {
      this.pos++;
      return true;
    }
    return false;
  }

  private lookingAt(s: string): boolean {
    return this.src.startsWith(s, this.pos);
  }

  private skipWhitespace(): void {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) {
      this.pos++;
    }
  }

  private readTagName(): string {
    let name = '';
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (/[a-zA-Z0-9\-_]/.test(ch)) {
        name += ch;
        this.pos++;
      } else {
        break;
      }
    }
    return name;
  }

  private readAttrName(): string {
    let name = '';
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (/[a-zA-Z0-9\-_:@.]/.test(ch)) {
        name += ch;
        this.pos++;
      } else {
        break;
      }
    }
    return name;
  }

  private readQuotedString(quote: string): string {
    this.pos++; // skip opening quote
    let value = '';
    while (this.pos < this.src.length && this.src[this.pos] !== quote) {
      value += this.src[this.pos];
      this.pos++;
    }
    this.pos++; // skip closing quote
    return value;
  }

  private readUnquotedValue(): string {
    let value = '';
    while (this.pos < this.src.length && !/[\s>\/]/.test(this.src[this.pos])) {
      value += this.src[this.pos];
      this.pos++;
    }
    return value;
  }
}
