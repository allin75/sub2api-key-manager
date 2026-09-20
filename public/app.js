const state = { csrfToken: '', keys: [], schedule: null, budget:null, role:'admin', accessKey:null, accessKeys:[], selectedAccessId:'', loadVersion:0 };
const elements = Object.fromEntries(['loginScreen','loginForm','loginError','password','app','logoutButton','refreshButton','resetCountdown','openAddButton','usageSummary','keyGrid','addOverlay','addForm','customKey','addError','closeAddButton','cancelAddButton','quotaOverlay','quotaForm','quotaInput','quotaError','quotaDescription','closeQuotaButton','cancelQuotaButton','toast'].map(id => [id, document.getElementById(id)]));

for(const id of ['roleLabel','budgetStatus','syncStatus','budgetOverlay','budgetForm','budgetInput','budgetError','closeBudgetButton','cancelBudgetButton','saveBudgetButton']) elements[id]=document.getElementById(id);
for(const id of ['accessManagement','accessTotals','accessSearch','accessList','currentAccess','changeSecretButton','newAccessButton','accessOverlay','accessForm','accessTitle','accessDescription','accessSecret','accessLimitField','accessLimit','accessError','closeAccessButton','cancelAccessButton','saveAccessButton','addDescription']) elements[id]=document.getElementById(id);
for(const id of ['transferOverlay','transferForm','transferDescription','transferTarget','transferError','closeTransferButton','cancelTransferButton','saveTransferButton']) elements[id]=document.getElementById(id);
let transferKeyId='';
elements.closeTransferButton.addEventListener('click',closeTransfer);
elements.cancelTransferButton.addEventListener('click',closeTransfer);
elements.transferOverlay.addEventListener('click',event=>{if(event.target===elements.transferOverlay)closeTransfer()});
elements.transferForm.addEventListener('submit',async event=>{
  event.preventDefault();elements.transferError.textContent='';setBusy(elements.saveTransferButton,true,'转移中…');
  try {
    const result=await api(`/api/keys/${encodeURIComponent(transferKeyId)}/transfer`,{method:'POST',body:{accessKeyId:elements.transferTarget.value}});
    closeTransfer();await loadKeys();toast(result.pendingSync?'关联已转移，额度状态待同步':'关联和本月用量已转移');
  }catch(error){elements.transferError.textContent=error.message;}
  finally{setBusy(elements.saveTransferButton,false,'转移关联');}
});
function closeTransfer(){elements.transferOverlay.classList.add('hidden');elements.transferForm.reset();elements.transferError.textContent='';transferKeyId='';}
function openTransfer(id){
  transferKeyId=id;
  const key=state.keys.find(item=>item.id===id);
  elements.transferDescription.textContent=`将“${key?.name||'API Key'}”从当前登录密钥转移到另一条登录密钥。`;
  elements.transferTarget.innerHTML=state.accessKeys.filter(entry=>entry.id!==state.selectedAccessId).map(entry=>`<option value="${entry.id}">${escapeHtml(entry.secret)}</option>`).join('');
  elements.transferError.textContent='';elements.transferOverlay.classList.remove('hidden');elements.transferTarget.focus();
}
let editingAccessId=null;
elements.newAccessButton.addEventListener('click',()=>openAccess());
elements.changeSecretButton.addEventListener('click',()=>openAccess(state.accessKey));
elements.closeAccessButton.addEventListener('click',closeAccess);
elements.cancelAccessButton.addEventListener('click',closeAccess);
elements.accessOverlay.addEventListener('click',event=>{if(event.target===elements.accessOverlay)closeAccess()});
elements.accessForm.addEventListener('submit',saveAccess);
elements.accessSearch.addEventListener('input',renderAccessKeys);
elements.closeBudgetButton.addEventListener('click',closeBudget);
elements.cancelBudgetButton.addEventListener('click',closeBudget);
elements.budgetOverlay.addEventListener('click',event=>{if(event.target===elements.budgetOverlay)closeBudget()});
elements.budgetForm.addEventListener('submit',saveBudget);

async function boot() {
  try {
    const session = await api('/api/session');
    enterApp(session);
  } catch { showLogin(); }
}

