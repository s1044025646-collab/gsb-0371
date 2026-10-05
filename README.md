# Newton 插值后端（精确有理数）

只做有限点的**代数插值**：给定横坐标互不相同的点，构造次数不超过 `点数-1`、
通过全部给定点的 Newton 形式多项式，在任意有理位置**精确**求值，并解释差商
以及新增点如何改变表示。

仅提供 HTTP API 与 CLI（无前端）。TypeScript + Node.js（≥ 22.5）+
内置 `node:sqlite`，**无需** Docker、WSL、付费服务或外部在线 API，
也**不使用**任何现成插值或符号代数库；差商、Newton 系数、嵌套乘法全部自行实现。

> 不做统计拟合、平滑、样条、克里金、误差/置信区间或实根求解；
> 插值曲线只在给定节点上有代数保证，不能当作真实数据趋势或可靠预测。

## 表示与算法

- 点按**输入次序**保存。Newton 形式为
  `P(x) = c0 + c1(x-x0) + c2(x-x0)(x-x1) + ... + c{n-1}(x-x0)...(x-x{n-2})`。
- 系数 `c_k` 即差商表对角线 `f[0..k]`，递推
  `f[i..j] = (f[i+1..j] - f[i..j-1]) / (x_j - x_i)`。
- 求值用**嵌套乘法（Horner 式）**：
  `c0 + (x-x0)(c1 + (x-x1)(c2 + ... (c{n-1}))...)`。
- 所有数都是 BigInt 分子/分母分数：分母统一转正并约分；横坐标重复用
  BigInt 精确比较判定，不用浮点。
- **增量追加**：保留旧节点次序与已有系数，只新增一个高阶系数
  `c_n = (y_n - P_old(x_n)) / Π_{i<n}(x_n - x_i)`。
  旧点函数值不变；新点若本在旧多项式上，`c_n` 是精确 `0`。
  重复横坐标即使纵坐标相同也明确拒绝，绝不除以零继续计算。
- **次数约定**：有效次数 = 最高非零系数的阶；单点常量为 `0`；
  全零多项式约定为 `-1`。
- 重排点序可能改变 Newton 系数，但代表的多项式不变；提供 `/compare`
  在指定查询点精确对照两个顺序（另用独立 Lagrange 公式交叉核对）。

### 与“数值拟合”的区别

插值要求曲线**逐点精确通过**全部给定数据点（本项目用精确分数代回校验，
不使用浮点容差）；拟合/回归是在某个模型族里整体逼近、允许不过点，
并带统计含义。二者目标不同，本服务不提供后者。

## 输入限制与错误码

- 节点数上限 `30`；输入分子/分母最多 `64` 位；中间结果最多 `20000` 位。
- 超限返回诊断错误，不静默截断。

| 错误码 | 含义 |
| --- | --- |
| `E_INVALID_RATIONAL` | 不是合法整数或 `a/b`（不接受小数） |
| `E_ZERO_DENOMINATOR` | 分母为零 |
| `E_TOO_MANY_DIGITS` | 输入分子/分母超过 64 位 |
| `E_BUDGET` | 中间结果超过位数预算 |
| `E_DIVISION_BY_ZERO` | 有理数除法/差商分母为零 |
| `E_DUPLICATE_X` | 重复横坐标（纵坐标相同也拒绝） |
| `E_TOO_MANY_NODES` | 节点数超过 30 |
| `E_EMPTY_SET` | 空数据集无有效插值版本/不能求值 |
| `E_BAD_POINT` / `E_BAD_REQUEST` | 点或请求结构错误 |
| `E_SET_NOT_FOUND` / `E_VERSION_NOT_FOUND` | 对象不存在 |

近似十进制（默认 12 位、四舍五入）**仅用于展示**，始终与精确分数并列标识，
不会反向替代数据库里的分数。

## 构建、测试、启动

