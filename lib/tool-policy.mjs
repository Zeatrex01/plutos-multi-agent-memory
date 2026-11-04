// MCP tool access policy — one table, applied at dispatch.
//
// A new mutating tool is guarded by default: unknown names are 'mutate'. Forgetting to
// classify a writer must not reopen the "globally registered server writes into ~/ " hole.
// Read / setup / diagnostic tools are the explicit exceptions.
export const TOOL_ACCESS = {
    init_roadmap: 'setup',
    plutos_project_info: 'diagnostic',
    board_read: 'read',
    plutos_context_for_task: 'read',
    plutos_code_lookup: 'read',
    plutos_usage: 'read',
    plutos_modules: 'drawer',
    roster_read: 'read',
    plutos_system_status: 'read',
    status_report: 'read',
    project_deck: 'read',
    research_read: 'read'
};

export function toolAccess(toolName) {
    return TOOL_ACCESS[toolName] || 'mutate';
}

export function requiresProject(toolName, args = {}) {
    const access = toolAccess(toolName);
    if (access === 'mutate') return true;
    // Listing drawers reads; opening or closing one writes .plutos/drawers.json.
    if (access === 'drawer') return args?.action === 'open' || args?.action === 'close';
    return false;
}

// Binding is a different question from write permission. Reads and setup also need to know
// they are looking at the active repository; otherwise an old global MCP can return another
// project's board or initialize the wrong directory without ever reaching the write marker.
export function requiresProjectBinding(toolName) {
    return toolAccess(toolName) !== 'diagnostic';
}
