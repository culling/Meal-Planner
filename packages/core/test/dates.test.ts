import { describe, expect, it } from "vitest";
import { addDays, diffDays, isoWeekOf, parseIsoDuration, shiftWeek, weekDates, weekStartDate } from "../src/dates";

describe("ISO weeks", () => {
  it("matches known dates", () => {
    expect(isoWeekOf("2026-10-12")).toBe("2026-W42");
    expect(weekStartDate("2026-W41")).toBe("2026-10-05");
  });
  it("handles year boundaries", () => {
    expect(isoWeekOf("2021-01-01")).toBe("2020-W53");
    expect(isoWeekOf("2024-12-30")).toBe("2025-W01");
    expect(shiftWeek("2025-W01", -1)).toBe("2024-W52");
    expect(shiftWeek("2020-W53", 1)).toBe("2021-W01");
  });
  it("lists seven days starting Monday", () => {
    const d = weekDates("2026-W42");
    expect(d[0]).toBe("2026-10-12");
    expect(d[6]).toBe("2026-10-18");
  });
  it("adds days across DST changes", () => {
    expect(addDays("2026-09-26", 2)).toBe("2026-09-28");
    expect(diffDays("2026-10-12", "2026-10-05")).toBe(7);
  });
});

describe("parseIsoDuration", () => {
  it.each([
    ["PT15M", 15],
    ["PT1H15M", 75],
    ["PT2H", 120],
    ["P1DT1H", 1500],
    ["PT0S", null],
    ["nonsense", null],
  ])("%s -> %s", (input, out) => {
    expect(parseIsoDuration(input)).toBe(out);
  });
});
