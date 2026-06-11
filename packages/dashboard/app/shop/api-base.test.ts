import { describe, expect, test } from "bun:test";
import { shopApiBase } from "./api-base";

// shop routes live at the server ROOT: the env var points at .../api and the
// helper must strip exactly that suffix (and nothing inside the host/path).
describe("shopApiBase", () => {
  test("strips the trailing /api", () => {
    expect(shopApiBase("http://localhost:4070/api")).toBe("http://localhost:4070");
  });

  test("tolerates a trailing slash", () => {
    expect(shopApiBase("http://localhost:4070/api/")).toBe("http://localhost:4070");
  });

  test("leaves a bare origin alone", () => {
    expect(shopApiBase("http://localhost:4070")).toBe("http://localhost:4070");
  });

  test("works on the prod url shape", () => {
    expect(shopApiBase("https://remit-api.s0nderlabs.xyz/api")).toBe("https://remit-api.s0nderlabs.xyz");
  });

  test("only strips /api as a path SUFFIX, not inside the host", () => {
    expect(shopApiBase("https://api.example.com/api")).toBe("https://api.example.com");
  });

  test("defaults to localhost when unset or empty", () => {
    expect(shopApiBase(undefined)).toBe("http://localhost:4070");
    expect(shopApiBase("")).toBe("http://localhost:4070");
  });
});
