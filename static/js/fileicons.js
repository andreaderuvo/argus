// <imports> generated from what this file uses; edit the code, not this list
import { svg } from '/js/dom.js';
import { ICONS } from '/js/icons.js';
// </imports>
/* --------------------------------------------------------------- file icons */

// Colour by family, label by actual extension: `PDF` reads as a PDF at a glance, and an
// unknown `.fq` still gets a sensible badge instead of a generic blank sheet.
const FAMILIES = [
  [/^(pdf)$/, '#e5786d'],
  [/^(png|jpe?g|gif|webp|svg|bmp|tiff?|ico|heic|avif)$/, '#c78fd6'],
  [/^(py|rs|js|mjs|cjs|ts|tsx|jsx|go|c|h|cc|cpp|hpp|java|rb|sh|bash|zsh|pl|r|jl|lua|php|swift|kt)$/, '#8fd6a0'],
  [/^(csv|tsv|xlsx?|xlsm|parquet|json|jsonl|ndjson|db|sqlite3?|arrow|feather)$/, '#6fc7d6'],
  [/^(gz|bz2|xz|zst|zip|tar|tgz|7z|rar|lz4)$/, '#d6b46f'],
  [/^(fa|fasta|fq|fastq|vcf|bam|sam|cram|bed|gff|gtf|gbk|nwk|phy)$/, '#9fd66f'],
  [/^(mp3|wav|flac|ogg|m4a|mp4|mkv|mov|avi|webm)$/, '#d66fa8'],
  [/^(stl|step|stp)$/, '#e0a15a'],
  [/^(yaml|yml|toml|ini|cfg|conf|env|lock|nf|mk)$/, '#8a93a3'],
  [/^(md|txt|rst|log|out|err|tex|docx?|odt)$/, '#7aa2d6'],
];

function badge(name) {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  if (!ext || ext.length > 8) return { label: '', color: '#6b7484' };
  const family = FAMILIES.find(([re]) => re.test(ext));
  return { label: ext.slice(0, 4).toUpperCase(), color: family ? family[1] : '#6b7484' };
}

export function fileIcon(entry) {
  const stroke = { fill: 'none', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  if (entry.type === 'directory') {
    return svg('svg', { viewBox: '0 0 24 24', class: 'ficon' }, [
      svg('path', { d: ICONS.folder, stroke: '#7aa2d6', ...stroke }),
    ]);
  }
  const { label, color } = badge(entry.name);
  const kids = [svg('path', { d: ICONS.file, stroke: color, ...stroke })];
  if (label) {
    const t = svg('text', {
      x: '12', y: '17.6', 'text-anchor': 'middle', fill: color,
      'font-size': label.length > 3 ? '5.4' : '6.6', 'font-weight': '700',
      'font-family': 'ui-monospace, monospace',
    });
    t.textContent = label;
    kids.push(t);
  }
  return svg('svg', { viewBox: '0 0 24 24', class: 'ficon' }, kids);
}
