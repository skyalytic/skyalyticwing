import type { Type } from '@nestjs/common';

/**
 * ServiceResolver - 内置工具的懒服务解析器。
 *
 * 部分被桥接的服务（AgentMessageService / SessionService / AcpService /
 * DaemonService 等）位于非全局模块，且其模块内服务反向注入了
 * TOOL_EXECUTOR_SERVICE —— 若 ToolExecutorService 构造期直连这些服务会形成
 * 循环实例化。因此通过 ModuleRef（strict:false）在工具执行期懒解析，
 * 解析失败（模块未注册/未初始化）返回 undefined，由工具返回"服务不可用"。
 */
export type ServiceResolver = <T>(typeOrToken: Type<T> | string) => T | undefined;
