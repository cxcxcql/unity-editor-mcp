import { compileToolValidator, normalizeInputSchema, SchemaValidationError } from '../../core/schemaValidation.js';
import { GENERIC_OBJECT_OUTPUT_SCHEMA, inferToolAnnotations } from '../../core/toolAnnotations.js';

/**
 * Base class for all tool handlers.
 * Each subclass owns its MCP metadata and Unity execution behavior.
 */
export class BaseToolHandler {
  constructor(name, description, inputSchema = {}, options = {}) {
    this.name = name;
    this.description = description;
    this.inputSchema = normalizeInputSchema(inputSchema);
    this.outputSchema = options.outputSchema || GENERIC_OBJECT_OUTPUT_SCHEMA;
    this.annotations = options.annotations || inferToolAnnotations(name);
    this.validateInputSchema = compileToolValidator(name, this.inputSchema);
  }

  /**
   * Validates the input parameters against the schema
   * Override this method for custom validation
   * @param {object} params - Input parameters
   * @throws {Error} If validation fails
   */
  validate(params) {
    // Basic validation - check required fields from schema
    if (this.inputSchema.required) {
      for (const field of this.inputSchema.required) {
        if (params[field] === undefined || params[field] === null) {
          throw new Error(`Missing required parameter: ${field}`);
        }
      }
    }
  }

  /**
   * Executes the tool logic
   * Must be implemented by subclasses
   * @param {object} params - Validated input parameters
   * @param {object} context - MCP request context
   * @returns {Promise<object>} Tool result
   */
  async execute(params, context) {
    throw new Error('execute() must be implemented by subclass');
  }

  /**
   * Main handler method that orchestrates validation and execution
   * @param {object} params - Input parameters
   * @param {object} context - MCP request context
   * @returns {Promise<object>} Standardized response
   */
  async handle(params = {}, context = {}) {
    const safeParams = params ?? {};
    try {
      this.validate(safeParams);
      this.validateInputSchema(safeParams);

      const result = await this.execute(safeParams, context);

      return {
        status: 'success',
        result: this.normalizeExecutionResult(result)
      };
    } catch (error) {
      return {
        status: 'error',
        error: error.message,
        code: error.code || 'TOOL_ERROR',
        details: {
          tool: this.name,
          params: this.summarizeParams(safeParams),
          ...(error.details && typeof error.details === 'object' ? error.details : {}),
          validation: error instanceof SchemaValidationError ? error.errors : undefined,
          stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        }
      };
    }
  }

  /**
   * Summarizes parameters for error reporting
   * @param {object} params - Parameters to summarize
   * @returns {string} Summary string
   */
  summarizeParams(params) {
    if (!params || typeof params !== 'object') {
      return 'No parameters';
    }

    const entries = Object.entries(params);
    if (entries.length === 0) {
      return 'Empty parameters';
    }

    return entries
      .map(([key, value]) => {
        let valueStr = '';
        if (value === null) {
          valueStr = 'null';
        } else if (value === undefined) {
          valueStr = 'undefined';
        } else if (typeof value === 'string') {
          // Truncate long strings
          valueStr = value.length > 50 ? `"${value.substring(0, 47)}..."` : `"${value}"`;
        } else if (typeof value === 'object') {
          valueStr = Array.isArray(value) ? `[Array(${value.length})]` : '[Object]';
        } else {
          valueStr = String(value);
        }
        return `${key}: ${valueStr}`;
      })
      .join(', ');
  }

  normalizeExecutionResult(result) {
    if (
      result &&
      typeof result === 'object' &&
      result.isError === true &&
      Array.isArray(result.content)
    ) {
      const error = new Error(result.content[0]?.text || 'Tool execution failed');
      error.code = result.structuredContent?.code || 'TOOL_ERROR';
      throw error;
    }

    if (
      result &&
      typeof result === 'object' &&
      Array.isArray(result.content) &&
      result.structuredContent !== undefined
    ) {
      return result.structuredContent;
    }

    return result;
  }

  /**
   * Returns the tool definition for MCP
   * @returns {object} Tool definition
   */
  getDefinition() {
    return {
      name: this.name,
      description: this.description,
      inputSchema: this.inputSchema,
      outputSchema: this.outputSchema,
      annotations: this.annotations
    };
  }
}
