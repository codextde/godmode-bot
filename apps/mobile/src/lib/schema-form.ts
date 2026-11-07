import { t } from "./i18n";

/**
 * A small form for a trigger's JSON-schema config, like the desktop's json-schema-form.tsx: strings, numbers, booleans
 * and enums get real fields, anything more complex (objects, arrays, unions) is typed as JSON.
 */

type Json = Record<string, unknown>;

export type FieldKind = "string" | "number" | "integer" | "boolean" | "enum" | "json";

export interface SchemaField {
  key: string;
  title: string;
  description: string;
  kind: FieldKind;
  required: boolean;
  default: unknown;
  options: (string | number)[];
  placeholder: string;
}

/** Typed values, plus the raw text of JSON fields once edited (so half-typed JSON isn't lost). */
export interface ConfigState {
  values: Record<string, unknown>;
  json: Record<string, string>;
}

/** The phone's keyboard curls quotes as you type; JSON only reads straight ones. */
export function straightQuotes(text: string): string {
  return text.replace(/[\u201C\u201D\u201E\u201F]/g, '"').replace(/[\u2018\u2019\u201A\u201B]/g, "'");
}

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Follows local `$ref`s ("#/$defs/Foo") and single-element `allOf` wrappers; outer keywords win. */
function resolve(node: unknown, root: Json, depth = 0): Json {
  if (!isObject(node) || depth > 8) return {};
  const { $ref, allOf, ...rest } = node;
  let base: Json = {};
  if (typeof $ref === "string" && $ref.startsWith("#/")) {
    const target = $ref
      .slice(2)
      .split("/")
      .reduce<unknown>((acc, part) => (isObject(acc) ? acc[part.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined), root);
    base = resolve(target, root, depth + 1);
  } else if (Array.isArray(allOf) && allOf.length === 1) {
    base = resolve(allOf[0], root, depth + 1);
  }
  return { ...base, ...rest };
}

/** One simple type for a property (dropping `null` from unions), or null when it isn't simple. */
function simpleType(node: Json, root: Json): { type: string; enum?: unknown[] } | null {
  if (Array.isArray(node.enum)) return { type: "enum", enum: node.enum };
  if (node.const !== undefined) return { type: "enum", enum: [node.const] };
  const variants = (Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : null)
    ?.map((v) => resolve(v, root))
    .filter((v) => v.type !== "null");
  if (variants) return variants.length === 1 ? simpleType(variants[0]!, root) : null;
  const types = (Array.isArray(node.type) ? node.type : [node.type]).filter((x) => x !== "null" && x !== undefined);
  return types.length === 1 && typeof types[0] === "string" ? { type: types[0] } : null;
}

function kindOf(node: Json, root: Json): Pick<SchemaField, "kind" | "options"> {
  const simple = simpleType(node, root);
  if (simple?.type === "enum") {
    const options = (simple.enum ?? []).filter((o): o is string | number => typeof o === "string" || typeof o === "number");
    return options.length && options.length === simple.enum?.length ? { kind: "enum", options } : { kind: "json", options: [] };
  }
  if (simple?.type === "string" || simple?.type === "number" || simple?.type === "integer" || simple?.type === "boolean") {
    return { kind: simple.type, options: [] };
  }
  return { kind: "json", options: [] };
}

function titleFromKey(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The fields of an object schema, in declaration order. */
export function schemaFields(schema: Json | null | undefined): SchemaField[] {
  if (!schema) return [];
  const root = resolve(schema, schema);
  const props = isObject(root.properties) ? root.properties : {};
  const required = new Set(Array.isArray(root.required) ? root.required.filter((r): r is string => typeof r === "string") : []);
  return Object.entries(props).map(([key, raw]) => {
    const node = resolve(raw, schema);
    const { kind, options } = kindOf(node, schema);
    const examples = Array.isArray(node.examples) ? node.examples : [];
    const example = examples.find((e) => typeof e === "string" || typeof e === "number");
    return {
      key,
      title: typeof node.title === "string" && node.title.trim() ? node.title : titleFromKey(key),
      description: typeof node.description === "string" ? node.description.trim() : "",
      kind,
      required: required.has(key),
      default: node.default,
      options,
      placeholder: example !== undefined ? t("automations:schemaForm.example", { example }) : "",
    };
  });
}

/** Text shown in a JSON field: what the human typed, else the current value. */
export function jsonText(state: ConfigState, key: string): string {
  const typed = state.json[key];
  if (typed !== undefined) return typed;
  const v = state.values[key];
  return v === undefined ? "" : JSON.stringify(v, null, 2);
}

/** Defaults of a trigger type's fields, for a freshly picked trigger. A switch without a default starts off. */
export function defaultConfig(fields: SchemaField[]): ConfigState {
  const values: Record<string, unknown> = {};
  for (const f of fields) {
    const v = f.default ?? (f.kind === "boolean" ? false : undefined);
    if (v !== undefined && v !== null) values[f.key] = v;
  }
  return { values, json: {} };
}

export function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === "";
}

/** Problems keyed by field; empty when the config can be saved. */
export function configProblems(fields: SchemaField[], state: ConfigState): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    if (f.kind === "boolean") continue;
    if (f.kind === "json") {
      const text = straightQuotes(jsonText(state, f.key)).trim();
      if (!text) {
        if (f.required) out[f.key] = t("automations:schemaForm.required");
        continue;
      }
      try {
        JSON.parse(text);
      } catch {
        out[f.key] = t("automations:schemaForm.invalidJson");
      }
      continue;
    }
    const v = state.values[f.key];
    if (isEmpty(v)) {
      if (f.required) out[f.key] = t("automations:schemaForm.required");
    } else if (f.kind === "integer" && !Number.isInteger(v)) out[f.key] = t("automations:schemaForm.wholeNumber");
    else if (f.kind === "number" && !Number.isFinite(v)) out[f.key] = t("automations:schemaForm.number");
  }
  return out;
}

/** The config to save: set values only, JSON fields parsed. Call when `configProblems` is empty. */
export function configValue(fields: SchemaField[], state: ConfigState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.kind === "json") {
      const text = straightQuotes(jsonText(state, f.key)).trim();
      if (text) out[f.key] = JSON.parse(text);
    } else if (f.kind === "boolean") {
      if (state.values[f.key] !== undefined || f.required) out[f.key] = state.values[f.key] === true;
    } else if (!isEmpty(state.values[f.key])) out[f.key] = state.values[f.key];
  }
  return out;
}
