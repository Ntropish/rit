import { describe, it, expect } from 'vitest';
import { parseTemplate, type ElementNode, type ExpressionNode, type TextNode } from '../framework/parser.js';

describe('Template parser', () => {
  describe('text nodes', () => {
    it('parses plain text', () => {
      const nodes = parseTemplate('hello world');
      expect(nodes).toHaveLength(1);
      expect(nodes[0].type).toBe('text');
      expect((nodes[0] as TextNode).value).toBe('hello world');
    });
  });

  describe('elements', () => {
    it('parses a simple element', () => {
      const nodes = parseTemplate('<div></div>');
      expect(nodes).toHaveLength(1);
      const el = nodes[0] as ElementNode;
      expect(el.type).toBe('element');
      expect(el.tag).toBe('div');
      expect(el.children).toHaveLength(0);
    });

    it('parses nested elements', () => {
      const nodes = parseTemplate('<div><span>text</span></div>');
      const div = nodes[0] as ElementNode;
      expect(div.tag).toBe('div');
      expect(div.children).toHaveLength(1);
      const span = div.children[0] as ElementNode;
      expect(span.tag).toBe('span');
      expect(span.children).toHaveLength(1);
      expect((span.children[0] as TextNode).value).toBe('text');
    });

    it('parses self-closing elements', () => {
      const nodes = parseTemplate('<br />');
      const el = nodes[0] as ElementNode;
      expect(el.tag).toBe('br');
      expect(el.selfClosing).toBe(true);
      expect(el.children).toHaveLength(0);
    });

    it('parses custom self-closing elements', () => {
      const nodes = parseTemplate('<product-card key="x" />');
      const el = nodes[0] as ElementNode;
      expect(el.tag).toBe('product-card');
      expect(el.selfClosing).toBe(true);
      expect(el.attrs).toHaveLength(1);
      expect(el.attrs[0].name).toBe('key');
      expect(el.attrs[0].value).toBe('x');
    });

    it('parses void elements without explicit self-close', () => {
      const nodes = parseTemplate('<img src="photo.jpg">');
      const el = nodes[0] as ElementNode;
      expect(el.tag).toBe('img');
      expect(el.selfClosing).toBe(true);
    });
  });

  describe('attributes', () => {
    it('parses static attributes', () => {
      const nodes = parseTemplate('<div class="card" id="main"></div>');
      const el = nodes[0] as ElementNode;
      expect(el.attrs).toHaveLength(2);
      expect(el.attrs[0]).toEqual({ name: 'class', value: 'card' });
      expect(el.attrs[1]).toEqual({ name: 'id', value: 'main' });
    });

    it('parses dynamic attributes', () => {
      const nodes = parseTemplate('<div class={getClass()}></div>');
      const el = nodes[0] as ElementNode;
      expect(el.attrs).toHaveLength(1);
      expect(el.attrs[0].name).toBe('class');
      expect((el.attrs[0].value as ExpressionNode).type).toBe('expression');
      expect((el.attrs[0].value as ExpressionNode).expr).toBe('getClass()');
    });

    it('parses boolean attributes', () => {
      const nodes = parseTemplate('<input disabled />');
      const el = nodes[0] as ElementNode;
      expect(el.attrs).toHaveLength(1);
      expect(el.attrs[0]).toEqual({ name: 'disabled', value: 'true' });
    });

    it('parses single-quoted attributes', () => {
      const nodes = parseTemplate("<div class='card'></div>");
      const el = nodes[0] as ElementNode;
      expect(el.attrs[0].value).toBe('card');
    });
  });

  describe('expressions', () => {
    it('parses inline expressions', () => {
      const nodes = parseTemplate('{get("key")}');
      expect(nodes).toHaveLength(1);
      expect(nodes[0].type).toBe('expression');
      expect((nodes[0] as ExpressionNode).expr).toBe('get("key")');
    });

    it('parses expressions between text', () => {
      const nodes = parseTemplate('Price: {hget("product", "price")} USD');
      expect(nodes).toHaveLength(3);
      expect(nodes[0].type).toBe('text');
      expect(nodes[1].type).toBe('expression');
      expect(nodes[2].type).toBe('text');
    });

    it('parses expressions inside elements', () => {
      const nodes = parseTemplate('<span>{hget(props.key, "name")}</span>');
      const span = nodes[0] as ElementNode;
      expect(span.children).toHaveLength(1);
      expect(span.children[0].type).toBe('expression');
      expect((span.children[0] as ExpressionNode).expr).toBe('hget(props.key, "name")');
    });

    it('handles nested braces in expressions', () => {
      const nodes = parseTemplate('{obj.x ? {a: 1} : {b: 2}}');
      // Should parse the entire expression including inner braces
      expect(nodes).toHaveLength(1);
      expect((nodes[0] as ExpressionNode).expr).toBe('obj.x ? {a: 1} : {b: 2}');
    });
  });

  describe('mixed content', () => {
    it('parses a realistic component template', () => {
      const template = '<div class="card"><h2>{hget(props.key, "name")}</h2><span>{hget(props.key, "price")}</span></div>';
      const nodes = parseTemplate(template);
      const div = nodes[0] as ElementNode;
      expect(div.tag).toBe('div');
      expect(div.children).toHaveLength(2);

      const h2 = div.children[0] as ElementNode;
      expect(h2.tag).toBe('h2');
      expect(h2.children).toHaveLength(1);
      expect((h2.children[0] as ExpressionNode).expr).toBe('hget(props.key, "name")');

      const span = div.children[1] as ElementNode;
      expect(span.tag).toBe('span');
      expect((span.children[0] as ExpressionNode).expr).toBe('hget(props.key, "price")');
    });

    it('parses a for expression', () => {
      const template = '{for(smembers("ids"), id => <item key={id} />)}';
      const nodes = parseTemplate(template);
      expect(nodes).toHaveLength(1);
      expect(nodes[0].type).toBe('expression');
      expect((nodes[0] as ExpressionNode).expr).toContain('for(');
    });
  });
});
