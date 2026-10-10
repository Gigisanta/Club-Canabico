import { createHash } from "node:crypto";
import { canonicalJson } from "../../shared/operations/exact.js";
import {
  APPSHEET_DEFINITION_CATEGORIES,
  APPSHEET_DEFINITION_COUNT_KEYS,
  APPSHEET_DEFINITION_PARSER_VERSION,
  APPSHEET_DEFINITION_SCHEMA_VERSION,
  appSheetDefinitionInventorySchema,
  type AppSheetDefinitionCategory,
  type AppSheetDefinitionCoverage,
  type AppSheetDefinitionEvidence,
  type AppSheetDefinitionField,
  type AppSheetDefinitionIdentity,
  type AppSheetDefinitionInventory,
  type AppSheetDefinitionRecord,
  type AppSheetDefinitionSection,
  type AppSheetDefinitionCounts,
  type AppSheetDefinitionCountKey,
  type AppSheetDefinitionPosition,
} from "../../shared/operations/appsheet-definition.js";
import { containsRecognizableCredential, isCredentialBearingHeader } from "./legacy-reader.js";

const MAX_HTML_BYTES = 24 * 1024 * 1024;
const MAX_NODES = 1_000_000;
const MAX_DEPTH = 256;
const MAX_TEXT_FIELD = 64_000;
const MAX_EVIDENCE = 250_000;
const MAX_SECTIONS = 10_000;
const MAX_RECORDS = 100_000;
const HASH = /^[a-f0-9]{64}$/;

type HtmlNode = HtmlElement | HtmlText;
interface HtmlElement {
  kind: "element";
  tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
  parent: HtmlElement | null;
  offset: number;
}
interface HtmlText {
  kind: "text";
  value: string;
  parent: HtmlElement;
  offset: number;
}
interface PendingEvidence {
  kind: AppSheetDefinitionEvidence["kind"];
  sectionPath: string[];
  offset: number;
  label: string | null;
}
interface ParsedProperties {
  fields: AppSheetDefinitionField[];
  redactedFieldCount: number;
  ambiguousFieldCount: number;
  warnings: string[];
}

export class AppSheetDefinitionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "AppSheetDefinitionError";
  }
}

function fail(code: string): never {
  throw new AppSheetDefinitionError(code);
}

const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const ignoredSubtreeTags = new Set(["script", "style", "template", "noscript", "iframe", "svg"]);
const blockTags = new Set(["address", "article", "aside", "blockquote", "dd", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "section", "table", "tr", "ul"]);
const headingTag = /^h[1-6]$/;

const entities: Record<string, string> = {
  amp: "&", apos: "'", gt: ">", lt: "<", nbsp: "\u00a0", quot: '"',
  copy: "\u00a9", mdash: "\u2014", ndash: "\u2013", hellip: "\u2026", rsquo: "\u2019", lsquo: "\u2018", rdquo: "\u201d", ldquo: "\u201c",
};

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#(?:x[0-9a-f]+|[0-9]+)|[a-z][a-z0-9]+);?/gi, (whole, entity: string) => {
    if (entity[0] === "#") {
      const hex = entity[1]?.toLowerCase() === "x";
      const numeric = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(numeric) || numeric <= 0 || numeric > 0x10ffff || (numeric >= 0xd800 && numeric <= 0xdfff)) return "\ufffd";
      return String.fromCodePoint(numeric);
    }
    return entities[entity.toLowerCase()] ?? whole;
  });
}

function tagEnd(source: string, start: number): number {
  let quote = "";
  let unquotedValue = false;
  let afterEquals = false;
  for (let index = start; index < source.length; index++) {
    const character = source[index]!;
    if (quote) {
      if (character === quote) quote = "";
      continue;
    }
    if (unquotedValue) {
      if (character === ">") return index;
      if (/\s/.test(character)) unquotedValue = false;
      continue;
    }
    if (afterEquals) {
      if (/\s/.test(character)) continue;
      afterEquals = false;
      if (character === "\"" || character === "'") quote = character;
      else if (character === ">") return index;
      else unquotedValue = true;
      continue;
    }
    if (character === ">") return index;
    if (character === "=") afterEquals = true;
  }
  return -1;
}

function declarationEnd(source: string, start: number): number {
  let quote = "";
  for (let index = start; index < source.length; index++) {
    const character = source[index]!;
    if (quote) {
      if (character === quote) quote = "";
    } else if (character === "\"" || character === "'") quote = character;
    else if (character === ">") return index;
  }
  return -1;
}

function plausibleTagStart(source: string, start: number): boolean {
  let index = start + 1;
  if (source[index] === "/") {
    index++;
  }
  // HTML tag names start immediately after `<` or `</`; accepting intervening
  // whitespace makes an unescaped comparison such as `< value` consume markup.
  if (!/[a-z]/i.test(source[index] ?? "")) return false;
  index++;
  while (index < source.length && /[a-z0-9:-]/i.test(source[index]!)) index++;
  return /[\s/>]/.test(source[index] ?? "");
}

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = Object.create(null) as Record<string, string>;
  let index = 0;
  while (index < source.length && !/\s/.test(source[index]!)) index++;
  while (index < source.length) {
    while (index < source.length && /[\s/]/.test(source[index]!)) index++;
    if (index >= source.length) break;
    const nameStart = index;
    while (index < source.length && !/[\s=/>]/.test(source[index]!)) index++;
    if (index === nameStart) { index++; continue; }
    const name = source.slice(nameStart, index).toLowerCase();
    while (index < source.length && /\s/.test(source[index]!)) index++;
    let value = "";
    if (source[index] === "=") {
      index++;
      while (index < source.length && /\s/.test(source[index]!)) index++;
      const quote = source[index] === "\"" || source[index] === "'" ? source[index++]! : "";
      const valueStart = index;
      if (quote) {
        while (index < source.length && source[index] !== quote) index++;
        value = source.slice(valueStart, index);
        if (source[index] === quote) index++;
      } else {
        while (index < source.length && !/[\s>]/.test(source[index]!)) index++;
        value = source.slice(valueStart, index);
      }
    }
    if (!(name in attrs)) attrs[name] = decodeHtmlEntities(value);
  }
  return attrs;
}

