import * as fs from 'node:fs/promises'; // fixme remove
export async function dumpFile(label, tag, base = 'Storage', ) {
  const path = `${base}/MutableCollection/KeyRecovery/${tag}`;
  console.log(label, path, !!await fs.readFile(path, 'utf8').catch(() => ''));
}
