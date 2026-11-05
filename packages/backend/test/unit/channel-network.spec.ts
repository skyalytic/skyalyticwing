import { selectChannelProxy } from '../../src/modules/channels/channel-network.js';
describe('channel proxy routing',()=>{
  const system={server:'127.0.0.1:7897',bypass:'<local>;*.internal.test'};
  it('uses the Windows system proxy for HTTPS and WebSocket channels',()=>{
    expect(selectChannelProxy('wss://openws.work.weixin.qq.com',{},system)).toBe('http://127.0.0.1:7897/');
    expect(selectChannelProxy('https://oapi.dingtalk.com',{},system)).toBe('http://127.0.0.1:7897/');
  });
  it('honors explicit proxy configuration and bypasses local addresses',()=>{
    expect(selectChannelProxy('https://api.dingtalk.com',{HTTPS_PROXY:'http://proxy.test:8888'},system)).toBe('http://proxy.test:8888/');
    for(const url of ['http://127.0.0.1:910','http://localhost','https://a.internal.test','http://printer'])expect(selectChannelProxy(url,{},system)).toBeUndefined();
    expect(selectChannelProxy('https://api.dingtalk.com',{NO_PROXY:'.dingtalk.com'},system)).toBeUndefined();
    expect(selectChannelProxy('https://evil-dingtalk.com',{NO_PROXY:'.dingtalk.com'},system)).toBeDefined();
  });
  it('supports protocol-specific system settings without sending local traffic to a proxy',()=>{
    expect(selectChannelProxy('wss://openws.work.weixin.qq.com',{}, {server:'http=proxy.test:8080;https=proxy.test:8443',bypass:''})).toBe('http://proxy.test:8443/');
    expect(selectChannelProxy('https://api.dingtalk.com',{},null)).toBeUndefined();
  });
});
