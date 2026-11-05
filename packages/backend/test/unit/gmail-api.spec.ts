import { gmailApi } from '../../src/modules/tools/executor/built-in/gmail-api';
describe('Gmail REST tools',()=>{
 const old=process.env['GMAIL_CREDENTIALS'];beforeEach(()=>delete process.env['GMAIL_CREDENTIALS']);afterAll(()=>{if(old!==undefined)process.env['GMAIL_CREDENTIALS']=old;});
 const config={get:()=>({access_token:'fixture-token'})};
 it('queries and reads metadata with a bounded result limit',async()=>{
  const http={get:jest.fn().mockResolvedValueOnce({status:200,data:{messages:[{id:'a/b',threadId:'t'}]}}).mockResolvedValueOnce({status:200,data:{snippet:'test',payload:{headers:[]}}})};
  const r=await gmailApi('search',{query:'label:inbox'},config as never,http as never);expect(r.success).toBe(true);expect(http.get.mock.calls[1][0]).toContain('a%2Fb?format=metadata');
 });
 it('encodes Chinese MIME and never treats an error response as delivery',async()=>{
  const http={post:jest.fn().mockResolvedValue({status:200,data:{id:'sent-id'}})};
  expect((await gmailApi('send',{to:'fixture@example.com',subject:'中文',body:'测试'},config as never,http as never)).success).toBe(true);
  const mime=Buffer.from(http.post.mock.calls[0][1].raw,'base64url').toString();expect(mime).toContain('Subject: =?UTF-8?B?5Lit5paH?=');
  http.post.mockResolvedValue({status:403,data:{}} as never);expect((await gmailApi('send',{to:'fixture@example.com',subject:'s',body:'b'},config as never,http as never)).success).toBe(false);
 });
 it('rejects header injection before sending and keeps failed credentials out of results',async()=>{
  const http={post:jest.fn()};expect((await gmailApi('send',{to:'a@b.com\r\nBcc: secret@x.com',subject:'s',body:'b'},config as never,http as never)).success).toBe(false);expect(http.post).not.toHaveBeenCalled();
  http.post.mockRejectedValue(new Error('private-token'));const r=await gmailApi('search',{query:'x'},{get:()=>({client_id:'x',client_secret:'private-token',refresh_token:'y'})} as never,http as never);expect(JSON.stringify(r)).not.toContain('private-token');
 });
});
