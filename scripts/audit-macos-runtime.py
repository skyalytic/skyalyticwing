"""Reject non-system dylibs outside the app and inconsistent OS requirements."""
import os, pathlib, plistlib, struct, sys

app = pathlib.Path(sys.argv[1]).resolve()
with (app / 'Contents/Info.plist').open('rb') as stream:
    info = plistlib.load(stream)
declared = tuple(int(p) for p in info['LSMinimumSystemVersion'].split('.'))
declared = (declared + (0, 0))[:3]
count = 0
for file in app.rglob('*'):
    if not file.is_file() or file.is_symlink():
        continue
    with file.open('rb') as stream:
        magic = stream.read(4)
        if magic not in (b'\xcf\xfa\xed\xfe', b'\xfe\xed\xfa\xcf'):
            continue
        endian = '<' if magic == b'\xcf\xfa\xed\xfe' else '>'
        header = stream.read(28)
        commands = struct.unpack(endian + 'I', header[12:16])[0]
        deps, rpaths = [], []
        for _ in range(commands):
            command = stream.read(8)
            kind, size = struct.unpack(endian + 'II', command)
            data = command + stream.read(size - 8)
            if kind in (0xc, 0x80000018, 0x8000001f, 0x80000023, 0x8000001c):
                offset = struct.unpack(endian + 'I', data[8:12])[0]
                value = data[offset:].split(b'\0')[0].decode()
                (rpaths if kind == 0x8000001c else deps).append(value)
            if kind in (0x24, 0x32):
                offset = 8 if kind == 0x24 else 12
                v = struct.unpack(endian + 'I', data[offset:offset+4])[0]
                minimum = (v >> 16, (v >> 8) & 255, v & 255)
                if minimum > declared:
                    raise RuntimeError(f'{file.relative_to(app)} requires macOS {minimum}, bundle claims {declared}')
    count += 1
    def expand(value):
        return pathlib.Path(value.replace('@loader_path', str(file.parent)).replace('@executable_path', str(app / 'Contents/MacOS')))
    for dependency in deps:
        if dependency.startswith(('/usr/lib/', '/System/Library/')):
            continue
        if dependency.startswith('@rpath/'):
            candidates = [expand(r) / dependency[len('@rpath/'):] for r in rpaths]
        else:
            candidates = [expand(dependency)]
        if not any(p.exists() and p.resolve().is_relative_to(app) for p in candidates):
            raise RuntimeError(f'Unbundled dependency: {file.relative_to(app)} -> {dependency}')
python = app / 'Contents/Resources/_up_/packages/backend/deploy/python/bin/python3'
if not python.exists():
    raise RuntimeError('Python is not bundled')
print(f'PASS: {count} Mach-O files; all non-system dylibs bundled; macOS minimum {declared}; Python bundled')
