import { Injectable } from '@nestjs/common';
export interface ExternalToolReloadResult { loaded: number; skippedConflicts: string[]; total: number }
@Injectable()
export class ExternalToolLoaderService {
  async onModuleInit(): Promise<void> {}
  async reloadExternalTools(): Promise<ExternalToolReloadResult> { return { loaded: 0, skippedConflicts: [], total: 0 }; }
}
