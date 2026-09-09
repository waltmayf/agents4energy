import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Read a .py file from the sibling python/ directory and replace template
 * placeholders. Placeholders use `{{KEY}}` syntax; the replacements map
 * provides concrete values only known at runtime (env vars, artifacts
 * prefix, etc.). Ported from
 * reference/genai-demos/cdk/lib/tools/python/loadScript.ts.
 *
 * The python/ directory is copied alongside the bundled handler at build
 * time (see the NodejsFunction bundling.commandHooks in backend.ts) so
 * __dirname here resolves correctly both in source and in the deployed
 * bundle.
 */
export function loadPythonScript(
  filename: string,
  replacements: Record<string, string> = {},
): string {
  const filePath = join(__dirname, 'python', filename);
  let content = readFileSync(filePath, 'utf-8');
  for (const [key, value] of Object.entries(replacements)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }
  return content;
}
