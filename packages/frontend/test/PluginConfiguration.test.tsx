import {render,screen,fireEvent,waitFor} from '@testing-library/react';
import {beforeEach,expect,it,vi} from 'vitest';
import {PluginConfiguration} from '../src/modules/plugins/PluginConfiguration';
import {apiClient} from '../src/services/api-client';
vi.mock('../src/services/api-client',()=>({apiClient:{get:vi.fn(),put:vi.fn(),delete:vi.fn()}}));
vi.mock('../src/components/modals/ConfirmDialog',()=>({showConfirm:vi.fn().mockResolvedValue(true)}));
beforeEach(()=>{vi.clearAllMocks();});
it('uses password fields, keeps a saved secret blank, and saves typed settings without replacing the secret',async()=>{
  vi.mocked(apiClient.get).mockResolvedValue({config:{apiKey:'***',limit:10},schema:{properties:{apiKey:{type:'string',title:'API Key'},limit:{type:'integer',title:'Limit'}},required:['apiKey']}});
  const close=vi.fn();render(<PluginConfiguration id="local" name="Local" onClose={close}/>);
  const key=await screen.findByLabelText('API Key');expect(key).toHaveAttribute('type','password');expect(key).toHaveValue('');
  fireEvent.change(screen.getByLabelText('Limit'),{target:{value:'20'}});fireEvent.click(screen.getByRole('button',{name:'保存配置'}));
  await waitFor(()=>expect(apiClient.put).toHaveBeenCalledWith('/plugins/local/config',{limit:20}));expect(close).toHaveBeenCalled();
});
it('keeps JSON edits on save failure and supports clearing credentials',async()=>{
  vi.mocked(apiClient.get).mockResolvedValue({config:{token:'***'},schema:null});vi.mocked(apiClient.put).mockRejectedValueOnce(Error('保存失败'));
  render(<PluginConfiguration id="local" name="Local" onClose={vi.fn()}/>);const input=await screen.findByLabelText('JSON 配置');
  fireEvent.change(input,{target:{value:'{"token":"new-value"}'}});fireEvent.click(screen.getByRole('button',{name:'保存配置'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('保存失败');expect(input).toHaveValue('{"token":"new-value"}');
  fireEvent.click(screen.getByRole('button',{name:'清除配置'}));await waitFor(()=>expect(apiClient.delete).toHaveBeenCalledWith('/plugins/local/config'));
});
