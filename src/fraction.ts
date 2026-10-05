/**
 * 精确有理数：全程 BigInt 分子/分母运算。
 * 不变式：d > 0，且 gcd(|n|, d) === 1。
 */

export const MAX_INPUT_DIGITS = 64;
export const MAX_INTERMEDIATE_DIGITS = 20000;

export class FractionError extends Error {
  constructor(
    public readonly code:
      | 'E_INVALID_RATIONAL'
      | 'E_ZERO_DENOMINATOR'
      | 'E_TOO_MANY_DIGITS'
      | 'E_BUDGET'
      | 'E_DIVISION_BY_ZERO',
    message: string,
  ) {
    super(message);
    this.name = 'FractionError';
  }
}

function bigAbs(a: bigint): bigint {
  return a < 0n ? -a : a;
}

export function gcd(a: bigint, b: bigint): bigint {
  a = bigAbs(a);
  b = bigAbs(b);
  while (b !== 0n) {
    [a, b] = [b, a % b];
  }
  return a;
}

function digitCount(a: bigint): number {
  return bigAbs(a).toString().length;
}

/** 检查中间结果位数预算，超限抛诊断而不是静默截断。 */
export function checkBudget(n: bigint, d: bigint): void {
  if (digitCount(n) > MAX_INTERMEDIATE_DIGITS || digitCount(d) > MAX_INTERMEDIATE_DIGITS) {
    throw new FractionError(
      'E_BUDGET',
      `中间结果超过 ${MAX_INTERMEDIATE_DIGITS} 位数字预算，拒绝继续计算`,
    );
  }
}

/**
 * 解析整数或 a/b 字符串。分母必须非零；不接受小数；分母统一转正并约分。
 */
export function parseRational(input: string | number | bigint): Fraction {
  if (typeof input === 'bigint') return Fraction.from(input, 1n);
  if (typeof input === 'number') {
    if (!Number.isSafeInteger(input)) {
      throw new FractionError(
        'E_INVALID_RATIONAL',
        `数值 ${String(input)} 不是安全整数，请改用整数或 a/b 字符串`,
      );
    }
    input = String(input);
  }
  const raw = input.trim();
  if (raw.length === 0) {
    throw new FractionError('E_INVALID_RATIONAL', '空字符串不是合法有理数');
  }
  if (!/^[+-]?\d+(\/[+-]?\d+)?$/.test(raw)) {
    throw new FractionError(
      'E_INVALID_RATIONAL',
      `"${input}" 不是合法的整数或 a/b 分数字面量（不接受小数）`,
    );
  }

  const slash = raw.indexOf('/');
  let numStr: string;
  let denStr: string;
  if (slash === -1) {
    numStr = raw;
    denStr = '1';
  } else {
    numStr = raw.slice(0, slash);
    denStr = raw.slice(slash + 1);
  }
  let n = BigInt(numStr);
  let d = BigInt(denStr);
  if (d === 0n) {
    throw new FractionError('E_ZERO_DENOMINATOR', `"${input}" 的分母为零`);
  }
  // 输入位数上限
  if (digitCount(n) > MAX_INPUT_DIGITS || digitCount(d) > MAX_INPUT_DIGITS) {
    throw new FractionError(
      'E_TOO_MANY_DIGITS',
      `输入分子或分母超过 ${MAX_INPUT_DIGITS} 位上限`,
    );
  }
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d);
  n /= g;
  d /= g;
  return new Fraction(n, d);
}

export class Fraction {
  constructor(
    public readonly n: bigint,
    public readonly d: bigint,
  ) {}

  static from(n: bigint, d: bigint): Fraction {
    if (d === 0n) throw new FractionError('E_DIVISION_BY_ZERO', '分母为零');
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const g = gcd(n, d);
    n /= g;
    d /= g;
    checkBudget(n, d);
    return new Fraction(n, d);
  }

  static ZERO = new Fraction(0n, 1n);
  static ONE = new Fraction(1n, 1n);

  isZero(): boolean {
    return this.n === 0n;
  }

  neg(): Fraction {
    return Fraction.from(-this.n, this.d);
  }

  add(o: Fraction): Fraction {
    return Fraction.from(this.n * o.d + o.n * this.d, this.d * o.d);
  }

  sub(o: Fraction): Fraction {
    return Fraction.from(this.n * o.d - o.n * this.d, this.d * o.d);
  }

  mul(o: Fraction): Fraction {
    return Fraction.from(this.n * o.n, this.d * o.d);
  }

  div(o: Fraction): Fraction {
    if (o.n === 0n) {
      throw new FractionError('E_DIVISION_BY_ZERO', '有理数除法：除数为零');
    }
    return Fraction.from(this.n * o.d, this.d * o.n);
  }

  /** 精确相等比较（不用浮点）。 */
  equals(o: Fraction): boolean {
    return this.n === o.n && this.d === o.d;
  }

  /** 规范字符串：整数不带 /1，负号统一在分子。 */
  toString(): string {
    return this.d === 1n ? this.n.toString() : `${this.n}/${this.d}`;
  }

  toJSON(): { n: string; d: string } {
    return { n: this.n.toString(), d: this.d.toString() };
  }

  static fromJSON(v: { n: string; d: string }): Fraction {
    return Fraction.from(BigInt(v.n), BigInt(v.d));
  }

  /**
   * 仅供展示的近似十进制，四舍五入到 scale 位小数；
   * 与精确分数并列显示，绝不回写数据库。
   */
  toApproxDecimal(scale = 12): string {
    const neg = this.n < 0n;
    const an = neg ? -this.n : this.n;
    const p = 10n ** BigInt(scale + 1);
    const q = (an * p) / this.d;
    const ten = 10n;
    const rounded = q / ten + (q % ten >= 5n ? 1n : 0n);
    const divisor = 10n ** BigInt(scale);
    const intPart = rounded / divisor;
    const fracPart = rounded % divisor;
    const fracStr = fracPart.toString().padStart(scale, '0').replace(/0+$/, '');
    let out: string;
    if (fracStr.length === 0) {
      out = intPart.toString();
    } else {
      out = `${intPart}.${fracStr}`;
    }
    if (neg && !(intPart === 0n && fracPart === 0n)) out = `-${out}`;
    return out;
  }
}
