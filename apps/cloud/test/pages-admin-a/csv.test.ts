import { describe, expect, test } from "vitest";
import { csvCell, csvResponse, csvRow, toCsv } from "@/app/(app)/admin/_lib/csv";

describe("csv cells", () => {
  test("plain values pass through, empty for null and undefined", () => {
    expect(csvCell("anna")).toBe("anna");
    expect(csvCell(12)).toBe("12");
    expect(csvCell(true)).toBe("yes");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(new Date("2026-10-04T12:00:00Z"))).toBe("2026-10-04T12:00:00.000Z");
  });

  test("quotes commas, quotes and line breaks", () => {
    expect(csvCell("Doe, Jane")).toBe('"Doe, Jane"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
  });

  test("neutralises text a spreadsheet would run as a formula", () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe(`"'=HYPERLINK(""http://evil"")"`);
    expect(csvCell("+1 555")).toBe("'+1 555");
    expect(csvCell("-2")).toBe("'-2");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\tcmd")).toBe("'\tcmd");
    expect(csvCell("  =1+1")).toBe("'  =1+1");
    // Real numbers stay numbers.
    expect(csvCell(-2)).toBe("-2");
  });

  test("rows and files", () => {
    expect(csvRow(["a", "b,c", 1])).toBe('a,"b,c",1');
    const csv = toCsv(["id", "name"], [["1", "x"], ["2", "y"]]);
    expect(csv).toBe("﻿id,name\r\n1,x\r\n2,y\r\n");
  });

  test("response is an attachment that is never cached", async () => {
    const res = csvResponse("people", "a,b\r\n");
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="people-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("a,b\r\n");
  });
});
