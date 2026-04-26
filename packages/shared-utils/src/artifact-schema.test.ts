/**
 * Unit tests for packages/shared-utils/src/artifact-schema.ts
 */

import { describe, it, expect } from 'vitest';
import {
  inferSchemaFromHeadTail,
  adoptMcpSchema,
  formatSchemaForPrompt,
} from './artifact-schema.js';

describe('inferSchemaFromHeadTail', () => {
  it('infers a JSON object with top-level keys and types', () => {
    const head = '{"id": 42, "name": "alpha", "active": true, "ratio": 1.5, "meta": null}';
    const schema = inferSchemaFromHeadTail(head, '', 'application/json');
    expect(schema.kind).toBe('json_object');
    expect(schema.partial).toBe(false);
    expect(schema.topLevelKeys).toEqual({
      id: 'int',
      name: 'string',
      active: 'boolean',
      ratio: 'float',
      meta: 'null',
    });
    expect(schema.inferenceSource).toBe('head_tail_infer');
  });

  it('infers a JSON array with itemCount and item schema', () => {
    const head = '[{"id":1,"deadlock_time":"2026-04-25T00:00:00Z"},{"id":2,"deadlock_time":"2026-04-25T01:00:00Z"}]';
    const schema = inferSchemaFromHeadTail(head, '', 'application/json');
    expect(schema.kind).toBe('json_array');
    expect(schema.itemCount).toBe(2);
    expect(schema.itemSchema).toEqual({ id: 'int', deadlock_time: 'string' });
    expect(schema.partial).toBe(false);
  });

  it('infers XML with root element and first children', () => {
    const head = '<?xml version="1.0"?><root><child1>a</child1><child2>b</child2><child3>c</child3></root>';
    const schema = inferSchemaFromHeadTail(head, '', 'application/xml');
    expect(schema.kind).toBe('xml');
    expect(schema.rootElement).toBe('root');
    expect(schema.firstChildren).toEqual(['child1', 'child2', 'child3']);
    expect(schema.partial).toBe(true);
  });

  it('infers CSV with column names', () => {
    const head = 'id,name,timestamp\n1,alpha,2026-04-25\n2,beta,2026-04-25\n';
    const schema = inferSchemaFromHeadTail(head, '', 'text/csv');
    expect(schema.kind).toBe('csv');
    expect(schema.columns).toEqual(['id', 'name', 'timestamp']);
    expect(schema.partial).toBe(true);
  });

  it('falls through to text for plain content', () => {
    const head = 'just some plain text\nwith two lines\n';
    const schema = inferSchemaFromHeadTail(head, '', 'text/plain');
    expect(schema.kind).toBe('text');
    expect(schema.lineCount).toBeGreaterThan(0);
    expect(schema.byteCount).toBeGreaterThan(0);
  });

  it('marks JSON as partial when input is mid-record-truncated', () => {
    // Truncated mid-object: missing closing `}`. Recovery cuts to last `}` (the inner one).
    const head = '[{"id":1,"name":"alpha"},{"id":2,"name":"be';
    const tail = '';
    const schema = inferSchemaFromHeadTail(head, tail, 'application/json');
    expect(schema.kind).toBe('json_array');
    // Should still extract some signal even though parse failed on full input.
    expect(schema.partial).toBe(true);
    // itemSchema should at least include keys from the first object.
    expect(schema.itemSchema).toBeDefined();
    expect(schema.itemSchema).toHaveProperty('id');
    expect(schema.itemSchema).toHaveProperty('name');
  });
});

describe('adoptMcpSchema', () => {
  it('adopts a producer-supplied schema and stamps inferenceSource', () => {
    const schema = adoptMcpSchema({
      kind: 'json_array',
      itemCount: 6,
      itemSchema: { Id: 'int', DeadlockTime: 'string' },
    });
    expect(schema.kind).toBe('json_array');
    expect(schema.itemCount).toBe(6);
    expect(schema.inferenceSource).toBe('mcp_provided');
  });

  it('handles non-object input gracefully', () => {
    const schema = adoptMcpSchema(null);
    expect(schema.kind).toBe('unknown');
    expect(schema.inferenceSource).toBe('unknown');
  });
});

describe('formatSchemaForPrompt', () => {
  it('formats a JSON array with item count + item shape', () => {
    const out = formatSchemaForPrompt({
      kind: 'json_array',
      itemCount: 6,
      itemSchema: { Id: 'int', DeadlockTime: 'string' },
      inferenceSource: 'mcp_provided',
    });
    expect(out).toContain('6 items');
    expect(out).toContain('Id (int)');
    expect(out).toContain('DeadlockTime (string)');
  });

  it('formats a partial JSON object', () => {
    const out = formatSchemaForPrompt({
      kind: 'json_object',
      topLevelKeys: { id: 'int', name: 'string' },
      partial: true,
      inferenceSource: 'head_tail_infer',
    });
    expect(out).toContain('id (int)');
    expect(out).toContain('partial');
  });

  it('formats XML with root + children', () => {
    const out = formatSchemaForPrompt({
      kind: 'xml',
      rootElement: 'ShowPlanXML',
      firstChildren: ['BatchSequence', 'Statements'],
      inferenceSource: 'head_tail_infer',
    });
    expect(out).toContain('XML <ShowPlanXML>');
    expect(out).toContain('BatchSequence');
  });

  it('formats CSV with columns', () => {
    const out = formatSchemaForPrompt({
      kind: 'csv',
      columns: ['id', 'name'],
      rowCount: 100,
      inferenceSource: 'head_tail_infer',
    });
    expect(out).toContain('CSV');
    expect(out).toContain('id, name');
  });

  it('formats text with line + byte counts', () => {
    const out = formatSchemaForPrompt({
      kind: 'text',
      lineCount: 42,
      byteCount: 1024,
      inferenceSource: 'head_tail_infer',
    });
    expect(out).toContain('42 lines');
    expect(out).toContain('1024 bytes');
  });
});
