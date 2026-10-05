import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Fraction, FractionError, parseRational } from '../src/fraction.js';
import {
  NewtonError,
  appendPoint,
  buildInterpolation,
  evaluateInterpolation,
  lagrangeEvaluate,
  normalizePoints,
  verifyInterpolatesExactly,
} from '../src/newton.js';
import { Store } from '../src/storage.js';
import { InterpService } from '../src/service.js';

function tempStore(): { store: Store; svc: InterpService } {
  const dir = mkdtempSync(join(tmpdir(), 'newton-test-'));
  const store = new Store(join(dir, 't.db'));
  return { store, svc: new InterpService(store) };
}

test('分数解析：负分母规范化与约分', () => {
  assert.equal(parseRational('1/-2').toString(), '-1/2');
  assert.equal(parseRational('-2/-4').toString(), '1/2');
  assert.equal(parseRational('2/-4').toString(), '-1/2');
  assert.equal(parseRational('6').toString(), '6');
  assert.equal(parseRational('0/5').toString(), '0');
});

test('分数运算精确', () => {
  const a = parseRational('1/3');
  const b = parseRational('1/6');
  assert.equal(a.add(b).toString(), '1/2');
  assert.equal(a.sub(b).toString(), '1/6');
  assert.equal(a.mul(b).toString(), '1/18');
  assert.equal(a.div(b).toString(), '2');
});

test('非法输入：分母零/格式错误/位数超限', () => {
  assert.throws(
    () => parseRational('1/0'),
    (e: FractionError) => e.code === 'E_ZERO_DENOMINATOR',
  );
  assert.throws(() => parseRational('1.5'), (e: FractionError) => e.code === 'E_INVALID_RATIONAL');
  assert.throws(() => parseRational('abc'), (e: FractionError) => e.code === 'E_INVALID_RATIONAL');
  const huge = '9'.repeat(65);
  assert.throws(() => parseRational(`${huge}/1`), (e: FractionError) => e.code === 'E_TOO_MANY_DIGITS');
});

test('演示：x^2+x+1 与 x=3 得 13', () => {
  const pts = normalizePoints([
    { x: '0', y: '1' },
    { x: '1', y: '3' },
    { x: '2', y: '7' },
  ]);
  const interp = buildInterpolation(pts);
  assert.deepEqual(interp.coefficients.map((c) => c.toString()), ['1', '2', '1']);
  assert.equal(interp.effectiveDegree, 2);
  assert.equal(evaluateInterpolation(interp, parseRational('3')).toString(), '13');
  assert.equal(verifyInterpolatesExactly(interp).ok, true);
});

test('追加共线点：最高新增系数为精确零，旧点值不变', () => {
  let interp = buildInterpolation(
    normalizePoints([
      { x: '0', y: '1' },
      { x: '1', y: '3' },
      { x: '2', y: '7' },
    ]),
  );
  interp = appendPoint(interp, normalizePoints([{ x: '3', y: '13' }])[0]!);
  const top: Fraction = interp.coefficients[3]!;
  assert.ok(top.isZero(), '最高系数必须精确为 0');
  assert.equal(interp.effectiveDegree, 2);
  for (const p of [
    ['0', '1'],
    ['1', '3'],
    ['2', '7'],
    ['3', '13'],
  ] as const) {
    assert.equal(evaluateInterpolation(interp, parseRational(p[0])).toString(), p[1]);
  }
});

test('重复横坐标即使 y 相同也拒绝', () => {
  assert.throws(
    () => normalizePoints([
      { x: '1/2', y: '1' },
      { x: '2/4', y: '1' },
    ]),
    (e: NewtonError) => e.code === 'E_DUPLICATE_X',
  );
});

test('单点常量，全零多项式次数约定 -1', () => {
  const c = buildInterpolation(normalizePoints([{ x: '5', y: '7' }]));
  assert.equal(c.effectiveDegree, 0);
  assert.equal(evaluateInterpolation(c, parseRational('100')).toString(), '7');
  const z = buildInterpolation(normalizePoints([
    { x: '0', y: '0' },
    { x: '1', y: '0' },
    { x: '2', y: '0' },
  ]));
  assert.equal(z.effectiveDegree, -1);
  assert.equal(evaluateInterpolation(z, parseRational('9/2')).toString(), '0');
});

