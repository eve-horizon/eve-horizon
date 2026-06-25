/**
 * Safe template expression engine for workflow step overrides.
 *
 * Used by Phase 4 of the per-job harness override plan to let workflow steps
 * reference values derived from the invocation — either the caller's `inputs`
 * payload or the triggering event's `event.payload`.
 *
 * Grammar (intentionally tiny — every extension is a new code path to audit):
 *
 *   template := (literal | reference)*
 *   reference := '${' head path '}'
 *   head := 'inputs' | 'event.payload'
 *   path := ('.' ident)*
 *   ident := [A-Za-z_][A-Za-z0-9_-]*
 *
 * There are no operators, no function calls, and no indexing — those would all
 * be template-injection CVEs waiting to happen. Unknown heads fail at parse
 * time. Unknown fields fail at `evaluate` time (or at `validate` time if we
 * know the declared input names).
 */

/** A parsed reference like `${inputs.model}` or `${event.payload.meta.brand}`. */
export interface TemplateReference {
  /** `inputs` or `event.payload`. */
  head: 'inputs' | 'event.payload';
  /** Dotted path under the head. `inputs.model` → `['model']`. */
  path: string[];
  /** Verbatim expression text for diagnostics, e.g. `inputs.model`. */
  raw: string;
  /** Zero-based offset in the original template string for error reporting. */
  start: number;
  /** Exclusive end offset. */
  end: number;
}

/** A parsed template. A value without any `${...}` parses to a single literal part. */
export interface ParsedTemplate {
  parts: Array<
    | { kind: 'literal'; value: string }
    | { kind: 'ref'; ref: TemplateReference }
  >;
  /** All references discovered during parse, in order. */
  refs: TemplateReference[];
  /** True if the template is exactly one `${...}` with no surrounding literal. */
  singleRef: boolean;
}

export interface TemplateError {
  message: string;
  start: number;
  end: number;
}

export interface ValidateOptions {
  /** Declared workflow input names. When set, unknown `${inputs.<key>}` is an error. */
  declaredInputs?: ReadonlySet<string>;
  /**
   * When set, refs starting with `event.payload` are accepted even when no
   * event is expected. Structural validation at sync time cannot know the
   * runtime event shape, so we always tolerate any `event.payload.<path>`.
   */
  allowEventPayload?: boolean;
}

const REF_HEAD_INPUTS = 'inputs';
const REF_HEAD_EVENT = 'event.payload';
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

/**
 * Return true iff the string contains at least one `${...}` reference. Used by
 * callers to cheaply short-circuit on plain strings.
 */
export function looksTemplated(input: string): boolean {
  return input.includes('${');
}

/**
 * Parse a template string. Throws a single `TemplateParseError` on the first
 * malformed reference — callers should catch and surface it.
 */
export class TemplateParseError extends Error {
  constructor(
    message: string,
    public readonly start: number,
    public readonly end: number,
  ) {
    super(message);
    this.name = 'TemplateParseError';
  }
}

export function parseTemplate(input: string): ParsedTemplate {
  const parts: ParsedTemplate['parts'] = [];
  const refs: TemplateReference[] = [];
  let i = 0;
  let buf = '';
  let refCount = 0;
  let nonRefLiteralLen = 0;

  while (i < input.length) {
    const ch = input[i];
    if (ch === '\\' && input[i + 1] === '$') {
      buf += '$';
      i += 2;
      continue;
    }
    if (ch === '$' && input[i + 1] === '{') {
      if (buf.length > 0) {
        parts.push({ kind: 'literal', value: buf });
        nonRefLiteralLen += buf.length;
        buf = '';
      }
      const refStart = i;
      const close = input.indexOf('}', i + 2);
      if (close === -1) {
        throw new TemplateParseError('Unterminated `${` in template', i, input.length);
      }
      const body = input.slice(i + 2, close).trim();
      const ref = parseReference(body, i + 2, close);
      parts.push({ kind: 'ref', ref });
      refs.push(ref);
      refCount += 1;
      i = close + 1;
      continue;
    }
    buf += ch;
    i += 1;
  }
  if (buf.length > 0) {
    parts.push({ kind: 'literal', value: buf });
    nonRefLiteralLen += buf.length;
  }

  return {
    parts,
    refs,
    singleRef: refCount === 1 && nonRefLiteralLen === 0,
  };
}

function parseReference(body: string, start: number, end: number): TemplateReference {
  if (body.length === 0) {
    throw new TemplateParseError('Empty `${}` expression', start, end);
  }

  // Heads are matched greedily: `event.payload` before `event` (not allowed).
  let head: 'inputs' | 'event.payload';
  let rest: string;
  if (body === REF_HEAD_INPUTS || body.startsWith(`${REF_HEAD_INPUTS}.`)) {
    head = 'inputs';
    rest = body.slice(REF_HEAD_INPUTS.length);
  } else if (body === REF_HEAD_EVENT || body.startsWith(`${REF_HEAD_EVENT}.`)) {
    head = 'event.payload';
    rest = body.slice(REF_HEAD_EVENT.length);
  } else {
    throw new TemplateParseError(
      `Unsupported expression head in \`${body}\`. Only \`inputs.<key>\` and \`event.payload.<path>\` are allowed.`,
      start,
      end,
    );
  }

  // `rest` is '' (bare head) or starts with '.'; split out the dotted path.
  const path: string[] = [];
  if (rest.length > 0) {
    if (!rest.startsWith('.')) {
      throw new TemplateParseError(`Invalid expression \`${body}\``, start, end);
    }
    const segments = rest.slice(1).split('.');
    for (const segment of segments) {
      if (segment.length === 0) {
        throw new TemplateParseError(`Empty path segment in \`${body}\``, start, end);
      }
      if (!IDENT_RE.test(segment)) {
        throw new TemplateParseError(
          `Invalid path segment \`${segment}\` in \`${body}\` (letters, digits, underscores, hyphens only)`,
          start,
          end,
        );
      }
      path.push(segment);
    }
  }

  if (head === 'inputs' && path.length !== 1) {
    // `${inputs}` and `${inputs.a.b}` are both disallowed: inputs are a flat map.
    throw new TemplateParseError(
      `\`inputs.<key>\` expects exactly one key, got \`${body}\``,
      start,
      end,
    );
  }
  if (head === 'event.payload' && path.length === 0) {
    throw new TemplateParseError(
      '`event.payload.<path>` requires at least one path segment',
      start,
      end,
    );
  }

  return { head, path, raw: body, start, end };
}

