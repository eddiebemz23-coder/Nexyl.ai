// Safe arithmetic evaluator (recursive descent). No eval().
// Supports + - * / % ^ ( ), unary minus, decimals, and a few functions.

const FUNCS = {
  sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor,
  ceil: Math.ceil, sin: Math.sin, cos: Math.cos, tan: Math.tan,
  ln: Math.log, log: Math.log10,
};
const CONSTS = { pi: Math.PI, e: Math.E };

function tokenize(src) {
  const tokens = [];
  const re = /\s*(\d+\.?\d*|\.\d+|[a-z]+|[-+*/%^()])/giy;
  let m, last = 0;
  while ((m = re.exec(src)) !== null) {
    tokens.push(m[1].toLowerCase());
    last = re.lastIndex;
  }
  if (src.slice(last).trim() !== '') throw new Error('Unexpected character in expression');
  return tokens;
}

function evaluate(src) {
  const t = tokenize(src);
  let i = 0;
  const peek = () => t[i];
  const next = () => t[i++];

  function expr() {
    let v = term();
    while (peek() === '+' || peek() === '-') v = next() === '+' ? v + term() : v - term();
    return v;
  }
  function term() {
    let v = power();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = next();
      const r = power();
      if (op === '*') v *= r;
      else if (op === '/') {
        if (r === 0) throw new Error('Division by zero');
        v /= r;
      } else v %= r;
    }
    return v;
  }
  function power() {
    const base = unary();
    if (peek() === '^') { next(); return Math.pow(base, power()); } // right-assoc
    return base;
  }
  function unary() {
    if (peek() === '-') { next(); return -unary(); }
    if (peek() === '+') { next(); return unary(); }
    return atom();
  }
  function atom() {
    const tok = next();
    if (tok === undefined) throw new Error('Unexpected end of expression');
    if (tok === '(') {
      const v = expr();
      if (next() !== ')') throw new Error('Missing closing parenthesis');
      return v;
    }
    if (/^[\d.]/.test(tok)) return parseFloat(tok);
    if (tok in CONSTS) return CONSTS[tok];
    if (tok in FUNCS) {
      if (next() !== '(') throw new Error(`Expected "(" after ${tok}`);
      const v = expr();
      if (next() !== ')') throw new Error('Missing closing parenthesis');
      return FUNCS[tok](v);
    }
    throw new Error(`Unknown token "${tok}"`);
  }

  const result = expr();
  if (i < t.length) throw new Error('Unexpected token "' + t[i] + '"');
  if (!Number.isFinite(result)) throw new Error('Result is not a finite number');
  return result;
}

function format(n) {
  return Number.isInteger(n) ? String(n) : String(parseFloat(n.toPrecision(12)));
}

module.exports = { evaluate, format };
