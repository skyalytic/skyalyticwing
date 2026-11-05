import { dirname, join, delimiter } from 'node:path';
import { existsSync } from 'node:fs';

/** npx.cmd cannot be spawned directly on Windows; run its JS CLI without a shell. */
export function mcpCommand(command:string,args:string[],env:Record<string,string>){
  const childEnv={...process.env,...env};
  if(/^npx(?:\.cmd)?$/i.test(command)){
    const cli=join(dirname(require.resolve('npm/package.json')),'bin','npx-cli.js');
    if(!existsSync(cli))throw new Error('安装包缺少 npm 运行组件，请修复 Wing 安装');
    const pathKey=Object.keys(childEnv).find(k=>k.toLowerCase()==='path')||'PATH';
    childEnv[pathKey]=dirname(process.execPath)+delimiter+(childEnv[pathKey]||'');
    return {command:process.execPath,args:[cli,...args],env:childEnv};
  }
  return {command,args,env:childEnv};
}
