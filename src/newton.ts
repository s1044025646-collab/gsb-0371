/**
 * Newton 插值核心：自行计算差商并构造 Newton 形式。
 * 不调用任何现成插值或符号代数库。
 */
import { Fraction, FractionError, parseRational } from './fraction.js';

export const ALGORITHM_VERSION = 'newton-exact-bigint-v1';
export const MAX_NODES = 30;

export class NewtonError extends Error {
  constructor(
    public readonly code:
      | 'E_DUPLICATE_X'
      | 'E_TOO_MANY_NODES'
      | 'E_EMPTY_SET'
      | 'E_BAD_POINT'
      | 'E_DIVISION_BY_ZERO',
    message: string,
  ) {
    super(message);
    this.name = 'NewtonError';
  }
}

export interface RawPoint {
  x: string | number | bigint;
  y: string | number | bigint;
}

export interface NormalizedPoint {
  x: Fraction;
  y: Fraction;
}

/** 一层差商：level=0 为函数值列，level=k 为 k 阶差商列 */
export interface DividedDifferenceTable {
  /** table[k][i] = 以点 i..i+k 计算的 k 阶差商 */
  table: Fraction[][];
}

export interface NewtonBasisTerm {
  degree: number;
  coefficient: Fraction;
  /** 该系数乘的基底节点：degree k 对应 (x-x0)...(x-x{k-1}) */
  basisNodes: Fraction[];
}

export interface NewtonInterpolation {
  points: NormalizedPoint[];
  coefficients: Fraction[];
  table: Fraction[][];
  /** 实际有效次数：最高非零 Newton 系数的阶；全零多项式约定为 -1 */
  effectiveDegree: number;
  algorithmVersion: string;
}

/** 解析并规范化一个批次的点，同时检查重复横坐标（精确比较）。 */
export function normalizePoints(raw: RawPoint[]): NormalizedPoint[] {
  if (raw.length > MAX_NODES) {
    throw new NewtonError(
      'E_TOO_MANY_NODES',
      `节点数 ${raw.length} 超过上限 ${MAX_NODES}`,
    );
  }
  const pts: NormalizedPoint[] = [];
  for (let i = 0; i < raw.length; i++) {
    const rp: RawPoint | undefined = raw[i];
    if (!rp || typeof rp !== 'object' || rp.x === undefined || rp.y === undefined) {
      throw new NewtonError('E_BAD_POINT', `第 ${i + 1} 个点格式错误，需要 {x, y}`);
    }
    let x: Fraction;
    let y: Fraction;
    try {
      x = parseRational(rp.x);
    } catch (e) {
      throw new NewtonError(
        'E_BAD_POINT',
        `第 ${i + 1} 个点横坐标非法：${(e as Error).message}`,
      );
    }
    try {
      y = parseRational(rp.y);
    } catch (e) {
      throw new NewtonError(
        'E_BAD_POINT',
        `第 ${i + 1} 个点纵坐标非法：${(e as Error).message}`,
      );
    }
    pts.push({ x, y });
  }
  // 精确 BigInt 比较重复横坐标，即使 y 相同也拒绝
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const pi = pts[i]!;
      const pj = pts[j]!;
      if (pi.x.equals(pj.x)) {
        throw new NewtonError(
          'E_DUPLICATE_X',
          `重复横坐标 x=${pi.x.toString()}（出现在第 ${i + 1} 与第 ${j + 1} 个点），即使纵坐标相同也拒绝导入`,
        );
      }
    }
  }
  return pts;
}

/** 追加一个点时，同样以精确比较拒绝与既有节点重复的横坐标。 */
export function checkXNotPresent(points: NormalizedPoint[], x: Fraction): void {
  if (points.length >= MAX_NODES) {
    throw new NewtonError('E_TOO_MANY_NODES', `节点数已达上限 ${MAX_NODES}`);
  }
  for (const p of points) {
    if (p.x.equals(x)) {
      throw new NewtonError(
        'E_DUPLICATE_X',
        `横坐标 x=${x.toString()} 已存在，拒绝重复导入（不会尝试除以零）`,
      );
    }
  }
}

/**
 * 计算完整差商表。
 * 递推：f[i..j] = (f[i+1..j] - f[i..j-1]) / (x_j - x_i)
 */
export function dividedDifferenceTable(points: NormalizedPoint[]): Fraction[][] {
  const n = points.length;
  const col: Fraction[][] = [];
  col.push(points.map((p): Fraction => p.y));
  for (let k = 1; k < n; k++) {
    const prev: Fraction[] = col[k - 1]!;
    const cur: Fraction[] = [];
    for (let i = 0; i + k < n; i++) {
      const xRight = points[i + k]!.x;
      const xLeft = points[i]!.x;
      const denom = xRight.sub(xLeft);
      if (denom.isZero()) {
        // 理论上被重复横坐标检查拦截，这里是防御性分支
        throw new NewtonError('E_DIVISION_BY_ZERO', '差商分母 x_j - x_i 为零');
      }
      cur.push(prev[i + 1]!.sub(prev[i]!).div(denom));
    }
    col.push(cur);
  }
  return col;
}

