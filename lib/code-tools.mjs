// The code drawer (lib/drawers.mjs): two tools over data PLUT_OS already keeps, so a project
// does not need an external server for them.
// plutos_code_lookup answers "where is this, what
// does it use, what uses it" from the code graph and its declared symbols (lib/task-context.mjs,
// the index plutos_context_for_task already builds); plutos_usage reads the local Claude Code
// token ledger (lib/usage.mjs). Both only read. File-level, not call-level: who calls one
// function is beyond the scan, and the answer says so rather than guessing.
import { codeIndex } from './task-context.mjs';
import { readTokenUsage } from './usage.mjs';

export const CODE_TOOLS = [
  {
    name: "plutos_code_lookup",
    description: "PLUT_OS: Find a file or a declared symbol in this project's code and list what each match imports and what imports it. File-level, from the local code graph; nothing leaves the machine.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "A symbol name (exact, any case) or part of a file path, e.g. 'readBoard' or 'lib/board'." },
        limit: { type: "number", description: "Most matches to return (default 6, at most 20)." }
      },
      required: ["query"]
    }
  },
  {
    name: "plutos_usage",
    description: "PLUT_OS, Claude Code only: token use of this project's sessions on this computer (totals, the costliest sessions and models), read from local transcripts.",
    inputSchema: { type: "object", properties: {}, required: [] }
  }
];

const cap = (list, n) => list.length > n ? [...list.slice(0, n), `… ${list.length - n} more`] : list;

// → { matches: [{ file, via, symbols, uses, usedBy }], fileCount }
export function codeLookup(root, query, { limit = 6 } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('query is required.');
  const max = Math.min(Math.max(Number(limit) || 6, 1), 20);
  const index = codeIndex(root);
  const found = new Map();
  for (const file of index.declaredBy.get(q) || index.declaredByLower.get(q.toLowerCase()) || []) found.set(file, `declares ${q}`);
  // Path matches nearest first: the file itself (with or without its extension), then a file
  // whose name starts with the query, then any path containing it, shortest first.
  const needle = q.toLowerCase().replace(/\\/g, '/');
  const rankPath = f => { const l = f.toLowerCase(), bare = l.replace(/\.[^./]+$/, '');
    return l === needle || bare === needle || bare.endsWith('/' + needle) ? 0 : l.split('/').pop().startsWith(needle.split('/').pop()) ? 1 : 2; };
  const byPath = index.files.filter(f => !found.has(f) && f.toLowerCase().includes(needle))
    .sort((a, b) => rankPath(a) - rankPath(b) || a.length - b.length);
  for (const file of byPath) { if (found.size >= max) break; found.set(file, 'path'); }
  const matches = [...found].slice(0, max).map(([file, via]) => ({
    file, via,
    symbols: cap(index.symbolsOf.get(file) || [], 12),
    uses: cap([...(index.deps.get(file) || [])].sort(), 10),
    usedBy: cap([...(index.users.get(file) || [])].sort(), 10)
  }));
  return { matches, fileCount: index.fileCount };
}

export function formatCodeLookup(query, result) {
  if (!result.matches.length) return `No file or declared symbol matches "${query}" in ${result.fileCount} scanned files. Try part of a path, or plutos_context_for_task with the task in words.`;
  const lines = [`${result.matches.length} match(es) for "${query}" (file-level; who calls a single function is not tracked):`];
  for (const m of result.matches) {
    lines.push(`- ${m.file} (${m.via})`);
    if (m.symbols.length) lines.push(`  declares: ${m.symbols.join(', ')}`);
    lines.push(`  uses: ${m.uses.join(', ') || 'nothing in this project'}`);
    lines.push(`  used by: ${m.usedBy.join(', ') || 'nothing in this project'}`);
  }
  return lines.join('\n');
}

const work = t => (t.output || 0) + (t.thinking || 0);
const fmt = n => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n);

export function usageSummary(root) {
  const u = readTokenUsage(root, { onlyProject: true });
  if (!u.available) return 'No Claude Code transcripts on this computer, so there is nothing to count.';
  const project = u.projects.find(p => p.current);
  if (!project) return 'No Claude Code session for this project on this computer.';
  const sessions = u.sessions.filter(s => s.project === project.name).slice(0, 5);
  const lines = [
    `This project's Claude Code sessions on this computer: ${fmt(work(project))} output+thinking tokens, ${fmt(project.input || 0)} input, ${fmt(project.cacheRead || 0)} cache reads, ${project.calls || 0} calls.`,
    ...(sessions.length ? ['Costliest sessions:', ...sessions.map(s => `- ${s.id.slice(0, 8)} ${String(s.started).slice(0, 10)}: ${fmt(work(s))}`)] : []),
    `Models on this computer: ${u.models.slice(0, 4).map(m => `${m.name} ${fmt(work(m))}`).join(', ') || 'none'}.`,
    'Other AI tools are not counted.' + (u.truncated ? ' Some transcripts were too large to read.' : '')
  ];
  return lines.join('\n');
}
