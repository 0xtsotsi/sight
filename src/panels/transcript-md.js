// src/panels/transcript-md.js
//
// Markdown serializer for the agent chat transcript. Pure module — no
// React, no DOM. Call site passes the turn list and the format is
// stable across versions. The output is GitHub-Flavored Markdown so
// it pastes cleanly into PRs and changelogs.

const ROLE_LABEL = { user: 'User', assistant: 'Assistant' };

export function turnsToMarkdown(turns) {
  if (!Array.isArray(turns)) return '';
  const out = [];
  for (const t of turns) {
    const role = ROLE_LABEL[t.role] || t.role || 'unknown';
    const ts = t.ts ? new Date(t.ts).toISOString() : '';
    out.push(`## ${role} ${ts ? '— ' + ts : ''}`);
    out.push('');
    const content = String(t.content || '').trim();
    if (content) out.push(content);
    if (Array.isArray(t.events)) {
      for (const e of t.events) {
        if (!e) continue;
        switch (e.type) {
          case 'thinking':
            if (e.delta) {
              out.push('');
              out.push('_thinking:_');
              out.push('');
              out.push('> ' + String(e.delta).replace(/\n/g, '\n> '));
            }
            break;
          case 'tool':
            out.push('');
            out.push(`- **tool** ${e.name || ''}${e.status ? ' (' + e.status + ')' : ''}${e.durationMs ? ' — ' + e.durationMs + 'ms' : ''}`);
            if (e.args !== undefined) {
              out.push('  ```json');
              out.push('  ' + JSON.stringify(e.args, null, 2).replace(/\n/g, '\n  '));
              out.push('  ```');
            }
            break;
          case 'diff':
            out.push('');
            out.push('- **diff** ' + (e.summary || e.path || ''));
            if (e.unifiedDiff) {
              out.push('  ```diff');
              out.push('  ' + String(e.unifiedDiff).replace(/\n/g, '\n  '));
              out.push('  ```');
            }
            break;
          case 'media':
            out.push('');
            out.push(`- **media** ${e.kind || ''} ${e.attribution || ''}`);
            break;
          case 'visual_direction':
            out.push('');
            out.push(`- **visual direction** ${e.directionId || ''}${e.status ? ' (' + e.status + ')' : ''}`);
            break;
          default:
            break;
        }
      }
    }
    out.push('');
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
