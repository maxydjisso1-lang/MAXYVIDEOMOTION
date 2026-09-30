import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { BveError } from "./errors.js";
import { SCHEMAS_DIR } from "./locations.js";

export type SchemaName =
  | "analysis" | "audio" | "brand" | "captions" | "color" | "creative-plan" | "motion"
  | "preset" | "project" | "qc-report" | "qc-waivers" | "render-record" | "style-tokens" | "timeline" | "transcript";

// ajv-formats ships CJS; normalize the default export across loaders.
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as (ajv: Ajv2020) => void;

let ajv: Ajv2020 | undefined;
const cache = new Map<SchemaName, ValidateFunction>();

function instance(): Ajv2020 {
  if (ajv) return ajv;
  ajv = new Ajv2020({ allErrors: true, strict: true, strictRequired: false, allowUnionTypes: true, useDefaults: false });
  addFormats(ajv);
  for (const file of readdirSync(SCHEMAS_DIR)) {
    if (file.endsWith(".schema.json")) ajv.addSchema(JSON.parse(readFileSync(join(SCHEMAS_DIR, file), "utf8")));
  }
  return ajv;
}

function validator(name: SchemaName): ValidateFunction {
  let fn = cache.get(name);
  if (!fn) {
    fn = instance().getSchema(`bve://schemas/${name}.schema.json`);
    if (!fn) throw new BveError("INTERNAL", `Unknown schema "${name}"`);
    cache.set(name, fn);
  }
  return fn;
}

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? [])
    // if/then branches produce a redundant "must match then schema" line.
    .filter((e) => e.keyword !== "if")
    .slice(0, 12)
    .map((e) => `${e.instancePath || "/"} ${e.message ?? "is invalid"}${e.params && "allowedValues" in e.params ? ` (${(e.params.allowedValues as unknown[]).join(", ")})` : ""}`);
}

export function validate<T>(name: SchemaName, data: unknown, label: string = name): T {
  const fn = validator(name);
  if (!fn(data)) {
    const issues = formatErrors(fn.errors);
    throw new BveError("VALIDATION", `${label} does not match schemas/${name}.schema.json:\n  - ${issues.join("\n  - ")}`, {
      details: issues,
      hint: `Fix the listed fields; the schema is the contract (schemas/${name}.schema.json).`,
    });
  }
  return data as T;
}

export function isValid(name: SchemaName, data: unknown): boolean {
  return validator(name)(data) as boolean;
}
