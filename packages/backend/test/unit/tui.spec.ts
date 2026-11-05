import 'reflect-metadata';
import { TuiService } from '../../src/modules/terminal/tui.service';
import { SessionService } from '../../src/modules/session/session.service';
describe('TUI lifecycle', () => {
  it('runs a model turn, exposes its result, isolates owners and closes', async () => {
    const mockAgent = { async *run() { yield { type:'assistant_message', content:'fixture answer' }; yield {type:'done'}; } };
    const tui=new TuiService({get:(token:unknown)=>token===SessionService?{createSession:()=>({id:'chat'}),getSession:()=>({messages:[]})}:mockAgent} as never);
    const start=tui.start('owner');const id=('id' in start?start.id:'')!;
    expect(()=>tui.status('other',id)).toThrow();
    expect(tui.send('owner',id,'/help')).toHaveProperty('text');
    tui.send('owner',id,'hello');await new Promise(r=>setTimeout(r,0));
    expect(tui.status('owner',id)).toMatchObject({running:false,text:expect.stringContaining('fixture answer')});
    expect(tui.stop('owner',id)).toMatchObject({stopped:true});expect(()=>tui.status('owner',id)).toThrow();
  });
  it('reports a model failure rather than a fabricated answer', async () => {
    const tui=new TuiService({get:(token:unknown)=>token===SessionService?{createSession:()=>({id:'chat'})}:{async *run(){throw new Error('provider unavailable');}}} as never);
    const start=tui.start('owner');const id=('id' in start?start.id:'')!;tui.send('owner',id,'hello');await new Promise(r=>setTimeout(r,0));
    expect(tui.status('owner',id)).toHaveProperty('text',expect.stringContaining('provider unavailable'));
    tui.stop('owner',id);
  });
});
