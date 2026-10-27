import type { PageLine } from './TextPage.js';
import { wrapText } from './Detail.js';
import { LABEL_HELP } from './labels.js';

/** Full explanations stay accessible even when the terminal cannot fit the footer. */
export function helpLines(width: number): PageLine[] {
  const sections = [
    'Keyboard help',
    '↑↓ / j k — move between projects and caches',
    '→ / d — inspect directories, sizes and preset status',
    'space — select or deselect the focused row',
    'a — toggle section (projects, recent projects, or caches)',
    'p — switch preset: recommended / aggressive',
    'enter — review selection; enter again confirms cleanup',
    't — inspect and empty the whole system Trash',
    'esc / ← — back; q — quit; ? — this help',
    'In inspection/help: ↑↓ scroll, pgup/pgdn page, g/G top/end.',
    '',
    'What the labels mean',
    `slow rebuild — ${LABEL_HELP.slow}`,
    `rebuild offline — ${LABEL_HELP.offline}`,
    `downloads needed — ${LABEL_HELP.network}`,
    `uncommitted changes — ${LABEL_HELP.uncommitted}`,
    `linked worktree — ${LABEL_HELP.worktree}`,
    '',
    'Recommended includes build output and caches. Aggressive also includes dependencies.',
    'Inspection shows candidates from the scan, not an approval. Confirmation checks each path before cleanup.',
    'Moving files to Trash does not free disk space until Trash is emptied.',
  ];
  return sections.flatMap((text, index) => text === '' ? [{ text: ' ' }] :
    wrapText(text, width).map(line => ({ text: line, bold: index === 0 || text === 'What the labels mean' })));
}
