// src/agent/systemPrompt.js
//
// Builds the system prompt the agent receives at the start of every turn.
// Includes the project path, the current page model (when includePage is
// on), and the selected node (when includeSelection is on). The tool list
// is described inline so the agent knows the diff-only write contract.
//
// The prompt is intentionally short — long prompts eat tokens and the
// model already knows how to write Astro. We describe the contract, not
// the language.
//
// Snapshot shape (from AgentPanel):
//   {
//     projectPath: string,
//     selectedNodeId: string | null,
//     activePagePath: string | null,
//     pageModel: { imports, nodes, ... } | null,
//   }

const TOOL_DESCRIPTIONS = `
You have access to these tools — use them in this order:
  1. list_pages   — survey the project
  2. read_page    — read a specific page's full AST
  3. read_cms     — read a JSON content file
  4. scan_project — refresh the project tree after edits
  5. apply_page_diff — propose an edit to a page (DOES NOT WRITE TO DISK)

CRITICAL: apply_page_diff is the ONLY way to change a page. It returns a
diff for the user to review in the Sight UI. They will click "Apply" to
accept or "Reject" to discard. Never call any direct write tool — none
exists in your toolset. The user is in the loop; your job is to propose
changes, not to commit them.

For each proposed edit:
  - path: the absolute .astro path you're editing
  - beforeJson: the FULL page model as you received it (or as returned
    by read_page). The UI uses this to compute the diff.
  - afterJson: the FULL page model with your edit applied. Must include
    the same imports / extraFrontmatter / nodes shape.
  - summary: one short sentence (<= 280 chars) describing the change.

If the user only asks a question, don't call any tools — just answer.
`;

/**
 * @param {object} snapshot — per-call context from AgentPanel
 * @param {string} [extra]  — optional appended text (e.g. CMS snapshot JSON)
 * @returns {string}
 */
export function buildSystemPrompt(snapshot, extra = '') {
  const lines = [
    'You are the AI agent inside Sight — a visual builder for Astro projects.',
    'You help the user edit pages by proposing structured diffs they review and apply.',
    '',
    'Project: ' + (snapshot?.projectPath || '(none)'),
  ];

  if (snapshot?.activePagePath) {
    lines.push('Active page: ' + snapshot.activePagePath);
  }

  if (snapshot?.selectedNodeId) {
    lines.push('Selected node id: ' + snapshot.selectedNodeId);
  }

  if (snapshot?.pageModel) {
    lines.push('');
    lines.push('Current page model (JSON):');
    lines.push('```json');
    lines.push(JSON.stringify(snapshot.pageModel, null, 2));
    lines.push('```');
    lines.push('');
    lines.push('When you propose an edit, include the FULL updated model in afterJson — same shape, your changes applied.');
  }

  lines.push('');
  lines.push(TOOL_DESCRIPTIONS);

  if (extra) {
    lines.push('');
    lines.push(extra);
  }

  return lines.join('\n');
}
