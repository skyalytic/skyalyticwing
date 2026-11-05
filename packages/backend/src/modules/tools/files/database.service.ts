import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  Post,
  Query,
} from '@nestjs/common';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PythonEnvService } from '../../core/python/python-env.service.js';
import { SecurityManagerService } from '../../core/security/security-manager.service.js';
import { getDefaultDataDir } from '../../core/utils/web-data.util.js';
import { withFileMutation } from './checkpoint-store.js';

/** Python's bundled SQLite: no user SQL is interpolated into Python or a shell command. */
const WORKER = String.raw`
import sys,json,sqlite3,time,pathlib
sys.stdin.reconfigure(encoding='utf-8')
sys.stdout.reconfigure(encoding='utf-8')
p=json.load(sys.stdin)
write=bool(p.get('write'))
uri=pathlib.Path(p['path']).as_uri()+('?mode=rwc' if write else '?mode=ro')
db=sqlite3.connect(uri,uri=True,timeout=3)
db.enable_load_extension(False)
db.setlimit(sqlite3.SQLITE_LIMIT_LENGTH,65536)
db.setlimit(sqlite3.SQLITE_LIMIT_COLUMN,128)
deadline=time.monotonic()+5
db.set_progress_handler(lambda: 1 if time.monotonic()>deadline else 0,1000)
def auth(action,a,b,c,d):
    if action in (sqlite3.SQLITE_ATTACH,sqlite3.SQLITE_DETACH): return sqlite3.SQLITE_DENY
    if action==sqlite3.SQLITE_FUNCTION and str(b or a).lower() in ('load_extension','readfile','writefile'): return sqlite3.SQLITE_DENY
    if action==sqlite3.SQLITE_PRAGMA and str(a).lower() not in ('table_info','table_xinfo','index_list','foreign_key_list'): return sqlite3.SQLITE_DENY
    return sqlite3.SQLITE_OK
def value(v):
    if isinstance(v,bytes): return {'binary':v.hex()[:200],'bytes':len(v)}
    return v
try:
    if write:
        backup=sqlite3.connect(p['backup']); db.backup(backup); backup.close()
    db.set_authorizer(auth)
    if p.get('schema'):
        tables=[]
        for name,kind in db.execute("SELECT name,type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name").fetchall():
            cols=[{'name':r[1],'type':r[2],'notNull':bool(r[3]),'pk':r[5]} for r in db.execute('PRAGMA table_info("'+name.replace('"','""')+'")')]
            tables.append({'name':name,'kind':kind,'columns':cols})
        result={'tables':tables}
    elif p.get('create'):
        db.execute('CREATE TABLE IF NOT EXISTS wing_notes (id INTEGER PRIMARY KEY, title TEXT, content TEXT)')
        db.commit(); result={'created':True}
    else:
        if not write: db.set_authorizer(None);db.execute('PRAGMA query_only=ON');db.set_authorizer(auth)
        cursor=db.execute(p['sql'],p.get('params') or [])
        columns=[d[0] for d in cursor.description] if cursor.description else []
        rows=cursor.fetchmany(1001) if columns else []
        result={'columns':columns,'rows':[[value(v) for v in row] for row in rows[:1000]],'truncated':len(rows)>1000,'affected':max(0,cursor.rowcount)}
        if write: db.commit()
    print(json.dumps(result,ensure_ascii=False))
except Exception as e:
    db.rollback();print(json.dumps({'error':str(e)},ensure_ascii=False))
finally:
    db.close()
`;
@Injectable()
export class DatabaseService {
  constructor(
    private readonly security: SecurityManagerService,
    private readonly python: PythonEnvService,
  ) {}
  async run(body: {
    path: string;
    sql?: string;
    params?: unknown[];
    write?: boolean;
    schema?: boolean;
    create?: boolean;
  }) {
    if (typeof body?.path !== 'string' || !body.path)
      throw new BadRequestException('数据库路径不能为空');
    const path = resolve(body.path),
      write = body.write === true || body.create === true;
    if (!['.sqlite', '.sqlite3', '.db'].includes(extname(path).toLowerCase()))
      throw new BadRequestException('支持本地 SQLite 数据库（.db / .sqlite / .sqlite3）');
    if (
      !this.security.isPathAllowed(path, 'read') ||
      (write && !this.security.isPathAllowed(path, 'write'))
    )
      throw new BadRequestException('数据库路径未授权');
    if (existsSync(path) && statSync(path).size > 1024 * 1024 * 1024)
      throw new BadRequestException('内置数据库工作台限制为 1 GB');
    if (body.create && existsSync(path)) throw new BadRequestException('目标数据库已存在');
    if (!body.create && !existsSync(path)) throw new BadRequestException('数据库不存在');
    if (
      !body.schema &&
      !body.create &&
      (typeof body.sql !== 'string' || !body.sql.trim() || body.sql.length > 100000)
    )
      throw new BadRequestException('SQL 不能为空或超过长度限制');
    if (
      body.params !== undefined &&
      (!Array.isArray(body.params) ||
        body.params.length > 1000 ||
        body.params.some((p) => p !== null && !['string', 'number'].includes(typeof p)))
    )
      throw new BadRequestException('参数必须为字符串、数字或 null 的数组');
    const runtime = this.python.resolve();
    if (!runtime) throw new BadRequestException(this.python.missingHint());
    const execute = () =>
      new Promise<Record<string, unknown>>((done, reject) => {
        let backup: string | undefined;
        if (write) {
          mkdirSync(dirname(path), { recursive: true });
          const dir = join(getDefaultDataDir(), 'database-backups');
          mkdirSync(dir, { recursive: true });
          backup = join(dir, randomUUID() + '.sqlite');
        }
        const child = spawn(runtime.bin, ['-I', '-c', WORKER], {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        });
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        let output = '',
          error = '',
          oversize = false;
        const timeout = setTimeout(() => {
          child.kill();
          reject(new BadRequestException(write ? '数据库操作超时，提交状态未确认；请先查询结果，勿直接重复执行写入' : '数据库查询超时（15 秒），请缩小查询范围'));
        }, 15000);
        child.stdout.on('data', (chunk) => {
          output += chunk.toString();
          if (Buffer.byteLength(output) > 4 * 1024 * 1024) {
            oversize = true;
            child.kill();
          }
        });
        child.stderr.on('data', (chunk) => {
          error = (error + chunk.toString()).slice(0, 2000);
        });
        child.on('error', (e) => {
          clearTimeout(timeout);
          reject(new BadRequestException('数据库运行时不可用：' + e.message));
        });
        child.on('close', (code) => {
          clearTimeout(timeout);
          try {
            if (oversize) throw new Error(write ? '数据库返回结果过大，提交状态未确认；请先查询结果，勿直接重复执行写入' : '查询结果过大，请缩小查询范围');
            if (code !== 0) throw new Error(error || '数据库操作失败');
            const result = JSON.parse(output);
            if (result.error) throw new Error(result.error);
            done({ ...result, ...(backup ? { backup } : {}) });
          } catch (e) {
            reject(new BadRequestException(e instanceof Error ? e.message : String(e)));
          }
        });
        child.stdin.on('error', () => {});
        child.stdin.end(JSON.stringify({ ...body, path, write, backup }));
      });
    return write ? withFileMutation(path, execute) : execute();
  }
}
@Controller('database')
export class DatabaseController {
  constructor(private readonly database: DatabaseService) {}
  @Get('schema') schema(@Query('path') path: string) {
    return this.database.run({ path, schema: true });
  }
  @Post('query') query(@Body() body: { path: string; sql: string; params?: unknown[] }) {
    return this.database.run({
      path: body.path,
      sql: body.sql,
      ...(body.params ? { params: body.params } : {}),
      write: false,
    });
  }
  @Post('execute') execute(@Body() body: { path: string; sql: string; params?: unknown[] }) {
    return this.database.run({
      path: body.path,
      sql: body.sql,
      ...(body.params ? { params: body.params } : {}),
      write: true,
    });
  }
  @Post('create') create(@Body() body: { path: string }) {
    return this.database.run({ path: body.path, create: true });
  }
}
