/**
 * @nestjs/swagger 装饰器兼容层
 *
 * 通过运行时 require 加载 @nestjs/swagger（模块名运行时拼接，
 * 避免 TypeScript 静态解析未安装依赖导致编译失败）。
 * 依赖未安装时退化为 no-op 装饰器；执行 pnpm install 安装
 * @nestjs/swagger 后无需改码即恢复为真实装饰器。
 */

/** ApiTags 装饰器签名（与 @nestjs/swagger 对齐） */
type ApiTagsFn = (name: string | string[]) => ClassDecorator;

const swaggerModule: Record<string, unknown> | undefined = (() => {
  try {
    return require('@nestjs' + '/swagger') as Record<string, unknown>;
  } catch {
    return undefined;
  }
})();

/** 类分组标签装饰器；@nestjs/swagger 未安装时为 no-op */
export const ApiTags: ApiTagsFn =
  (swaggerModule?.['ApiTags'] as ApiTagsFn | undefined) ?? (() => () => undefined);