```powershell
npm install        # 仅安装 typescript 与 @types/node（开发依赖）
npm run build      # 类型检查 + 输出到 dist/
npm test           # 先构建，再运行 node:test（13 个用例）

npm start                        # 默认自动选择空闲端口，打印实际 URL
$env:PORT=8080; npm start        # 或用环境变量
npm start -- --port 8080         # 或用命令行参数
$env:NEWTON_DATA_DIR="D:\mydata"; npm start   # 自定义项目内/外数据目录

npm run demo                     # 端到端演示（使用临时数据库，不污染 data/）
```

SQLite 数据库默认在项目内 `data/newton.db`（WAL 模式）。
表结构保存不可变点集版本、输入次序、算法版本
（`newton-exact-bigint-v1`）与精确系数；追加只插入新版本，
失败由事务回滚保护旧版本。空点集可以保存，但不产生插值版本、不能发报告。

## 完整演示命令（CLI）

```powershell
npm run build
node dist/src/cli.js create demo 0,1 1,3 2,7
node dist/src/cli.js report 1
node dist/src/cli.js eval 1 3                 # 精确 13
node dist/src/cli.js differences 1
node dist/src/cli.js append 1 3 13
node dist/src/cli.js report 1                 # 最高系数精确 0，有效次数仍为 2
node dist/src/cli.js sample 1 0 1 1/2 2 3
node dist/src/cli.js compare 5/2 "0,1;1,3;2,7" "2,7;0,1;1,3"
node dist/src/cli.js create empty
node dist/src/cli.js sets
node dist/src/cli.js versions 1
node dist/src/cli.js history 1
```

非整数节点与负分母规范化、重复横坐标拒绝：

```powershell
node dist/src/cli.js create frac "1/-2,2/-4" "2/4,1/3"   # 规范化为 (-1/2,-1/2)、(1/2,1/3)
node dist/src/cli.js create dup "1/2,3" "2/4,3"          # E_DUPLICATE_X
node dist/src/cli.js create bad "1/0,2"                  # E_ZERO_DENOMINATOR
```

## HTTP API

| 方法与路径 | 说明 |
| --- | --- |
| `GET /health` | 健康检查与数据目录 |
| `POST /sets` | `{name?, points:[{x,y}]}`，空数组可存；返回报告 |
| `GET /sets` | 列出点集 |
| `GET /sets/:id` | 点集与全部版本 |
| `POST /sets/:id/points` | `{x,y}` 追加点，生成新版本 |
| `GET /sets/:id/report` | 有序点/规范坐标/逐层差商/Newton 系数与基底/有效次数/代回校验 |
| `POST /sets/:id/evaluate` | `{x}` 精确求值，并列近似值与 Lagrange 对照 |
| `POST /sets/:id/sample` | `{xs:[...]}` 有限采样导出 |
| `GET /sets/:id/history?limit=N` | 该点集查询历史 |
| `POST /compare` | `{orderA, orderB, x}` 比较两种点序 |
| `GET /history?limit=N` | 全局查询历史 |

```powershell
$b = @{ name='demo'; points=@(
  @{x='0';y='1'}, @{x='1';y='3'}, @{x='2';y='7'}
)} | ConvertTo-Json
$r = Invoke-RestMethod -Method Post http://127.0.0.1:<port>/sets -ContentType 'application/json' -Body $b
Invoke-RestMethod -Method Post "http://127.0.0.1:<port>/sets/$($r.setId)/evaluate" `
  -ContentType 'application/json' -Body (@{x='3'}|ConvertTo-Json)
```

## 项目结构

```
src/fraction.ts   精确有理数（BigInt）、解析校验、位数预算、展示用近似十进制
src/newton.ts     差商表、Newton 构造、嵌套乘法、增量追加、独立 Lagrange 核对
src/storage.ts    node:sqlite 不可变版本/历史/算法版本
src/service.ts    报告、求值、点序比较、采样
src/server.ts     HTTP API（默认空闲端口）
src/cli.ts        命令行
scripts/demo.ts   端到端演示
test/newton.test.ts  13 个精确测试
```

## 已知限制

- `node:sqlite` 在当前 Node 版本带 ExperimentalWarning，功能可用、无外部原生依赖。
- 为保证精确性与位数预算，未做巨大幂基展开；多项式只以 Newton 基表示。
- 仅代数插值；不含拟合、样条、绘图、求根与预测能力。
