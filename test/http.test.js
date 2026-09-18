import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('HTTP roles, CSRF, cache, and budget enforcement through mock Sub2API',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'budget-http-'));
  const key={id:1,key:'sk-test-only-123456789012',name:'Mock',status:'active',quota:100,quota_used:4};
  let loginCount=0,readCount=0;
  const mock=http.createServer(async(req,res)=>{
    let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw||'{}');let data;
    if(req.url==='/api/v1/auth/login'){loginCount++;data={access_token:'test-token',expires_in:3600};}
    else if(req.url.startsWith('/api/v1/keys?')){readCount++;data={items:[key],pages:1};}
    else if(req.url.startsWith('/api/v1/user/api-keys/1/usage/daily')){
      const today=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
      data={items:[{date:today,actual_cost:50,requests:1}]};
    } else if(req.url==='/api/v1/keys/1'&&req.method==='PUT'){Object.assign(key,body);data=key;}
    else {res.writeHead(404);res.end('{}');return;}
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({code:0,data}));
  });
  mock.listen(0,'127.0.0.1');await once(mock,'listening');
  const child=spawn(process.execPath,['src/server.js'],{cwd:new URL('..',import.meta.url),env:{...process.env,PORT:'0',DATA_DIR:directory,ADMIN_PASSWORD:'111',SUPERADMIN_PASSWORD:'superadmin',SUB2API_BASE_URL:`http://127.0.0.1:${mock.address().port}`,SUB2API_EMAIL:'test@example.invalid',SUB2API_PASSWORD:'test',COOKIE_SECURE:'false'},stdio:['ignore','pipe','pipe']});
  try{
    const port=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error('Server startup timeout')),10000);
      child.stdout.on('data',chunk=>{const m=chunk.toString().match(/listening on port (\d+)/);if(m){clearTimeout(timer);resolve(m[1]);}});
      child.once('exit',code=>{clearTimeout(timer);reject(Error(`Server exited ${code}`))});
    });
    const base=`http://127.0.0.1:${port}`;
    const login=async password=>{const r=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({password})});return {...await r.json(),cookie:r.headers.get('set-cookie').split(';')[0]}};
    const admin=await login('111'),superadmin=await login('superadmin');
    assert.equal(admin.role,'admin');assert.equal(superadmin.role,'superadmin');
    const request=(url,method='GET',body,session=admin,csrf=true)=>fetch(base+url,{method,headers:{Cookie:session.cookie,Origin:base,'Content-Type':'application/json',...(csrf?{'X-CSRF-Token':session.csrfToken}:{})},body:body?JSON.stringify(body):undefined});
    assert.equal((await fetch(base+'/api/keys')).status,401);
    assert.equal((await request('/api/session')).status,200);
    for(const [url,method,body] of [['/api/budget','PUT',{limit:10}],['/api/keys','POST',{customKey:key.key}],['/api/keys/1','DELETE']]){
      assert.equal((await request(url,method,body)).status,403);
    }
    assert.equal((await request('/api/budget','PUT',{limit:100},superadmin,false)).status,403);
    const added=await (await request('/api/keys','POST',{customKey:key.key},superadmin)).json();
    const id=added.keys[0].id;
    assert.equal(added.budget.status,'unset');
    assert.equal((await request('/api/keys/'+id,'PUT',{quota:80})).status,200);
    assert.equal(key.quota,80);
    const before=readCount;await request('/api/keys');await request('/api/keys');await request('/api/refresh','POST');assert.equal(readCount,before);
    const blocked=await (await request('/api/budget','PUT',{limit:50},superadmin)).json();
    assert.equal(blocked.budget.status,'blocked');assert.equal(key.status,'inactive');
    assert.equal((await request('/api/keys/'+id,'PUT',{quota:100})).status,409);
    await request('/api/budget','PUT',{limit:100},superadmin);assert.equal(key.status,'active');
    assert.equal(loginCount,1);
    assert.equal((await request('/api/budget','PUT',{limit:null},superadmin)).status,400);
    const raw=await fs.readFile(path.join(directory,'state.json'),'utf8');assert.ok(!raw.includes(key.key));
  }finally{
    const exited=once(child,'exit');child.kill();await exited;
    mock.closeAllConnections();await new Promise(resolve=>mock.close(resolve));
    await fs.rm(directory,{recursive:true,force:true});
  }
});
