import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Read a .py file from the python/ directory and replace template placeholders.
 *
 * Placeholders use the `{{KEY}}` syntax. The replacements map provides the
 * concrete values that are only known at runtime (env vars, session prefix, etc.).
 */
export function loadPythonScript(
    filename: string,
    replacements: Record<string, string> = {},
): string {
    const filePath = join(__dirname, filename);
    let content = readFileSync(filePath, 'utf-8');
    for (const [key, value] of Object.entries(replacements)) {
        content = content.replaceAll(`{{${key}}}`, value);
    }
    return content;
}
