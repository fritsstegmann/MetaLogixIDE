/**
 * The one extension-to-language mapping shared by the Files tab and the Diff tab (spec AC37). A language is returned
 * only when `highlight.js/lib/common` has it, so an unknown or missing extension (and Dockerfile, which the common
 * bundle lacks) gives `''`, which callers treat as plain text.
 */
import hljs from 'highlight.js/lib/common';

const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', swift: 'swift',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  json: 'json', jsonc: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini',
  html: 'xml', xml: 'xml', css: 'css', scss: 'scss',
  sql: 'sql', dockerfile: 'dockerfile',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
};

/** The highlight.js language for `path`'s file extension (case-insensitive), or `''` for plain text. */
export function langForPath(path: string): string {
  const dot = path.lastIndexOf('.');
  const lang = dot === -1 ? '' : EXT_TO_LANG[path.slice(dot + 1).toLowerCase()] ?? '';
  return lang && hljs.getLanguage(lang) ? lang : '';
}
