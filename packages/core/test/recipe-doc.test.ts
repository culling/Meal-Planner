import { describe, expect, it } from "vitest";
import { parseDoc, stringifyDoc } from "../src/frontmatter";
import { addCookLog, addNote, buildBody, parseBody, updateBodyParts } from "../src/recipe-doc";

const FILE = `---
id: butter-chicken
title: Butter Chicken
servings: 4
tags: [curry, chicken]
myOwnField: keep me   # a comment
---

# Butter Chicken

## Ingredients

### Marinade
- 600 g chicken thigh
- 1/2 cup yoghurt

## Method

1. Combine the marinade.
2. Cook it
   over medium heat.

## my notes

### 2026-10-01
Great.

## Cook log

- 2026-10-09 — cooked for 4, rating 4
`;

describe("recipe body", () => {
  it("parses sections case-insensitively", () => {
    const { body } = parseDoc(FILE);
    const p = parseBody(body);
    expect(p.ingredients).toHaveLength(2);
    expect(p.method).toEqual([
      { n: 1, text: "Combine the marinade." },
      { n: 2, text: "Cook it\nover medium heat." },
    ]);
    expect(p.notes).toEqual([{ date: "2026-10-01", text: "Great." }]);
    expect(p.cookLog[0]).toMatchObject({ date: "2026-10-09", people: 4, rating: 4 });
  });
  it("treats missing sections as empty", () => {
    const p = parseBody("# Just a title\n");
    expect(p.ingredients).toEqual([]);
    expect(p.method).toEqual([]);
  });
  it("adds notes newest first and appends to the cook log", () => {
    let b = parseDoc(FILE).body;
    b = addNote(b, "2026-10-10", "Less chilli");
    expect(parseBody(b).notes.map((n) => n.date)).toEqual(["2026-10-10", "2026-10-01"]);
    b = addCookLog(b, "2026-10-11 — cooked for 2");
    expect(parseBody(b).cookLog).toHaveLength(2);
  });
  it("replaces sections without touching notes", () => {
    const b = updateBodyParts(parseDoc(FILE).body, { ingredientsMd: "- 1 onion", title: "Butter Chook" });
    const p = parseBody(b);
    expect(p.ingredients).toHaveLength(1);
    expect(p.notes).toHaveLength(1);
    expect(b).toContain("# Butter Chook");
  });
  it("builds a new body", () => {
    const b = buildBody({ title: "X", ingredientsMd: "- 1 egg", methodMd: "1. Boil" });
    expect(parseBody(b).method).toHaveLength(1);
  });
});

describe("frontmatter round trip", () => {
  it("rewrites an unchanged file identically (comments and unknown fields kept)", () => {
    const doc = parseDoc(FILE);
    expect(stringifyDoc(doc.data, doc.body, doc)).toBe(FILE);
  });
  it("keeps unknown fields when data changes", () => {
    const doc = parseDoc(FILE);
    const out = stringifyDoc({ ...doc.data, servings: 6 }, doc.body, doc);
    expect(parseDoc(out).data).toMatchObject({ servings: 6, myOwnField: "keep me" });
  });
  it("keeps dates and timestamps as text", () => {
    const doc = parseDoc("---\nd: 2026-10-09\nt: 2026-10-09T18:56:00+13:00\n---\nbody\n");
    expect(doc.data).toEqual({ d: "2026-10-09", t: "2026-10-09T18:56:00+13:00" });
  });
});
