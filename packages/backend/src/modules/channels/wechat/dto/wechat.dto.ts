import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** 微信 iLink 二维码请求 DTO（POST /weixin/qr，兼容 GET query） */
export class WeixinQrDto {
  @IsString()
  @IsOptional()
  @MaxLength(8)
  @IsIn(['1', '2', '3', '4'])
  bot_type?: string;
}

/** CLI 安装请求 DTO（POST /weixin/cli-install、POST /wecom/cli-install） */
export class CliInstallDto {
  /** CLI 输出渠道等可选参数（当前保留占位，对齐旧版无参数行为） */
  @IsString()
  @IsOptional()
  @MaxLength(64)
  channel?: string;
}

/** 心跳启动 DTO（POST /lifecycle/heartbeat） */
export class HeartbeatDto {
  @IsString()
  @IsOptional()
  @MaxLength(128)
  agentId?: string;

  @IsInt()
  @IsOptional()
  @Min(1000)
  @Max(24 * 60 * 60 * 1000)
  intervalMs?: number;
}

/** 系统通知 DTO（POST /notify） */
export class NotifyDto {
  @IsString()
  @IsOptional()
  @MaxLength(200)
  title?: string;

  @IsString()
  @IsOptional()
  @MaxLength(2000)
  message?: string;

  @IsIn(['info', 'warn', 'error'])
  @IsOptional()
  level?: 'info' | 'warn' | 'error';

  @IsString()
  @IsOptional()
  @MaxLength(128)
  sessionId?: string;

  @IsOptional()
  silent?: boolean;
}
