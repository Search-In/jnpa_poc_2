/**
 * AJV-backed validator registry. Connectors/gateway import `validate(id, data)`
 * to assert any object conforms to its canonical JSON-Schema at the boundary.
 */
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { ALL_SCHEMAS } from './schemas.js';

export * from './schemas.js';

// Use the draft 2020-12 build so our $schema dialect is recognised.
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

for (const schema of ALL_SCHEMAS) {
  ajv.addSchema(schema, schema.$id);
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/** Validate `data` against the schema registered under `$id`. */
export function validate(schemaId: string, data: unknown): ValidationResult {
  const fn = ajv.getSchema(schemaId) as ValidateFunction | undefined;
  if (!fn) {
    throw new Error(`No JSON-Schema registered for id "${schemaId}"`);
  }
  const valid = fn(data) as boolean;
  const errors = valid
    ? []
    : (fn.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`);
  return { valid, errors };
}

/** Throwing variant — raises with a readable message if invalid. */
export function assertValid<T>(schemaId: string, data: unknown): T {
  const { valid, errors } = validate(schemaId, data);
  if (!valid) {
    throw new Error(`Validation failed for ${schemaId}: ${errors.join('; ')}`);
  }
  return data as T;
}
