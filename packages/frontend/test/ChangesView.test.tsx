import {render,screen,fireEvent,waitFor,act} from '@testing-library/react';
import {beforeEach,describe,it,expect,vi} from 'vitest';
import {ChangesView} from '@/components/workspace/ChangesView';
import {useProjectPanel} from '@/stores/project-panel-store';
import {apiClient} from '@/services/api-client';
vi.mock('@/services/api-client',()=>({apiClient:{get:vi.fn(),post:vi.fn()}}));
vi.mock('@/components/workspace/GitChangesView',()=>({GitChangesView:()=>null}));
let state='applied',visible=false;
const detail=()=>({id:'change',name:'方案.txt',path:'E:/project/方案.txt',at:1,source:'AI 对话修改',state,before:{hash:'before',size:5},after:{hash:'after',size:8},binary:false,compatible:true,diff:'-原文\n+新内容',added:1,removed:1,reason:''});
beforeEach(()=>{
 state='applied';visible=false;vi.clearAllMocks();
 useProjectPanel.setState({projectDir:'E:/project',treeVersion:0});
 vi.mocked(apiClient.get).mockImplementation(async(path)=>path.startsWith('/files/changes?')?{changes:visible?[detail()]:[]}:detail());
 vi.mocked(apiClient.post).mockImplementation(async()=>{state=state==='applied'?'undone':'applied';return detail();});
});
describe('changes view live refresh and restore',()=>{
 it('shows a completed file edit without a manual refresh, and only restores after confirmation',async()=>{
  render(<ChangesView/>); await screen.findByText('还没有文档变更');
  visible=true;act(()=>useProjectPanel.getState().bumpTreeVersion());
  await screen.findByText('+新内容');
  fireEvent.click(screen.getByRole('button',{name:'撤销此变更'}));
  expect(apiClient.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'取消'}));
  expect(apiClient.post).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'撤销此变更'}));
  fireEvent.click(screen.getByRole('button',{name:'确认恢复'}));
  await screen.findByRole('button',{name:'重做此变更'});
  expect(apiClient.post).toHaveBeenCalledWith('/files/changes/change/restore',{state:'applied'});
  fireEvent.click(screen.getByRole('button',{name:'重做此变更'}));
  fireEvent.click(screen.getByRole('button',{name:'确认恢复'}));
  await screen.findByRole('button',{name:'撤销此变更'});
  expect(apiClient.post).toHaveBeenLastCalledWith('/files/changes/change/restore',{state:'undone'});
 });
 it('keeps the current state after a restore error and shows the conflict',async()=>{
  visible=true;vi.mocked(apiClient.post).mockRejectedValue(new Error('已有后续修改'));
  render(<ChangesView/>); await screen.findByText('+新内容');
  fireEvent.click(screen.getByRole('button',{name:'撤销此变更'}));fireEvent.click(screen.getByRole('button',{name:'确认恢复'}));
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('已有后续修改'));
  expect(screen.getByRole('button',{name:'撤销此变更'})).toBeEnabled();
  expect(screen.queryByRole('button',{name:'重做此变更'})).toBeNull();
 });
});
