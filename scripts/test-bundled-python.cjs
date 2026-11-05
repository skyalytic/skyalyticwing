const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const {execFileSync} = require('node:child_process');
const deploy = fs.realpathSync(process.argv[2]);
// Exercise the same resolver the AI Python tools use, with no system interpreter.
delete process.env.SKYWING_PYTHON;
process.env.PATH = process.platform === 'win32' ? path.join(process.env.SystemRoot,'System32') : '/nonexistent';
const {PythonEnvService} = require(path.join(deploy,'dist/modules/core/python/python-env.service.js'));
const result = new PythonEnvService().resolve();
assert.equal(result?.source, 'bundled');
assert(fs.realpathSync(result.bin).startsWith(deploy+path.sep));
execFileSync(result.bin,['-I','-B','-c','import ssl,sqlite3,ctypes,lzma,bz2,zlib,pip; print("PASS: AI tool resolves packaged Python without a system Python PATH")'],{stdio:'inherit',env:{...process.env,PYTHONHOME:'',PYTHONPATH:'',PYTHONDONTWRITEBYTECODE:'1'}});