test('不同点序系数不同但代表同一多项式：多查询点 Lagrange 独立核对', () => {
  const raw = [
    { x: '-1/2', y: '1/3' },
    { x: '0', y: '2' },
    { x: '1/4', y: '-1/2' },
    { x: '3', y: '5' },
  ];
  const a = buildInterpolation(normalizePoints(raw));
  const b = buildInterpolation(normalizePoints([...raw].reverse()));
  const queries = ['0', '1/3', '-2', '7/8', '10', '-5/6'];
  for (const q of queries) {
    const x = parseRational(q);
    const va = evaluateInterpolation(a, x);
    const vb = evaluateInterpolation(b, x);
    const vl = lagrangeEvaluate(a.points, x);
    assert.ok(va.equals(vb), `点序值在 ${q} 不一致`);
    assert.ok(va.equals(vl), `Lagrange 对照在 ${q} 不一致`);
  }
  // 系数可以不同
  assert.notDeepEqual(
    a.coefficients.map((c) => c.toString()),
    b.coefficients.map((c) => c.toString()),
  );
});

test('大整数精确运算（无浮点）', () => {
  const M = '12345678901234567890123456789012345678'; // 38 位
  const pts = normalizePoints([
    { x: '0', y: '0' },
    { x: M, y: M },
  ]);
  const interp = buildInterpolation(pts);
  assert.equal(evaluateInterpolation(interp, parseRational(M)).toString(), M);
  const xInput = `${2n * BigInt(M) + 1n}/2`; // M + 1/2，分子奇 => 必为分数
  const expected = parseRational(xInput).toString();
  assert.ok(expected.includes('/'));
  assert.equal(evaluateInterpolation(interp, parseRational(xInput)).toString(), expected);
});

test('非整数节点差商与逐点精确代回', () => {
  const pts = normalizePoints([
    { x: '1/2', y: '1/4' },
    { x: '3/2', y: '9/4' },
    { x: '5/2', y: '25/4' },
  ]);
  const interp = buildInterpolation(pts);
  const v = verifyInterpolatesExactly(interp);
  assert.equal(v.ok, true);
  assert.equal(evaluateInterpolation(interp, parseRational('0')).toString(), '0'); // x^2/4 在 0 为 0
});

test('存储版本不可变：追加失败不损坏旧版本，重开可查', () => {
  const dir = mkdtempSync(join(tmpdir(), 'newton-reopen-'));
  const dbPath = join(dir, 't.db');
  let store = new Store(dbPath);
  const svc = new InterpService(store);
  const { setId } = svc.createSet('s', [
    { x: '0', y: '1' },
    { x: '1', y: '3' },
  ]);
  const before = svc.getReport(setId).newtonForm.coefficients.join(',');
  assert.throws(() => svc.appendPoint(setId, '1', '99'), (e: NewtonError) => e.code === 'E_DUPLICATE_X');
  assert.equal(svc.getReport(setId).newtonForm.coefficients.join(','), before);
  svc.appendPoint(setId, '2', '7');
  assert.equal(svc.listVersions(setId).length, 2);
  store.close();

  // 重启后重开同一数据库：历史与版本仍在，系数重算一致
  const reopened = new Store(dbPath);
  const svc2 = new InterpService(reopened);
  assert.equal(svc2.listVersions(setId).length, 2);
  assert.equal(svc2.evaluate(setId, '2').exact, '7');
  assert.ok(svc2.history(setId).some((h) => h.kind === 'append_point'));
  reopened.close();
});

test('空数据集可保存但拒绝插值报告', () => {
  const { svc } = tempStore();
  const { setId, report } = svc.createSet('e', []);
  assert.equal(report, null);
  assert.throws(() => svc.getReport(setId), /空集/);
  const r = svc.appendPoint(setId, '1/2', '3/4');
  assert.equal(r.normalizedPoints[0]!.x, '1/2');
});

test('节点数上限 30 与非法批次', () => {
  const { svc } = tempStore();
  const many = Array.from({ length: 31 }, (_, i) => ({ x: String(i), y: String(i * i) }));
  assert.throws(() => svc.createSet('big', many), (e: NewtonError) => e.code === 'E_TOO_MANY_NODES');
  assert.throws(
    () => svc.createSet('bad', [{ x: 'oops', y: '1' }]),
    (e: NewtonError) => e.code === 'E_BAD_POINT',
  );
});
