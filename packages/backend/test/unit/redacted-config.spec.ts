import { restoreRedactedConfig } from '../../src/modules/core/logger/redacted-config.util.js';
import { ConfigController } from '../../src/modules/core/config/config.controller.js';
import { ConfigService } from '../../src/modules/core/config/config.service.js';
import { ProviderService } from '../../src/modules/ai/llm/provider.service.js';

describe('masked configuration roundtrip', () => {
  it('preserves credentials while updating normal fields, and permits deliberate clearing', () => {
    const current = {auth:{token:'real-value'},providers:{test:{apiKey:'real-key',maxTokens:100}}};
    expect(restoreRedactedConfig({auth:{token:'***'},providers:{test:{apiKey:'***',maxTokens:200}}},current)).toEqual({auth:{token:'real-value'},providers:{test:{apiKey:'real-key',maxTokens:200}}});
    expect(restoreRedactedConfig({auth:{token:''}},current)).toEqual({auth:{token:''}});
    expect(current.providers.test.maxTokens).toBe(100);
  });
  it('matches reordered array entries by stable identity, never by index', () => {
    const current = [{id:'a',env:{API_KEY:'key-a'}},{id:'b',env:{API_KEY:'key-b'}}];
    expect(restoreRedactedConfig([{id:'b',env:{API_KEY:'***'}},{id:'a',env:{API_KEY:'***'}}],current)).toEqual([current[1],current[0]]);
    expect(()=>restoreRedactedConfig([{env:{API_KEY:'***'}}],current)).toThrow('脱敏占位符');
    expect(()=>restoreRedactedConfig([{id:'new',env:{API_KEY:'***'}}],current)).toThrow('脱敏占位符');
  });
  it('preserves nested TLS keys without changing ordinary URLs or text', () => {
    expect(restoreRedactedConfig({tls:{key:'***'},url:'***',content:'***'}, {tls:{key:'tls-private'}})).toEqual({tls:{key:'tls-private'},url:'***',content:'***'});
    expect(()=>restoreRedactedConfig({apiKey:'***'},{apiKey:'***'})).toThrow('脱敏占位符');
  });
  it('protects both configuration write routes and persists only the restored value', () => {
    const config = new ConfigService(); config.set('security',{auth:{token:'original'}}); config.save=jest.fn();
    const controller = new ConfigController(config, {} as ProviderService);
    controller.updateAll({security:{auth:{token:'***',mode:'token'}}});
    controller.updateSection('security',{auth:{token:'***'},enabled:true});
    expect(config.get<any>('security')).toEqual({auth:{token:'original',mode:'token'},enabled:true});
    expect(config.save).toHaveBeenCalledTimes(2);
  });
});
