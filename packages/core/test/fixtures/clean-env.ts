/** A Godmode run sets these for its own Claude Code. Tests started inside one must behave as they do in a clean shell. */
for (const key of ["DISABLE_AUTOUPDATER", "OMC_SKIP_HOOKS", "CLAUDE_CODE_PLUGIN_DIR_WATCH", "CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD"]) {
  delete process.env[key];
}
