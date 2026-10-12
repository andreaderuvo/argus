/* Which icon a file name gets: Material Icon Theme's map (static/vendor/material-icon-theme-*),
 *  and Argus's own for the formats a genomics lab lives in, which that map does not know. A leaf:
 *  imports nothing, so it is tested in Node (tests/test_iconname.py).
 *
 *  A whole name first (Dockerfile, Makefile, README.md), then the extensions from the longest:
 *  `reads.fastq.gz` is a FASTQ before it is a gzip, and `x.tar.gz` an archive before a gzip.
 */


// Argus's own, in static/img/fileicons/: what Material has nothing for.
export const BIO = {
  sequence: ['fa', 'fasta', 'fna', 'faa', 'ffn', 'frn', 'fas', 'fastq', 'fq', 'seq', 'aln', 'clustal', 'sto', 'stockholm'],
  alignment: ['sam', 'bam', 'cram', 'bai', 'crai', 'csi', 'pileup', 'mpileup'],
  variants: ['vcf', 'bcf', 'gvcf', 'maf'],
  tree: ['nwk', 'newick', 'tre', 'tree', 'treefile', 'nex', 'nexus', 'phy', 'phylip', 'nhx'],
  annotation: ['gff', 'gff3', 'gtf', 'bed', 'bedgraph', 'bigwig', 'bw', 'gbk', 'gb', 'genbank', 'embl', 'gbff', 'wig'],
  pipeline: ['nf', 'smk', 'wdl', 'cwl'],
};
// Whole names, before Material's: a Snakefile is a pipeline, nextflow.config too.
const BIO_NAMES = { snakefile: 'pipeline', 'nextflow.config': 'pipeline' };
const BIO_EXT = Object.fromEntries(Object.entries(BIO).flatMap(([icon, exts]) => exts.map((e) => [e, icon])));
const PACKED = /\.(gz|bgz|bz2|xz|zst|lz4)$/;

/** `{set: 'material'|'bio', icon}` for a file name, or null when nothing fits. */
export function iconFor(name, map, light = false) {
  const lower = String(name || '').toLowerCase();
  if (!lower) return null;
  const pick = (table, key) => (light && map?.light?.[table]?.[key]) || map?.[table]?.[key];
  if (BIO_NAMES[lower]) return { set: 'bio', icon: BIO_NAMES[lower] };
  const whole = map && pick('names', lower);
  if (whole) return { set: 'material', icon: whole };
  const parts = lower.split('.');
  for (let i = 1; i < parts.length; i += 1) {
    const ext = parts.slice(i).join('.');
    if (BIO_EXT[ext]) return { set: 'bio', icon: BIO_EXT[ext] };
    const inner = ext.replace(PACKED, '');
    if (inner !== ext && BIO_EXT[inner]) return { set: 'bio', icon: BIO_EXT[inner] };
    const found = map && pick('ext', ext);
    if (found) return { set: 'material', icon: found };
  }
  return null;
}