elements.loginForm.addEventListener('submit', async event => {
  event.preventDefault();
  elements.loginError.textContent = '';
  try {
    const session = await api('/api/login', { method:'POST', body:{ password:elements.password.value } });
    elements.password.value = '';
    enterApp(session);
  } catch (error) { elements.loginError.textContent = error.message; }
});

elements.logoutButton.addEventListener('click', async () => {
  try { await api('/api/logout', { method:'POST' }); } finally { state.csrfToken=''; showLogin(); }
});
elements.refreshButton.addEventListener('click', () => loadKeys(true));
elements.openAddButton.addEventListener('click', () => { elements.addDescription.textContent=`关联到登录密钥“${currentAccess()?.secret||''}”；完整 API Key 仅用于验证。`; elements.addOverlay.classList.remove('hidden'); elements.customKey.focus(); });
elements.closeAddButton.addEventListener('click', closeAdd);
elements.cancelAddButton.addEventListener('click', closeAdd);
elements.addOverlay.addEventListener('click', event => { if (event.target === elements.addOverlay) closeAdd(); });
elements.addForm.addEventListener('submit', async event => {
  event.preventDefault();
  elements.addError.textContent='';
  try {
    await api('/api/keys', { method:'POST', body:{ customKey:elements.customKey.value.trim() } });
    closeAdd(); toast('自定义 Key 已验证并添加'); await loadKeys();
  } catch(error) { elements.addError.textContent=error.message; }
});
elements.closeQuotaButton.addEventListener('click', closeQuota);
elements.cancelQuotaButton.addEventListener('click', closeQuota);
elements.quotaOverlay.addEventListener('click', event => { if(event.target===elements.quotaOverlay) closeQuota(); });
elements.quotaForm.addEventListener('submit', updateQuota);

function enterApp(session) {
  state.csrfToken=session.csrfToken;
  state.role=session.role;
  state.accessKey=session.accessKey;
  state.accessKeys=[];
  state.selectedAccessId=session.accessKey?.id||'';
  elements.roleLabel.textContent=state.role==='superadmin'?'超级管理员':'密钥管理';
  elements.accessManagement.classList.toggle('hidden',state.role!=='superadmin');
  elements.changeSecretButton.classList.toggle('hidden',state.role==='superadmin');
  elements.accessSearch.value='';
  elements.openAddButton.classList.toggle('hidden',state.role!=='superadmin');
  elements.loginScreen.classList.add('hidden');
  elements.app.classList.remove('hidden');
  loadKeys();
}

function showLogin() {
  closeBudget(); closeAdd(); closeQuota(); closeAccess(); closeTransfer();
  state.loadVersion++;
  state.csrfToken='';state.keys=[];state.budget=null;state.accessKeys=[];state.accessKey=null;state.selectedAccessId='';
  elements.accessList.innerHTML='';elements.accessTotals.innerHTML='';elements.currentAccess.textContent='';elements.usageSummary.innerHTML='';elements.keyGrid.innerHTML='';
  elements.app.classList.add('hidden');
  elements.loginScreen.classList.remove('hidden');
  elements.password.focus();
}

async function loadKeys(showMessage=false) {
  const version=++state.loadVersion;
  setBusy(elements.refreshButton,true,'刷新中…');
  if(!state.keys.length)elements.keyGrid.innerHTML='<div class="loading">正在读取用量数据…</div>';
  try {
    if(state.role==='superadmin') {
      const list=await api('/api/access-keys');
      if(version!==state.loadVersion)return;
      state.accessKeys=list.accessKeys;
      if(!state.accessKeys.some(entry=>entry.id===state.selectedAccessId))state.selectedAccessId=state.accessKeys[0]?.id||'';
      renderAccessKeys();
    }
    const data=await api(showMessage?'/api/refresh':'/api/keys',showMessage?{method:'POST'}:{});
    if(version!==state.loadVersion)return;
    state.keys=data.keys; state.schedule=data.schedule;state.budget=data.budget;
    const selected=currentAccess();
    if(selected){selected.budget=data.budget;selected.keyCount=data.keys.length;}
    renderAccessKeys();renderCurrentAccess();
    renderSummary(); renderKeys(); renderSchedule();
    if(showMessage) toast(data.cached?'已显示缓存，手动刷新最多每 5 分钟一次':data.budget?.stale?'同步未完成，保留最近成功数据':'数据已刷新');
  } catch(error) {
    if(version===state.loadVersion)elements.syncStatus.textContent=error.message;
  } finally { if(version===state.loadVersion)setBusy(elements.refreshButton,false,'刷新数据'); }
}

