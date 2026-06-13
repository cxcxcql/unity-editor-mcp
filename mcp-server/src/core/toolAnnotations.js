const READ_ONLY_PREFIXES = [
  'get_',
  'list_',
  'find_',
  'read_',
  'analyze_',
  'validate_'
];

const READ_ONLY_TOOLS = new Set([
  'ping',
  'enhanced_read_logs',
  'get_editor_state',
  'get_hierarchy',
  'get_component_types'
]);

const MUTATING_PREFIXES = [
  'add_',
  'cancel_',
  'clear_',
  'click_',
  'create_',
  'delete_',
  'execute_',
  'exit_',
  'instantiate_',
  'load_',
  'modify_',
  'open_',
  'pause_',
  'play_',
  'refresh_',
  'remove_',
  'run_',
  'save_',
  'set_',
  'simulate_',
  'start_',
  'stop_',
  'update_',
  'wait_'
];

const DESTRUCTIVE_TOOLS = new Set([
  'clear_console',
  'delete_gameobject',
  'delete_script',
  'execute_menu_item',
  'remove_component'
]);

const CONSERVATIVE_MULTI_ACTION_TOOLS = new Set([
  'manage_asset_database',
  'manage_asset_import_settings',
  'manage_layers',
  'manage_selection',
  'manage_tags',
  'manage_tools',
  'manage_windows'
]);

export function inferToolAnnotations(toolName) {
  const isReadOnly =
    READ_ONLY_TOOLS.has(toolName) ||
    READ_ONLY_PREFIXES.some((prefix) => toolName.startsWith(prefix));

  const mutates =
    CONSERVATIVE_MULTI_ACTION_TOOLS.has(toolName) ||
    DESTRUCTIVE_TOOLS.has(toolName) ||
    MUTATING_PREFIXES.some((prefix) => toolName.startsWith(prefix));

  if (isReadOnly && !mutates) {
    return {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    };
  }

  return {
    readOnlyHint: false,
    destructiveHint: mutates,
    idempotentHint: false,
    openWorldHint: false
  };
}

export const GENERIC_OBJECT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true
};
