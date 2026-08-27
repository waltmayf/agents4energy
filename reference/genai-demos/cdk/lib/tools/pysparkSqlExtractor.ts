/**
 * Extracts SQL strings from `spark.sql(...)` calls in PySpark code.
 *
 * Supports single-quoted, double-quoted, triple-quoted, and f-string variants.
 * Returns the raw SQL template strings (f-string interpolation placeholders
 * like `{table}` are preserved as-is since we cannot resolve them at static
 * analysis time).
 */

/**
 * Regex that matches `spark.sql(...)` calls with various Python string literals:
 *   - f-string triple double-quoted: f\"""...\"""
 *   - f-string triple single-quoted: f'''...'''
 *   - f-string double-quoted: f"..."
 *   - f-string single-quoted: f'...'
 *   - triple double-quoted: \"""...\"""
 *   - triple single-quoted: '''...'''
 *   - double-quoted: "..."
 *   - single-quoted: '...'
 */
const SPARK_SQL_REGEX =
  /spark\.sql\(\s*(?:f?"""([\s\S]*?)"""|f?'''([\s\S]*?)'''|f?"([^"]*)"|f?'([^']*)')\s*\)/g;

/**
 * Extract all SQL statement strings from PySpark code containing
 * `spark.sql(...)` calls.
 *
 * @param code - PySpark source code to scan
 * @returns Array of extracted SQL strings (may be empty)
 */
export function extractSparkSqlStatements(code: string): string[] {
  if (!code) {
    return [];
  }

  const results: string[] = [];

  // Reset regex state for each call (global regexes are stateful)
  SPARK_SQL_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = SPARK_SQL_REGEX.exec(code)) !== null) {
    // Capture groups: 1=triple-double, 2=triple-single, 3=double, 4=single
    const sql = match[1] ?? match[2] ?? match[3] ?? match[4];
    if (sql !== undefined && sql.trim().length > 0) {
      results.push(sql.trim());
    }
  }

  return results;
}