/**
 * Validate a template structurally. Returns errors rather than throwing so
 * callers can accumulate multiple errors across a workflow.
 */
export function validateTemplate(
  input: string,
  options: ValidateOptions = {},
): TemplateError[] {
  if (!looksTemplated(input)) return [];
  let parsed: ParsedTemplate;
  try {
    parsed = parseTemplate(input);
  } catch (error) {
    if (error instanceof TemplateParseError) {
      return [{ message: error.message, start: error.start, end: error.end }];
    }
    throw error;
  }
  const errors: TemplateError[] = [];
  for (const ref of parsed.refs) {
    if (ref.head === 'inputs' && options.declaredInputs) {
      const key = ref.path[0];
      if (!options.declaredInputs.has(key)) {
        errors.push({
          message: `Template references undeclared input \`inputs.${key}\`. Declare it in workflow.inputs.`,
          start: ref.start,
          end: ref.end,
        });
      }
    }
    // Event payload paths cannot be validated structurally — the payload shape
    // is not known until runtime. We do a shallow smoke check only: the parser
    // already rejected obviously malformed paths.
  }
  return errors;
}

export interface EvaluateScope {
  inputs?: Record<string, unknown>;
  event?: { payload?: unknown };
}

export interface EvaluateResult {
  /** The fully-interpolated value. `null` iff any ref resolved to null/undefined. */
  value: string | null;
  /** References that could not be resolved against `scope`. */
  missing: TemplateReference[];
  /** References that resolved to a non-scalar (object/array). */
  nonScalar: TemplateReference[];
}

/**
 * Interpolate `template` against `scope`. Returns `value: null` if any
 * reference resolves to `undefined`, `null`, or a non-scalar value — callers
 * decide whether to fall back or error.
 *
 * If the template is a single `${...}` (no surrounding literals) and the ref
 * resolves to a number or boolean, the resulting string is that scalar's
 * `String(...)` form. Mixed templates always stringify via concatenation.
 */
export function evaluateTemplate(
  template: string,
  scope: EvaluateScope,
): EvaluateResult {
  const parsed = parseTemplate(template);
  if (parsed.refs.length === 0) {
    return { value: template, missing: [], nonScalar: [] };
  }

  const missing: TemplateReference[] = [];
  const nonScalar: TemplateReference[] = [];
  let out = '';

  for (const part of parsed.parts) {
    if (part.kind === 'literal') {
      out += part.value;
      continue;
    }
    const resolved = resolveRef(part.ref, scope);
    if (resolved === undefined || resolved === null) {
      missing.push(part.ref);
      continue;
    }
    if (typeof resolved === 'object') {
      nonScalar.push(part.ref);
      continue;
    }
    out += String(resolved);
  }

  if (missing.length > 0 || nonScalar.length > 0) {
    return { value: null, missing, nonScalar };
  }
  return { value: out, missing, nonScalar };
}

function resolveRef(ref: TemplateReference, scope: EvaluateScope): unknown {
  if (ref.head === 'inputs') {
    if (!scope.inputs) return undefined;
    return scope.inputs[ref.path[0]];
  }
  // event.payload.<path>
  const payload = scope.event?.payload;
  if (payload === undefined || payload === null) return undefined;
  return lookupPath(payload, ref.path);
}

function lookupPath(root: unknown, path: string[]): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (current === undefined || current === null) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Apply `evaluateTemplate` to every string-valued leaf of `value`, returning
 * a structurally identical object/array/string. Non-string leaves pass
 * through unchanged. If any leaf fails to resolve, the result carries a
 * `missing` list and each failed string leaf is replaced with the original
 * template text so the caller can surface diagnostics without crashing.
 */
export interface InterpolateResult<T> {
  value: T;
  missing: Array<{ path: string; ref: TemplateReference }>;
  nonScalar: Array<{ path: string; ref: TemplateReference }>;
}

export function interpolateValue<T>(
  value: T,
  scope: EvaluateScope,
  path: string = '',
): InterpolateResult<T> {
  const missing: InterpolateResult<T>['missing'] = [];
  const nonScalar: InterpolateResult<T>['nonScalar'] = [];

  function walk(node: unknown, nodePath: string): unknown {
    if (typeof node === 'string') {
      if (!looksTemplated(node)) return node;
      const result = evaluateTemplate(node, scope);
      for (const ref of result.missing) missing.push({ path: nodePath, ref });
      for (const ref of result.nonScalar) nonScalar.push({ path: nodePath, ref });
      return result.value ?? node;
    }
    if (Array.isArray(node)) {
      return node.map((item, idx) => walk(item, `${nodePath}[${idx}]`));
    }
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        out[k] = walk(v, nodePath ? `${nodePath}.${k}` : k);
      }
      return out;
    }
    return node;
  }

  const result = walk(value, path) as T;
  return { value: result, missing, nonScalar };
}
