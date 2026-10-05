/**
 * 插值服务：在存储层与 API/CLI 之间组织精确计算与报告。
 */
import { Fraction, parseRational } from './fraction.js';
import {
  NewtonInterpolation,
  NormalizedPoint,
  RawPoint,
  NewtonError,
  basisTerms,
  buildInterpolation,
  evaluateInterpolation,
  lagrangeEvaluate,
  normalizePoints,
  verifyInterpolatesExactly,
} from './newton.js';
import { Store, VersionRecord } from './storage.js';

export interface TableCell {
  level: number;
  index: number;
  value: string;
}

export interface InterpolationReport {
  versionId: number;
  setId: number;
  versionNo: number;
  algorithmVersion: string;
  /** 原始有序点（按输入次序） */
  orderedPoints: { index: number; x: string; y: string }[];
  /** 约分后的规范坐标（与原始一致，这里显式列出规范化结果） */
  normalizedPoints: { index: number; x: string; y: string; approx: { x: string; y: string } }[];
  /** 逐层差商证据：每一层的差商序列 */
  dividedDifferences: { level: number; values: { startIndex: number; value: string }[] }[];
  newtonForm: {
    coefficients: string[];
    basis: { degree: number; coefficient: string; factor: string }[];
    effectiveDegree: number;
    degreeConvention: string;
  };
  verification: { exact: boolean; failures: { index: number; expected: string; actual: string }[] };
}

const DEGREE_CONVENTION =
  '有效次数 = 最高非零 Newton 系数的阶；全零多项式次数约定为 -1（单点常量次数为 0）';

function factorString(degree: number): string {
  if (degree === 0) return '1';
  const parts = ['1'];
  for (let k = 0; k < degree; k++) parts.push(`(x - x${k})`);
  return parts.join(' * ');
}

export class InterpService {
  constructor(private store: Store) {}

  createSet(name: string, raw: RawPoint[]): { setId: number; report: InterpolationReport | null } {
    const points = normalizePoints(raw);
    const { setId, version } = this.store.createSet(name, points);
    this.store.recordHistory(setId, version?.id ?? null, 'create_set', { name, pointCount: raw.length }, {
      setId,
      versionId: version?.id ?? null,
    });
    return { setId, report: version ? this.report(version) : null };
  }

  appendPoint(setId: number, x: string, y: string): InterpolationReport {
    const point: NormalizedPoint = { x: parseRational(x), y: parseRational(y) };
    const version = this.store.appendPoint(setId, point);
    this.store.recordHistory(setId, version.id, 'append_point', { x, y }, { versionId: version.id });
    return this.report(version);
  }

  getReport(setId: number, versionId?: number): InterpolationReport {
    const v = versionId
      ? this.store.getVersion(versionId)
      : this.store.getLatestVersion(setId);
    return this.report(v);
  }

  private report(v: VersionRecord): InterpolationReport {
    const interp = this.store.rehydrate(v);
    const orderedPoints = interp.points.map((p, i) => ({
      index: i,
      x: p.x.toString(),
      y: p.y.toString(),
    }));
    const normalizedPoints = interp.points.map((p, i) => ({
      index: i,
      x: p.x.toString(),
      y: p.y.toString(),
      approx: { x: p.x.toApproxDecimal(), y: p.y.toApproxDecimal() },
    }));
    const dividedDifferences = interp.table.map((col, level) => ({
      level,
      values: col.map((value, startIndex) => ({ startIndex, value: value.toString() })),
    }));
    const basis = basisTerms(interp).map((t) => ({
      degree: t.degree,
      coefficient: t.coefficient.toString(),
      factor: factorString(t.degree),
    }));
    const vfy = verifyInterpolatesExactly(interp);
    return {
      versionId: v.id,
      setId: v.setId,
      versionNo: v.versionNo,
      algorithmVersion: v.algorithmVersion,
      orderedPoints,
      normalizedPoints,
      dividedDifferences,
      newtonForm: {
        coefficients: interp.coefficients.map((c) => c.toString()),
        basis,
        effectiveDegree: interp.effectiveDegree,
        degreeConvention: DEGREE_CONVENTION,
      },
      verification: { exact: vfy.ok, failures: vfy.failures },
    };
  }

  /** 精确求值：Newton 嵌套乘法，并列近似十进制展示。 */
  evaluate(setId: number, xInput: string, versionId?: number) {
    const v = versionId ? this.store.getVersion(versionId) : this.store.getLatestVersion(setId);
    const interp = this.store.rehydrate(v);
    const x = parseRational(xInput);
    const exact = evaluateInterpolation(interp, x);
    // 独立 Lagrange 交叉验证（精确相等）
    const lagrange = lagrangeEvaluate(interp.points, x);
    const crossCheck = exact.equals(lagrange);
    const result = {
      x: x.toString(),
      exact: exact.toString(),
      approx: exact.toApproxDecimal(),
      lagrangeExact: lagrange.toString(),
      crossCheck,
      versionId: v.id,
    };
    this.store.recordHistory(setId, v.id, 'evaluate', { x: xInput }, result);
    return result;
  }

  /**
   * 比较两个点序：对同一批点按给定两种顺序分别构造 Newton，
   * 在指定查询点对照结果（系数可不同，值必须精确相同）。
   */
  compareOrder(orderA: RawPoint[], orderB: RawPoint[], xInput: string) {
    const a = normalizePoints(orderA);
    const b = normalizePoints(orderB);
    if (a.length !== b.length) {
      throw new NewtonError('E_BAD_POINT', '两个点序点数不一致');
    }
    const setA = new Set(a.map((p) => `${p.x.toString()}@${p.y.toString()}`));
    for (const p of b) {
      if (!setA.has(`${p.x.toString()}@${p.y.toString()}`)) {
        throw new NewtonError('E_BAD_POINT', '两个点序必须包含完全相同的点集合');
      }
    }
    const interpA = buildInterpolation(a);
    const interpB = buildInterpolation(b);
    const x = parseRational(xInput);
    const va = evaluateInterpolation(interpA, x);
    const vb = evaluateInterpolation(interpB, x);
    return {
      x: x.toString(),
      orderA: { coefficients: interpA.coefficients.map((c) => c.toString()) },
      orderB: { coefficients: interpB.coefficients.map((c) => c.toString()) },
      valueA: va.toString(),
      valueB: vb.toString(),
      samePolynomialAtX: va.equals(vb),
      note: '点序改变可使 Newton 系数不同，但在 x 处求值必须精确相等',
    };
  }

  /** 有限采样位置导出：每个位置给精确分数与近似值。 */
  sample(setId: number, xs: string[], versionId?: number) {
    const v = versionId ? this.store.getVersion(versionId) : this.store.getLatestVersion(setId);
    const interp = this.store.rehydrate(v);
    const rows = xs.map((xInput) => {
      const x = parseRational(xInput);
      const exact = evaluateInterpolation(interp, x);
      return {
        x: x.toString(),
        exact: exact.toString(),
        approx: exact.toApproxDecimal(),
      };
    });
    this.store.recordHistory(setId, v.id, 'sample', { xs }, { count: rows.length });
    return { versionId: v.id, rows };
  }

  history(setId?: number, limit?: number) {
    return this.store.listHistory(setId, limit);
  }

  listSets() {
    return this.store.listSets();
  }

  listVersions(setId: number) {
    return this.store.listVersions(setId);
  }
}

export { Fraction, NewtonError };
