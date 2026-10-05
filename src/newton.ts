/**
 * Newton 差商插值（精确有理数实现）。
 *
 * Newton 形式：
 *   P(x) = c0
 *        + c1 * (x - x0)
 *        + c2 * (x - x0)(x - x1)
 *        + ...
 *        + c_{n-1} * (x - x0)...(x - x_{n-2})
 *
 * 系数 c_k 正是按节点输入次序计算的第 k 阶差商 f[x0,...,xk]。
 * 全程使用 BigInt 有理数，不使用浮点，也不调用任何插值/符号代数库。
 */

import {
  Rational,
  RationalError,
  ZERO,
  div,
  eq,
  isZero,
  parseRational,
  sub,
} from './rational.js';

export const MAX_NODES = 30;
export const ALGO_VERSION = 'newton-divided-difference:1';

export interface Point {
  x: Rational;
  y: Rational;
}

export interface RawPoint {
  x: unknown;
  y: unknown;
}

/** 差商表的一列：level=0 为原始 y，level=k 为 k 阶差商。 */
export interface DifferenceTable {
  /** table[level][i] = f[x_i, ..., x_{i+level}]，按层组织。 */
  table: Rational[][];
}

export interface NewtonModel {
  nodes: Point[]; // 保持输入次序的节点
  coefficients: Rational[]; // c0..c_{n-1}
  differenceTable: DifferenceTable;
  /** 实际有效次数：最高阶非零系数的下标；全零多项式约定为 0（见 README）。 */
  degree: number;
  algoVersion: string;
}

/** 解析并严格校验一批点：横坐标必须两两互不相同（精确比较）。 */
export function parsePoints(raw: RawPoint[]): Point[] {
  if (!Array.isArray(raw)) {
    throw new RationalError('INVALID_BATCH', '点集必须是数组');
  }
  if (raw.length === 0) return [];
  if (raw.length > MAX_NODES) {
    throw new RationalError(
      'TOO_MANY_NODES',
      `节点数 ${raw.length} 超过上限 ${MAX_NODES}`
    );
  }
  const points: Point[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || !('x' in item) || !('y' in item)) {
      throw new RationalError('INVALID_BATCH', '每个点必须是包含 x 与 y 的对象', JSON.stringify(item));
    }
    points.push({ x: parseRational(item.x), y: parseRational(item.y) });
  }
  // 精确检查重复横坐标；即使 y 相同也明确拒绝，绝不合并。
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      if (eq(points[i].x, points[j].x)) {
        throw new RationalError(
          'DUPLICATE_X',
          `第 ${i} 个与第 ${j} 个点横坐标相同，重复横坐标不允许`,
          `${i},${j}`
        );
      }
    }
  }
  return points;
}

/**
 * 构造完整差商表。
 * 递推：f[x_i..x_j] = (f[x_{i+1}..x_j] - f[x_i..x_{j-1}]) / (x_j - x_i)。
 * 分母 x_j - x_i 不可能为零：横坐标已被证明两两不同（精确比较）。
 */
export function buildDifferenceTable(nodes: Point[]): DifferenceTable {
  const n = nodes.length;
  const table: Rational[][] = [];
  table.push(nodes.map((p) => p.y));
  for (let level = 1; level < n; level++) {
    const prev = table[level - 1];
    const col: Rational[] = [];
    for (let i = 0; i + level < n; i++) {
      const j = i + level;
      const numerator = sub(prev[i + 1], prev[i]);
      const denominator = sub(nodes[j].x, nodes[i].x);
      // 这里若意外除以零一定是前置校验被绕过，直接失败而非继续。
      if (isZero(denominator)) {
        throw new RationalError('DENOMINATOR_ZERO', '差商分母为零（存在重复横坐标）');
      }
      col.push(div(numerator, denominator));
    }
    table.push(col);
  }
  return { table };
}

export function effectiveDegree(coefficients: Rational[]): number {
  // 全零（含空系数集）约定次数为 0：唯一的零次基底是常数 1，常数 0 视为零次多项式。
  let d = 0;
  for (let k = 0; k < coefficients.length; k++) {
    if (!isZero(coefficients[k])) d = k;
  }
  return d;
}

