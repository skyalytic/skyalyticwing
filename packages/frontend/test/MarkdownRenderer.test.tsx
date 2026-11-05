import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer';

afterEach(cleanup);
const table = '| 类别 | 例子 | 原因 |\n| :--- | :---: | ---: |\n| **账号** | 用户提供的资料 | 授权填写 |\n| 其他 | A\\|B | `字段` |';

it.each(['\n', '\r\n'])('renders Chinese tables with %j line endings and inline formatting', newline => {
  render(<MarkdownRenderer content={'说明'+newline+newline+table.replaceAll('\n',newline)+newline+newline+'后续说明'} />);
  const grid=screen.getByRole('table');
  expect(within(grid).getAllByRole('columnheader')).toHaveLength(3);
  expect(within(grid).getAllByRole('row')).toHaveLength(3);
  expect(within(grid).getByText('账号').tagName).toBe('STRONG');
  expect(within(grid).getByText('A|B')).toBeInTheDocument();
  expect(within(grid).getByText('字段').tagName).toBe('CODE');
  expect(within(grid).getByRole('columnheader',{name:'例子'})).toHaveStyle({textAlign:'center'});
  expect(screen.getByText('后续说明')).toBeInTheDocument();
  expect(grid.parentElement).toHaveClass('markdown-table-scroll');
});

it('finishes a streamed table without losing cells',()=>{
  const {rerender}=render(<MarkdownRenderer content="| 类别 | 例子 |"/>);
  expect(screen.queryByRole('table')).toBeNull();
  rerender(<MarkdownRenderer content={table}/>);
  expect(screen.getByRole('table')).toBeInTheDocument();
  expect(screen.getByRole('cell',{name:'授权填写'})).toBeInTheDocument();
});

it('keeps literal pipes and fenced examples as text, and does not enable unsafe HTML',()=>{
  const {container}=render(<MarkdownRenderer content={'普通 A | B\n\n```text\n'+table+'\n```\n\n<script>alert(1)</script>\n\n[链接](javascript:alert(1))'}/>);
  expect(screen.queryByRole('table')).toBeNull();
  expect(screen.getByText('普通 A | B')).toBeInTheDocument();
  expect(container.querySelector('pre code')).toHaveTextContent('| 类别 |');
  expect(container.querySelector('script')).toBeNull();
  expect(container.querySelector('a')).not.toHaveAttribute('href','javascript:alert(1)');
});
