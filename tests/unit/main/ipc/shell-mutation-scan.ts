/**
 * Static scanner for the IPC handler map: finds every channel whose handler
 * spawns, kills, removes or records a shell (`ptyManager.spawn/kill`,
 * `shells.upsert/remove`), directly or through any same-file helper it
 * references, transitively. A mutation is recognised when the method is
 * read off a receiver named `ptyManager`/`shells` (an identifier, or a
 * property or string-literal element access), through any mix of `?.`, `!`,
 * parentheses, `as` and `satisfies`, whether or not it is called on the
 * spot. Shapes that hide the receiver or method make the scan throw instead
 * of passing the handler: a computed key on the receiver or method, the
 * receiver used as a value rather than as the object of a member access
 * (aliased, passed to a function, stored, returned, truth-tested), and any
 * destructuring of a receiver name (declaration, parameter or assignment).
 * Such a shape only throws when a handler reaches it, so code outside the
 * handlers' helper closure may use it freely. Spreads in the map
 * (`...dropHandlers`) are followed into same-file constants or imported
 * modules; a spread or handler key it cannot read throws. Not covered:
 * helpers imported from other modules and called by a handler (only spreads
 * are followed across files), a services object whose receivers live under
 * property names other than `ptyManager`/`shells`, and dynamic access such
 * as `Reflect.get` or `eval`.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

const MUTATIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  ptyManager: new Set(['spawn', 'kill']),
  shells: new Set(['upsert', 'remove']),
};
const RECEIVERS: ReadonlySet<string> = new Set(Object.keys(MUTATIONS));
const MUTATING_METHODS: ReadonlySet<string> = new Set(Object.values(MUTATIONS).flatMap((m) => [...m]));

/** Result of scanning one handler map: every channel seen, and those that mutate shells. */
export interface HandlerScan {
  readonly channels: readonly string[];
  readonly mutating: readonly string[];
}

/** Maps a module specifier to a source path; returns null for packages the scan cannot follow. */
export type ModuleResolver = (specifier: string, fromFile: string) => string | null;

interface BodyScan {
  readonly direct: boolean;
  readonly refs: ReadonlySet<string>;
  readonly unreadable: string | null;
}

interface ParsedFile {
  readonly file: string;
  readonly source: ts.SourceFile;
  readonly locals: ReadonlyMap<string, ts.Node>;
  readonly imports: ReadonlyMap<string, { specifier: string; name: string }>;
  readonly mutatingLocals: ReadonlySet<string>;
  readonly unreadableLocals: ReadonlyMap<string, string>;
}

type Member = ts.PropertyAccessExpression | ts.ElementAccessExpression;

function isWrapper(node: ts.Node): node is ts.NonNullExpression | ts.ParenthesizedExpression | ts.AsExpression | ts.SatisfiesExpression | ts.TypeAssertion {
  return ts.isNonNullExpression(node) || ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node);
}

function unwrap(expr: ts.Expression): ts.Expression {
  return isWrapper(expr) ? unwrap(expr.expression) : expr;
}

function isMember(node: ts.Node): node is Member {
  return ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);
}

function memberName(node: Member): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  const key = node.argumentExpression;
  return ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key) ? key.text : null;
}

function receiverName(expr: ts.Expression): string | null {
  const inner = unwrap(expr);
  if (ts.isIdentifier(inner)) return inner.text;
  return isMember(inner) ? memberName(inner) : null;
}

function isShellMutation(node: ts.Node): boolean {
  if (!isMember(node)) return false;
  const method = memberName(node);
  const receiver = receiverName(node.expression);
  return method !== null && receiver !== null && (MUTATIONS[receiver]?.has(method) ?? false);
}

function usedAsMemberObject(node: ts.Node): boolean {
  let outer = node;
  while (isWrapper(outer.parent)) outer = outer.parent;
  return isMember(outer.parent) && outer.parent.expression === outer;
}

