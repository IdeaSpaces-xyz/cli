// The inventory of every server operation the CLI performs, derived from source.
//
// The failure this answers: the server retires a route, instruments the old
// one, and a bundle in the wild keeps calling it until a stranger reports a
// 404. Nothing compared what the CLI calls with what the server serves. This
// file makes the calling side a checked-in artifact — `contract/api-calls.json`
// — regenerated from `src/auth/api.ts`, so a change to the client fails a test
// until the inventory moves with it, and a parity check can hold the inventory
// against an OpenAPI document (see check-api-parity.mjs).
//
//   node scripts/api-calls.mjs            rewrite contract/api-calls.json
//   node scripts/api-calls.mjs --check    exit 1 if the checked-in file is stale
//
// Extraction is static: every `request(config, METHOD, PATH)` call and the raw
// `fetch(`${config.apiUrl}${path}`, { method })` streaming call. A path is
// evaluated symbolically — string parts kept, `${API_V1}` resolved, every
// interpolated value reduced to a `{placeholder}` named after its innermost
// identifier, a conditional suffix expanded into both alternatives, a query
// string dropped. An expression shape the evaluator does not know is an error,
// never a silently missing call: a new way of building a path must teach this
// file before it ships.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SOURCE = "src/auth/api.ts";
export const INVENTORY = "contract/api-calls.json";
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

class ShapeError extends Error {}

/** `{name}` for an expression that becomes a path segment at runtime. */
function placeholder(node, scope) {
  if (ts.isIdentifier(node)) {
    // Inside an inlined helper the parameter already carries the caller's name.
    const bound = scope?.lookup(node.text);
    return typeof bound === "string" && bound.startsWith("{") ? bound : `{${node.text}}`;
  }
  if (ts.isCallExpression(node)) {
    // encodeURIComponent(x), String(x), x.split("/").map(...).join("/")
    if (ts.isPropertyAccessExpression(node.expression)) return placeholder(node.expression.expression, scope);
    if (node.arguments.length) return placeholder(node.arguments[0], scope);
  }
  if (ts.isPropertyAccessExpression(node)) return `{${node.name.text}}`;
  throw new ShapeError(`cannot name a placeholder for ${node.getText()}`);
}

/** Every string a path expression can evaluate to, in the scope it sits in. */
function evaluate(node, scope) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isParenthesizedExpression(node)) return evaluate(node.expression, scope);
  if (ts.isTemplateExpression(node)) {
    let results = [node.head.text];
    for (const span of node.templateSpans) {
      const values = evaluate(span.expression, scope);
      results = results.flatMap((prefix) => values.map((v) => prefix + v + span.literal.text));
    }
    return results;
  }
  if (ts.isConditionalExpression(node)) {
    return [...evaluate(node.whenTrue, scope), ...evaluate(node.whenFalse, scope)];
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = evaluate(node.left, scope);
    const right = evaluate(node.right, scope);
    return left.flatMap((l) => right.map((r) => l + r));
  }
  if (ts.isIdentifier(node)) {
    const bound = scope.lookup(node.text);
    if (bound === undefined) throw new ShapeError(`unbound identifier ${node.text}`);
    if (typeof bound === "string") return [bound];
    return evaluate(bound, scope);
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    if (ts.isIdentifier(callee)) {
      const fn = scope.lookupFunction(callee.text);
      if (fn) return evaluateFunction(fn, node.arguments, scope);
    }
    return [placeholder(node, scope)];
  }
  if (ts.isPropertyAccessExpression(node)) return [placeholder(node, scope)];
  throw new ShapeError(`unknown path shape: ${node.getText()}`);
}

/** Inline a module-level helper (`repoBase`, `filesPath`, …) with its arguments as placeholders. */
function evaluateFunction(fn, args, scope) {
  const bindings = new Map();
  fn.parameters.forEach((param, i) => {
    bindings.set(param.name.getText(), args[i] ? placeholder(args[i], scope) : `{${param.name.getText()}}`);
  });
  const inner = scope.child(bindings, fn.body);
  if (!ts.isBlock(fn.body)) return evaluate(fn.body, inner);
  const ret = fn.body.statements.find(ts.isReturnStatement);
  if (!ret?.expression) throw new ShapeError(`helper ${fn.name?.getText() ?? "(arrow)"} has no return`);
  return evaluate(ret.expression, inner);
}

