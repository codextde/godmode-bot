import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

/**
 * A small form for a trigger's JSON-schema config: strings, numbers, booleans and enums get real inputs,
 * anything more complex (objects, arrays, unions) falls back to a JSON editor.
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

/** Form state: typed values, plus the raw text of JSON fields once edited (so half-typed JSON isn't lost). */
export interface ConfigState {
  values: Record<string, unknown>;
  json: Record<string, string>;
}

const NONE = "__none";

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Follow local `$ref`s ("#/$defs/Foo") and single-element `allOf` wrappers; outer keywords win. */
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

/** Reduce a property schema to one simple type (dropping `null` from unions), or null when it isn't simple. */
function simpleType(node: Json, root: Json): { type: string; enum?: unknown[] } | null {
  if (Array.isArray(node.enum)) return { type: "enum", enum: node.enum };
  if (node.const !== undefined) return { type: "enum", enum: [node.const] };
  const variants = (Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : null)
    ?.map((v) => resolve(v, root))
    .filter((v) => v.type !== "null");
  if (variants) return variants.length === 1 ? simpleType(variants[0], root) : null;
  const types = (Array.isArray(node.type) ? node.type : [node.type]).filter((t) => t !== "null" && t !== undefined);
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
      placeholder: example !== undefined ? `e.g. ${example}` : "",
    };
  });
}

/** Text shown in a JSON field: what the human typed, else the current value. */
function jsonText(state: ConfigState, key: string): string {
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

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === "";
}

/** Problems keyed by field; empty when the config can be saved. */
export function configProblems(fields: SchemaField[], state: ConfigState): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    // A switch is always on or off, so it's never missing.
    if (f.kind === "boolean") continue;
    if (f.kind === "json") {
      const text = jsonText(state, f.key).trim();
      if (!text) {
        if (f.required) out[f.key] = "Required";
        continue;
      }
      try {
        JSON.parse(text);
      } catch {
        out[f.key] = "Enter valid JSON";
      }
      continue;
    }
    const v = state.values[f.key];
    if (isEmpty(v)) {
      if (f.required) out[f.key] = "Required";
    } else if (f.kind === "integer" && !Number.isInteger(v)) out[f.key] = "Enter a whole number";
    else if (f.kind === "number" && !Number.isFinite(v)) out[f.key] = "Enter a number";
  }
  return out;
}

/** The config to save: set values only, JSON fields parsed. Call when `configProblems` is empty. */
export function configValue(fields: SchemaField[], state: ConfigState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.kind === "json") {
      const text = jsonText(state, f.key).trim();
      if (text) out[f.key] = JSON.parse(text);
    } else if (f.kind === "boolean") {
      // What the switch shows: unset reads as off.
      if (state.values[f.key] !== undefined || f.required) out[f.key] = state.values[f.key] === true;
    } else if (!isEmpty(state.values[f.key])) out[f.key] = state.values[f.key];
  }
  return out;
}

export function JsonSchemaForm({
  fields,
  state,
  onChange,
  problems,
  showProblems,
  idPrefix,
}: {
  fields: SchemaField[];
  state: ConfigState;
  onChange: (state: ConfigState) => void;
  problems: Record<string, string>;
  showProblems: boolean;
  idPrefix: string;
}) {
  const setValue = (key: string, v: unknown) => {
    const values = { ...state.values };
    if (isEmpty(v)) delete values[key];
    else values[key] = v;
    onChange({ ...state, values });
  };
  const setJson = (key: string, text: string) => onChange({ ...state, json: { ...state.json, [key]: text } });

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {fields.map((f) => {
        const id = `${idPrefix}-${f.key}`;
        const problem = showProblems ? problems[f.key] : undefined;
        const hintId = f.description ? `${id}-hint` : undefined;
        const errorId = `${id}-error`;
        const describedBy = [problem ? errorId : null, hintId].filter(Boolean).join(" ") || undefined;
        const wide = f.kind === "json" || f.kind === "boolean" || f.description.length > 90;

        if (f.kind === "boolean") {
          return (
            <div key={f.key} className="flex items-start gap-3 rounded-lg border bg-card p-3 shadow-card sm:col-span-2">
              <div className="min-w-0 flex-1">
                <Label htmlFor={id} className="cursor-pointer text-sm">
                  {f.title}
                </Label>
                {f.description && (
                  <p id={hintId} className="mt-1 text-xs text-muted-foreground">
                    {f.description}
                  </p>
                )}
              </div>
              <Switch id={id} checked={state.values[f.key] === true} onCheckedChange={(v) => setValue(f.key, v)} aria-describedby={hintId} />
            </div>
          );
        }

        return (
          <div key={f.key} className={cn("min-w-0 space-y-1.5", wide && "sm:col-span-2")}>
            <Label htmlFor={id} className="text-xs">
              {f.title}
              {!f.required && <span className="font-normal text-muted-foreground">optional</span>}
            </Label>
            {f.kind === "enum" ? (
              <Select
                value={state.values[f.key] === undefined ? NONE : String(state.values[f.key])}
                onValueChange={(v) => setValue(f.key, v === NONE ? undefined : f.options.find((o) => String(o) === v))}
              >
                <SelectTrigger id={id} className="w-full" aria-invalid={!!problem} aria-describedby={describedBy}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent position="popper">
                  {!f.required && <SelectItem value={NONE}>Not set</SelectItem>}
                  {f.options.map((o) => (
                    <SelectItem key={String(o)} value={String(o)}>
                      {String(o)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : f.kind === "json" ? (
              <Textarea
                id={id}
                value={jsonText(state, f.key)}
                onChange={(e) => setJson(f.key, e.target.value)}
                placeholder='{ "key": "value" }'
                spellCheck={false}
                aria-invalid={!!problem}
                aria-describedby={describedBy}
                className="min-h-20 font-mono text-xs"
              />
            ) : (
              <Input
                id={id}
                type={f.kind === "string" ? "text" : "number"}
                step={f.kind === "integer" ? 1 : "any"}
                value={state.values[f.key] === undefined ? "" : String(state.values[f.key])}
                onChange={(e) => {
                  const raw = e.target.value;
                  setValue(f.key, f.kind === "string" ? raw : raw === "" ? undefined : Number(raw));
                }}
                placeholder={f.placeholder}
                aria-invalid={!!problem}
                aria-describedby={describedBy}
              />
            )}
            {problem && (
              <p id={errorId} className="text-xs text-destructive">
                {problem}
              </p>
            )}
            {f.description && (
              <p id={hintId} className="line-clamp-3 text-xs text-muted-foreground" title={f.description}>
                {f.description}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
