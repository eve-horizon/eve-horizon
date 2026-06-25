import { describe, it, expect } from 'vitest';
import {
  parseTemplate,
  validateTemplate,
  evaluateTemplate,
  interpolateValue,
  looksTemplated,
  TemplateParseError,
} from '../expr.js';

describe('looksTemplated', () => {
  it('detects `${` occurrences', () => {
    expect(looksTemplated('hello')).toBe(false);
    expect(looksTemplated('hello ${inputs.x}')).toBe(true);
    expect(looksTemplated('$not a template')).toBe(false);
  });
});

describe('parseTemplate', () => {
  it('parses a bare literal', () => {
    const out = parseTemplate('hello');
    expect(out.parts).toEqual([{ kind: 'literal', value: 'hello' }]);
    expect(out.refs).toHaveLength(0);
    expect(out.singleRef).toBe(false);
  });

  it('parses a single-ref template', () => {
    const out = parseTemplate('${inputs.model}');
    expect(out.refs).toHaveLength(1);
    expect(out.refs[0].head).toBe('inputs');
    expect(out.refs[0].path).toEqual(['model']);
    expect(out.singleRef).toBe(true);
  });

  it('parses a mixed template', () => {
    const out = parseTemplate('prefix-${inputs.model}-suffix');
    expect(out.parts).toHaveLength(3);
    expect(out.parts[0]).toEqual({ kind: 'literal', value: 'prefix-' });
    expect(out.parts[1].kind).toBe('ref');
    expect(out.parts[2]).toEqual({ kind: 'literal', value: '-suffix' });
    expect(out.singleRef).toBe(false);
  });

  it('parses event.payload with a dotted path', () => {
    const out = parseTemplate('${event.payload.meta.brand}');
    expect(out.refs[0].head).toBe('event.payload');
    expect(out.refs[0].path).toEqual(['meta', 'brand']);
  });

  it('supports escaped `$` via backslash', () => {
    const out = parseTemplate('price: \\${inputs.model}');
    expect(out.refs).toHaveLength(0);
    expect(out.parts).toEqual([{ kind: 'literal', value: 'price: ${inputs.model}' }]);
  });

  it.each([
    ['${}', 'Empty'],
    ['${bogus}', 'Unsupported expression head'],
    ['${inputs}', 'inputs.<key>'],
    ['${inputs..key}', 'Empty path segment'],
    ['${inputs.}', 'Empty path segment'],
    ['${inputs.model', 'Unterminated'],
    ['${inputs.model.extra}', 'inputs.<key>'],
    ['${event.payload}', 'event.payload.<path>'],
    ['${event.payload.}', 'Empty path segment'],
    ['${inputs.model!}', 'Invalid path segment'],
  ])('rejects malformed expression `%s`', (expr, fragment) => {
    expect(() => parseTemplate(expr)).toThrow(TemplateParseError);
    try {
      parseTemplate(expr);
    } catch (error) {
      expect((error as TemplateParseError).message).toContain(fragment);
    }
  });
});

describe('validateTemplate', () => {
  it('returns no errors for a plain string', () => {
    expect(validateTemplate('hello')).toEqual([]);
  });

  it('accepts a valid inputs reference when declared', () => {
    expect(
      validateTemplate('${inputs.model}', { declaredInputs: new Set(['model']) }),
    ).toEqual([]);
  });

  it('reports undeclared inputs references', () => {
    const errs = validateTemplate('${inputs.mystery}', {
      declaredInputs: new Set(['model']),
    });
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toMatch(/undeclared input/);
  });

  it('accepts event.payload references without structural checking', () => {
    expect(validateTemplate('${event.payload.anything.here}')).toEqual([]);
  });

  it('surfaces parse errors as structured error records', () => {
    const errs = validateTemplate('${bogus}');
    expect(errs).toHaveLength(1);
    expect(errs[0].message).toMatch(/Unsupported expression head/);
  });
});

describe('evaluateTemplate', () => {
  it('returns plain literals unchanged', () => {
    expect(evaluateTemplate('hello', {}).value).toBe('hello');
  });

  it('resolves a single inputs reference', () => {
    expect(
      evaluateTemplate('${inputs.model}', { inputs: { model: 'claude-sonnet-4-6' } }).value,
    ).toBe('claude-sonnet-4-6');
  });

  it('resolves a mixed template', () => {
    expect(
      evaluateTemplate('profile-${inputs.model}', { inputs: { model: 'glm-4.6' } }).value,
    ).toBe('profile-glm-4.6');
  });

  it('stringifies scalar numbers and booleans', () => {
    expect(evaluateTemplate('${inputs.count}', { inputs: { count: 42 } }).value).toBe('42');
    expect(evaluateTemplate('${inputs.on}', { inputs: { on: true } }).value).toBe('true');
  });

  it('resolves nested event.payload paths', () => {
    const result = evaluateTemplate('${event.payload.meta.brand}', {
      event: { payload: { meta: { brand: 'eden' } } },
    });
    expect(result.value).toBe('eden');
  });

  it('returns null with `missing` when a reference is undefined', () => {
    const result = evaluateTemplate('${inputs.model}', { inputs: {} });
    expect(result.value).toBeNull();
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0].raw).toBe('inputs.model');
  });

  it('treats non-scalar resolutions as unresolved', () => {
    const result = evaluateTemplate('${inputs.model}', {
      inputs: { model: { nested: 'object' } as unknown as string },
    });
    expect(result.value).toBeNull();
    expect(result.nonScalar).toHaveLength(1);
  });

  it('handles missing event payload gracefully', () => {
    const result = evaluateTemplate('${event.payload.foo}', {});
    expect(result.value).toBeNull();
    expect(result.missing).toHaveLength(1);
  });
});

describe('interpolateValue', () => {
  it('recursively interpolates string leaves', () => {
    const result = interpolateValue(
      {
        harness: 'zai',
        model: '${inputs.model}',
        nested: { temperature: 0.2, variant: '${event.payload.variant}' },
      },
      {
        inputs: { model: 'glm-4.6' },
        event: { payload: { variant: 'fast' } },
      },
    );
    expect(result.value).toEqual({
      harness: 'zai',
      model: 'glm-4.6',
      nested: { temperature: 0.2, variant: 'fast' },
    });
    expect(result.missing).toHaveLength(0);
  });

  it('reports missing refs with paths', () => {
    const result = interpolateValue(
      { model: '${inputs.mystery}' },
      { inputs: {} },
    );
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0].path).toBe('model');
    // Leaf preserved so callers can show the original template in diagnostics.
    expect((result.value as { model: string }).model).toBe('${inputs.mystery}');
  });

  it('passes through non-string leaves', () => {
    const result = interpolateValue(
      { n: 1, b: true, a: [null, 2, 'plain'] },
      {},
    );
    expect(result.value).toEqual({ n: 1, b: true, a: [null, 2, 'plain'] });
  });
});
