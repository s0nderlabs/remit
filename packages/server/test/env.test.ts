// envInt guards the numeric-env trap: `.env.example` ships optional vars as `KEY=`,
// Bun loads them as "", and `Number("" ?? def)` silently becomes 0 — zeroing rate
// limits (every request 429s) and intervals (reconcile never scheduled).

import { describe, expect, test } from "bun:test";
import { envInt } from "../src/deps";

describe("envInt", () => {
  test("empty string falls back to the default (the `cp .env.example .env` trap)", () => {
    process.env.__REMIT_TEST_INT = "";
    expect(envInt("__REMIT_TEST_INT", 240)).toBe(240);
    process.env.__REMIT_TEST_INT = "   ";
    expect(envInt("__REMIT_TEST_INT", 240)).toBe(240);
  });

  test("garbage falls back; real values (incl. 0) parse; missing uses default", () => {
    process.env.__REMIT_TEST_INT = "abc";
    expect(envInt("__REMIT_TEST_INT", 30)).toBe(30); // NaN would disable a limiter entirely
    process.env.__REMIT_TEST_INT = "12";
    expect(envInt("__REMIT_TEST_INT", 30)).toBe(12);
    process.env.__REMIT_TEST_INT = "0"; // explicit 0 is a real value (e.g. disables reconcile)
    expect(envInt("__REMIT_TEST_INT", 30)).toBe(0);
    delete process.env.__REMIT_TEST_INT;
    expect(envInt("__REMIT_TEST_INT", 7)).toBe(7);
  });
});