function parseHtml(source: string): HtmlElement {
  const root: HtmlElement = { kind: "element", tag: "#document", attrs: Object.create(null) as Record<string, string>, children: [], parent: null, offset: 0 };
  const stack: HtmlElement[] = [root];
  let nodes = 1;
  let index = 0;
  const appendText = (start: number, end: number) => {
    if (end <= start) return;
    if (++nodes > MAX_NODES) fail("html_node_limit_exceeded");
    const parent = stack[stack.length - 1]!;
    parent.children.push({ kind: "text", value: decodeHtmlEntities(source.slice(start, end)), parent, offset: start });
  };

  while (index < source.length) {
    const start = source.indexOf("<", index);
    if (start < 0) { appendText(index, source.length); break; }
    appendText(index, start);
    if (source.startsWith("<!--", start)) {
      const close = source.indexOf("-->", start + 4);
      index = close < 0 ? source.length : close + 3;
      continue;
    }
    if (/^<!|^<\?/.test(source.slice(start, start + 2))) {
      const end = declarationEnd(source, start + 2);
      index = end < 0 ? source.length : end + 1;
      continue;
    }
    // A literal `<` in a formula or description is text unless it begins a
    // syntactically plausible tag. Searching forward for `>` first would eat
    // all intervening markup (and silently truncate the inventory).
    if (!plausibleTagStart(source, start)) {
      appendText(start, start + 1);
      index = start + 1;
      continue;
    }
    const end = tagEnd(source, start + 1);
    if (end < 0) { appendText(start, source.length); break; }
    const raw = source.slice(start + 1, end);
    const closing = /^\s*\//.test(raw);
    const tagMatch = /^\s*\/?\s*([a-z][a-z0-9:-]*)/i.exec(raw);
    if (!tagMatch) {
      appendText(start, end + 1);
      index = end + 1;
      continue;
    }
    const tag = tagMatch[1]!.toLowerCase();
    if (closing) {
      for (let cursor = stack.length - 1; cursor > 0; cursor--) {
        if (stack[cursor]!.tag === tag) { stack.length = cursor; break; }
      }
      index = end + 1;
      continue;
    }
    if (["p", "li", "dt", "dd", "tr", "td", "th"].includes(tag)) {
      const closeSet = tag === "td" || tag === "th" ? new Set(["td", "th"]) : new Set([tag]);
      for (let cursor = stack.length - 1; cursor > 0; cursor--) {
        if (closeSet.has(stack[cursor]!.tag)) { stack.length = cursor; break; }
        if (["table", "ul", "ol", "dl", "body"].includes(stack[cursor]!.tag)) break;
      }
    }
    const parent = stack[stack.length - 1]!;
    const node: HtmlElement = {
      kind: "element", tag, attrs: parseAttributes(raw.slice(tagMatch[0].length)), children: [],
      parent, offset: start,
    };
    parent.children.push(node);
    if (++nodes > MAX_NODES) fail("html_node_limit_exceeded");
    index = end + 1;
    if (ignoredSubtreeTags.has(tag)) {
      const closingPattern = new RegExp(`<\\/\\s*${tag}\\s*>`, "ig");
      closingPattern.lastIndex = index;
      const close = closingPattern.exec(source);
      index = close ? closingPattern.lastIndex : source.length;
      continue;
    }
    if (!voidTags.has(tag) && !/\/\s*$/.test(raw)) {
      stack.push(node);
      if (stack.length > MAX_DEPTH) fail("html_depth_limit_exceeded");
    }
  }
  return root;
}

function inspectable(element: HtmlElement): boolean {
  for (let current: HtmlElement | null = element; current; current = current.parent)
    if (ignoredSubtreeTags.has(current.tag)) return false;
  return true;
}

function rawTextContent(node: HtmlNode): string {
  if (node.kind === "text") return node.value;
  if (!inspectable(node) && node.tag !== "#document") return "";
  return node.children.map((child) => child.kind === "element" && child.tag === "br" ? "\n" : rawTextContent(child)).join("");
}

function normalizedText(node: HtmlNode): string {
  if (node.kind === "text") return node.value;
  if (!inspectable(node) && node.tag !== "#document") return "";
  const values = node.children.map((child) => child.kind === "element" && child.tag === "br" ? " " : normalizedText(child));
  return values.join(blockTags.has(node.tag) ? " " : "").replace(/\s+/g, " ").trim();
}

function walk(root: HtmlNode): HtmlElement[] {
  const output: HtmlElement[] = [];
  const stack: HtmlNode[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.kind !== "element") continue;
    output.push(node);
    for (let index = node.children.length - 1; index >= 0; index--) stack.push(node.children[index]!);
  }
  return output;
}

function directElements(node: HtmlElement): HtmlElement[] {
  return node.children.filter((child): child is HtmlElement => child.kind === "element" && inspectable(child));
}

function descendantsOfType(node: HtmlElement, tag: string, stopAtTables = false): HtmlElement[] {
  const output: HtmlElement[] = [];
  const stack = [...node.children].reverse();
  while (stack.length) {
    const current = stack.pop()!;
    if (current.kind !== "element" || !inspectable(current)) continue;
    if (current.tag === tag) output.push(current);
    if (stopAtTables && current.tag === "table" && current !== node) continue;
    for (let index = current.children.length - 1; index >= 0; index--) stack.push(current.children[index]!);
  }
  return output;
}

function nextElementSibling(node: HtmlElement): HtmlElement | null {
  if (!node.parent) return null;
  const siblings = directElements(node.parent);
  const index = siblings.indexOf(node);
  return index < 0 ? null : siblings[index + 1] ?? null;
}

function linePosition(source: string, offset: number, lineStarts: number[]): AppSheetDefinitionPosition {
  let low = 0;
  let high = lineStarts.length;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (lineStarts[middle]! <= offset) low = middle;
    else high = middle;
  }
  return { offset, line: low + 1, column: offset - lineStarts[low]! + 1 };
}