/** Lexical scope: parameters become placeholders, local consts evaluate, module consts resolve. */
class Scope {
  constructor(sourceFile, parent = null, bindings = new Map(), body = null) {
    this.sourceFile = sourceFile;
    this.parent = parent;
    this.bindings = bindings;
    this.body = body;
  }
  child(bindings, body) {
    return new Scope(this.sourceFile, this, bindings, body);
  }
  lookup(name) {
    if (this.bindings.has(name)) return this.bindings.get(name);
    const local = this.body ? findConst(this.body, name) : null;
    if (local) return local;
    if (this.parent) return this.parent.lookup(name);
    const moduleConst = findConst(this.sourceFile, name);
    if (moduleConst) return moduleConst;
    return undefined;
  }
  lookupFunction(name) {
    for (const statement of this.sourceFile.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
      if (ts.isVariableStatement(statement)) {
        for (const decl of statement.declarationList.declarations) {
          if (decl.name.getText() === name && decl.initializer && ts.isArrowFunction(decl.initializer)) {
            return decl.initializer;
          }
        }
      }
    }
    return null;
  }
}

/** The initializer of `const <name> = …` declared directly inside `container`. */
function findConst(container, name) {
  const statements = ts.isSourceFile(container) || ts.isBlock(container) ? container.statements : [];
  for (const statement of statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const decl of statement.declarationList.declarations) {
      if (decl.name.getText() === name && decl.initializer) return decl.initializer;
    }
  }
  return null;
}

/** Placeholders for every parameter of the function enclosing `node`. */
function enclosingScope(node, sourceFile) {
  let current = node;
  while (current && !ts.isFunctionLike(current)) current = current.parent;
  if (!current) return new Scope(sourceFile);
  const bindings = new Map();
  for (const param of current.parameters) bindings.set(param.name.getText(), `{${param.name.getText()}}`);
  return new Scope(sourceFile, new Scope(sourceFile), bindings, current.body);
}

function stripQuery(path) {
  const i = path.indexOf("?");
  return i >= 0 ? path.slice(0, i) : path;
}

/** Every method a call can use: a literal, or a conditional between literals. */
function methodsOf(node) {
  if (ts.isStringLiteral(node) && METHODS.has(node.text)) return [node.text];
  if (ts.isParenthesizedExpression(node)) return methodsOf(node.expression);
  if (ts.isConditionalExpression(node)) return [...methodsOf(node.whenTrue), ...methodsOf(node.whenFalse)];
  throw new ShapeError(`method is not a literal: ${node.getText()}`);
}

function record(calls, methodNode, pathNode, scope) {
  for (const method of methodsOf(methodNode)) {
    for (const path of evaluate(pathNode, scope)) calls.push({ method, path: stripQuery(path) });
  }
}

/** All `{ method, path }` operations `source` performs, sorted and unique. */
export function extractApiCalls(source, fileName = SOURCE) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const calls = [];
  const fail = (node, error) => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    throw new Error(`${fileName}:${line + 1}: ${error.message}`);
  };
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const scope = enclosingScope(node, sourceFile);
      try {
        if (node.expression.text === "request" && node.arguments.length >= 3) {
          record(calls, node.arguments[1], node.arguments[2], scope);
        } else if (node.expression.text === "fetch" && node.arguments.length >= 2) {
          // fetch(`${config.apiUrl}${path}`, { method: "POST", … })
          const url = node.arguments[0];
          const init = node.arguments[1];
          if (!ts.isTemplateExpression(url) || !ts.isObjectLiteralExpression(init)) {
            throw new ShapeError("fetch call is not `${config.apiUrl}${path}` with an options literal");
          }
          const spans = url.templateSpans;
          if (spans.length !== 2 || spans[0].expression.getText() !== "config.apiUrl") {
            throw new ShapeError("fetch URL must be `${config.apiUrl}${path}`");
          }
          const methodProp = init.properties.find((p) => p.name?.getText() === "method");
          // `request()` itself: `{ method, … }` forwards its parameter. That is the
          // transport, not an operation — every operation names its method literally.
          if (methodProp && ts.isShorthandPropertyAssignment(methodProp)) return;
          if (!methodProp || !ts.isPropertyAssignment(methodProp)) {
            throw new ShapeError("fetch options carry no literal method");
          }
          record(calls, methodProp.initializer, spans[1].expression, scope);
        }
      } catch (error) {
        if (error instanceof ShapeError) fail(node, error);
        throw error;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const unique = new Map(calls.map((c) => [`${c.method} ${c.path}`, c]));
  return [...unique.values()].sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
}

export function renderInventory(calls) {
  return JSON.stringify({ source: SOURCE, generated_by: "scripts/api-calls.mjs", calls }, null, 2) + "\n";
}

function main() {
  const calls = extractApiCalls(readFileSync(join(root, SOURCE), "utf8"));
  const rendered = renderInventory(calls);
  const target = join(root, INVENTORY);
  if (process.argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(target, "utf8");
    } catch {
      // missing counts as stale
    }
    if (current !== rendered) {
      process.stderr.write(`${INVENTORY} is stale — run: node scripts/api-calls.mjs\n`);
      process.exit(1);
    }
    process.stdout.write(`${INVENTORY} matches ${SOURCE}: ${calls.length} operations.\n`);
    return;
  }
  writeFileSync(target, rendered);
  process.stdout.write(`Wrote ${INVENTORY}: ${calls.length} operations.\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
