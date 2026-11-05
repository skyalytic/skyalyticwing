// exec-args.util 测试：命令字符串 → argv 段解析（execFileSync 数组化防注入配套）
import { parseCommandSegments } from '../../src/modules/core/utils/exec-args.util.js';

describe('parseCommandSegments', () => {
  it('简单命令拆分为 argv', () => {
    expect(parseCommandSegments('git -C /repo log -3')).toEqual([
      { argv: ['git', '-C', '/repo', 'log', '-3'], joiner: '&&' },
    ]);
  });

  it('带空格的参数经引号分组为一个 token', () => {
    expect(parseCommandSegments('git commit -m "Initial commit by SkyalyticWing"')).toEqual([
      { argv: ['git', 'commit', '-m', 'Initial commit by SkyalyticWing'], joiner: '&&' },
    ]);
    expect(parseCommandSegments("echo 'hello world'")).toEqual([
      { argv: ['echo', 'hello world'], joiner: '&&' },
    ]);
  });

  it('|| 连接的多段安装命令（apt 回退 pacman）', () => {
    const segs = parseCommandSegments('sudo apt install -y xdotool || sudo pacman -S xdotool');
    expect(segs).toEqual([
      { argv: ['sudo', 'apt', 'install', '-y', 'xdotool'], joiner: '&&' },
      { argv: ['sudo', 'pacman', '-S', 'xdotool'], joiner: '||' },
    ]);
  });

  it('&& 连接的多段命令', () => {
    const segs = parseCommandSegments('npm install && npm test');
    expect(segs).toEqual([
      { argv: ['npm', 'install'], joiner: '&&' },
      { argv: ['npm', 'test'], joiner: '&&' },
    ]);
  });

  it('管道 / 重定向 / 分号 / 命令替换返回 null（fail-close）', () => {
    expect(parseCommandSegments('ls | wc -l')).toBeNull();
    expect(parseCommandSegments('echo hi > out.txt')).toBeNull();
    expect(parseCommandSegments('a; b')).toBeNull();
    expect(parseCommandSegments('echo `whoami`')).toBeNull();
    expect(parseCommandSegments('echo $(whoami)')).toBeNull();
  });

  it('未闭合引号 / 空命令返回 null', () => {
    expect(parseCommandSegments('echo "unclosed')).toBeNull();
    expect(parseCommandSegments('   ')).toBeNull();
    expect(parseCommandSegments('')).toBeNull();
  });

  it('引号内的 shell 元字符不触发拒绝', () => {
    const segs = parseCommandSegments('git commit -m "fix: a | b && c"');
    expect(segs).toEqual([
      { argv: ['git', 'commit', '-m', 'fix: a | b && c'], joiner: '&&' },
    ]);
  });
});