function currentAccess(){return state.role==='superadmin'?state.accessKeys.find(entry=>entry.id===state.selectedAccessId):state.accessKey;}

function renderCurrentAccess(){
  const entry=currentAccess();
  elements.currentAccess.innerHTML=entry?`<span>${state.role==='superadmin'?'当前管理':'当前登录'}密钥</span><strong>${escapeHtml(entry.secret)}</strong>${entry.previousSecrets.length?`<small>曾用密钥：${entry.previousSecrets.map(escapeHtml).join('、')}</small>`:''}`:'';
}

function renderAccessKeys(){
  if(state.role!=='superadmin')return;
  const all=state.accessKeys, ready=all.every(entry=>entry.budget.used!==null), allocated=all.reduce((sum,entry)=>sum+(entry.budget.limit||0),0), used=all.reduce((sum,entry)=>sum+(entry.budget.used||0),0), balance=all.reduce((sum,entry)=>sum+(entry.budget.balance||0),0);
  const unset=all.filter(entry=>entry.budget.limit===null).length;
  elements.accessTotals.innerHTML=`<div><span>登录密钥</span><strong>${all.length}</strong></div><div><span>月度总额度${unset?'（已设置）':''}</span><strong>${money(allocated)}</strong></div><div><span>本月已用</span><strong>${ready?money(used):'待同步'}</strong></div><div><span>剩余额度${unset?'（已设置）':''}</span><strong>${ready?money(balance):'待同步'}</strong></div>`;
  const search=elements.accessSearch.value.toLocaleLowerCase();
  const matches=all.filter(entry=>[entry.secret,...entry.previousSecrets].some(value=>value.toLocaleLowerCase().includes(search)));
  elements.accessList.innerHTML=matches.map(entry=>`<article class="access-card${entry.id===state.selectedAccessId?' access-selected':''}"><div class="access-card-heading"><strong>${escapeHtml(entry.secret)}</strong><span>${entry.keyCount} 个 API Key</span></div>${entry.previousSecrets.length?`<p class="access-history">曾用密钥：${entry.previousSecrets.map(escapeHtml).join('、')}</p>`:''}<dl><div><dt>每月额度</dt><dd>${entry.budget.limit===null?'未设置':money(entry.budget.limit)}</dd></div><div><dt>已用 / 剩余</dt><dd>${entry.budget.used===null?'待同步':`${money(entry.budget.used)} / ${entry.budget.balance===null?'未设置':money(entry.budget.balance)}`}</dd></div></dl><p class="access-status">${entry.budget.stale?'用量待同步 · ':''}${entry.budget.status==='blocked'?'月度额度已用尽':entry.budget.limit===null?'尚未设置月度额度':'月度额度已启用'}</p><div class="access-actions"><button class="secondary" data-access-select="${entry.id}" aria-pressed="${entry.id===state.selectedAccessId}">${entry.id===state.selectedAccessId?'正在管理':'查看管理'}</button><button class="secondary" data-access-budget="${entry.id}">设置额度</button><button class="text-button" data-access-edit="${entry.id}">修改密钥</button></div></article>`).join('')||'<p class="access-empty">没有匹配的登录密钥或曾用密钥。</p>';
  elements.accessList.querySelectorAll('[data-access-select]').forEach(button=>button.addEventListener('click',()=>selectAccess(button.dataset.accessSelect)));
  elements.accessList.querySelectorAll('[data-access-edit]').forEach(button=>button.addEventListener('click',()=>openAccess(all.find(entry=>entry.id===button.dataset.accessEdit))));
  elements.accessList.querySelectorAll('[data-access-budget]').forEach(button=>button.addEventListener('click',async()=>{
    await selectAccess(button.dataset.accessBudget);
    if(state.selectedAccessId===button.dataset.accessBudget&&!elements.app.classList.contains('hidden'))document.getElementById('editBudget')?.click();
  }));
}

