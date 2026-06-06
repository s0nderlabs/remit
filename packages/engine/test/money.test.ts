import { describe, expect, test } from "bun:test";
import { usdcToAtoms, atomsToUsdc, parseAtoms } from "../src/money";

describe("usdcToAtoms", () => {
  test("whole dollars", () => {
    expect(usdcToAtoms("25")).toBe(25_000_000n);
    expect(usdcToAtoms("0")).toBe(0n);
  });
  test("relayer minFee shape", () => {
    expect(usdcToAtoms("0.01")).toBe(10_000n); // the documented 10000-atom minimum fee
  });
  test("full precision", () => {
    expect(usdcToAtoms("1.234567")).toBe(1_234_567n);
    expect(usdcToAtoms("0.000001")).toBe(1n);
  });
  test("no float drift on awkward decimals", () => {
    expect(usdcToAtoms("0.1")).toBe(100_000n);
    expect(usdcToAtoms("0.29")).toBe(290_000n);
  });
  test("rejects malformed", () => {
    expect(() => usdcToAtoms("")).toThrow();
    expect(() => usdcToAtoms("-1")).toThrow();
    expect(() => usdcToAtoms("1.2345678")).toThrow(); // > 6 decimals
    expect(() => usdcToAtoms("1e3")).toThrow();
    expect(() => usdcToAtoms("0x10")).toThrow();
    expect(() => usdcToAtoms("1,000")).toThrow();
  });
});

describe("atomsToUsdc", () => {
  test("round trips", () => {
    for (const s of ["0", "0.01", "25", "1.234567", "0.000001", "1000000"]) {
      expect(atomsToUsdc(usdcToAtoms(s))).toBe(s);
    }
  });
  test("trims trailing zeros", () => {
    expect(atomsToUsdc(100_000n)).toBe("0.1");
    expect(atomsToUsdc(25_000_000n)).toBe("25");
  });
  test("rejects negative", () => {
    expect(() => atomsToUsdc(-1n)).toThrow();
  });
});

describe("parseAtoms", () => {
  test("relayer requiredPaymentAmount shape", () => {
    expect(parseAtoms("10000")).toBe(10_000n);
    expect(parseAtoms("12821")).toBe(12_821n); // probe10 ROW2 swap fee
  });
  test("rejects non-digits", () => {
    expect(() => parseAtoms("0x10")).toThrow();
    expect(() => parseAtoms("10.5")).toThrow();
    expect(() => parseAtoms("")).toThrow();
  });
});
