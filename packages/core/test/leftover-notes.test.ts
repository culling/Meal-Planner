import { describe, expect, it } from "vitest";
import { parseStorageNotes } from "../src/leftover-notes";

describe("parseStorageNotes", () => {
  it("reads fridge and freezer times", () => {
    const f = parseStorageNotes("Store leftovers in an airtight container in the fridge for up to 4 days. Freeze for up to 3 months. Reheat gently on the stove.");
    expect(f).toMatchObject({ fridgeDays: 4, freezerDays: 90, freezable: true });
    expect(f.reheatNotes).toContain("Reheat");
  });
  it("handles the number before the place, and ranges (lower end)", () => {
    expect(parseStorageNotes("Keeps 3-4 days in the fridge.").fridgeDays).toBe(3);
    expect(parseStorageNotes("Will keep for 2 weeks in the refrigerator").fridgeDays).toBe(14);
  });
  it("does not mix up two times in one sentence", () => {
    const f = parseStorageNotes("Keeps for 3 days in the fridge or 3 months in the freezer.");
    expect(f).toMatchObject({ fridgeDays: 3, freezerDays: 90 });
  });
  it("detects recipes that don't freeze", () => {
    expect(parseStorageNotes("This does not freeze well because the sauce splits.").freezable).toBe(false);
    expect(parseStorageNotes("Not suitable for freezing.").freezable).toBe(false);
    expect(parseStorageNotes("Do not freeze.").freezable).toBe(false);
  });
  it("detects recipes that do freeze", () => {
    expect(parseStorageNotes("This freezes well.").freezable).toBe(true);
  });
  it("reports nothing when the notes say nothing", () => {
    expect(parseStorageNotes("Use thighs for more flavour. Serve with rice.")).toEqual({ fridgeDays: null, freezerDays: null, freezable: null, reheatNotes: null });
  });
});