async function selectAccess(id){
  state.selectedAccessId=id;state.keys=[];state.budget=null;
  elements.usageSummary.innerHTML='';elements.budgetStatus.textContent='';elements.syncStatus.textContent='';
  renderCurrentAccess();renderAccessKeys();
  await loadKeys();
}

function openAccess(entry){
  editingAccessId=entry?.id||null;
  elements.accessTitle.textContent=entry?'修改登录密钥':'新增登录密钥';
  elements.accessDescription.textContent=entry?'修改后旧密钥失效，需要重新登录；关联的 API Key、额度和用量不变。':'设置用于登录管理页的密钥和月度额度，保存后关联 API Key。';
  elements.accessSecret.value=entry?.secret||'';
  elements.accessLimitField.classList.toggle('hidden',!!entry);
  elements.accessLimit.required=!entry;
  elements.accessLimit.value='';elements.accessError.textContent='';
  elements.accessOverlay.classList.remove('hidden');elements.accessSecret.focus();
}

function closeAccess(){elements.accessOverlay.classList.add('hidden');elements.accessForm.reset();elements.accessError.textContent='';editingAccessId=null;}

async function saveAccess(event){
  event.preventDefault();elements.accessError.textContent='';setBusy(elements.saveAccessButton,true,'保存中…');
  const self=state.role!=='superadmin', editing=editingAccessId;
  const changed=self&&elements.accessSecret.value!==state.accessKey?.secret;
  try {
    const url=self?'/api/login-secret':editing?`/api/access-keys/${encodeURIComponent(editing)}`:'/api/access-keys';
    const body={secret:elements.accessSecret.value,...(!editing?{limit:Number(elements.accessLimit.value)}:{})};
    const result=await api(url,{method:editing?'PUT':'POST',body});
    closeAccess();
    if(changed){showLogin();toast('登录密钥已修改，请使用新密钥登录');return;}
    if(!editing)state.selectedAccessId=result.accessKey.id;
    await loadKeys();toast(editing?'登录密钥已保存':'登录密钥已创建，请关联 API Key');
  }catch(error){elements.accessError.textContent=error.message;}
  finally{setBusy(elements.saveAccessButton,false,'保存');}
}

function renderKeys() {
  if(!state.keys.length){elements.keyGrid.innerHTML='<div class="empty"><strong>尚未配置自定义 Key</strong><br>请由超级管理员添加 Key。</div>';return;}
  const labels=[['yesterday','昨日'],['today','今日'],['week','本周'],['month','本月'],['lastMonth','上月']];
  elements.keyGrid.innerHTML=state.keys.map((key,index)=>{
    if(!key.matched) return `<article class="key-card"><div class="card-head"><div class="key-title"><div class="key-number">${pad(index+1)}</div><div><div class="key-name">未匹配 Key</div><div class="key-value">${escapeHtml(key.maskedKey)}</div></div></div><span class="status missing">未找到</span></div><div class="card-error">${escapeHtml(key.error||'无法匹配')}</div><div class="card-footer"><span>不会参与重置</span><button class="remove" data-remove="${key.id}">移除</button></div></article>`;
    const periods=labels.map(([id,label])=>`<div class="period"><span>${label}</span><strong>${money(key.usage?.[id]?.cost)}</strong></div>`).join('');
    return `<article class="key-card"><div class="card-head"><div class="key-title"><div class="key-number">${pad(index+1)}</div><div><div class="key-name">${escapeHtml(key.name)}</div><div class="key-value">${escapeHtml(key.maskedKey)}</div></div></div><span class="status ${key.status==='active'?'active':'missing'}">${key.status==='active'?'正常':escapeHtml(key.status||'未知')}</span></div><div class="periods">${periods}</div>${renderQuota(key)}${key.error?`<div class="card-error">用量读取失败：${escapeHtml(key.error)}</div>`:''}<div class="card-footer"><span>最后使用：${formatTime(key.lastUsedAt)}</span><button class="remove" data-remove="${key.id}">移除</button></div></article>`;
  }).join('');
  document.querySelectorAll('[data-remove]').forEach(button=>button.addEventListener('click',()=>removeKey(button.dataset.remove)));
  document.querySelectorAll('[data-remove]').forEach(button=>button.classList.toggle('hidden',state.role!=='superadmin'));
  if(state.role==='superadmin'&&state.accessKeys.length>1)elements.keyGrid.querySelectorAll('[data-remove]').forEach(button=>{
    const transfer=document.createElement('button');transfer.className='text-button';transfer.textContent='转移关联';
    transfer.addEventListener('click',()=>openTransfer(button.dataset.remove));button.before(transfer);
  });
  document.querySelectorAll('[data-quota]').forEach(button=>button.addEventListener('click',()=>openQuota(button.dataset.quota,button.dataset.name,button.dataset.value)));
}

