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
  const otherKey={id:2,key:'sk-second-only-123456789012',name:'Second mock',status:'active',quota:100,quota_used:2};
  const upstreamKeys=[key,otherKey];
  let loginCount=0,readCount=0,failSecondUsageAfter=null;
  const mock=http.createServer(async(req,res)=>{
    let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw||'{}');let data;
    if(req.url==='/api/v1/auth/login'){loginCount++;data={access_token:'test-token',expires_in:3600};}
    else if(req.url.startsWith('/api/v1/keys?')){readCount++;data={items:upstreamKeys,pages:1};}
    else if(/^\/api\/v1\/user\/api-keys\/[12]\/usage\/daily/.test(req.url)){
      if(req.url.includes('/api-keys/2/')&&failSecondUsageAfter!==null&&--failSecondUsageAfter===0){failSecondUsageAfter=null;res.writeHead(503);res.end('{}');return;}
      const today=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
      data={items:[{date:today,actual_cost:req.url.includes('/api-keys/1/')?50:10,requests:1}]};
    } else if(/^\/api\/v1\/keys\/[12]$/.test(req.url)&&req.method==='PUT'){const target=upstreamKeys.find(k=>k.id===Number(req.url.split('/').pop()));Object.assign(target,body);data=target;}
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
    // Login keys own independent data; renaming never changes that ownership.
    const listResponse=await request('/api/access-keys','GET',undefined,superadmin);
    assert.equal(listResponse.status,200);
    const {accessKeys}=await listResponse.json();
    assert.equal(accessKeys.length,1);
    assert.equal(accessKeys[0].secret,'111');
    assert.deepEqual(accessKeys[0].previousSecrets,[]);
    assert.equal(accessKeys[0].budget.limit,100);
    assert.equal((await request('/api/access-keys','GET')).status,403);
    assert.equal((await request('/api/access-keys','POST',{secret:'second',limit:20},superadmin)).status,201);
    const second=await login('second');
    const own=await (await request('/api/keys','GET',undefined,second)).json();
    assert.deepEqual(own.keys,[]);
    assert.equal(own.budget.limit,20);
    assert.equal((await request(`/api/keys?accessKeyId=${accessKeys[0].id}`,'GET',undefined,second)).status,403);
    assert.equal((await request('/api/keys/'+id,'PUT',{quota:1},second)).status,404);
    assert.equal((await request('/api/access-keys','POST',{secret:'second',limit:20},superadmin)).status,409);
    assert.equal((await request('/api/access-keys','POST',{secret:'superadmin',limit:20},superadmin)).status,409);
    assert.equal((await request('/api/login-secret','PUT',{secret:'second'},admin)).status,409);
    assert.equal((await request('/api/login-secret','PUT',{secret:'mise111'},admin,false)).status,403);
    const renamed=await request('/api/login-secret','PUT',{secret:'mise111'},admin);
    assert.equal(renamed.status,200);
    assert.equal((await request('/api/keys','GET',undefined,admin)).status,401);
    const oldLogin=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'111'})});
    assert.equal(oldLogin.status,401);
    const renamedSession=await login('mise111');
    assert.equal(renamedSession.accessKey.id,accessKeys[0].id);
    assert.deepEqual(renamedSession.accessKey.previousSecrets,['111']);
    const preserved=await (await request('/api/keys','GET',undefined,renamedSession)).json();
    assert.equal(preserved.keys[0].id,id);
    assert.equal(preserved.budget.limit,100);
    assert.equal(preserved.budget.used,50);
    assert.equal((await request('/api/login-secret','PUT',{secret:'mise111'},renamedSession)).status,200);
    assert.deepEqual((await (await request('/api/access-keys','GET',undefined,superadmin)).json()).accessKeys[0].previousSecrets,['111']);
    const secondId=second.accessKey.id;
    const scoped=url=>`${url}?accessKeyId=${secondId}`;
    assert.equal((await request(scoped('/api/keys'),'POST',{customKey:key.key},superadmin)).status,409);
    const secondAdded=await (await request(scoped('/api/keys'),'POST',{customKey:otherKey.key},superadmin)).json();
    assert.equal(secondAdded.budget.used,10);
    assert.equal(secondAdded.keys.length,1);
    await request(scoped('/api/budget'),'PUT',{limit:10},superadmin);
    assert.equal(otherKey.status,'inactive');assert.equal(key.status,'active');
    await request('/api/budget','PUT',{limit:50},superadmin);
    await request(scoped('/api/budget'),'PUT',{limit:20},superadmin);
    assert.equal(otherKey.status,'active');assert.equal(key.status,'inactive');
    const secondView=await (await request('/api/keys','GET',undefined,second)).json();
    assert.equal(secondView.keys[0].name,'Second mock');
    assert.equal(secondView.budget.used,10);
    const competing=await Promise.all(['a','b'].map(()=>request('/api/access-keys','POST',{secret:'concurrent',limit:5},superadmin)));
    assert.deepEqual(competing.map(r=>r.status).sort(),[201,409]);
    assert.equal((await request(`/api/access-keys/${secondId}`,'PUT',{secret:'second-renamed'},second)).status,403);
    assert.equal((await request(`/api/access-keys/${secondId}`,'PUT',{secret:'second-renamed'},superadmin)).status,200);
    assert.equal((await request('/api/keys','GET',undefined,second)).status,401);
    const secondRenamed=await login('second-renamed');
    assert.deepEqual(secondRenamed.accessKey.previousSecrets,['second']);
    for(const secret of ['', ' padded ', 'x'.repeat(129), 123]) assert.equal((await request('/api/login-secret','PUT',{secret},secondRenamed)).status,400);
    assert.equal((await request('/api/login-secret','PUT',{secret:'superadmin'},secondRenamed)).status,409);
    const transferPath=scoped(`/api/keys/${secondAdded.keys[0].id}/transfer`);
    assert.equal((await request(transferPath,'POST',{accessKeyId:accessKeys[0].id},secondRenamed)).status,403);
    failSecondUsageAfter=1;
    assert.equal((await request(transferPath,'POST',{accessKeyId:accessKeys[0].id},superadmin)).status,502);
    assert.equal((await (await request('/api/keys','GET',undefined,secondRenamed)).json()).keys.length,1);
    assert.equal((await request(transferPath,'POST',{accessKeyId:accessKeys[0].id},superadmin)).status,200);
    const destination=await (await request('/api/keys','GET',undefined,renamedSession)).json();
    const source=await (await request('/api/keys','GET',undefined,secondRenamed)).json();
    assert.equal(destination.keys.length,2);assert.equal(destination.budget.used,60);
    assert.equal(source.keys.length,0);assert.equal(source.budget.used,0);
    assert.equal(otherKey.status,'inactive');
    await request('/api/budget','PUT',{limit:100},superadmin);
    assert.equal(key.status,'active');assert.equal(otherKey.status,'active');
    assert.equal((await request(scoped('/api/keys/'+secondAdded.keys[0].id),'PUT',{quota:1},secondRenamed)).status,404);
    failSecondUsageAfter=2;
    const partial=await (await request(`/api/keys/${secondAdded.keys[0].id}/transfer`,'POST',{accessKeyId:secondId},superadmin)).json();
    assert.equal(partial.pendingSync,true);
    const pendingState=JSON.parse(await fs.readFile(path.join(directory,'state.json'),'utf8'));
    assert.equal(pendingState.accessKeys.find(entry=>entry.id===secondId).state.actionRetry,true);
    await request(scoped('/api/budget'),'PUT',{limit:5},superadmin);
    assert.equal(otherKey.status,'inactive');assert.equal(key.status,'active');
    const restoredView=await (await request('/api/keys','GET',undefined,secondRenamed)).json();
    assert.equal(restoredView.budget.used,10);assert.equal(restoredView.budget.error,null);
    const raw=await fs.readFile(path.join(directory,'state.json'),'utf8');assert.ok(!raw.includes(key.key));
    assert.ok(!raw.includes(otherKey.key));
  }finally{
    const exited=once(child,'exit');child.kill();await exited;
    mock.closeAllConnections();await new Promise(resolve=>mock.close(resolve));
    await fs.rm(directory,{recursive:true,force:true});
  }
});
