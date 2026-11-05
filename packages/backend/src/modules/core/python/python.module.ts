import { Global, Module } from '@nestjs/common';
import { PythonEnvService } from './python-env.service.js';

/** 捆绑 Python 环境解析（全局）：AI python 工具/桌面自动化共用 */
@Global()
@Module({
  providers: [PythonEnvService],
  exports: [PythonEnvService],
})
export class PythonModule {}
