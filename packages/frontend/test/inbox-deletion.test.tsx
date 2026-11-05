import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import {render,screen,fireEvent,waitFor,cleanup,within} from '@testing-library/react';
import {MemoryRouter} from 'react-router-dom';
import {InboxPage} from '../src/modules/channels/InboxPage';
const mocks=vi.hoisted(()=>({get:vi.fn(),post:vi.fn(),error:vi.fn()}));
vi.mock('../src/services/api-client',()=>({apiClient:mocks}));
vi.mock('../src/components/ui/Toast',()=>({toast:{error:mocks.error}}));
vi.mock('../src/i18n/workbench-text',()=>({wt:(s:string,p?:Record<string,unknown>)=>s.replace('{{count}}',String(p?.count??'')),useWorkbenchLanguage:()=>{},workbenchLocale:()=> 'zh-CN'}));
let data:any;
const item=(id:string)=>({id,channelId:'feishu',peer:id,thread:'thread',content:'消息'+id,timestamp:1,direction:'inbound',unread:false,task:'none'});
beforeEach(()=>{vi.clearAllMocks();data={items:[item('one'),item('two')],drafts:[{id:'draft',itemId:'one',content:'关联草稿',status:'draft'}]};mocks.get.mockImplementation(async()=>structuredClone(data));mocks.post.mockImplementation(async(path,body)=>{if(path==='/inbox/clear'){data.items=data.items.filter((i:any)=>!body.ids.includes(i.id));data.drafts=data.drafts.filter((d:any)=>!body.ids.includes(d.itemId));}return {deleted:body.ids?.length};});});
afterEach(cleanup);
const setup=async()=>{render(<MemoryRouter><InboxPage/></MemoryRouter>);await screen.findByText('消息one');};
describe('inbox deletion',()=>{
 it('deletes a selected message and clears its draft and detail without touching another message',async()=>{
  await setup();fireEvent.click(screen.getByText('消息one'));await screen.findByText('关联草稿');
  fireEvent.click(screen.getByRole('button',{name:'删除此消息'}));
  await waitFor(()=>expect(screen.queryByText('消息one')).toBeNull());
  expect(screen.queryByText('关联草稿')).toBeNull();expect(screen.getByText('消息two')).toBeInTheDocument();
  expect(mocks.post).toHaveBeenCalledWith('/inbox/clear',{ids:['one']});
 });
 it('confirms the complete snapshot even with a filter, preserves messages arriving later and allows cancel',async()=>{
  await setup();fireEvent.change(screen.getByLabelText('搜索收件箱'),{target:{value:'one'}});
  fireEvent.click(screen.getByRole('button',{name:'一键清理全部'}));
  expect(screen.getByText('将删除所选的 2 条本地消息及关联草稿。')).toBeInTheDocument();
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button',{name:'取消'}));expect(mocks.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'一键清理全部'}));data.items.push(item('new'));
  fireEvent.click(screen.getByRole('button',{name:'确认清理'}));
  await waitFor(()=>expect(screen.queryByRole('dialog')).toBeNull());
  expect(mocks.post).toHaveBeenCalledWith('/inbox/clear',{ids:['one','two']});
  fireEvent.change(screen.getByLabelText('搜索收件箱'),{target:{value:''}});expect(await screen.findByText('消息new')).toBeInTheDocument();
 });
 it('keeps the message visible and reports a failed deletion',async()=>{
  await setup();fireEvent.click(screen.getByText('消息one'));mocks.post.mockRejectedValueOnce(new Error('正在发送'));
  fireEvent.click(screen.getByRole('button',{name:'删除此消息'}));await waitFor(()=>expect(mocks.error).toHaveBeenCalled());
  expect(screen.getAllByText('消息one').length).toBeGreaterThan(0);
 });
});
