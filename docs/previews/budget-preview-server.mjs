import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../../public/',import.meta.url));
const budget={type:'monthly',limit:1000,nextLimit:null,month:'2026-10',used:481.70,balance:518.30,status:'active',monthlyResetEnabled:true,weeklyResetEnabled:true,stale:false,nextMonthAt:'2026-10-31T16:00:00Z',nextCheckAt:'2026-10-22T08:00:00Z',lastSuccessAt:'2026-10-22T07:00:00Z'};
const account={id:'demo-admin',secret:'Demo Admin',previousSecrets:[],keyCount:2,budget,rewards:[]};
const keys=['Research','Coding'].map((name,i)=>({
  id:`demo-${i}`,name:`Demo ${name}`,maskedKey:'sk-demo-only',matched:true,status:'active',quota:120,quotaUsed:26+i*6,
  usage:Object.fromEntries(['today','yesterday','week','lastWeek','month','lastMonth'].map((period,j)=>[period,{cost:[16,24,32,18,80,103][j]+i}]))
}));

// Entirely fake, loopback-only preview: no credentials, upstream client or scheduler.
http.createServer(async(request,response)=>{
  const url=new URL(request.url,'http://127.0.0.1');
  response.setHeader('Cache-Control','no-store');
  const json=(status,data)=>{response.writeHead(status,{'Content-Type':'application/json'});response.end(JSON.stringify(data));};
  if(url.pathname.startsWith('/api/')){
    if(request.method==='PUT'&&url.pathname==='/api/budget'){
      let raw='';for await(const chunk of request)raw+=chunk;
      const body=JSON.parse(raw||'{}');await new Promise(resolve=>setTimeout(resolve,700));
      if(!Number.isFinite(body.limit)||body.limit<.01||body.limit>1e8)return json(400,{error:'额度无效'});
      Object.assign(budget,{limit:body.limit,type:body.type,nextLimit:body.nextLimit??null,balance:Math.max(0,body.limit-budget.used)});
      return json(200,{keys,budget,rewards:[],orderVersion:0});
    }
    if(request.method!=='GET')return json(405,{error:'Fake preview only'});
    if(url.pathname==='/api/session')return json(200,{role:'superadmin',csrfToken:'fake-only',announcement:{version:'demo',acknowledged:true},notices:[]});
    if(url.pathname==='/api/access-keys')return json(200,{accessKeys:[account],orderVersion:0});
    if(url.pathname==='/api/keys')return json(200,{keys,budget,rewards:[],orderVersion:0,schedule:null});
    if(url.pathname==='/api/sync-status')return json(200,{inProgress:false,events:[],lastSuccessAt:budget.lastSuccessAt,nextCheckAt:budget.nextCheckAt});
    return json(200,{notices:[]});
  }
  try{
    const name=url.pathname==='/'?'index.html':url.pathname.slice(1),file=path.resolve(root,name);
    if(!file.startsWith(root))throw new Error('Invalid path');
    const body=await fs.readFile(file);
    response.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');response.end(body);
  }catch{response.writeHead(404);response.end();}
}).listen(3116,'127.0.0.1',()=>console.log('Fake budget preview http://127.0.0.1:3116/'));
