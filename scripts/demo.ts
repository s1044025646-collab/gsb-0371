/**
 * 端到端演示：使用独立临时数据目录，不污染 data/。
 * 覆盖：(0,1)(1,3)(2,7)=x^2+x+1，x=3 得 13；
 * 追加 (3,13) 最高新增系数为精确 0；非整数节点约分；重复横坐标拒绝。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage.js';
import { InterpService } from '../src/service.js';

function hr(title: string): void {
  console.log('\n=== ' + title + ' ===');
}

const dir = mkdtempSync(join(tmpdir(), 'newton-demo-'));
const store = new Store(join(dir, 'demo.db'));
const svc = new InterpService(store);

hr('1. 建立点集 (0,1) (1,3) (2,7)');
const { setId, report } = svc.createSet('demo', [
  { x: '0', y: '1' },
  { x: '1', y: '3' },
  { x: '2', y: '7' },
]);
console.log('Newton 系数:', report!.newtonForm.coefficients.join(', '));
console.log('有效次数:', report!.newtonForm.effectiveDegree);
console.log('逐点精确代回校验:', report!.verification.exact ? '通过' : '失败');

hr('2. 在 x=3 精确求值');
const ev = svc.evaluate(setId, '3');
console.log(`P(3) 精确=${ev.exact}  近似=${ev.approx}  Lagrange对照=${ev.lagrangeExact}  一致=${ev.crossCheck}`);

hr('3. 追加 (3,13)，新版本');
const r2 = svc.appendPoint(setId, '3', '13');
console.log('新版本全部系数:', r2.newtonForm.coefficients.join(', '));
const top = r2.newtonForm.coefficients[r2.newtonForm.coefficients.length - 1];
console.log(`最高新增系数 = ${top}（应为精确 0，不是接近 0 的小数）`);
console.log('追加后有效次数:', r2.newtonForm.effectiveDegree, '（仍为 2）');
const evOld = svc.evaluate(setId, '0');
console.log('旧数据点函数值不变，P(0)=', evOld.exact);

hr('4. 非整数节点与负分母规范化');
const { setId: s2 } = svc.createSet('frac', [
  { x: '1/-2', y: '2/-4' }, // x 规范化为 -1/2，y 为 -1/2
  { x: '2/4', y: '1/3' },   // x 规范化为 1/2
]);
const rep2 = svc.getReport(s2);
for (const p of rep2.normalizedPoints) console.log(`x=${p.x} (~${p.approx.x})  y=${p.y} (~${p.approx.y})`);

hr('5. 重复横坐标被拒绝（即使纵坐标相同）');
try {
  svc.createSet('dup', [
    { x: '1/2', y: '3' },
    { x: '2/4', y: '3' },
  ]);
  console.log('未拒绝（错误！）');
} catch (e) {
  console.log('已拒绝:', (e as Error).message);
}

hr('6. 两种点序在同一查询点对照');
const cmp = svc.compareOrder(
  [
    { x: '0', y: '1' },
    { x: '1', y: '3' },
    { x: '2', y: '7' },
  ],
  [
    { x: '2', y: '7' },
    { x: '0', y: '1' },
    { x: '1', y: '3' },
  ],
  '5/2',
);
console.log('顺序A系数:', cmp.orderA.coefficients.join(', '));
console.log('顺序B系数:', cmp.orderB.coefficients.join(', '));
console.log(`A: ${cmp.valueA}  B: ${cmp.valueB}  代表同一多项式: ${cmp.samePolynomialAtX}`);

hr('7. 空数据集可保存但无有效插值报告');
const empty = svc.createSet('empty', []);
console.log('空集 id =', empty.setId, '报告 =', empty.report);
try {
  svc.getReport(empty.setId);
} catch (e) {
  console.log('空集报告已拒绝:', (e as Error).message);
}

hr('8. 有限采样导出');
const smp = svc.sample(setId, ['0', '1', '1/2', '2', '3']);
for (const row of smp.rows) console.log(`x=${row.x}  P(x)=${row.exact}  (~${row.approx})`);

store.close();
console.log('\n演示完成，临时数据库位于:', dir);
