import { test, expect } from "bun:test";
import {
  isIdentifierName,
  findDeclarations,
  filterReferences,
  findReferences,
  registerDeclarationFinder,
  registerReferenceRefiner,
} from "../web/code-nav.js";

test("isIdentifierName accepts identifier-shaped strings only", () => {
  expect(isIdentifierName("foo")).toBe(true);
  expect(isIdentifierName("_bar$2")).toBe(true);
  expect(isIdentifierName("$")).toBe(true);
  expect(isIdentifierName("2foo")).toBe(false);
  expect(isIdentifierName("a-b")).toBe(false);
  expect(isIdentifierName("")).toBe(false);
  expect(isIdentifierName(null as unknown as string)).toBe(false);
});

// --- declaration finding (js / ts) ---

test("findDeclarations locates function / class / const declarations in JavaScript", () => {
  const src = [
    "import { helper } from './h.js';",
    "",
    "function greet(name) {",
    "  return helper(name);",
    "}",
    "",
    "const greet2 = () => {};",
    "class Greeter {}",
    "greet('x');",
  ].join("\n");
  expect(findDeclarations(src, "javascript", "greet")).toEqual([{ line: 3, column: "function ".length }]);
  expect(findDeclarations(src, "javascript", "greet2")).toEqual([{ line: 7, column: "const ".length }]);
  expect(findDeclarations(src, "javascript", "Greeter")).toEqual([{ line: 8, column: "class ".length }]);
  expect(findDeclarations(src, "javascript", "helper")).toEqual([{ line: 1, column: "import { ".length }]);
});

test("findDeclarations locates interface / type / enum declarations in TypeScript", () => {
  const src = [
    "export interface Widget {",
    "  id: number;",
    "}",
    "type WidgetId = number;",
    "enum Color { Red, Green }",
    "let widget: Widget;",
  ].join("\n");
  expect(findDeclarations(src, "typescript", "Widget")).toEqual([{ line: 1, column: "export interface ".length }]);
  expect(findDeclarations(src, "typescript", "WidgetId")).toEqual([{ line: 4, column: "type ".length }]);
  expect(findDeclarations(src, "typescript", "Color")).toEqual([{ line: 5, column: "enum ".length }]);
});

test("findDeclarations does not treat property access or substrings as declarations", () => {
  const src = [
    "obj.function = 1;",
    "const greeting = makeGreeting();",
    "doGreet();",
  ].join("\n");
  expect(findDeclarations(src, "javascript", "greet")).toEqual([]);
});

test("findDeclarations returns every matching line", () => {
  const src = ["function f() {}", "function f() {}"].join("\n");
  expect(findDeclarations(src, "javascript", "f")).toEqual([
    { line: 1, column: "function ".length },
    { line: 2, column: "function ".length },
  ]);
});

// --- declaration finding (go) ---

test("findDeclarations locates func / method / type / var declarations in Go", () => {
  const src = [
    "package main",
    "",
    "type Server struct {}",
    "",
    "func New() *Server { return &Server{} }",
    "",
    "func (s *Server) Start() error {",
    "\tcount := 0",
    "\tfor i := range items {",
    "\t\tcount += i",
    "\t}",
    "\treturn nil",
    "}",
    "var defaultServer *Server",
  ].join("\n");
  expect(findDeclarations(src, "go", "Server")).toEqual([{ line: 3, column: "type ".length }]);
  expect(findDeclarations(src, "go", "New")).toEqual([{ line: 5, column: "func ".length }]);
  expect(findDeclarations(src, "go", "Start")).toEqual([{ line: 7, column: "func (s *Server) ".length }]);
  expect(findDeclarations(src, "go", "count")).toEqual([{ line: 8, column: "\tcount := 0".indexOf("count") }]);
  expect(findDeclarations(src, "go", "i")).toEqual([{ line: 9, column: "\tfor i".indexOf("i", 1) }]);
  expect(findDeclarations(src, "go", "defaultServer")).toEqual([{ line: 14, column: "var ".length }]);
});

test("findDeclarations returns [] for unknown languages or non-identifier symbols", () => {
  expect(findDeclarations("function f(){}", "no-such-lang", "f")).toEqual([]);
  expect(findDeclarations("function f(){}", "javascript", "f(")).toEqual([]);
  expect(findDeclarations("function f(){}", "javascript", "")).toEqual([]);
});

test("registerDeclarationFinder installs a finder for a new language", () => {
  registerDeclarationFinder("decl-test-lang", (src: string, name: string) =>
    src.split("\n").flatMap((line, i) => (line.includes(`DEF ${name}`) ? [{ line: i + 1, column: line.indexOf(name) }] : [])),
  );
  expect(findDeclarations("noise\nDEF zonk here", "decl-test-lang", "zonk")).toEqual([{ line: 2, column: 4 }]);
});

// --- references ---

test("filterReferences keeps only whole-word, case-exact occurrences", () => {
  const raw = [
    { path: "a.ts", line: 1, text: "const state = makeState();" },
    { path: "a.ts", line: 2, text: "stateful = true;" },
    { path: "b.ts", line: 9, text: "obj.State.update();" },
    { path: "b.ts", line: 10, text: "  return state.value;" },
  ];
  expect(filterReferences(raw, "state")).toEqual([
    { path: "a.ts", line: 1, text: "const state = makeState();" },
    { path: "b.ts", line: 10, text: "  return state.value;" },
  ]);
});

test("findReferences applies the default whole-word filter when no refiner is registered", () => {
  const raw = [
    { path: "a.go", line: 1, text: "x := foo()" },
    { path: "a.go", line: 2, text: "foobar()" },
  ];
  expect(findReferences(raw, "go", "foo")).toEqual([{ path: "a.go", line: 1, text: "x := foo()" }]);
});

test("registerReferenceRefiner can further narrow the default-filtered matches", () => {
  registerReferenceRefiner("ref-test-lang", (matches: { path: string }[]) => matches.filter(m => m.path.endsWith(".keep")));
  const raw = [
    { path: "a.keep", line: 1, text: "use foo" },
    { path: "b.drop", line: 1, text: "use foo" },
  ];
  expect(findReferences(raw, "ref-test-lang", "foo")).toEqual([{ path: "a.keep", line: 1, text: "use foo" }]);
});
