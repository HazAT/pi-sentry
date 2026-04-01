import { describe, it, expect } from "vitest";
import { splitCommand, createSentryCLI } from "../sentry-cli.js";

describe("splitCommand", () => {
  it("splits basic args", () => {
    expect(splitCommand("issue list --limit 5")).toEqual(["issue", "list", "--limit", "5"]);
  });

  it("handles double-quoted strings", () => {
    expect(splitCommand('issue list --query "is:unresolved assigned:me"')).toEqual([
      "issue",
      "list",
      "--query",
      "is:unresolved assigned:me",
    ]);
  });

  it("handles single-quoted strings", () => {
    expect(splitCommand("issue list --query 'is:unresolved'")).toEqual([
      "issue",
      "list",
      "--query",
      "is:unresolved",
    ]);
  });

  it("returns empty array for empty string", () => {
    expect(splitCommand("")).toEqual([]);
  });

  it("handles extra whitespace", () => {
    expect(splitCommand("  auth   status  ")).toEqual(["auth", "status"]);
  });

  it("preserves content inside quotes with spaces", () => {
    expect(splitCommand('trace view "abc 123 def"')).toEqual(["trace", "view", "abc 123 def"]);
  });

  it("handles mixed quotes", () => {
    expect(splitCommand(`issue list --query "title:'my error'"`)).toEqual([
      "issue",
      "list",
      "--query",
      "title:'my error'",
    ]);
  });

  it("keeps escaped spaces in a single argument", () => {
    expect(splitCommand("trace view abc\\ 123")).toEqual(["trace", "view", "abc 123"]);
  });

  it("keeps escaped quotes inside double quotes", () => {
    expect(splitCommand('issue list --query "title=\\"my error\\""')).toEqual([
      "issue",
      "list",
      "--query",
      'title="my error"',
    ]);
  });

  it("treats an unterminated quote as part of the final argument", () => {
    expect(splitCommand('issue list --query "oops')).toEqual(["issue", "list", "--query", "oops"]);
  });
});

describe("createSentryCLI", () => {
  it("returns object with expected methods", () => {
    const cli = createSentryCLI();
    expect(typeof cli.run).toBe("function");
    expect(typeof cli.authStatus).toBe("function");
    expect(typeof cli.authLogin).toBe("function");
    expect(typeof cli.issueList).toBe("function");
  });
});
