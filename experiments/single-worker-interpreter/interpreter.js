// n8n の式を「コード生成せずに」評価するツリーウォーク型インタプリタ。
// @n8n/tournament が生成した関数本体を esprima で AST 化し、直接解釈する。
// new Function も eval も使わないため、単一の Cloudflare Worker で完結する。
import * as esprima from 'esprima-next';

const RETURN = Symbol('return');

// 式から触れてよい組み込みだけを明示的に許可する（allowlist 方式）。
// globalThis を直接晒さないため、Worker のバインディングや fetch には到達できない。
const SAFE_GLOBALS = {
  Boolean, Number, String, Array, Object, Math, JSON, Date, RegExp,
  parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
  encodeURI, decodeURI, Map, Set, Symbol, BigInt, Error, TypeError, RangeError,
  Infinity, NaN, undefined,
};

class Scope {
  constructor(parent, thisVal) {
    this.vars = new Map();
    this.parent = parent;
    this.thisVal = parent && thisVal === undefined ? parent.thisVal : thisVal;
  }
  declare(name, value) { this.vars.set(name, value); }
  has(name) {
    return this.vars.has(name)
      || (this.parent ? this.parent.has(name) : Object.prototype.hasOwnProperty.call(SAFE_GLOBALS, name));
  }
  get(name) {
    if (this.vars.has(name)) return this.vars.get(name);
    if (this.parent) return this.parent.get(name);
    if (Object.prototype.hasOwnProperty.call(SAFE_GLOBALS, name)) return SAFE_GLOBALS[name];
    throw new ReferenceError(name + ' is not defined');
  }
  set(name, value) {
    if (this.vars.has(name)) { this.vars.set(name, value); return; }
    if (this.parent && this.parent.has(name)) { this.parent.set(name, value); return; }
    this.vars.set(name, value);
  }
}

// プロトタイプ汚染・関数合成の遮断。tournament の AST フックでも弾かれるが二重に防ぐ。
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype', '__defineGetter__', '__defineSetter__']);

function member(obj, key) {
  if (obj === null || obj === undefined) {
    throw new TypeError(`Cannot read properties of ${obj} (reading '${key}')`);
  }
  if (BLOCKED_KEYS.has(String(key))) {
    throw new Error(`Cannot access "${key}" due to security concerns`);
  }
  return obj[key];
}

const BINARY = {
  '+': (a, b) => a + b, '-': (a, b) => a - b, '*': (a, b) => a * b, '/': (a, b) => a / b,
  '%': (a, b) => a % b, '**': (a, b) => a ** b,
  '==': (a, b) => a == b, '!=': (a, b) => a != b,
  '===': (a, b) => a === b, '!==': (a, b) => a !== b,
  '<': (a, b) => a < b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '>=': (a, b) => a >= b,
  '&': (a, b) => a & b, '|': (a, b) => a | b, '^': (a, b) => a ^ b,
  '<<': (a, b) => a << b, '>>': (a, b) => a >> b, '>>>': (a, b) => a >>> b,
  'in': (a, b) => a in b, 'instanceof': (a, b) => a instanceof b,
};

const UNARY = {
  '-': (v) => -v, '+': (v) => +v, '!': (v) => !v, '~': (v) => ~v, 'typeof': (v) => typeof v, 'void': () => undefined,
};