function renderQuota(key){
  const limit=Math.max(0,Number(key.quota)||0), used=Math.max(0,Number(key.quotaUsed)||0);
  const percent=limit>0?used/limit*100:0;
  const tone=limit===0?'quota-unlimited':percent>=100?'quota-exhausted':percent>=80?'quota-warning':'quota-normal';
  const status=limit===0?'未设置上限':percent>=100?'额度已用尽':`已用 ${percent.toFixed(1)}%`;
  const detail=limit===0?'不设额度上限':used>limit?`超出 ${money(used-limit)}`:`剩余 ${money(Math.max(0,limit-used))}`;
  return `<div class="quota quota-panel ${tone}"><div class="quota-row"><span>已用额度 / 上限</span><button class="quota-edit" data-quota="${key.id}" data-name="${escapeHtml(key.name)}" data-value="${limit}">调整配额</button></div><div class="quota-amount"><strong>${money(used)}</strong><span>/ ${limit>0?money(limit):'无限制'}</span></div>${limit>0?`<progress class="quota-progress" max="100" value="${Math.min(100,percent)}" aria-label="${escapeHtml(key.name)} 额度使用率">${percent.toFixed(1)}%</progress>`:'<div class="quota-unlimited" aria-hidden="true">∞</div>'}<div class="quota-meta"><span>${status}</span><span>${detail}</span></div><p class="quota-caption">USD · 已用额度每周一 06:00 重置，历史统计保留</p></div>`;
}

function renderSummary(){
  const matched=state.keys.filter(key=>key.matched);
  const totals=matched.reduce((sum,key)=>{
    sum.total+=Number(key.quotaUsed||0);
    for(const period of ['yesterday','today','week','month','lastMonth']) sum[period]+=Number(key.usage?.[period]?.cost||0);
    return sum;
  },{total:0,yesterday:0,today:0,week:0,month:0,lastMonth:0});
  const b=state.budget;
  const items=[['yesterday','昨日'],['today','今日'],['week','本周'],['month','本月'],['lastMonth','上月']];
  elements.usageSummary.innerHTML=`<div class="summary-item balance-item"><div class="balance-heading"><span>余额</span>${state.role==='superadmin'?'<button class="quota-edit" id="editBudget">设置</button>':''}</div><strong>${b?.limit==null?'未设置':b.balance===null?'待同步':money(b.balance)}</strong><small>${b?.limit==null?'尚未启用月度限额':`月度总额度 ${money(b.limit)}`}</small></div>`+items.map(([id,label])=>`<div class="summary-item"><span>${label}</span><strong>${state.keys.some(k=>!k.usage)?'—':money(totals[id])}</strong></div>`).join('');
  document.getElementById('editBudget')?.addEventListener('click',()=>{elements.budgetInput.value=b?.limit??'';elements.budgetError.textContent='';elements.budgetOverlay.classList.remove('hidden');elements.budgetInput.focus()});
  const details=b?.limit!=null?`${b.month} ${b.used===null?'本月用量待同步':`已计入 ${money(b.used)}`}${b.overage>0?` · 超出 ${money(b.overage)}`:''} · 下月刷新 ${formatTime(b.nextMonthAt)}`:'月度总额度由超级管理员设置后启用';
  elements.budgetStatus.textContent=`${b?.status==='blocked'?'月度额度已用尽，已配置 Key 暂停使用。 ':''}${details}${b?.pendingCount?` · ${b.pendingCount} 项状态变更待重试`:''}`;
  elements.budgetStatus.classList.toggle('budget-blocked',b?.status==='blocked');
  elements.syncStatus.textContent=`${b?.stale?'数据待同步 · ':''}最后成功更新：${b?.lastSuccessAt?formatTime(b.lastSuccessAt):'暂无'} · 下次检查：${b?.nextCheckAt?formatTime(b.nextCheckAt):'等待调度'}${b?.error?` · ${b.error}`:''}`;
}

