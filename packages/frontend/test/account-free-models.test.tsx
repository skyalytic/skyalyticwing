import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ChatInput } from '@/components/chat/ChatInput';
import { useDataStore } from '@/services/data-loader';

afterEach(()=>{cleanup();vi.unstubAllGlobals();useDataStore.getState().set({models:[]});});
it('selects and sends a user model without fetching an account or showing credit controls', async () => {
  const models=[{id:'custom::fixture',name:'Fixture API',providerName:'Custom',kind:'chat',available:true},{id:'ollama::fixture',name:'Fixture Local',providerName:'Ollama',kind:'chat',available:true}];
  const fetcher=vi.fn(async (url:string,init?:RequestInit)=> {
    if(String(url).includes('official-account'))throw Error('Unexpected account request');
    const data=url==='/api/models'?{models}:url==='/api/config/general'?{value:init?.body?JSON.parse(String(init.body)):{defaultModel:'custom::fixture'}}:[];
    return Response.json({success:true,data});
  });
  vi.stubGlobal('fetch',fetcher);
  const send=vi.fn();render(<MemoryRouter><ChatInput onSend={send}/></MemoryRouter>);
  await screen.findByRole('option',{name:/Fixture API/});
  fireEvent.change(screen.getByTitle('切换模型'),{target:{value:'ollama::fixture'}});
  await waitFor(()=>expect(screen.getByTitle('切换模型')).toHaveValue('ollama::fixture'));
  fireEvent.change(screen.getByRole('textbox'),{target:{value:'fixture message'}});
  fireEvent.keyDown(screen.getByRole('textbox'),{key:'Enter'});
  await waitFor(()=>expect(send).toHaveBeenCalled());
  expect(send.mock.calls[0]?.[0]).toBe('fixture message');
  expect(JSON.stringify(fetcher.mock.calls)).not.toContain('official-account');
  expect(screen.queryByText('登录 Wing')).toBeNull();
  expect(screen.queryByText('补充积分')).toBeNull();
});
