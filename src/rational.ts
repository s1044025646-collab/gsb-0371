/**
 * 精确有理数：BigInt 分子 / 分母。
 * 不变量：den > 0，且 num/den 已约分；零规范化为 0/1。
 * 所有比较均为精确比较，不使用任何浮点近似。
 */

export const MAX_DIGITS = 80; // 单个整数字符串（含分子分母）允许的最大十进制位数
export const MAX_INTERMEDIATE_BITS = 8192; // 中间结果（分子或分母）允许的最大二进制位数

export type ErrorCode =
  | 'DENOMINATOR_ZERO'
  | 'INVALID_NUMBER_FORMAT'
  | 'NUMBER_TOO_LARGE'
  | 'INTERMEDIATE_BUDGET_EXCEEDED'
  | 'DUPLICATE_X'
  | 'TOO_MANY_NODES'
  | 'EMPTY_DATASET'
  | 'NOT_FOUND'
  | 'INVALID_BATCH'
  | 'BAD_REQUEST';

export class RationalError extends Error {
  readonly code: ErrorCode;
  readonly detail?: string;
  constructor(code: ErrorCode, message: string, detail?: string) {
    super(message);
    this.name = 'RationalError';
    this.code = code;
    this.detail = detail;
  }
}

export interface Rational {
  num: bigint;
  den: bigint;
}

function digitCount(s: string): number {
  return s.replace(/^[+-]/, '').length;
}

function bigAbsBits(v: bigint): number {
  const a = v < 0n ? -v : v;
  return a.toString(2).length;
}

/** 对单个输入整数字符串做位数上限检查。 */
function checkInputDigits(intPart: string, raw: string): void {
  if (digitCount(intPart) > MAX_DIGITS) {
    throw new RationalError(
      'NUMBER_TOO_LARGE',
      `输入整数超过 ${MAX_DIGITS} 位上限`,
      raw
    );
  }
}

function make(num: bigint, den: bigint): Rational {
  if (den === 0n) throw new RationalError('DENOMINATOR_ZERO', '分母不能为零');
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  if (num === 0n) return { num: 0n, den: 1n };
  const g = gcd(num < 0n ? -num : num, den);
  return { num: num / g, den: den / g };
}

/** 对中间运算结果做二进制位数预算检查。 */
function checkBudget(r: Rational, where: string): Rational {
  const bits = Math.max(bigAbsBits(r.num), bigAbsBits(r.den));
  if (bits > MAX_INTERMEDIATE_BITS) {
    throw new RationalError(
      'INTERMEDIATE_BUDGET_EXCEEDED',
      `中间结果超过 ${MAX_INTERMEDIATE_BITS} 位（二进制）计算预算`,
      where
    );
  }
  return r;
}

export function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a;
}

export const ZERO: Rational = { num: 0n, den: 1n };
export const ONE: Rational = { num: 1n, den: 1n };

/**
 * 解析一个点坐标。
 * 接受：number（仅安全整数）、bigint、整数字符串 "3"/"-3"、分数字符串 "1/2"/"-1/-2"。
 * 不接受小数、指数记法。
 */
export function parseRational(input: unknown): Rational {
  if (typeof input === 'bigint') return make(input, 1n);
  if (typeof input === 'number') {
    if (!Number.isSafeInteger(input)) {
      throw new RationalError(
        'INVALID_NUMBER_FORMAT',
        'number 类型只接受安全整数；分数或大整数请用字符串',
        String(input)
      );
    }
    return make(BigInt(input), 1n);
  }
  if (typeof input !== 'string') {
    throw new RationalError('INVALID_NUMBER_FORMAT', '坐标必须是整数或 a/b 字符串', String(input));
  }
  const raw = input.trim();
  if (raw === '') {
    throw new RationalError('INVALID_NUMBER_FORMAT', '空字符串不是合法数字');
  }
  const parts = raw.split('/');
  if (parts.length > 2) {
    throw new RationalError('INVALID_NUMBER_FORMAT', '分数最多包含一个 "/"', raw);
  }
  const intRe = /^[+-]?\d+$/;
  const numStr = parts[0].trim();
  if (!intRe.test(numStr)) {
    throw new RationalError('INVALID_NUMBER_FORMAT', '分子必须是十进制整数', raw);
  }
  checkInputDigits(numStr, raw);
  const num = BigInt(numStr);
  if (parts.length === 1) return make(num, 1n);
  const denStr = parts[1].trim();
  if (!intRe.test(denStr)) {
    throw new RationalError('INVALID_NUMBER_FORMAT', '分母必须是十进制整数', raw);
  }
  checkInputDigits(denStr, raw);
  const den = BigInt(denStr);
  if (den === 0n) throw new RationalError('DENOMINATOR_ZERO', '分母不能为零', raw);
  return make(num, den);
}

export function fromBigInts(num: bigint, den: bigint): Rational {
  return checkBudget(make(num, den), 'fromBigInts');
}

export function isZero(a: Rational): boolean {
  return a.num === 0n;
}

export function eq(a: Rational, b: Rational): boolean {
  // 两者都已规范化，直接比较分子分母即可（同值有唯一表示）。
  return a.num === b.num && a.den === b.den;
}

export function neg(a: Rational): Rational {
  return { num: -a.num, den: a.den };
}

export function add(a: Rational, b: Rational): Rational {
  return checkBudget(make(a.num * b.den + b.num * a.den, a.den * b.den), 'add');
}

export function sub(a: Rational, b: Rational): Rational {
  return checkBudget(make(a.num * b.den - b.num * a.den, a.den * b.den), 'sub');
}

export function mul(a: Rational, b: Rational): Rational {
  return checkBudget(make(a.num * b.num, a.den * b.den), 'mul');
}

export function div(a: Rational, b: Rational): Rational {
  if (b.num === 0n) throw new RationalError('DENOMINATOR_ZERO', '有理数除以零');
  return checkBudget(make(a.num * b.den, a.den * b.num), 'div');
}

/** "a/b" 或整数形式的规范字符串。 */
export function toFractionString(a: Rational): string {
  if (a.den === 1n) return a.num.toString();
  return `${a.num.toString()}/${a.den.toString()}`;
}

/**
 * 仅用于展示的十进制近似。显式截断（非四舍五入）到 12 位小数，
 * 永远不会写回数据库，也不会用于任何判断。
 */
export function toApproxDecimal(a: Rational, fracDigits = 12): string {
  const negative = a.num < 0n;
  const num = negative ? -a.num : a.num;
  const scale = 10n ** BigInt(fracDigits);
  const whole = num / a.den;
  const frac = (num % a.den) * scale / a.den;
  const sign = negative && (whole !== 0n || frac !== 0n) ? '-' : '';
  return `${sign}${whole.toString()}.${frac.toString().padStart(fracDigits, '0')}`;
}

export function serialize(a: Rational): string {
  return toFractionString(a);
}