function effectiveDegreeOf(coeffs: Fraction[]): number {
  for (let k = coeffs.length - 1; k >= 0; k--) {
    if (!coeffs[k]!.isZero()) return k;
  }
  return -1; // 全零多项式次数约定为 -1
}

/** 构造 Newton 插值：系数 c_k = table[k][0]。 */
export function buildInterpolation(points: NormalizedPoint[]): NewtonInterpolation {
  if (points.length === 0) {
    throw new NewtonError('E_EMPTY_SET', '空数据集不能生成插值报告');
  }
  const table = dividedDifferenceTable(points);
  const coefficients: Fraction[] = table.map((col) => col[0]!);
  return {
    points,
    coefficients,
    table,
    effectiveDegree: effectiveDegreeOf(coefficients),
    algorithmVersion: ALGORITHM_VERSION,
  };
}

/**
 * 增量追加：保留既有节点次序与已有 Newton 系数，只增加一个高阶系数。
 * c_new = (y_new - P_old(x_new)) / Π_{i<n}(x_new - x_i)
 * 分母为基低在新点处的值；新点横坐标互不相同保证分母非零。
 */
export function appendPoint(
  interp: NewtonInterpolation,
  point: NormalizedPoint,
): NewtonInterpolation {
  checkXNotPresent(interp.points, point.x);
  const points = [...interp.points, point];
  const oldValue = evaluateInterpolation(interp, point.x);
  let basisValue = Fraction.ONE;
  for (const p of interp.points) {
    basisValue = basisValue.mul(point.x.sub(p.x));
  }
  if (basisValue.isZero()) {
    throw new NewtonError('E_DIVISION_BY_ZERO', '新点处 Newton 基底值为零');
  }
  const newCoeff = point.y.sub(oldValue).div(basisValue);
  const coefficients = [...interp.coefficients, newCoeff];
  // 重算完整表用于展示（与增量系数一致，全部为精确值）
  const table = dividedDifferenceTable(points);
  return {
    points,
    coefficients,
    table,
    effectiveDegree: effectiveDegreeOf(coefficients),
    algorithmVersion: ALGORITHM_VERSION,
  };
}

/**
 * Newton 嵌套乘法（Horner 式）：
 * P(x) = c0 + (x-x0)(c1 + (x-x1)(c2 + ... (c{n-1})...))
 */
export function evaluateInterpolation(interp: NewtonInterpolation, x: Fraction): Fraction {
  const c = interp.coefficients;
  const xs = interp.points;
  let value: Fraction = c[c.length - 1]!;
  for (let k = c.length - 2; k >= 0; k--) {
    value = value.mul(x.sub(xs[k]!.x)).add(c[k]!);
  }
  return value;
}

/** 基底项报告：阶数、系数、参与的节点。 */
export function basisTerms(interp: NewtonInterpolation): NewtonBasisTerm[] {
  return interp.coefficients.map((coefficient, degree) => ({
    degree,
    coefficient,
    basisNodes: interp.points.slice(0, degree).map((p) => p.x),
  }));
}

/**
 * 独立 Lagrange 公式求值（仅用于交叉验证，与 Newton 实现相互独立）：
 * P(x) = Σ y_i Π_{j≠i} (x-x_j)/(x_i-x_j)
 */
export function lagrangeEvaluate(points: NormalizedPoint[], x: Fraction): Fraction {
  if (points.length === 0) {
    throw new NewtonError('E_EMPTY_SET', '空数据集不能求值');
  }
  let sum = Fraction.ZERO;
  for (let i = 0; i < points.length; i++) {
    let term: Fraction = points[i]!.y;
    for (let j = 0; j < points.length; j++) {
      if (j === i) continue;
      const pi = points[i]!;
      const pj = points[j]!;
      const denom = pi.x.sub(pj.x);
      if (denom.isZero()) {
        throw new NewtonError('E_DIVISION_BY_ZERO', 'Lagrange 分母为零');
      }
      term = term.mul(x.sub(pj.x).div(denom));
    }
    sum = sum.add(term);
  }
  return sum;
}

/** 逐个代回原数据点，必须精确相等（不使用浮点容差）。 */
export function verifyInterpolatesExactly(interp: NewtonInterpolation): {
  ok: boolean;
  failures: { index: number; expected: string; actual: string }[];
} {
  const failures: { index: number; expected: string; actual: string }[] = [];
  interp.points.forEach((p, i) => {
    const actual = evaluateInterpolation(interp, p.x);
    if (!actual.equals(p.y)) {
      failures.push({ index: i, expected: p.y.toString(), actual: actual.toString() });
    }
  });
  return { ok: failures.length === 0, failures };
}

export { FractionError };
