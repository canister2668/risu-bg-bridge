// Strict subset YAML parser for risu-bg-extension target locks and patch
// series. Deliberately supports only what this kit's own files use:
//
//   - mappings (`key: value`), nested by indentation
//   - block scalars (`|-` strips the final newline, `|` keeps it) captured
//     VERBATIM from the raw source — interior blank lines and `#` characters
//     are preserved because patch anchors depend on exact text
//   - lists of scalars and lists of mappings (`- key: value` continuation)
//   - scalars: quoted strings, integers, floats, booleans, null
//
// Everything else — flow style ([], {}), anchors/aliases, tabs, duplicate
// keys, inconsistent indentation — is a hard error. Lock files must fail
// closed on anything this parser cannot prove, never guess.

export class YamlSyntaxError extends Error {
  constructor(message, line) {
    super(`${message} (line ${line})`);
    this.name = "YamlSyntaxError";
    this.line = line;
  }
}

const KEY_RE = /^([A-Za-z_][A-Za-z0-9_.-]*|"[^"]*"|'[^']*'):(?:[ \t]+(.*))?$/;
const LIST_RE = /^-([ \t]+(.*))?$/;
const INT_RE = /^-?\d+$/;
const FLOAT_RE = /^-?\d+\.\d+$/;

class RawLine {
  constructor(raw, number) {
    this.raw = raw;
    this.number = number;
    // blank = only whitespace; indent = leading spaces (null when blank)
    this.blank = raw.trim() === "";
    this.indent = this.blank ? null : raw.length - raw.trimStart().length;
  }
}

/** Structural content of a raw line: comment-stripped, trimmed. */
function structuralContent(rawLine) {
  if (rawLine.blank) return "";
  const stripped = stripComment(rawLine.raw);
  return stripped.trim();
}

function stripComment(text) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) {
      // '#' inside a plain scalar is a comment only when preceded by
      // whitespace or at the start of the value (YAML rule).
      if (i === 0 || /\s/.test(text[i - 1])) {
        return text.slice(0, i).replace(/\s+$/, "");
      }
    }
  }
  return text;
}

function parseScalar(text, line) {
  const value = text.trim();
  if (value === "" || value === "~" || value === "null") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (INT_RE.test(value)) return Number(value);
  if (FLOAT_RE.test(value)) return Number(value);
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"');
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.startsWith('"') || value.startsWith("'")) {
    throw new YamlSyntaxError(`Unterminated quoted scalar: ${value}`, line);
  }
  if (value.startsWith("[") || value.startsWith("{") || value.startsWith("&") || value.startsWith("*") || value.startsWith("!")) {
    throw new YamlSyntaxError(`Unsupported YAML construct: ${value}`, line);
  }
  if (value.includes(": ")) {
    throw new YamlSyntaxError(`Plain scalar contains ': ' (inline mapping not supported): ${value}`, line);
  }
  return value;
}

function isCommentLine(rawLine) {
  if (rawLine.blank) return false;
  return structuralContent(rawLine) === "" && rawLine.raw.trim() !== "";
}

class Cursor {
  constructor(rawLines) {
    this.rawLines = rawLines;
    this.i = 0; // index into rawLines
  }
  /** Advances to the next structural (non-blank, non-comment) line. */
  next() {
    while (this.i < this.rawLines.length) {
      const line = this.rawLines[this.i];
      if (!line.blank && !isCommentLine(line)) return line;
      this.i++;
    }
    return null;
  }
}

/**
 * Parses a block scalar indicator: "|", "|-", "|N", or "|N-". The optional
 * number is an explicit strip count (absolute columns) for cases where the
 * content's own leading spaces must be preserved — e.g. patch anchors that
 * begin with indentation. Without a number the strip count is taken from the
 * first non-blank content line (standard YAML behavior).
 */
function parseIndicator(indicator, line) {
  const m = /^(\|)(\d+)?(-)?$/.exec(indicator ?? "");
  if (!m) {
    throw new YamlSyntaxError(`Unsupported block scalar indicator: ${JSON.stringify(indicator)}`, line ?? 0);
  }
  return { keepFinalNewline: !m[3], explicitIndent: m[2] !== undefined ? Number(m[2]) : null };
}

function isBlockIndicator(text) {
  return /^\|(\d+)?(-)?$/.test(text ?? "");
}

/**
 * Captures a block scalar starting at the cursor (the key/indicator line has
 * already been consumed). Content is taken verbatim from the raw source.
 * With an explicit indicator `|N`/`|N-` exactly N columns are stripped from
 * every content line; otherwise the indent of the first non-blank content
 * line is the strip count. Interior blank lines are kept as empty lines;
 * trailing blank lines are dropped. `|`/`|N` append one final newline.
 */
function parseBlockScalar(cursor, keyIndent, indicator) {
  const { keepFinalNewline, explicitIndent } = parseIndicator(indicator, 0);
  const start = cursor.i;
  let blockIndent = explicitIndent;
  let end = start;
  for (let j = start; j < cursor.rawLines.length; j++) {
    const line = cursor.rawLines[j];
    if (line.blank) {
      end = j + 1;
      continue;
    }
    if (blockIndent === null) blockIndent = line.indent;
    if (line.indent < blockIndent) {
      if (line.indent > keyIndent) {
        throw new YamlSyntaxError(
          `Inconsistent block scalar indentation (expected >= ${blockIndent}, found ${line.indent})`,
          line.number
        );
      }
      break; // dedent ends the block
    }
    end = j + 1;
  }
  if (blockIndent === null) throw new YamlSyntaxError("Empty block scalar", 0);
  // Drop trailing blank lines captured past the block.
  while (end > start && cursor.rawLines[end - 1].blank) end--;
  const contentLines = [];
  for (let j = start; j < end; j++) {
    const line = cursor.rawLines[j];
    contentLines.push(line.blank ? "" : line.raw.slice(blockIndent));
  }
  let text = contentLines.join("\n");
  if (keepFinalNewline) text += "\n";
  cursor.i = end;
  return text;
}

