import { readFile } from 'node:fs/promises';
import { DEFAULT_OPENAI_MODEL } from './openai.mjs';

// Only the CLI loads this configuration. Test application factories never read real credentials.
export async function loadAIConfig({filePath, env = process.env} = {}) {
  const values = {};
  if (filePath) {
    let source = '';
    try { source = await readFile(filePath, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot read local AI configuration'); }
    for (const line of source.replace(/^\uFEFF/,'').split(/\r?\n/)) {
      const match = /^\s*(OPENAI_API_KEY|OPENAI_MODEL)\s*=\s*(.*?)\s*$/.exec(line);
      if (!match) continue;
      let value = match[2];
      if (value.startsWith('"') || value.startsWith("'")) {
        const quote = value[0];
        const end = value.indexOf(quote,1);
        if (end < 0 || !/^\s*(#.*)?$/.test(value.slice(end+1))) throw new Error('Invalid local AI configuration');
        value = value.slice(1,end);
      } else value = value.replace(/\s+#.*$/,'').trim();
      values[match[1]] = value;
    }
  }
  return {
    apiKey: String(env.OPENAI_API_KEY ?? values.OPENAI_API_KEY ?? '').trim(),
    model: String(env.OPENAI_MODEL ?? values.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL).trim() || DEFAULT_OPENAI_MODEL,
  };
}