/** 由有序点集构造 Newton 插值模型。空点集返回 null（可保存但不能发报告）。 */
export function interpolate(points: Point[]): NewtonModel | null {
  if (points.length === 0) return null;
  const { table } = buildDifferenceTable(points);
  const coefficients = table.map((col) => col[0]);
  return {
    nodes: points,
    coefficients,
    differenceTable: { table },
    degree: effectiveDegree(coefficients),
    algoVersion: ALGO_VERSION,
  };
}

/**
 * 增量差商：在已有模型后追加一个横坐标不同的新点。
 * 保留原节点次序与全部已有系数，仅计算一个新的高阶系数：
 *
 *   c_n = (y_new - P_old(x_new)) / ((x_new-x0)(x_new-x1)...(x_new-x_{n-1}))
 *
 * 新点若已在原多项式上，差值为精确零，c_n 即为精确 0/1，而非“接近零的小数”。
 */
export function appendPoint(
  model: NewtonModel,
  rawX: unknown,
  rawY: unknown
): NewtonModel {
  const px = parseRational(rawX);
  const py = parseRational(rawY);
  for (let i = 0; i < model.nodes.length; i++) {
    if (eq(model.nodes[i].x, px)) {
      throw new RationalError(
        'DUPLICATE_X',
        `新点横坐标与第 ${i} 个已有节点相同，拒绝追加`,
        String(i)
      );
    }
  }
  if (model.nodes.length >= MAX_NODES) {
    throw new RationalError('TOO_MANY_NODES', `节点数已达上限 ${MAX_NODES}`);
  }
  const oldValue = evaluate(model, px);
  let basis = parseRational('1');
  for (const node of model.nodes) {
    basis = mulRational(basis, sub(px, node.x));
  }
  if (isZero(basis)) {
    // 理论上不可达（x_new 与所有 x_i 不同），保留以防被绕过。
    throw new RationalError('DENOMINATOR_ZERO', '新增系数基底值为零');
  }
  const newCoeff = div(sub(py, oldValue), basis);
  const nodes = [...model.nodes, { x: px, y: py }];
  const coefficients = [...model.coefficients, newCoeff];
  return {
    nodes,
    coefficients,
    differenceTable: buildDifferenceTable(nodes),
    degree: effectiveDegree(coefficients),
    algoVersion: ALGO_VERSION,
  };
}

// 内部直接引用四则运算，避免与下方导出命名冲突。
import { mul as mulRational } from './rational.js';

/**
 * Newton 嵌套乘法（Horner 式）求值：
 *   P = c_{n-1}
 *   P = P*(x - x_{k}) + c_k   （k 从 n-2 递减到 0）
 */
export function evaluate(model: NewtonModel, x: Rational): Rational {
  const n = model.nodes.length;
  if (n === 0) throw new RationalError('EMPTY_DATASET', '空数据集无法求值');
  let acc = model.coefficients[n - 1] ?? ZERO;
  for (let k = n - 2; k >= 0; k--) {
    acc = mulRational(acc, sub(x, model.nodes[k].x));
    acc = addRational(acc, model.coefficients[k]);
  }
  return acc;
}

import { add as addRational } from './rational.js';

/**
 * 独立参照实现：Lagrange 公式
 *   L(x) = Σ y_i * Π_{j≠i} (x - x_j)/(x_i - x_j)
 * 与 Newton 实现完全独立，仅用于测试/对照，不参与服务计算。
 */
export function lagrangeEvaluate(points: Point[], x: Rational): Rational {
  const n = points.length;
  if (n === 0) throw new RationalError('EMPTY_DATASET', '空数据集无法求值');
  let sum = ZERO;
  for (let i = 0; i < n; i++) {
    let term = points[i].y;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const denom = sub(points[i].x, points[j].x);
      if (isZero(denom)) throw new RationalError('DENOMINATOR_ZERO', 'Lagrange 基底分母为零');
      term = mulRational(term, div(sub(x, points[j].x), denom));
    }
    sum = addRational(sum, term);
  }
  return sum;
}

/** 基底的文字描述，用于报告：basis[0] = "1"，basis[k] = "(x-x0)...(x-x{k-1})"。 */
export function basisDescriptions(n: number): string[] {
  const out: string[] = ['1'];
  for (let k = 1; k < n; k++) {
    const factors: string[] = [];
    for (let j = 0; j < k; j++) factors.push(`(x - x${j})`);
    out.push(factors.join(''));
  }
  return out;
}
