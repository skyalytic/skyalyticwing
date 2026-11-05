import { ForbiddenException, Injectable } from '@nestjs/common';
export type LocalResourceType = 'plugin' | 'mcp' | 'skill';

@Injectable()
export class LocalResourcePolicy {
  // Account-private artifacts are not part of the standalone distribution.
  private available(key: string): boolean { return !/^(?:skyalytic:)?enterprise-/.test(key); }
  registerBundledSource(_type: LocalResourceType, _contains: (key: string) => boolean): void {}
  localResourceRoot(base: string): string { return base; }
  credentialIdentity(): string { return 'local'; }
  localMemoryRoot(base: string): string { return base; }
  async assert(_type: LocalResourceType, key: string): Promise<void> {
    if (!this.available(key)) throw new ForbiddenException('Account-private resources are unavailable');
  }
  async filterAvailable<T>(_type: LocalResourceType, items: T[], keyOf: (item: T) => string): Promise<T[]> {
    return items.filter(item => this.available(keyOf(item)));
  }
}
