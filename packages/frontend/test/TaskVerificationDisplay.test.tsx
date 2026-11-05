import {render,screen,fireEvent,cleanup} from '@testing-library/react';
import {afterEach,it,expect} from 'vitest';
import {MemoryRouter} from 'react-router-dom';
import {ToolCallDisplay} from '@/components/chat/ToolCallDisplay';
import {MessageItem} from '@/components/chat/MessageItem';
afterEach(cleanup);
it('keeps ordinary tool output collapsed and opens it with keyboard input',()=>{
  render(<ToolCallDisplay name="file-read" args={{path:'E:/项目/更新日志.txt'}} result={{success:true,output:'完整的工具返回正文'}}/>);
  expect(screen.queryByText('完整的工具返回正文')).toBeNull();
  const header=screen.getByRole('button',{name:/读取文件.*更新日志.txt/});
  expect(header).toHaveAttribute('aria-expanded','false');
  fireEvent.keyDown(header,{key:'Enter'});
  expect(screen.getByText('完整的工具返回正文')).toBeVisible();
  fireEvent.click(header);
  expect(screen.queryByText('完整的工具返回正文')).toBeNull();
});
it('shows readable checks without raw tool call IDs and supports keyboard collapse',()=>{
  render(<ToolCallDisplay name="task_verify" args={{checks:[{evidence:['internal-call-id']}]}} result={{success:true,data:{checks:[{requirement:'刷新后仍保留中文',status:'passed',detail:'已刷新并回读中文内容'}]}}}/>);
  expect(screen.queryByText(/刷新后仍保留中文/)).toBeNull();
  fireEvent.keyDown(screen.getByRole('button',{name:/任务验收/}),{key:'Enter'});
  expect(screen.getByText(/刷新后仍保留中文/)).toBeInTheDocument();expect(screen.queryByText(/internal-call-id/)).toBeNull();
  fireEvent.keyDown(screen.getByRole('button',{name:/任务验收/}),{key:'Enter'});
  expect(screen.queryByText(/刷新后仍保留中文/)).toBeNull();
});
it('retains failed tool status when reloading persisted history',()=>{
  render(<MemoryRouter><MessageItem message={{id:'persisted-failure',role:'tool',toolName:'powershell',content:JSON.stringify({success:false,error:'Command exited 1',output:'Partial output'}),timestamp:1}}/></MemoryRouter>);
  expect(screen.getByText('失败')).toBeInTheDocument();expect(screen.queryByText('成功')).toBeNull();
});
