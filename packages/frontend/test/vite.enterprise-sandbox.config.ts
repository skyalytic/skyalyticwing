import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {resolve} from 'node:path';
export default defineConfig({
 root:resolve(__dirname,'..'),resolve:{alias:{'@':resolve(__dirname,'../src')}},
 plugins:[react(),{name:'enterprise-sandbox-controls',apply:'serve',transformIndexHtml:()=>[{tag:'script',attrs:{type:'module',src:'/test/enterprise-sandbox-controls.ts'},injectTo:'body'}]}],
 server:{host:'127.0.0.1',port:19265,strictPort:true,proxy:{
 '/api':{target:'http://127.0.0.1:19264',changeOrigin:true},
 '/__enterprise-demo':{target:'http://127.0.0.1:19264'},
 '/ws':{target:'ws://127.0.0.1:19266',ws:true,configure:p=>p.on('proxyReqWs',req=>req.setHeader('Authorization','Bearer '+process.env['VITE_AUTH_TOKEN']))}
 }}
});

