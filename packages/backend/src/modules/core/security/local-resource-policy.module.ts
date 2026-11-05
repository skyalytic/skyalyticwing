import { Global, Module } from '@nestjs/common';
import { LocalResourcePolicy } from './local-resource-policy.service.js';

@Global()
@Module({ providers: [LocalResourcePolicy], exports: [LocalResourcePolicy] })
export class LocalResourcePolicyModule {}
