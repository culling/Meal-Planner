import YAML from "yaml";
import { ValidationError } from "./fsutil";

export interface ParsedDoc {
  data: Record<string, unknown>;
  body: string;
  /** frontmatter text exactly as found, used to avoid rewriting unchanged files */
  rawFront: string;
}

/** Split a Markdown file into YAML frontmatter and body. Missing/invalid frontmatter gives empty data. */
export function parseDoc(text: string): ParsedDoc {
  const src = text.replace(/^﻿/, "");
  const m = src.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { data: {}, body: src, rawFront: "" };
  let data: Record<string, unknown> = {};
  try {
    const parsed = YAML.parse(m[1]);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch (e) {
    const reason = (e as Error).message.split(/\r?\n/)[0];
    throw new ValidationError(`The frontmatter (the --- block at the top) isn't valid YAML: ${reason}`);
  }
  return { data, body: src.slice(m[0].length).replace(/^\r?\n/, ""), rawFront: m[1] };
}

/**
 * Write frontmatter + body. If `original` is given and the parsed data is deeply equal to the
 * original's, the original frontmatter text is reused so comments and layout survive untouched.
 */
export function stringifyDoc(data: Record<string, unknown>, body: string, original?: ParsedDoc): string {
  let front: string;
  if (original && original.rawFront && deepEqual(original.data, data)) {
    front = original.rawFront;
  } else {
    front = YAML.stringify(stripUndefined(data), { lineWidth: 0, defaultStringType: "PLAIN", defaultKeyType: "PLAIN" }).trimEnd();
  }
  const b = body.startsWith("\n") ? body.slice(1) : body;
  return `---\n${front}\n---\n\n${b.replace(/^\n+/, "")}`.replace(/\n*$/, "\n");
}

export function stripUndefined<T>(v: T): T {
  return JSON.parse(JSON.stringify(v, (_k, val) => (val === undefined ? null : val)));
}

export function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, sortKeys(x)]),
    );
  }
  return v;
}
