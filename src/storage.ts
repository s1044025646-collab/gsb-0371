/**
 * SQLite 持久化。仅使用 Node 内置 node:sqlite，无需原生编译依赖。
 * 点集版本不可变：追加只新增一行，失败由事务回滚保护旧版本。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Fraction } from './fraction.js';
import {
  ALGORITHM_VERSION,
  NewtonInterpolation,
  NormalizedPoint,
  appendPoint,
  buildInterpolation,
} from './newton.js';

export interface PointRecord {
  x: string;
  y: string;
}

export interface VersionRecord {
  id: number;
  setId: number;
  versionNo: number;
  algorithmVersion: string;
  points: PointRecord[];
  coefficients: string[];
  effectiveDegree: number;
  createdAt: string;
}

export interface SetRecord {
  id: number;
  name: string;
  createdAt: string;
  latestVersion: number;
}

export interface HistoryRecord {
  id: number;
  setId: number;
  versionId: number;
  kind: string;
  input: unknown;
  result: unknown;
  createdAt: string;
}

function pointsToJSON(points: NormalizedPoint[]): PointRecord[] {
  return points.map((p) => ({ x: p.x.toString(), y: p.y.toString() }));
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS point_sets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        set_id INTEGER NOT NULL REFERENCES point_sets(id),
        version_no INTEGER NOT NULL,
        algorithm_version TEXT NOT NULL,
        points_json TEXT NOT NULL,
        coefficients_json TEXT NOT NULL,
        effective_degree INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(set_id, version_no)
      );
      CREATE TABLE IF NOT EXISTS query_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        set_id INTEGER REFERENCES point_sets(id),
        version_id INTEGER REFERENCES versions(id),
        kind TEXT NOT NULL,
        input_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  /** 建立点集并生成版本 1；空批次允许保存，但不生成有效插值版本。 */
  createSet(name: string, points: NormalizedPoint[]): { setId: number; version: VersionRecord | null } {
    const tx = this.db.prepare('BEGIN');
    try {
      tx.run();
      const setRes = this.db.prepare('INSERT INTO point_sets(name) VALUES (?)').run(name);
      const setId = Number(setRes.lastInsertRowid);
      let version: VersionRecord | null = null;
      if (points.length > 0) {
        version = this.insertVersion(setId, 1, points);
      }
      this.db.exec('COMMIT');
      return { setId, version };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** 追加点：基于最新版本生成新版本，旧版本保持不变。 */
  appendPoint(
    setId: number,
    point: NormalizedPoint,
  ): VersionRecord {
    const latest = this.getLatestVersionRow(setId);
    if (!latest) {
      // 空点集的首次追加成为版本 1
      if (!this.getSet(setId)) throw new Error(`点集 ${setId} 不存在`);
      return this.insertVersion(setId, 1, [point]);
    }
    const interp = this.rehydrate(latest);
    const extended = appendPoint(interp, point);
    return this.insertVersion(setId, latest.versionNo + 1, extended.points, extended);
  }

  private insertVersion(
    setId: number,
    versionNo: number,
    points: NormalizedPoint[],
    interp?: NewtonInterpolation,
  ): VersionRecord {
    const built = interp ?? buildInterpolation(points);
    const stmt = this.db.prepare(
      `INSERT INTO versions(set_id, version_no, algorithm_version, points_json,
        coefficients_json, effective_degree) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const res = stmt.run(
      setId,
      versionNo,
      ALGORITHM_VERSION,
      JSON.stringify(pointsToJSON(built.points)),
      JSON.stringify(built.coefficients.map((c) => c.toString())),
      built.effectiveDegree,
    );
    return this.getVersion(Number(res.lastInsertRowid));
  }

  private getSet(setId: number): SetRecord | null {
    const row = this.db
      .prepare('SELECT id, name, created_at AS createdAt FROM point_sets WHERE id = ?')
      .get(setId) as { id: number; name: string; createdAt: string } | undefined;
    if (!row) return null;
    const latest = this.db
      .prepare('SELECT MAX(version_no) AS v FROM versions WHERE set_id = ?')
      .get(setId) as { v: number | null };
    return { ...row, latestVersion: latest.v ?? 0 };
  }

  getSetRecord(setId: number): SetRecord {
    const s = this.getSet(setId);
    if (!s) throw new ObjectNotFoundError('E_SET_NOT_FOUND', `点集 ${setId} 不存在`);
    return s;
  }

  listSets(): SetRecord[] {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.name, s.created_at AS createdAt,
                COALESCE(MAX(v.version_no), 0) AS latestVersion
         FROM point_sets s LEFT JOIN versions v ON v.set_id = s.id
         GROUP BY s.id ORDER BY s.id`,
      )
      .all() as unknown as SetRecord[];
    return rows;
  }

  private getLatestVersionRow(setId: number): VersionRecord | null {
    const row = this.db
      .prepare('SELECT id FROM versions WHERE set_id = ? ORDER BY version_no DESC LIMIT 1')
      .get(setId) as { id: number } | undefined;
    return row ? this.getVersion(row.id) : null;
  }

  /** 取点集最新版本（可为空集）。 */
  getLatestVersion(setId: number): VersionRecord {
    const v = this.getLatestVersionRow(setId);
    if (!v) throw new ObjectNotFoundError('E_EMPTY_SET', `点集 ${setId} 没有任何插值版本（可能为空集）`);
    return v;
  }

  getVersion(versionId: number): VersionRecord {
    const row = this.db
      .prepare(
        `SELECT id, set_id AS setId, version_no AS versionNo, algorithm_version AS algorithmVersion,
                points_json AS pointsJson, coefficients_json AS coefficientsJson,
                effective_degree AS effectiveDegree, created_at AS createdAt
         FROM versions WHERE id = ?`,
      )
      .get(versionId) as
      | {
          id: number;
          setId: number;
          versionNo: number;
          algorithmVersion: string;
          pointsJson: string;
          coefficientsJson: string;
          effectiveDegree: number;
          createdAt: string;
        }
      | undefined;
    if (!row) throw new ObjectNotFoundError('E_VERSION_NOT_FOUND', `版本 ${versionId} 不存在`);
    return {
      id: row.id,
      setId: row.setId,
      versionNo: row.versionNo,
      algorithmVersion: row.algorithmVersion,
      points: JSON.parse(row.pointsJson) as PointRecord[],
      coefficients: JSON.parse(row.coefficientsJson) as string[],
      effectiveDegree: row.effectiveDegree,
      createdAt: row.createdAt,
    };
  }

  listVersions(setId: number): VersionRecord[] {
    this.getSetRecord(setId);
    const rows = this.db
      .prepare('SELECT id FROM versions WHERE set_id = ? ORDER BY version_no')
      .all(setId) as { id: number }[];
    return rows.map((r) => this.getVersion(r.id));
  }

  /** 把存储的版本重建为完整插值对象（重算差商表；系数与存储一致）。 */
  rehydrate(version: VersionRecord): NewtonInterpolation {
    const points: NormalizedPoint[] = version.points.map((p) => ({
      x: parseStored(p.x),
      y: parseStored(p.y),
    }));
    const interp = buildInterpolation(points);
    // 一致性检查：存储系数必须与重算系数逐项精确相等
    interp.coefficients.forEach((c, i) => {
      if (c.toString() !== version.coefficients[i]) {
        throw new Error(`版本 ${version.id} 系数一致性校验失败（算法版本 ${version.algorithmVersion}）`);
      }
    });
    return interp;
  }

  recordHistory(
    setId: number | null,
    versionId: number | null,
    kind: string,
    input: unknown,
    result: unknown,
  ): number {
    const res = this.db
      .prepare(
        'INSERT INTO query_history(set_id, version_id, kind, input_json, result_json) VALUES (?,?,?,?,?)',
      )
      .run(setId, versionId, kind, JSON.stringify(input), JSON.stringify(result));
    return Number(res.lastInsertRowid);
  }

  listHistory(setId?: number, limit = 50): HistoryRecord[] {
    const rows = setId
      ? (this.db
          .prepare(
            'SELECT * FROM query_history WHERE set_id = ? ORDER BY id DESC LIMIT ?',
          )
          .all(setId, limit) as any[])
      : (this.db
          .prepare('SELECT * FROM query_history ORDER BY id DESC LIMIT ?')
          .all(limit) as any[]);
    return rows.map((r) => ({
      id: r.id,
      setId: r.set_id,
      versionId: r.version_id,
      kind: r.kind,
      input: JSON.parse(r.input_json),
      result: JSON.parse(r.result_json),
      createdAt: r.created_at,
    }));
  }
}

function parseStored(s: string): Fraction {
  // 存储为规范字符串 "n/d" 或整数
  const slash = s.indexOf('/');
  if (slash === -1) return Fraction.from(BigInt(s), 1n);
  return Fraction.from(BigInt(s.slice(0, slash)), BigInt(s.slice(slash + 1)));
}

export class ObjectNotFoundError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ObjectNotFoundError';
  }
}