function normalizeLabel(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const semanticFields: Array<[RegExp, string]> = [
  [/^app formula$/, "appFormula"], [/^(?:initial value|initialvalue)$/, "initialValue"],
  [/^(?:spreadsheet formula|sheet formula)$/, "spreadsheetFormula"],
  [/^(?:valid if|valid if expression|valid if formula|valid if condition)$/, "validIf"],
  [/^(?:show if|show if expression)$/, "showIf"],
  [/^(?:editable if|edit if)$/, "editableIf"], [/^(?:reset if|reset if expression)$/, "resetIf"],
  [/^(?:required if|required if expression)$/, "requiredIf"],
  [/^(?:error message if invalid|error message if invalid expression)$/, "invalidMessageIfInvalid"],
  [/^(?:suggested values|suggested values expression)$/, "suggestedValues"],
  [/^(?:reset on edit|reset on edit enabled)$/, "resetOnEdit"], [/^editable initial value$/, "editableInitialValue"],
  [/^(?:is a key|key|key column)$/, "key"], [/^(?:part of key|part of key column)$/, "partOfKey"],
  [/^(?:virtual column|is virtual|virtual)$/, "virtual"],
  [/^(?:is a ref|ref|reference|referenced table|referenced table name)$/, "reference"],
  [/^(?:referenced key column)$/, "referenceKey"], [/^(?:referenced type)$/, "referenceType"],
  [/^(?:security filter)$/, "securityFilter"], [/^(?:row filter condition)$/, "rowFilterCondition"],
  [/^(?:column name)$/, "columnName"], [/^(?:field name)$/, "fieldName"], [/^(?:schema name)$/, "schemaName"],
  [/^(?:table name)$/, "tableName"], [/^(?:slice name)$/, "sliceName"], [/^(?:view name)$/, "viewName"],
  [/^(?:action name)$/, "actionName"], [/^(?:rule name)$/, "ruleName"], [/^(?:name)$/, "name"],
  [/^(?:type|column type|view type|action type)$/, "type"], [/^(?:type qualifier)$/, "typeQualifier"],
  [/^(?:display name|display label)$/, "displayName"], [/^(?:source|data source|source table)$/, "source"],
  [/^(?:description|help text)$/, "description"], [/^(?:source path)$/, "sourcePath"], [/^(?:event|event source)$/, "event"],
  [/^(?:process|process name)$/, "process"], [/^(?:condition|only if this condition is true)$/, "condition"],
  [/^(?:template|template file)$/, "template"], [/^(?:deployment status|status)$/, "status"],
];

function semanticKey(label: string): string | null {
  const normalized = normalizeLabel(label);
  return semanticFields.find(([pattern]) => pattern.test(normalized))?.[1] ?? null;
}

function safeIdentifier(value: string, placeholder = "[excluded private identifier]"): string {
  return containsRecognizableCredential(value) ? placeholder : value;
}

function countKey(label: string): AppSheetDefinitionCountKey | null {
  const normalized = normalizeLabel(label);
  if (/^tables?$/.test(normalized)) return "tables";
  if (/^columns?$/.test(normalized)) return "columns";
  if (/^slices?$/.test(normalized)) return "slices";
  if (/^views?$/.test(normalized)) return "views";
  if (/^(?:format rules?|formatting rules?)$/.test(normalized)) return "formatRules";
  if (/^actions?$/.test(normalized)) return "actions";
  if (/^bots?$|^automations?$/.test(normalized)) return "bots";
  if (/^workflow rules?$/.test(normalized)) return "workflowRules";
  return null;
}

function parseDeclaredCounts(text: string, warnings: string[]): AppSheetDefinitionCounts {
  const matches: Array<{ key: AppSheetDefinitionCountKey; count: number; index: number }> = [];
  const patterns = [
    /\b([\d,]+)\s+(tables?|columns?|slices?|views?|format\s*rules?|formatting\s*rules?|actions?|bots?|automations?|workflow\s*rules?)\b/gi,
    /\b(tables?|columns?|slices?|views?|format\s*rules?|formatting\s*rules?|actions?|bots?|automations?|workflow\s*rules?)\s*[:(]\s*([\d,]+)/gi,
  ];
  for (const [patternIndex, pattern] of patterns.entries()) {
    for (const match of text.matchAll(pattern)) {
      const label = patternIndex === 0 ? match[2]! : match[1]!;
      const countText = patternIndex === 0 ? match[1]! : match[2]!;
      const key = countKey(label);
      const count = Number(countText.replaceAll(",", ""));
      if (!key || !Number.isSafeInteger(count) || count < 0 || count > MAX_RECORDS) continue;
      matches.push({ key, count, index: match.index });
    }
  }

  // Application Documentation places its inventory summary before the many
  // numbered tables, columns and views. Prefer the first compact run of
  // distinct categories; scanning the whole page mistakes object ordinals for
  // declared counts (for example, "1000 View").
  let summary: typeof matches = [];
  for (let start = 0; start < matches.length; start++) {
    const candidate: typeof matches = [];
    const seen = new Set<AppSheetDefinitionCountKey>();
    for (let index = start; index < matches.length; index++) {
      const item = matches[index]!;
      if (item.index - matches[start]!.index > 2_000 || seen.has(item.key)) break;
      seen.add(item.key);
      candidate.push(item);
    }
    if (seen.size >= 4) { summary = candidate; break; }
  }
  const selected = summary.length ? summary : matches;
  const counts: AppSheetDefinitionCounts = {};
  const found = new Map<AppSheetDefinitionCountKey, Set<number>>();
  for (const { key, count } of selected) {
    const values = found.get(key) ?? new Set<number>();
    values.add(count);
    found.set(key, values);
  }
  for (const [key, values] of found) {
    if (values.size === 1) counts[key] = [...values][0]!;
    else warnings.push(`declared_count_ambiguous:${key}`);
  }
  return counts;
}

function evidenceFactory(pending: PendingEvidence[]): (kind: PendingEvidence["kind"], node: HtmlElement, path: string[], label?: string | null) => string {
  return (kind, node, path, label = null) => {
    if (pending.length >= MAX_EVIDENCE) fail("definition_evidence_limit_exceeded");
    const id = `e${pending.length + 1}`;
    pending.push({ kind, sectionPath: path, offset: node.offset, label });
    return id;
  };
}

function parsedCredentialValue(value: string): boolean {
  if (containsRecognizableCredential(value)) return true;
  if (!value.startsWith("{") && !value.startsWith("[")) return false;
  try {
    return containsRecognizableCredential(JSON.parse(value) as unknown);
  } catch {
    return false;
  }
}

function makeField(label: string, value: string, evidenceId: string, contextTable: string | null): { field: AppSheetDefinitionField; redacted: boolean } {
  const rawLabel = label.trim().slice(0, 4_000) || "(sin etiqueta)";
  const exactValue = value.replace(/\r\n?/g, "\n").trim();
  if (exactValue.length > MAX_TEXT_FIELD) fail("definition_field_limit_exceeded");
  const redacted = containsRecognizableCredential(rawLabel) || isCredentialBearingHeader(rawLabel, contextTable ?? undefined) || parsedCredentialValue(exactValue);
  return {
    redacted,
    field: {
      label: containsRecognizableCredential(rawLabel) ? "[excluded private label]" : rawLabel,
      semanticKey: semanticKey(label),
      value: redacted ? null : exactValue,
      state: redacted ? "redacted" : "observed",
      evidenceId,
    },
  };
}

const qualifierSemantics: Record<string, string> = {
  Valid_If: "validIf",
  Show_If: "showIf",
  Editable_If: "editableIf",
  Reset_If: "resetIf",
  Required_If: "requiredIf",
  Error_Message_If_Invalid: "invalidMessageIfInvalid",
  Suggested_Values: "suggestedValues",
  ReferencedTableName: "reference",
  ReferencedKeyColumn: "referenceKey",
  ReferencedType: "referenceType",
  ReferencedRootTableName: "referenceRootTable",
  IsAPartOf: "isPartOf",
};

function qualifierValue(value: unknown): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return canonicalJson(value);
}

function fieldText(cell: HtmlElement): string {
  // AppSheet's generated documentation renders property values as cell text. Input
  // attributes are intentionally never read because they can contain auth state.
  return rawTextContent(cell).replace(/\r\n?/g, "\n").trim();
}

function parsePropertyTable(
  table: HtmlElement,
  contextTable: string | null,
  path: string[],
  addEvidence: ReturnType<typeof evidenceFactory>,
): ParsedProperties {
  const fields: AppSheetDefinitionField[] = [];
  const warnings: string[] = [];
  let redactedFieldCount = 0;
  let ambiguousFieldCount = 0;
  const rows = descendantsOfType(table, "tr", true);
  for (const row of rows) {
    const cells = directElements(row).filter((child) => child.tag === "td" || child.tag === "th");
    if (cells.length !== 2) {
      if (cells.length) {
        const rowId = addEvidence("row", row, path, "unrecognized_property_row");
        for (const [index, cell] of cells.entries()) {
          const value = fieldText(cell);
          if (!value) continue;
          const result = makeField(`cell ${index + 1}`, value, rowId, contextTable);
          result.field.state = "ambiguous";
          fields.push(result.field);
          ambiguousFieldCount++;
          if (result.redacted) redactedFieldCount++;
        }
      }
      continue;
    }
    const label = normalizedText(cells[0]!).replace(/\s+/g, " ").trim();
    const value = fieldText(cells[1]!);
    if (!label) {
      if (value) {
        const rowId = addEvidence("row", row, path, "unlabeled_property");
        const result = makeField("(sin etiqueta)", value, rowId, contextTable);
        result.field.state = "ambiguous";
        fields.push(result.field);
        ambiguousFieldCount++;
        if (result.redacted) redactedFieldCount++;
      }
      continue;
    }
    const rowId = addEvidence("row", row, path, label);
    const result = makeField(label, value, rowId, contextTable);
    const interactiveValueWithoutText = !value && ["input", "select", "textarea"].some((tag) => descendantsOfType(cells[1]!, tag).length > 0);
    if (interactiveValueWithoutText) {
      result.field.value = null;
      result.field.state = "ambiguous";
      ambiguousFieldCount++;
      warnings.push("interactive_property_value_not_inspected");
    }
    fields.push(result.field);
    if (result.redacted) redactedFieldCount++;

    if (normalizeLabel(label) !== "type qualifier") continue;
    let qualifier: unknown;
    try {
      qualifier = JSON.parse(value) as unknown;
    } catch {
      warnings.push("type_qualifier_json_unparseable");
      ambiguousFieldCount++;
      continue;
    }
    if (!qualifier || typeof qualifier !== "object" || Array.isArray(qualifier)) {
      warnings.push("type_qualifier_shape_unrecognized");
      ambiguousFieldCount++;
      continue;
    }
    for (const [key, raw] of Object.entries(qualifier)) {
      const semantic = qualifierSemantics[key];
      if (!semantic) continue;
      const projected = makeField(key, qualifierValue(raw), rowId, contextTable);
      projected.field.semanticKey = semantic;
      // A present JSON null is an observed absence of a rule, not the
      // expression "null". Keep the complete qualifier JSON in its source field.
      if (raw === null && !projected.redacted) projected.field.value = null;
      fields.push(projected.field);
      if (projected.redacted) redactedFieldCount++;
    }
  }
  return { fields, redactedFieldCount, ambiguousFieldCount, warnings };
}

function objectHeadingName(title: string, category: AppSheetDefinitionCategory): string {
  const suffix: Partial<Record<AppSheetDefinitionCategory, RegExp>> = {
    tables: /\s+table name$/i,
    slices: /\s+slice name$/i,
    views: /\s+view name$/i,
    formatRules: /\s+rule name$/i,
    actions: /\s+action name$/i,
  };
  const name = title.replace(suffix[category] ?? /$^/, "").trim();
  return safeIdentifier(name);
}

function recordName(category: AppSheetDefinitionCategory, fields: AppSheetDefinitionField[], fallback: string | null): string | null {
  const keys: Partial<Record<AppSheetDefinitionCategory, string[]>> = {
    tables: ["tableName"], columns: ["columnName"], slices: ["sliceName"], views: ["viewName"],
    formatRules: ["ruleName"], actions: ["actionName"],
  };
  for (const key of keys[category] ?? []) {
    const value = fields.find((field) => field.semanticKey === key && field.state === "observed")?.value;
    if (value) return value;
  }
  return fields.find((field) => field.semanticKey === "name" && field.state === "observed")?.value ?? fallback;
}

function makeRecord(
  category: AppSheetDefinitionCategory,
  fields: AppSheetDefinitionField[],
  evidenceId: string,
  fallbackName: string | null,
  children: AppSheetDefinitionRecord[] = [],
): AppSheetDefinitionRecord {
  return { category, name: recordName(category, fields, fallbackName), fields, evidenceId, children };
}

function sectionPathFor(node: HtmlElement): string[] {
  const path: string[] = [];
  for (let current: HtmlElement | null = node; current; current = current.parent) {
    if (current.tag === "section") {
      const classNames = current.attrs.class?.split(/\s+/).filter(Boolean) ?? [];
      if (classNames.length) path.unshift(classNames.join(" "));
    }
    if (headingTag.test(current.tag)) {
      const title = normalizedText(current);
      if (title) path.unshift(title);
    }
  }
  return path.slice(-32).map((segment) => containsRecognizableCredential(segment) ? "[excluded private label]" : segment);
}

function groupRecords(
  root: HtmlElement,
  category: AppSheetDefinitionCategory,
  sectionTitle: string,
  addEvidence: ReturnType<typeof evidenceFactory>,
): { records: AppSheetDefinitionRecord[]; redactedFieldCount: number; ambiguousFieldCount: number; warnings: string[]; evidenceId: string } {
  const rootPath = sectionPathFor(root);
  const sectionEvidenceId = addEvidence("definition", root, rootPath, sectionTitle);
  const records: AppSheetDefinitionRecord[] = [];
  const warnings: string[] = [];
  let redactedFieldCount = 0;
  let ambiguousFieldCount = 0;
  const children = directElements(root);
  for (const heading of children.filter((node) => node.tag === "h5")) {
    const title = normalizedText(heading);
    const table = nextElementSibling(heading);
    if (!table || table.tag !== "table") {
      warnings.push("object_definition_table_missing");
      continue;
    }
    const nameFallback = objectHeadingName(title, category);
    const objectPath = [...rootPath, nameFallback].slice(0, 32);
    const headingEvidenceId = addEvidence("heading", heading, objectPath, title);
    const parsed = parsePropertyTable(table, nameFallback || null, objectPath, addEvidence);
    records.push(makeRecord(category, parsed.fields, headingEvidenceId, nameFallback || null));
    redactedFieldCount += parsed.redactedFieldCount;
    ambiguousFieldCount += parsed.ambiguousFieldCount;
    warnings.push(...parsed.warnings);
  }
  return { records, redactedFieldCount, ambiguousFieldCount, warnings, evidenceId: sectionEvidenceId };
}

function tableClasses(node: HtmlElement): string[] {
  return node.attrs.class?.split(/\s+/).filter(Boolean) ?? [];
}

function parseColumnSchemas(
  root: HtmlElement,
  addEvidence: ReturnType<typeof evidenceFactory>,
): { section: AppSheetDefinitionSection | null; columnCount: number; redactedFieldCount: number; ambiguousFieldCount: number; warnings: string[] } {
  const rootPath = sectionPathFor(root);
  const sectionTitle = "Columns";
  const sectionEvidenceId = addEvidence("definition", root, rootPath, sectionTitle);
  const schemas: AppSheetDefinitionRecord[] = [];
  const warnings: string[] = [];
  let columnCount = 0;
  let redactedFieldCount = 0;
  let ambiguousFieldCount = 0;
  for (const schemaRoot of directElements(root).filter((node) => node.tag === "section")) {
    const heading = descendantsOfType(schemaRoot, "h5").find((node) => inspectable(node));
    if (!heading) { warnings.push("schema_heading_missing"); continue; }
    const schemaTitle = normalizedText(heading);
    const schemaName = safeIdentifier(schemaTitle.replace(/\s+schema name$/i, "").trim());
    const contextTable = schemaName.replace(/_schema$/i, "") || null;
    const schemaPath = [...rootPath, schemaName].slice(0, 32);
    const schemaEvidenceId = addEvidence("heading", heading, schemaPath, schemaTitle);
    const schemaPropertiesTable = nextElementSibling(heading);
    let schemaProperties: ParsedProperties = { fields: [], redactedFieldCount: 0, ambiguousFieldCount: 0, warnings: [] };
    if (schemaPropertiesTable?.tag === "table") schemaProperties = parsePropertyTable(schemaPropertiesTable, contextTable, schemaPath, addEvidence);
    else warnings.push("schema_property_table_missing");
    const columnRecords: AppSheetDefinitionRecord[] = [];
    const columnContainers = descendantsOfType(schemaRoot, "div").filter((node) =>
      tableClasses(node).some((className) => /^columns\d+section$/i.test(className)));
    for (const container of columnContainers) {
      for (const columnHeading of directElements(container).filter((node) => node.tag === "h3")) {
        const title = normalizedText(columnHeading);
        const match = /^column\s+(\d+)\s*:\s*(.*)$/i.exec(title);
        if (!match) { warnings.push("column_heading_unrecognized"); continue; }
        const headingColumnName = match[2]!.trim();
        const columnNameFallback = headingColumnName ? safeIdentifier(headingColumnName) : null;
        const columnPath = [...schemaPath, columnNameFallback ?? `Column ${match[1]}`].slice(0, 32);
        const columnEvidenceId = addEvidence("heading", columnHeading, columnPath, title);
        const table = nextElementSibling(columnHeading);
        if (!table || table.tag !== "table") {
          warnings.push("column_definition_table_missing");
          continue;
        }
        const parsed = parsePropertyTable(table, contextTable, columnPath, addEvidence);
        const fields = [...parsed.fields];
        const ordinal: AppSheetDefinitionField = {
          label: "Column ordinal",
          semanticKey: "ordinal",
          value: match[1]!,
          state: "observed",
          evidenceId: columnEvidenceId,
        };
        fields.push(ordinal);
        columnRecords.push(makeRecord("columns", fields, columnEvidenceId, columnNameFallback));
        columnCount++;
        redactedFieldCount += parsed.redactedFieldCount;
        ambiguousFieldCount += parsed.ambiguousFieldCount;
        warnings.push(...parsed.warnings);
      }
    }
    const schemaFields = [...schemaProperties.fields];
    schemaFields.push({ label: "Schema Name", semanticKey: "schemaName", value: schemaName, state: "observed", evidenceId: schemaEvidenceId });
    schemas.push(makeRecord("columns", schemaFields, schemaEvidenceId, schemaName, columnRecords));
    redactedFieldCount += schemaProperties.redactedFieldCount;
    ambiguousFieldCount += schemaProperties.ambiguousFieldCount;
    warnings.push(...schemaProperties.warnings);
  }
  if (!schemas.length) return { section: null, columnCount, redactedFieldCount, ambiguousFieldCount, warnings };
  return {
    section: { category: "columns", title: sectionTitle, sectionPath: rootPath, evidenceId: sectionEvidenceId, records: schemas },
    columnCount,
    redactedFieldCount,
    ambiguousFieldCount,
    warnings,
  };
}

function flattenRecords(records: AppSheetDefinitionRecord[]): AppSheetDefinitionRecord[] {
  const output: AppSheetDefinitionRecord[] = [];
  const stack = [...records].reverse();
  while (stack.length) {
    const record = stack.pop()!;
    output.push(record);
    for (let index = record.children.length - 1; index >= 0; index--) stack.push(record.children[index]!);
  }
  return output;
}

function evidenceCountFor(sectionList: AppSheetDefinitionSection[]): number {
  const ids = new Set<string>();
  for (const section of sectionList) {
    ids.add(section.evidenceId);
    for (const record of flattenRecords(section.records)) {
      ids.add(record.evidenceId);
      for (const field of record.fields) ids.add(field.evidenceId);
    }
  }
  return ids.size;
}

function coverageFor(
  category: AppSheetDefinitionCategory,
  declaredCounts: AppSheetDefinitionCounts,
  observedCount: number,
  records: AppSheetDefinitionRecord[],
  redactedFieldCount: number,
  ambiguousFieldCount: number,
  evidenceCount: number,
): AppSheetDefinitionCoverage {
  const countKey = APPSHEET_DEFINITION_COUNT_KEYS.includes(category as AppSheetDefinitionCountKey) ? category as AppSheetDefinitionCountKey : null;
  const declaredCount = countKey ? declaredCounts[countKey] ?? null : null;
  let state: AppSheetDefinitionCoverage["state"];
  if (redactedFieldCount > 0) state = "redacted";
  else if (declaredCount !== null && declaredCount === observedCount) state = "matched_declared_count";
  else if (declaredCount !== null) state = "count_mismatch";
  else if (observedCount > 0) state = "observed";
  else state = "unsupported";
  const note = state === "matched_declared_count"
    ? "Observed documentation records match the count declared in this same document; this does not certify runtime completeness."
    : state === "count_mismatch"
      ? "Declared and structurally extracted counts differ; review the source document and extraction."
      : state === "unsupported"
        ? "No inspectable section for this category was found in the captured documentation."
        : state === "redacted"
          ? "At least one field was omitted by credential redaction; the category count remains visible, but its definition is incomplete."
          : "Documentation content was observed; no independent expected count is available.";
  return {
    category,
    state,
    declaredCount,
    observedCount,
    missingCount: declaredCount === null ? null : Math.max(0, declaredCount - observedCount),
    redactedFieldCount,
    ambiguousFieldCount,
    evidenceCount,
    note,
  };
}

function metadataValue(nodes: HtmlElement[], matcher: RegExp): string | null {
  const match = nodes.find((node) => node.tag === "meta" && matcher.test(node.attrs.name ?? ""));
  const value = match?.attrs.content?.trim();
  return value ? value.slice(0, 1_000) : null;
}

/** AppSheet's generated document puts app properties before its object sections. */
function applicationHeaderProperty(
  nodes: HtmlElement[],
  property: "ShortName" | "Version",
  addEvidence: ReturnType<typeof evidenceFactory>,
  warnings: string[],
): string | null {
  const objectClasses = new Set(["tableSection", "schemaSection", "sliceSection", "viewSection", "formatRulesSection", "actionsSection"]);
  const firstObject = nodes.find((node) => node.tag === "section" && tableClasses(node).some((name) => objectClasses.has(name)));
  const values = nodes.filter((node) => node.tag === "tr" && (!firstObject || node.offset < firstObject.offset))
    .flatMap((row) => {
      const cells = directElements(row).filter((node) => node.tag === "td" || node.tag === "th");
      if (cells.length !== 2) return [];
      const label = descendantsOfType(cells[0]!, "label").find((node) => node.attrs.for === property);
      if (!label) return [];
      const value = normalizedText(cells[1]!);
      if (!value || containsRecognizableCredential(value)) return [];
      return [{ row, value }];
    });
  const unique = [...new Set(values.map(({ value }) => value))];
  if (unique.length > 1) {
    warnings.push(`application_header_ambiguous:${property}`);
    return null;
  }
  const match = values[0];
  if (!match) return null;
  if (match.value.length > (property === "Version" ? 200 : 1_000) ||
      (property === "Version" && !/^\d+(?:\.\d+)+$/.test(match.value))) {
    warnings.push(`application_header_invalid:${property}`);
    return null;
  }
  addEvidence("row", match.row, ["Application"], property === "Version" ? "Application version" : "Application short name");
  return match.value;
}

const processStateNamespacePattern = /^\/ProcessStateTables\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i;

function resolveAppIdentity(
  headerId: string | null,
  headerNode: HtmlElement | undefined,
  tableRecords: AppSheetDefinitionRecord[],
  addEvidence: ReturnType<typeof evidenceFactory>,
): { id: string | null; identity: AppSheetDefinitionIdentity; warnings: string[] } {
  const sourcePathFields = flattenRecords(tableRecords).flatMap((record) => record.fields)
    .filter((field) => field.semanticKey === "sourcePath" && field.state === "observed" && field.value !== null);
  const references = sourcePathFields.flatMap((field) => {
    const match = processStateNamespacePattern.exec(field.value ?? "");
    return match ? [{ id: match[1]!.toLowerCase(), evidenceId: field.evidenceId }] : [];
  });
  const candidates = [...new Set(references.map((reference) => reference.id))];
  const headerEvidenceId = headerId && headerNode
    ? addEvidence("definition", headerNode, ["Application"], "Application ID metadata")
    : null;
  const evidenceIds = [...new Set([
    ...(headerEvidenceId ? [headerEvidenceId] : []),
    ...references.map((reference) => reference.evidenceId),
  ])];
  const evidenceId = evidenceIds[0] ?? null;
  const warnings: string[] = [];

  if (candidates.length > 1) {
    warnings.push("application_identity_ambiguous_process_state_namespaces");
    return {
      id: null,
      identity: { method: "ambiguous", evidenceId, evidenceIds, sourcePathReferenceCount: references.length, candidateCount: candidates.length },
      warnings,
    };
  }

  const referencedId = candidates[0] ?? null;
  if (headerId && referencedId && headerId.toLowerCase() !== referencedId) {
    warnings.push("application_identity_header_source_namespace_conflict");
    return {
      id: null,
      identity: { method: "ambiguous", evidenceId, evidenceIds, sourcePathReferenceCount: references.length, candidateCount: candidates.length },
      warnings,
    };
  }

  if (headerId) {
    return {
      id: headerId,
      identity: { method: "app-document-header", evidenceId, evidenceIds, sourcePathReferenceCount: references.length, candidateCount: candidates.length },
      warnings,
    };
  }

  if (referencedId) {
    warnings.push("application_id_derived_from_referenced_process_state_namespace");
    return {
      id: referencedId,
      identity: { method: "referenced-process-state-namespace", evidenceId, evidenceIds, sourcePathReferenceCount: references.length, candidateCount: candidates.length },
      warnings,
    };
  }

  warnings.push("application_identity_unverified_no_header_or_process_state_namespace");
  return {
    id: null,
    identity: { method: "unverified", evidenceId, evidenceIds, sourcePathReferenceCount: references.length, candidateCount: 0 },
    warnings,
  };
}

function topLevelContent(root: HtmlElement): HtmlElement {
  const nodes = walk(root);
  return nodes.find((node) => node.tag === "main") ?? nodes.find((node) => node.tag === "article") ?? root;
}

export function parseAppSheetDefinitionHtml(html: string, options: { expectedAppId?: string } = {}): AppSheetDefinitionInventory {
  const byteLength = Buffer.byteLength(html, "utf8");
  if (byteLength === 0) fail("html_source_empty");
  if (byteLength > MAX_HTML_BYTES) fail("html_source_too_large");
  const sourceHash = createHash("sha256").update(html, "utf8").digest("hex");
  const root = parseHtml(html);
  const content = topLevelContent(root);
  const documentNodes = walk(root).filter(inspectable);
  const contentNodes = walk(content).filter(inspectable);
  const lineStarts = [0];
  for (let index = 0; index < html.length; index++) if (html[index] === "\n") lineStarts.push(index + 1);
  const pending: PendingEvidence[] = [];
  const addEvidence = evidenceFactory(pending);
  const sections: AppSheetDefinitionSection[] = [];
  const warnings = ["application_documentation_is_not_a_complete_runtime_export"];
  let redactedFieldCount = 0;
  let ambiguousFieldCount = 0;

  const groups: Array<{ className: string; category: AppSheetDefinitionCategory; title: string }> = [
    { className: "tableSection", category: "tables", title: "Tables" },
    { className: "sliceSection", category: "slices", title: "Slices" },
    { className: "viewSection", category: "views", title: "Views" },
    { className: "formatRulesSection", category: "formatRules", title: "Format Rules" },
    { className: "actionsSection", category: "actions", title: "Actions" },
  ];
  const groupCounts: Partial<Record<AppSheetDefinitionCountKey, number>> = {};
  const perCategoryRedacted: Partial<Record<AppSheetDefinitionCategory, number>> = {};
  const perCategoryAmbiguous: Partial<Record<AppSheetDefinitionCategory, number>> = {};
  for (const group of groups) {
    const roots = documentNodes.filter((node) => node.tag === "section" && tableClasses(node).includes(group.className));
    if (roots.length > 1) warnings.push(`section_root_duplicate:${group.className}`);
    for (const groupRoot of roots) {
      const grouped = groupRecords(groupRoot, group.category, group.title, addEvidence);
      if (grouped.records.length) sections.push({
        category: group.category,
        title: group.title,
        sectionPath: sectionPathFor(groupRoot),
        evidenceId: grouped.evidenceId,
        records: grouped.records,
      });
      const countKey = group.category as AppSheetDefinitionCountKey;
      groupCounts[countKey] = (groupCounts[countKey] ?? 0) + grouped.records.length;
      perCategoryRedacted[group.category] = (perCategoryRedacted[group.category] ?? 0) + grouped.redactedFieldCount;
      perCategoryAmbiguous[group.category] = (perCategoryAmbiguous[group.category] ?? 0) + grouped.ambiguousFieldCount;
      warnings.push(...grouped.warnings);
      redactedFieldCount += grouped.redactedFieldCount;
      ambiguousFieldCount += grouped.ambiguousFieldCount;
    }
  }

  const schemaRoots = documentNodes.filter((node) => node.tag === "section" && tableClasses(node).includes("schemaSection"));
  let extractedColumnCount = 0;
  for (const schemaRoot of schemaRoots) {
    const parsed = parseColumnSchemas(schemaRoot, addEvidence);
    if (parsed.section) sections.push(parsed.section);
    extractedColumnCount += parsed.columnCount;
    perCategoryRedacted.columns = (perCategoryRedacted.columns ?? 0) + parsed.redactedFieldCount;
    perCategoryAmbiguous.columns = (perCategoryAmbiguous.columns ?? 0) + parsed.ambiguousFieldCount;
    warnings.push(...parsed.warnings);
    redactedFieldCount += parsed.redactedFieldCount;
    ambiguousFieldCount += parsed.ambiguousFieldCount;
  }
  groupCounts.columns = extractedColumnCount;

  const sectionRecords = (category: AppSheetDefinitionCategory) => sections.filter((section) => section.category === category).flatMap((section) => section.records);
  const columnRecords = flattenRecords(sectionRecords("columns")).filter((record) => record.fields.some((field) => field.semanticKey === "columnName"));
  const declaredCounts = parseDeclaredCounts(normalizedText(content), warnings);
  const observedCounts: AppSheetDefinitionCounts = {
    tables: groupCounts.tables ?? 0,
    columns: columnRecords.length,
    slices: groupCounts.slices ?? 0,
    views: groupCounts.views ?? 0,
    formatRules: groupCounts.formatRules ?? 0,
    actions: groupCounts.actions ?? 0,
  };
  const workflowText = normalizedText(content);
  if (/\b0\s+workflow\s+rules?\b/i.test(workflowText)) observedCounts.workflowRules = 0;
  else if (declaredCounts.workflowRules !== undefined) observedCounts.workflowRules = 0;

  const allRecords = APPSHEET_DEFINITION_CATEGORIES.flatMap((category) => sectionRecords(category));
  const securityFields = flattenRecords(allRecords).flatMap((record) => record.fields)
    .filter((field) => field.semanticKey === "securityFilter");
  const settingsRecords = flattenRecords(allRecords).filter((record) => /user settings|app settings/i.test(record.name ?? ""));
  const countsWithCoverage = {
    ...observedCounts,
    bots: 0,
    workflowRules: observedCounts.workflowRules ?? 0,
  };
  const appIdMetadataNode = documentNodes.find((node) => node.tag === "meta" && /^(?:app\s*id|appsheet\s*app\s*id)$/i.test(node.attrs.name ?? ""));
  const appIdValue = metadataValue(documentNodes, /^(?:app\s*id|appsheet\s*app\s*id)$/i);
  const headerAppId = appIdValue && !containsRecognizableCredential(appIdValue) ? appIdValue : null;
  const appIdentity = resolveAppIdentity(headerAppId, appIdMetadataNode, sectionRecords("tables"), addEvidence);
  const appId = appIdentity.id;
  if (options.expectedAppId && appId !== options.expectedAppId) {
    if (appIdentity.identity.method === "ambiguous") fail("app_identity_ambiguous");
    fail(appId ? "app_identity_mismatch" : "app_identity_unverifiable");
  }
  const applicationNameValue = metadataValue(documentNodes, /^application-name$/i);
  const applicationName = applicationNameValue && !containsRecognizableCredential(applicationNameValue) ? applicationNameValue : null;
  const pageTitle = documentNodes.find((node) => node.tag === "title");
  const visibleTitle = pageTitle ? normalizedText(pageTitle) : null;
  const headerName = applicationHeaderProperty(documentNodes, "ShortName", addEvidence, warnings);
  const appVersion = applicationHeaderProperty(documentNodes, "Version", addEvidence, warnings);
  const appName = applicationName ?? headerName ?? (visibleTitle && !/appsheet|application documentation|documentation/i.test(visibleTitle) && !containsRecognizableCredential(visibleTitle) ? visibleTitle : null);

  const coverage = APPSHEET_DEFINITION_CATEGORIES.map((category) => {
    let records = sectionRecords(category);
    let observedCount = (countsWithCoverage as Partial<Record<AppSheetDefinitionCountKey, number>>)[category as AppSheetDefinitionCountKey] ?? records.length;
    let categoryRedacted = perCategoryRedacted[category] ?? 0;
    let categoryAmbiguous = perCategoryAmbiguous[category] ?? 0;
    let evidenceCount = evidenceCountFor(sections.filter((section) => section.category === category));
    if (category === "security") {
      observedCount = securityFields.length;
      categoryRedacted = securityFields.filter((field) => field.state === "redacted").length;
      categoryAmbiguous = securityFields.filter((field) => field.state === "ambiguous").length;
      evidenceCount = new Set(securityFields.map((field) => field.evidenceId)).size;
    } else if (category === "settings") {
      records = settingsRecords;
      observedCount = settingsRecords.length;
      const settingFields = flattenRecords(settingsRecords).flatMap((record) => record.fields);
      categoryRedacted = settingFields.filter((field) => field.state === "redacted").length;
      categoryAmbiguous = settingFields.filter((field) => field.state === "ambiguous").length;
      const settingEvidence = new Set(settingsRecords.flatMap((record) => [record.evidenceId, ...record.fields.map((field) => field.evidenceId)]));
      evidenceCount = settingEvidence.size;
    }
    return coverageFor(category, declaredCounts, observedCount, records, categoryRedacted, categoryAmbiguous, evidenceCount);
  });

  const evidence = pending.map((item, index): AppSheetDefinitionEvidence => ({
    id: `e${index + 1}`,
    kind: item.kind,
    sectionPath: item.sectionPath.slice(0, 32).map((segment) => containsRecognizableCredential(segment) ? "[excluded private label]" : segment),
    position: linePosition(html, item.offset, lineStarts),
    label: item.label && !containsRecognizableCredential(item.label) ? item.label.slice(0, 4_000) : null,
    excerpt: null,
  }));
  const inventoryBase = {
    schemaVersion: APPSHEET_DEFINITION_SCHEMA_VERSION,
    parserVersion: APPSHEET_DEFINITION_PARSER_VERSION,
    source: { sha256: sourceHash, byteLength, encoding: "utf-8" as const },
    app: { id: appId, name: appName, version: appVersion, deploymentState: null, generatedAt: null, identity: appIdentity.identity },
    declaredCounts,
    observedCounts,
    descriptorSha256: "",
    coverage,
    sections,
    evidence,
    redactedFieldCount,
    warnings: [...new Set([...warnings, ...appIdentity.warnings])],
  };
  const descriptorSha256 = createHash("sha256").update(canonicalJson(inventoryBase), "utf8").digest("hex");
  const parsed = appSheetDefinitionInventorySchema.safeParse({ ...inventoryBase, descriptorSha256 });
  if (!parsed.success) fail("definition_inventory_invalid");
  if (!HASH.test(parsed.data.source.sha256) || !HASH.test(parsed.data.descriptorSha256)) fail("definition_hash_invalid");
  return parsed.data;
}
