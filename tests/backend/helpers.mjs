import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export async function temporaryDirectory(t) {
  const root = resolve(tmpdir());
  const directory = await mkdtemp(join(root, 'hackalem-backend-test-'));
  t.after(async () => {
    const rel = relative(root, resolve(directory));
    if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || !rel.startsWith('hackalem-backend-test-')) {
      throw new Error('Refusing cleanup outside the generated test directory');
    }
    await rm(directory, {recursive:true, force:true});
  });
  return directory;
}
