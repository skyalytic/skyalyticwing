import { BadRequestException } from '@nestjs/common';
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/** 命令执行 DTO（POST /exec/command） */
export class ExecCommandDto {
  @IsString()
  @MaxLength(8000)
  command!: string;

  @IsString()
  @IsOptional()
  @MaxLength(1024)
  cwd?: string;

  @IsInt()
  @IsOptional()
  @Min(1000)
  timeout?: number;
}

/** 文件读取 DTO（POST /files/read） */
export class FileReadDto {
  @IsString()
  @MaxLength(2048)
  path!: string;
}

/** 目录列表 DTO（POST /files/list） */
export class FileListDto {
  @IsString()
  @MaxLength(2048)
  path!: string;
}

/** 技能市场安装 DTO（POST /skill-marketplace/install） */
export class SkillInstallDto {
  @IsString()
  @MaxLength(128)
  name!: string;

  @IsString()
  @IsOptional()
  @MaxLength(64)
  source?: string;
}

/** 计算机使用 - 键盘输入 DTO（POST /computer-use/type） */
export class ComputerTypeDto {
  @IsString()
  @MaxLength(10000)
  text!: string;

  @IsInt()
  @IsOptional()
  @Min(0)
  delay?: number;
}

/** 计算机使用 - 点击 DTO（POST /computer-use/click） */
export class ComputerClickDto {
  @IsInt()
  @IsOptional()
  x?: number;

  @IsInt()
  @IsOptional()
  y?: number;

  @IsIn(['left', 'right', 'middle'])
  @IsOptional()
  button?: string;

  @IsOptional()
  double?: boolean;
}

/** 浏览器导航 DTO（POST /browser/navigate、POST /browser/screenshot） */
export class BrowserNavigateDto {
  @IsString()
  @MaxLength(2048)
  url!: string;
}

/** LSP 扩展校验：文件参数非空 */
export function assertFileParam(file: string | undefined): string {
  if (!file || file.trim().length === 0) {
    throw new BadRequestException('file parameter required');
  }
  return file;
}

/** 技能名称校验（防路径穿越，对齐旧版 scan-skill 校验规则） */
export function isValidSkillName(name: string): boolean {
  return !name.includes('..') && !name.includes('/') && !name.includes('\\');
}