function bindingKey(node: ts.BindingElement): string | null {
  const key = node.propertyName ?? node.name;
  return ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : null;
}

function isAssignmentTarget(obj: ts.ObjectLiteralExpression): boolean {
  const parent = obj.parent;
  return ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.left === obj;
}

function destructuredKey(node: ts.Node): string | null {
  if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) return bindingKey(node);
  if (!ts.isObjectLiteralElement(node) || !ts.isObjectLiteralExpression(node.parent) || !isAssignmentTarget(node.parent)) return null;
  const name = node.name;
  return name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : null;
}

function memberHides(node: Member): boolean {
  const name = memberName(node);
  if (name === null) return RECEIVERS.has(receiverName(node.expression) ?? '') || (isMember(node.parent) && MUTATING_METHODS.has(memberName(node.parent) ?? ''));
  return RECEIVERS.has(name) && !usedAsMemberObject(node);
}

function unreadableShape(node: ts.Node): string | null {
  const key = destructuredKey(node);
  if (key !== null && RECEIVERS.has(key)) return `destructured ${key}`;
  if (isMember(node) && memberHides(node)) return node.getText().slice(0, 60);
  return null;
}

function scanBody(body: ts.Node, localNames: ReadonlySet<string>): BodyScan {
  const refs = new Set<string>();
  let direct = false;
  let unreadable: string | null = null;
  const visit = (node: ts.Node): void => {
    if (isShellMutation(node)) direct = true;
    unreadable ??= unreadableShape(node);
    if (ts.isIdentifier(node) && localNames.has(node.text)) refs.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(body);
  return { direct, refs, unreadable };
}

function collectLocals(source: ts.SourceFile): Map<string, ts.Node> {
  const locals = new Map<string, ts.Node>();
  for (const stmt of source.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) locals.set(stmt.name.text, stmt);
    if (ts.isClassDeclaration(stmt) && stmt.name) locals.set(stmt.name.text, stmt);
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.initializer) locals.set(decl.name.text, decl.initializer);
    }
  }
  return locals;
}

function collectImports(source: ts.SourceFile): Map<string, { specifier: string; name: string }> {
  const imports = new Map<string, { specifier: string; name: string }>();
  for (const stmt of source.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      imports.set(el.name.text, { specifier: stmt.moduleSpecifier.text, name: (el.propertyName ?? el.name).text });
    }
  }
  return imports;
}

function transitiveClosure(scans: ReadonlyMap<string, BodyScan>, seed: (s: BodyScan) => string | null): Map<string, string> {
  const reached = new Map<string, string>();
  for (const [name, s] of scans) {
    const reason = seed(s);
    if (reason !== null) reached.set(name, reason);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, s] of scans) {
      const via = reached.has(name) ? undefined : [...s.refs].find((r) => reached.has(r));
      if (via === undefined) continue;
      reached.set(name, `${via}: ${reached.get(via)}`);
      grew = true;
    }
  }
  return reached;
}

function parseFile(file: string, text: string): ParsedFile {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const locals = collectLocals(source);
  const names = new Set(locals.keys());
  const scans = new Map([...locals].map(([name, node]) => [name, scanBody(node, names)]));
  return {
    file,
    source,
    locals,
    imports: collectImports(source),
    mutatingLocals: new Set(transitiveClosure(scans, (s) => (s.direct ? 'mutates' : null)).keys()),
    unreadableLocals: transitiveClosure(scans, (s) => s.unreadable),
  };
}

function propertyKey(prop: ts.ObjectLiteralElementLike, file: string): string {
  const name = prop.name;
  if (name && (ts.isStringLiteral(name) || ts.isIdentifier(name))) return name.text;
  throw new Error(`${file}: unreadable handler key at ${prop.getText().slice(0, 60)}`);
}