function parseNode(cursor, indent) {
  const line = cursor.next();
  if (line.indent !== indent) {
    throw new YamlSyntaxError(`Expected indentation ${indent}, found ${line.indent}`, line.number);
  }
  const listMatch = LIST_RE.exec(structuralContent(line));
  if (listMatch) {
    const result = [];
    while (true) {
      const current = cursor.next();
      if (!current || current.indent !== indent || !LIST_RE.exec(structuralContent(current))) break;
      const rest = structuralContent(current).replace(LIST_RE, "$2");
      if (isBlockIndicator(rest)) {
        // "- |" scalar item
        cursor.i++; // consume the indicator line
        result.push(parseBlockScalar(cursor, indent, rest));
        continue;
      }
      if (rest !== "" && KEY_RE.test(rest)) {
        // "- key: value" mapping item with deeper continuation lines.
        const contStart = cursor.i + 1;
        let contEnd = contStart;
        let itemIndent = null;
        for (let j = contStart; j < cursor.rawLines.length; j++) {
          const l = cursor.rawLines[j];
          if (l.blank || isCommentLine(l)) {
            // Could be a blank inside a block scalar owned by the item;
            // only treat as end when a structural line confirms dedent.
            const peek = new Cursor(cursor.rawLines);
            peek.i = j;
            const after = peek.next();
            if (!after || after.indent <= indent) break;
            contEnd = j + 1;
            continue;
          }
          if (l.indent <= indent || LIST_RE.exec(structuralContent(l))) break;
          if (itemIndent === null) itemIndent = l.indent;
          contEnd = j + 1;
        }
        const itemLines = [
          { raw: rest.padStart(rest.length + (itemIndent ?? indent + 2)), number: current.number, blank: false, indent: itemIndent ?? indent + 2 },
        ];
        for (let j = contStart; j < contEnd; j++) itemLines.push(cursor.rawLines[j]);
        const itemCursor = new Cursor(itemLines);
        const firstItem = itemCursor.next();
        if (!firstItem) throw new YamlSyntaxError("Empty mapping list item", current.number);
        result.push(parseMap(itemCursor, firstItem.indent));
        cursor.i = contEnd;
      } else if (rest !== "") {
        result.push(parseScalar(rest, current.number));
        cursor.i++;
      } else {
        // "-" alone: nested node on the following deeper line.
        cursor.i++;
        const child = cursor.next();
        if (!child || child.indent <= indent) {
          throw new YamlSyntaxError("List item '-' requires a nested node", current.number);
        }
        const childValue = parseNode(cursor, child.indent);
        result.push(childValue);
      }
    }
    return result;
  }
  return parseMap(cursor, indent);
}

function parseMap(cursor, indent) {
  const result = {};
  while (true) {
    const line = cursor.next();
    if (!line || line.indent !== indent) break;
    const content = structuralContent(line);
    if (LIST_RE.test(content)) break;
    const m = KEY_RE.exec(content);
    if (!m) {
      throw new YamlSyntaxError(`Expected 'key: value', found: ${content}`, line.number);
    }
    let key = m[1];
    if (key.startsWith('"') || key.startsWith("'")) key = key.slice(1, -1);
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      throw new YamlSyntaxError(`Duplicate key: ${key}`, line.number);
    }
    const inline = m[2];
    if (inline !== undefined && inline !== "" && !isBlockIndicator(inline)) {
      result[key] = parseScalar(inline, line.number);
      cursor.i++;
    } else {
      // Null, nested node, or block scalar.
      const indicator = isBlockIndicator(inline) ? inline : null;
      cursor.i++; // consume the key line
      if (indicator) {
        result[key] = parseBlockScalar(cursor, indent, indicator);
        continue;
      }
      const next = cursor.next();
      if (next && next.indent > indent) {
        if (isBlockIndicator(structuralContent(next))) {
          const blockIndicator = structuralContent(next);
          cursor.i++; // consume indicator line
          result[key] = parseBlockScalar(cursor, indent, blockIndicator);
        } else {
          result[key] = parseNode(cursor, next.indent);
        }
      } else {
        result[key] = null;
      }
    }
  }
  return result;
}

export function parseYaml(source) {
  if (typeof source !== "string") {
    throw new YamlSyntaxError("parseYaml expects a string", 0);
  }
  const rawLines = source.split(/\r?\n/).map((raw, i) => {
    if (raw.includes("\t")) {
      throw new YamlSyntaxError("Tab characters are not allowed in this YAML subset", i + 1);
    }
    return new RawLine(raw, i + 1);
  });
  const cursor = new Cursor(rawLines);
  const first = cursor.next();
  if (!first) return {};
  return parseNode(cursor, first.indent);
}

/** Loads and parses a YAML file, failing closed on read or syntax errors. */
export async function loadYamlFile(fs, path) {
  const text = await fs.readFile(path, "utf8");
  try {
    return parseYaml(text);
  } catch (err) {
    if (err instanceof YamlSyntaxError) {
      throw new Error(`${path}: ${err.message}`);
    }
    throw err;
  }
}