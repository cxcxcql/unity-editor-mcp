import Ajv from 'ajv';

export class SchemaValidationError extends Error {
  constructor(message, errors = []) {
    super(message);
    this.name = 'SchemaValidationError';
    this.code = 'INVALID_PARAMS';
    this.errors = errors;
  }
}

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  allowUnionTypes: true
});

export function normalizeInputSchema(schema = {}) {
  if (!schema || typeof schema !== 'object') {
    return {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false
    };
  }

  const normalized = deepClone(schema);
  addDefaultAdditionalProperties(normalized);
  return normalized;
}

export function compileToolValidator(toolName, schema = {}) {
  const normalizedSchema = normalizeInputSchema(schema);
  const validate = ajv.compile(normalizedSchema);

  return (params = {}) => {
    const value = params ?? {};
    if (!validate(value)) {
      throw new SchemaValidationError(
        `Invalid parameters for ${toolName}: ${formatAjvErrors(validate.errors)}`,
        validate.errors || []
      );
    }
  };
}

export function formatAjvErrors(errors = []) {
  if (!errors.length) {
    return 'schema validation failed';
  }

  return errors
    .map((error) => {
      const path = error.instancePath || error.schemaPath || '/';
      if (error.keyword === 'additionalProperties') {
        return `${path} must not include unknown property "${error.params.additionalProperty}"`;
      }
      if (error.keyword === 'required') {
        return `${path} must include required property "${error.params.missingProperty}"`;
      }
      return `${path} ${error.message}`;
    })
    .join('; ');
}

function addDefaultAdditionalProperties(schema) {
  if (!schema || typeof schema !== 'object') {
    return;
  }

  if (schema.type === 'object' && schema.additionalProperties === undefined) {
    schema.additionalProperties = false;
  }

  for (const key of ['properties', 'patternProperties', '$defs', 'definitions']) {
    if (schema[key] && typeof schema[key] === 'object') {
      for (const child of Object.values(schema[key])) {
        addDefaultAdditionalProperties(child);
      }
    }
  }

  for (const key of ['items', 'contains', 'not', 'if', 'then', 'else']) {
    if (schema[key]) {
      addDefaultAdditionalProperties(schema[key]);
    }
  }

  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    if (Array.isArray(schema[key])) {
      for (const child of schema[key]) {
        addDefaultAdditionalProperties(child);
      }
    }
  }
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}
