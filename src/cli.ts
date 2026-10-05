#!/usr/bin/env node
/**
 * Newton 插值命令行。只做后端操作，输出 JSON。
 */
import { join } from 'node:path';
import { FractionError } from './fraction.js';
import { NewtonError } from './newton.js';
import { ObjectNotFoundError, Store } from './storage.js';
import { InterpService } from './service.js';

const DATA_DIR = process.env.NEWTON_DATA_DIR ?? join(process.cwd(), 'data');

function parsePoint(s: string): { x: string; y: string } {
  // 形如 0,1 或 1/2,3/4
  const m = s.match(/^(.+?),(.+)$/);
  if (!m) {
    throw new CliError('E_BAD_POINT', `点 "${s}" 格式应为 x,y（如 1/2,3/4）`);
  }
  return { x: m[1]!, y: m[2]! };
}

class CliError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function out(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function usage(): void {
  process.stderr.write(
    [
      '用法: newton <命令> [参数]',
      '命令:',
      '  create <名称> [点...]          建立点集；点形如 x,y（允许零个点=空集）',
      '  append <setId> <x> <y>         追加一个点，生成新版本',
      '  report <setId> [versionId]     查看插值报告（差商表/Newton系数/基底/有效次数）',
      '  eval <setId> <x>               精确求值（并列近似十进制与 Lagrange 对照）',
      '  differences <setId> [versionId] 仅查看逐层差商',
      '  compare <x> "<x0,y0>;..." "<x0,y0>;..."  比较两种点序在 x 处的值',
      '  sample <setId> <x1> <x2> ...   按有限采样位置导出精确结果',
      '  history [setId] [--limit N]    查询历史',
      '  sets                           列出点集',
      '  versions <setId>               列出版本',
      '',
    ].join('\n'),
  );
}

function main(argv: string[]): void {
  const [cmd, ...rest] = argv;
  const store = new Store(join(DATA_DIR, 'newton.db'));
  const service = new InterpService(store);
  try {
    switch (cmd) {
      case 'create': {
        const name = rest[0];
        if (!name) throw new CliError('E_BAD_REQUEST', '需要名称');
        const points = rest.slice(1).map(parsePoint);
        out(service.createSet(name, points));
        break;
      }
      case 'append': {
        const setId = Number(rest[0]);
        const x = rest[1];
        const y = rest[2];
        if (!Number.isInteger(setId) || x === undefined || y === undefined) {
          throw new CliError('E_BAD_REQUEST', '用法: append <setId> <x> <y>');
        }
        out({ report: service.appendPoint(setId, x, y) });
        break;
      }
      case 'report': {
        const setId = Number(rest[0]);
        const vid = rest[1] !== undefined ? Number(rest[1]) : undefined;
        out({ report: service.getReport(setId, vid) });
        break;
      }
      case 'differences': {
        const setId = Number(rest[0]);
        const vid = rest[1] !== undefined ? Number(rest[1]) : undefined;
        const r = service.getReport(setId, vid);
        out({ dividedDifferences: r.dividedDifferences, coefficients: r.newtonForm.coefficients });
        break;
      }
      case 'eval': {
        const setId = Number(rest[0]);
        const x = rest[1];
        if (x === undefined) throw new CliError('E_BAD_REQUEST', '用法: eval <setId> <x>');
        out({ result: service.evaluate(setId, x) });
        break;
      }
      case 'sample': {
        const setId = Number(rest[0]);
        const xs = rest.slice(1);
        if (xs.length === 0) throw new CliError('E_BAD_REQUEST', '至少给一个采样位置');
        out(service.sample(setId, xs));
        break;
      }
      case 'compare': {
        const x = rest[0];
        const specA = rest[1];
        const specB = rest[2];
        if (!x || !specA || !specB) {
          throw new CliError('E_BAD_REQUEST', '用法: compare <x> "<x0,y0>;x1,y1" "<...>"');
        }
        const toPoints = (spec: string) => spec.split(';').map((s) => s.trim()).filter(Boolean).map(parsePoint);
        out(service.compareOrder(toPoints(specA), toPoints(specB), x));
        break;
      }
      case 'history': {
        let setId: number | undefined;
        let limit = 50;
        for (let i = 0; i < rest.length; i++) {
          if (rest[i] === '--limit') limit = Number(rest[++i]);
          else if (setId === undefined) setId = Number(rest[i]);
        }
        out({ history: service.history(setId, limit) });
        break;
      }
      case 'sets':
        out({ sets: service.listSets() });
        break;
      case 'versions': {
        const setId = Number(rest[0]);
        out({ versions: service.listVersions(setId) });
        break;
      }
      default:
        usage();
        process.exitCode = cmd ? 2 : 0;
    }
  } catch (e) {
    const code =
      e instanceof FractionError || e instanceof NewtonError || e instanceof ObjectNotFoundError || e instanceof CliError
        ? e.code
        : 'E_INTERNAL';
    process.stderr.write(`错误 [${code}]: ${(e as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    store.close();
  }
}

main(process.argv.slice(2));
