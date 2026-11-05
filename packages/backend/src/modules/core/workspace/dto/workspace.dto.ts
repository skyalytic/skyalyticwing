import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** POST /workspace 请求体 */
export class WriteWorkspaceFileDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  file!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100000)
  content!: string;
}