function closeBudget(){elements.budgetOverlay?.classList.add('hidden');}
async function saveBudget(event){
  event.preventDefault();elements.budgetError.textContent='';setBusy(elements.saveBudgetButton,true,'保存中…');
  try{await api('/api/budget',{method:'PUT',body:{limit:Number(elements.budgetInput.value)}});closeBudget();await loadKeys();toast('月度总额度已保存');}
  catch(error){elements.budgetError.textContent=error.message;}
  finally{setBusy(elements.saveBudgetButton,false,'保存总额度');}
}

function renderSchedule(){if(!state.schedule?.nextResetAt)return;const remaining=Math.max(0,Date.parse(state.schedule.nextResetAt)-Date.now());elements.resetCountdown.textContent=formatCountdown(remaining)}

async function removeKey(id){if(!confirm('只从本管理页移除，不会删除 Sub2API 中的 Key。确定继续吗？'))return;try{await api(`/api/keys/${encodeURIComponent(id)}`,{method:'DELETE'});toast('已从管理列表移除');await loadKeys();}catch(error){toast(error.message)}}
function closeAdd(){elements.addOverlay.classList.add('hidden');elements.addForm.reset();elements.addError.textContent=''}
let quotaKeyId='';
function openQuota(id,name,value){quotaKeyId=id;elements.quotaDescription.textContent=`调整“${name}”的额度上限，单位为 USD。`;elements.quotaInput.value=Number(value||0);elements.quotaError.textContent='';elements.quotaOverlay.classList.remove('hidden');elements.quotaInput.focus()}
function closeQuota(){elements.quotaOverlay.classList.add('hidden');elements.quotaForm.reset();elements.quotaError.textContent='';quotaKeyId=''}
async function updateQuota(event){event.preventDefault();const quota=Number(elements.quotaInput.value);if(!Number.isFinite(quota)||quota<0){elements.quotaError.textContent='请输入不小于 0 的数字';return}try{await api(`/api/keys/${encodeURIComponent(quotaKeyId)}`,{method:'PUT',body:{quota}});closeQuota();toast('配额已更新');await loadKeys()}catch(error){elements.quotaError.textContent=error.message}}
function setBusy(button,busy,text){button.disabled=busy;button.textContent=text}
function money(value){return `$${Number(value||0).toFixed(2)}`}
function pad(value){return String(value).padStart(2,'0')}
function formatTime(value){if(!value)return'尚未使用';return new Intl.DateTimeFormat('zh-CN',{dateStyle:'medium',timeStyle:'short'}).format(new Date(value))}
function formatCountdown(milliseconds){const totalMinutes=Math.max(0,Math.floor(milliseconds/60000));const days=Math.floor(totalMinutes/1440);const hours=Math.floor(totalMinutes%1440/60);const minutes=totalMinutes%60;return `${days}d${hours}h${minutes}m`}
setInterval(renderSchedule,60000);
setInterval(()=>{if(!elements.app.classList.contains('hidden')&&!document.hidden)loadKeys()},60000);
function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))}
function toast(message){elements.toast.textContent=message;elements.toast.classList.add('show');setTimeout(()=>elements.toast.classList.remove('show'),3000)}

async function api(url, options={}) {
  if(state.role==='superadmin'&&state.selectedAccessId&&/^\/api\/(keys(?:\/|$)|budget$|refresh$)/.test(url))url+=`?accessKeyId=${encodeURIComponent(state.selectedAccessId)}`;
  const headers={Accept:'application/json',...(options.body?{'Content-Type':'application/json'}:{}),...(state.csrfToken?{'X-CSRF-Token':state.csrfToken}:{})};
  const response=await fetch(url,{method:options.method||'GET',headers,credentials:'same-origin',body:options.body?JSON.stringify(options.body):undefined});
  const data=await response.json().catch(()=>({error:'服务器返回格式错误'}));
  if(!response.ok){if(response.status===401&&url!=='/api/login')showLogin();throw new Error(data.error||`请求失败 (${response.status})`)}
  return data;
}

boot();