function evaluate(node, scope) {
  switch (node.type) {
    case 'Literal': return node.value;
    case 'Identifier': return scope.get(node.name);
    case 'ThisExpression': return scope.thisVal;

    case 'ChainExpression':
      // a?.b?.c — 途中が null/undefined なら undefined を返す
      try { return evaluate(node.expression, scope); }
      catch (e) { if (e && e.__optionalShortCircuit) return undefined; throw e; }

    case 'MemberExpression': {
      const obj = evaluate(node.object, scope);
      if (node.optional && (obj === null || obj === undefined)) {
        const e = new Error('optional short-circuit'); e.__optionalShortCircuit = true; throw e;
      }
      const key = node.computed ? evaluate(node.property, scope) : node.property.name;
      return member(obj, key);
    }

    case 'CallExpression': {
      let thisArg, fn;
      if (node.callee.type === 'MemberExpression') {
        thisArg = evaluate(node.callee.object, scope);
        if (node.callee.optional && (thisArg === null || thisArg === undefined)) {
          const e = new Error('optional short-circuit'); e.__optionalShortCircuit = true; throw e;
        }
        const key = node.callee.computed ? evaluate(node.callee.property, scope) : node.callee.property.name;
        fn = member(thisArg, key);
      } else {
        thisArg = undefined;
        fn = evaluate(node.callee, scope);
      }
      const args = [];
      for (const a of node.arguments) {
        if (a.type === 'SpreadElement') args.push(...evaluate(a.argument, scope));
        else args.push(evaluate(a, scope));
      }
      if (node.optional && (fn === null || fn === undefined)) {
        const e = new Error('optional short-circuit'); e.__optionalShortCircuit = true; throw e;
      }
      if (typeof fn !== 'function') throw new TypeError('not a function');
      return fn.apply(thisArg, args);
    }

    case 'ArrowFunctionExpression':
    case 'FunctionExpression': {
      const isArrow = node.type === 'ArrowFunctionExpression';
      return function (...args) {
        // アロー関数は this を継承、function 式は呼び出し側の this を使う
        const fnScope = new Scope(scope, isArrow ? scope.thisVal : this);
        node.params.forEach((p, i) => bindPattern(p, args[i], fnScope));
        if (isArrow && node.body.type !== 'BlockStatement') return evaluate(node.body, fnScope);
        const r = execute(node.body, fnScope);
        return r && r[RETURN] !== undefined ? r.value : undefined;
      };
    }

    case 'BinaryExpression': {
      const op = BINARY[node.operator];
      if (!op) throw new Error('unsupported operator: ' + node.operator);
      return op(evaluate(node.left, scope), evaluate(node.right, scope));
    }
    case 'LogicalExpression': {
      const l = evaluate(node.left, scope);
      if (node.operator === '&&') return l ? evaluate(node.right, scope) : l;
      if (node.operator === '||') return l ? l : evaluate(node.right, scope);
      if (node.operator === '??') return l ?? evaluate(node.right, scope);
      throw new Error('unsupported operator: ' + node.operator);
    }
    case 'UnaryExpression': {
      const op = UNARY[node.operator];
      if (!op) throw new Error('unsupported operator: ' + node.operator);
      return op(evaluate(node.argument, scope));
    }
    case 'ConditionalExpression':
      return evaluate(node.test, scope) ? evaluate(node.consequent, scope) : evaluate(node.alternate, scope);

    case 'ArrayExpression': {
      const out = [];
      for (const el of node.elements) {
        if (el === null) { out.length += 1; continue; }
        if (el.type === 'SpreadElement') out.push(...evaluate(el.argument, scope));
        else out.push(evaluate(el, scope));
      }
      return out;
    }
    case 'ObjectExpression': {
      const out = {};
      for (const p of node.properties) {
        if (p.type === 'SpreadElement') { Object.assign(out, evaluate(p.argument, scope)); continue; }
        const key = p.computed ? evaluate(p.key, scope) : (p.key.name ?? p.key.value);
        if (BLOCKED_KEYS.has(String(key))) throw new Error(`Cannot access "${key}" due to security concerns`);
        out[key] = evaluate(p.value, scope);
      }
      return out;
    }
    case 'TemplateLiteral': {
      let s = '';
      node.quasis.forEach((q, i) => {
        s += q.value.cooked;
        if (i < node.expressions.length) s += String(evaluate(node.expressions[i], scope));
      });
      return s;
    }
    case 'SequenceExpression': {
      let v;
      for (const e of node.expressions) v = evaluate(e, scope);
      return v;
    }
    case 'AssignmentExpression': {
      const v = evaluate(node.right, scope);
      if (node.left.type === 'Identifier') {
        if (node.operator === '=') scope.set(node.left.name, v);
        else scope.set(node.left.name, BINARY[node.operator.slice(0, -1)](scope.get(node.left.name), v));
        return scope.get(node.left.name);
      }
      if (node.left.type === 'MemberExpression') {
        const obj = evaluate(node.left.object, scope);
        const key = node.left.computed ? evaluate(node.left.property, scope) : node.left.property.name;
        if (BLOCKED_KEYS.has(String(key))) throw new Error(`Cannot access "${key}" due to security concerns`);
        obj[key] = v;
        return v;
      }
      throw new Error('unsupported assignment target');
    }
    default:
      throw new Error('unsupported expression node: ' + node.type);
  }
}

function bindPattern(pattern, value, scope) {
  if (pattern.type === 'Identifier') { scope.declare(pattern.name, value); return; }
  if (pattern.type === 'ArrayPattern') {
    pattern.elements.forEach((el, i) => el && bindPattern(el, value?.[i], scope));
    return;
  }
  if (pattern.type === 'ObjectPattern') {
    for (const p of pattern.properties) {
      const key = p.computed ? evaluate(p.key, scope) : (p.key.name ?? p.key.value);
      bindPattern(p.value, member(value, key), scope);
    }
    return;
  }
  if (pattern.type === 'AssignmentPattern') {
    bindPattern(pattern.left, value === undefined ? evaluate(pattern.right, scope) : value, scope);
    return;
  }
  throw new Error('unsupported param pattern: ' + pattern.type);
}

// 文の実行。return が起きたら { [RETURN]: true, value } を返して伝播させる。
function execute(node, scope) {
  switch (node.type) {
    case 'BlockStatement': {
      const inner = new Scope(scope);
      for (const st of node.body) {
        const r = execute(st, inner);
        if (r) return r;
      }
      return null;
    }
    case 'VariableDeclaration':
      for (const d of node.declarations) {
        bindPattern(d.id, d.init ? evaluate(d.init, scope) : undefined, scope);
      }
      return null;
    case 'ExpressionStatement':
      evaluate(node.expression, scope);
      return null;
    case 'ReturnStatement':
      return { [RETURN]: true, value: node.argument ? evaluate(node.argument, scope) : undefined };
    case 'IfStatement':
      if (evaluate(node.test, scope)) return execute(node.consequent, scope);
      return node.alternate ? execute(node.alternate, scope) : null;
    case 'TryStatement': {
      try {
        return execute(node.block, scope);
      } catch (err) {
        if (!node.handler) throw err;
        const cs = new Scope(scope);
        if (node.handler.param) bindPattern(node.handler.param, err, cs);
        return execute(node.handler.body, cs);
      } finally {
        if (node.finalizer) execute(node.finalizer, scope);
      }
    }
    case 'EmptyStatement':
      return null;
    default:
      throw new Error('unsupported statement node: ' + node.type);
  }
}

/**
 * tournament が生成した関数本体ソースを AST 化する。
 * ここは同期処理で、eval も new Function も使わない。
 */
export function compile(code) {
  const program = esprima.parseScript(`(function(E){${code}\n})`);
  const fnNode = program.body[0].expression;
  return { params: fnNode.params, body: fnNode.body };
}

/** コンパイル済み AST を data（= this）と errorHandler E のもとで評価する。完全に同期。 */
export function run(compiled, data, errorHandler) {
  const scope = new Scope(null, data);
  scope.declare('E', errorHandler);
  const r = execute(compiled.body, scope);
  return r && r[RETURN] ? r.value : undefined;
}