function handlerMutates(channel: string, node: ts.Node, parsed: ParsedFile): boolean {
  const s = scanBody(node, new Set(parsed.locals.keys()));
  if (s.unreadable !== null) throw new Error(`${parsed.file}: ${channel}: cannot analyse ${s.unreadable}`);
  const helper = [...s.refs].find((r) => parsed.unreadableLocals.has(r));
  if (helper !== undefined) throw new Error(`${parsed.file}: ${channel}: cannot analyse helper ${helper}: ${parsed.unreadableLocals.get(helper)}`);
  return s.direct || [...s.refs].some((r) => parsed.mutatingLocals.has(r));
}

interface ScanContext {
  readonly read: (file: string) => string;
  readonly resolveModule: ModuleResolver;
}

function scanObject(obj: ts.ObjectLiteralExpression, parsed: ParsedFile, ctx: ScanContext, out: Map<string, boolean>): void {
  for (const prop of obj.properties) {
    if (ts.isSpreadAssignment(prop)) {
      scanSpread(prop.expression, parsed, ctx, out);
      continue;
    }
    if (ts.isShorthandPropertyAssignment(prop)) {
      out.set(prop.name.text, handlerMutates(prop.name.text, prop.name, parsed));
      continue;
    }
    const channel = propertyKey(prop, parsed.file);
    out.set(channel, handlerMutates(channel, prop, parsed));
  }
}

function asObjectLiteral(node: ts.Node | undefined): ts.ObjectLiteralExpression | null {
  let current = node;
  while (current && (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current))) {
    current = current.expression;
  }
  return current && ts.isObjectLiteralExpression(current) ? current : null;
}

function scanSpread(expr: ts.Expression, parsed: ParsedFile, ctx: ScanContext, out: Map<string, boolean>): void {
  if (!ts.isIdentifier(expr)) throw new Error(`${parsed.file}: cannot follow spread ${expr.getText()}`);
  const local = asObjectLiteral(parsed.locals.get(expr.text));
  if (local) return scanObject(local, parsed, ctx, out);
  const imported = parsed.imports.get(expr.text);
  const target = imported ? ctx.resolveModule(imported.specifier, parsed.file) : null;
  if (!imported || !target) throw new Error(`${parsed.file}: cannot follow spread ${expr.text}`);
  scanNamedObject(target, imported.name, ctx, out);
}

function scanNamedObject(file: string, name: string, ctx: ScanContext, out: Map<string, boolean>): void {
  const parsed = parseFile(file, ctx.read(file));
  const obj = asObjectLiteral(parsed.locals.get(name));
  if (!obj) throw new Error(`${file}: ${name} is not an object literal`);
  scanObject(obj, parsed, ctx, out);
}

/**
 * Scans the object literal bound to `mapName` in `file` and reports every
 * channel key plus those whose handler mutates shells. `read` and
 * `resolveModule` are injectable so the scanner itself can be tested on
 * synthetic sources. Throws when the map or any spread cannot be read.
 */
export function scanHandlerMap(file: string, mapName: string, read: (f: string) => string, resolveModule: ModuleResolver): HandlerScan {
  const out = new Map<string, boolean>();
  scanNamedObject(file, mapName, { read, resolveModule }, out);
  return {
    channels: [...out.keys()],
    mutating: [...out].filter(([, m]) => m).map(([channel]) => channel),
  };
}

/** Resolves `@main/…` and relative specifiers to `.ts` files under `srcRoot`; packages resolve to null. */
export function srcResolver(srcRoot: string): ModuleResolver {
  return (specifier, fromFile) => {
    if (specifier.startsWith('@main/')) return resolve(srcRoot, 'main', `${specifier.slice('@main/'.length)}.ts`);
    if (specifier.startsWith('.')) return resolve(dirname(fromFile), `${specifier}.ts`);
    return null;
  };
}

/** Reads a source file as UTF-8. */
export const readSource = (file: string): string => readFileSync(file, 'utf8');
