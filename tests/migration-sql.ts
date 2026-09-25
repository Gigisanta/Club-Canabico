/** Split migration SQL without breaking PL/pgSQL bodies or quoted literals. */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let dollarTag: string | null = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    const next = sql[i + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") { blockComment = false; i++; }
      continue;
    }
    if (dollarTag) {
      if (sql.startsWith(dollarTag, i)) { i += dollarTag.length - 1; dollarTag = null; }
      continue;
    }
    if (quote) {
      if (char === quote && next === quote) { i++; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "-" && next === "-") { lineComment = true; i++; continue; }
    if (char === "/" && next === "*") { blockComment = true; i++; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (char === "$") {
      const match = /^\$[A-Za-z_][A-Za-z_0-9]*\$|^\$\$/.exec(sql.slice(i));
      if (match) { dollarTag = match[0]; i += dollarTag.length - 1; continue; }
    }
    if (char === ";") {
      const statement = sql.slice(start, i).trim();
      if (statement) statements.push(statement);
      start = i + 1;
    }
  }
  const tail = sql.slice(start).trim();
  if (tail) statements.push(tail);
  return statements;
}
