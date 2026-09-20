const state = { csrfToken: '', keys: [], schedule: null, budget:null, role:'admin', accessKey:null, accessKeys:[], selectedAccessId:'', loadVersion:0, rewards:[], keyOrderVersion:0, accessOrderVersion:0, sorting:false, policySaving:false };
const elements = Object.fromEntries(['loginScreen','loginForm','loginError','password','app','logoutButton','refreshButton','resetCountdown','openAddButton','usageSummary','keyGrid','addOverlay','addForm','customKey','addError','closeAddButton','cancelAddButton','quotaOverlay','quotaForm','quotaInput','quotaError','quotaDescription','closeQuotaButton','cancelQuotaButton','toast'].map(id => [id, document.getElementById(id)]));

for(const id of ['roleLabel','budgetStatus','syncStatus','budgetOverlay','budgetForm','budgetInput','budgetError','closeBudgetButton','cancelBudgetButton','saveBudgetButton']) elements[id]=document.getElementById(id);
for(const id of ['accessManagement','accessTotals','accessSearch','accessList','currentAccess','changeSecretButton','newAccessButton','accessOverlay','accessForm','accessTitle','accessDescription','accessSecret','accessLimitField','accessLimit','accessError','closeAccessButton','cancelAccessButton','saveAccessButton','addDescription']) elements[id]=document.getElementById(id);
for(const id of ['transferOverlay','transferForm','transferDescription','transferTarget','transferError','closeTransferButton','cancelTransferButton','saveTransferButton']) elements[id]=document.getElementById(id);
let transferKeyId='';
for(const id of ['budgetType','accessType','rewardList','openRewardButton','rewardOverlay','rewardForm','rewardAmount','rewardExpiry','rewardError','closeRewardButton','cancelRewardButton','saveRewardButton'])elements[id]=document.getElementById(id);
function closeReward(){elements.rewardOverlay.classList.add('hidden');elements.rewardForm.reset();elements.rewardError.textContent='';}
elements.closeRewardButton.addEventListener('click',closeReward);
elements.cancelRewardButton.addEventListener('click',closeReward);
elements.rewardOverlay.addEventListener('click',event=>{if(event.target===elements.rewardOverlay)closeReward()});
elements.openRewardButton.addEventListener('click',()=>{
  const expires=new Date(Date.now()+3*86400000);expires.setMinutes(expires.getMinutes()-expires.getTimezoneOffset());
  elements.rewardExpiry.value=expires.toISOString().slice(0,16);elements.rewardAmount.value='';elements.rewardError.textContent='';elements.rewardOverlay.classList.remove('hidden');elements.rewardAmount.focus();
});
elements.rewardForm.addEventListener('submit',async event=>{
  event.preventDefault();setBusy(elements.saveRewardButton,true,'发放中…');elements.rewardError.textContent='';
  try{await api('/api/rewards',{method:'POST',body:{limit:Number(elements.rewardAmount.value),expiresAt:new Date(elements.rewardExpiry.value).toISOString()}});closeReward();await loadKeys();toast('奖励已保存，Key 启用状态不会因奖励恢复');}
  catch(error){elements.rewardError.textContent=error.message;}
  finally{setBusy(elements.saveRewardButton,false,'发放奖励');}
});
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
  elements.transferTarget.innerHTML=state.accessKeys.filter(entry=>entry.id!==state.selectedAccessId&&entry.budget.type!=='trial').map(entry=>`<option value="${entry.id}">${escapeHtml(entry.secret)}</option>`).join('');
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
  elements.openRewardButton.classList.toggle('hidden',state.role!=='superadmin');
  elements.rewardList.closest('.reward-panel').classList.add('hidden');
  elements.loginScreen.classList.add('hidden');
  elements.app.classList.remove('hidden');
  loadKeys();
}

function showLogin() {
  closeBudget(); closeAdd(); closeQuota(); closeAccess(); closeTransfer(); closeReward();
  state.loadVersion++;
  state.csrfToken='';state.keys=[];state.budget=null;state.accessKeys=[];state.accessKey=null;state.selectedAccessId='';state.rewards=[];state.sorting=false;elements.rewardList.innerHTML='';
  elements.accessList.innerHTML='';elements.accessTotals.innerHTML='';elements.currentAccess.textContent='';elements.usageSummary.innerHTML='';elements.keyGrid.innerHTML='';
  elements.app.classList.add('hidden');
  elements.loginScreen.classList.remove('hidden');
  elements.password.focus();
}

async function loadKeys(showMessage=false) {
  if(state.sorting||state.policySaving)return;
  const version=++state.loadVersion;
  setBusy(elements.refreshButton,true,'刷新中…');
  if(!state.keys.length)elements.keyGrid.innerHTML='<div class="loading">正在读取用量数据…</div>';
  try {
    if(state.role==='superadmin') {
      const list=await api('/api/access-keys');
      if(version!==state.loadVersion)return;
      state.accessKeys=list.accessKeys;
      state.accessOrderVersion=list.orderVersion;
      if(!state.accessKeys.some(entry=>entry.id===state.selectedAccessId))state.selectedAccessId=state.accessKeys[0]?.id||'';
      renderAccessKeys();
    }
    const data=await api(showMessage?'/api/refresh':'/api/keys',showMessage?{method:'POST'}:{});
    if(version!==state.loadVersion)return;
    state.keys=data.keys; state.schedule=data.schedule;state.budget=data.budget;state.rewards=data.rewards||[];state.keyOrderVersion=data.orderVersion;
    const selected=currentAccess();
    if(selected){selected.budget=data.budget;selected.rewards=state.rewards;selected.keyCount=data.keys.length;}
    renderAccessKeys();renderCurrentAccess();
    renderSummary(); renderKeys(); renderSchedule();renderRewards();
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
  const all=state.accessKeys;
  const sumType=type=>all.filter(e=>e.budget.type===type).reduce((sum,e)=>sum+(e.budget.limit||0),0);
  const rewardBalance=all.flatMap(e=>e.rewards||[]).filter(r=>r.status==='active').reduce((sum,r)=>sum+r.remaining,0);
  const monthly=all.filter(e=>e.budget.type==='monthly');
  const monthlyTotal=field=>monthly.some(e=>e.budget.used===null)?'待同步':money(monthly.reduce((sum,e)=>sum+(e.budget[field]||0),0));
  elements.accessTotals.innerHTML=`<div><span>登录密钥</span><strong>${all.length}</strong></div><div><span>月度总额度（已设置）</span><strong>${money(sumType('monthly'))}</strong></div><div><span>月度额度已用</span><strong>${monthlyTotal('used')}</strong></div><div><span>月度额度剩余（已设置）</span><strong>${monthlyTotal('balance')}</strong></div><div><span>体验总额度</span><strong>${money(sumType('trial'))}</strong></div><div><span>有效奖励剩余</span><strong>${money(rewardBalance)}</strong></div>`;
  const search=elements.accessSearch.value.toLocaleLowerCase();
  const matches=all.filter(entry=>[entry.secret,...entry.previousSecrets].some(value=>value.toLocaleLowerCase().includes(search)));
  elements.accessList.innerHTML=matches.map(entry=>`<article class="access-card${entry.id===state.selectedAccessId?' access-selected':''}"><div class="access-card-heading"><strong>${escapeHtml(entry.secret)}</strong><span>${entry.keyCount} 个 API Key</span></div>${entry.previousSecrets.length?`<p class="access-history">曾用密钥：${entry.previousSecrets.map(escapeHtml).join('、')}</p>`:''}<dl><div><dt>每月额度</dt><dd>${entry.budget.limit===null?'未设置':money(entry.budget.limit)}</dd></div><div><dt>已用 / 剩余</dt><dd>${entry.budget.used===null?'待同步':`${money(entry.budget.used)} / ${entry.budget.balance===null?'未设置':money(entry.budget.balance)}`}</dd></div></dl><p class="access-status">${entry.budget.stale?'用量待同步 · ':''}${entry.budget.status==='blocked'?'月度额度已用尽':entry.budget.limit===null?'尚未设置月度额度':'月度额度已启用'}</p><div class="access-actions"><button class="secondary" data-access-select="${entry.id}" aria-pressed="${entry.id===state.selectedAccessId}">${entry.id===state.selectedAccessId?'正在管理':'查看管理'}</button><button class="secondary" data-access-budget="${entry.id}">设置额度</button><button class="text-button" data-access-edit="${entry.id}">修改密钥</button></div></article>`).join('')||'<p class="access-empty">没有匹配的登录密钥或曾用密钥。</p>';
  elements.accessList.querySelectorAll('[data-access-select]').forEach(button=>button.addEventListener('click',()=>selectAccess(button.dataset.accessSelect)));
  elements.accessList.querySelectorAll('[data-access-edit]').forEach(button=>button.addEventListener('click',()=>openAccess(all.find(entry=>entry.id===button.dataset.accessEdit))));
  elements.accessList.querySelectorAll('[data-access-budget]').forEach(button=>button.addEventListener('click',async()=>{
    await selectAccess(button.dataset.accessBudget);
    if(state.selectedAccessId===button.dataset.accessBudget&&!elements.app.classList.contains('hidden'))document.getElementById('editBudget')?.click();
  }));
  elements.accessList.querySelectorAll('.access-card').forEach((card,index)=>{
    const entry=matches[index],trial=entry.budget.type==='trial';
    card.querySelector('dt').textContent=trial?'一次性体验额度':entry.budget.monthlyResetEnabled?'每月额度':'原额度（累计）';
    card.querySelector('.access-status').textContent=`${entry.budget.stale?'用量待同步 · ':''}${trial?'体验 · 不自动刷新':entry.budget.monthlyResetEnabled?'月度额度':'月刷新关闭 · 用量累计'}${entry.budget.status==='blocked'?' · 已用尽':''}`;
    const switches=document.createElement('div');switches.className='refresh-switches';
    switches.innerHTML=[['weeklyResetEnabled','周刷新','周一 06:00 · API Key 用量'],['monthlyResetEnabled','月刷新','每月 1 日 00:00 · 总额度']].map(([field,label,description])=>`<label class="refresh-switch"><span>${label}<small>${description}</small></span><input type="checkbox" role="switch" aria-label="${label}" data-refresh-field="${field}" ${entry.budget[field]?'checked':''} ${trial||state.policySaving?'disabled':''}></label>`).join('')+`<p>${trial?'体验额度不参与自动刷新':'北京时间 · 开启后从下次计划时间生效'}</p>`;
    switches.querySelectorAll('input').forEach(input=>input.addEventListener('change',()=>saveRefreshPolicy(entry.id,input.dataset.refreshField,input.checked)));
    card.querySelector('.access-actions').before(switches);
  });
  mountSort(elements.accessList,matches.map(e=>e.id),'access',!!search);
}

async function selectAccess(id){
  if(state.sorting||state.policySaving)return;
  state.selectedAccessId=id;state.keys=[];state.budget=null;state.rewards=[];renderRewards();
  elements.usageSummary.innerHTML='';elements.budgetStatus.textContent='';elements.syncStatus.textContent='';
  renderCurrentAccess();renderAccessKeys();
  await loadKeys();
}

async function saveRefreshPolicy(id,field,enabled){
  if(state.policySaving||state.sorting){renderAccessKeys();return;}
  state.policySaving=true;state.loadVersion++;renderAccessKeys();
  try{
    const result=await api(`/api/refresh-policy?accessKeyId=${encodeURIComponent(id)}`,{method:'PUT',body:{[field]:enabled}});
    const entry=state.accessKeys.find(item=>item.id===id);if(entry)entry.budget=result.budget;
    toast(result.budget.stale?'刷新设置已保存，用量待同步':'刷新设置已保存');
  }catch(error){toast(error.message);}
  finally{state.policySaving=false;renderAccessKeys();await loadKeys();}
}

function openAccess(entry){
  editingAccessId=entry?.id||null;
  elements.accessTitle.textContent=entry?'修改登录密钥':'新增登录密钥';
  elements.accessDescription.textContent=entry?'修改后旧密钥失效，需要重新登录；关联的 API Key、额度和用量不变。':'设置用于登录管理页的密钥，选择月度或一次性体验额度，保存后关联 API Key。';
  elements.accessSecret.value=entry?.secret||'';
  elements.accessLimitField.classList.toggle('hidden',!!entry);
  elements.accessLimit.required=!entry;
  elements.accessLimit.value='';elements.accessError.textContent='';
  elements.accessType.value='monthly';
  elements.accessOverlay.classList.remove('hidden');elements.accessSecret.focus();
}

function closeAccess(){elements.accessOverlay.classList.add('hidden');elements.accessForm.reset();elements.accessError.textContent='';editingAccessId=null;}

async function saveAccess(event){
  event.preventDefault();elements.accessError.textContent='';setBusy(elements.saveAccessButton,true,'保存中…');
  const self=state.role!=='superadmin', editing=editingAccessId;
  const changed=self&&elements.accessSecret.value!==state.accessKey?.secret;
  try {
    const url=self?'/api/login-secret':editing?`/api/access-keys/${encodeURIComponent(editing)}`:'/api/access-keys';
    const body={secret:elements.accessSecret.value,...(!editing?{limit:Number(elements.accessLimit.value),type:elements.accessType.value}:{})};
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
  if(state.role==='superadmin'&&state.budget?.type!=='trial'&&state.accessKeys.some(e=>e.id!==state.selectedAccessId&&e.budget.type!=='trial'))elements.keyGrid.querySelectorAll('[data-remove]').forEach(button=>{
    const transfer=document.createElement('button');transfer.className='text-button';transfer.textContent='转移关联';
    transfer.addEventListener('click',()=>openTransfer(button.dataset.remove));button.before(transfer);
  });
  document.querySelectorAll('[data-quota]').forEach(button=>button.addEventListener('click',()=>openQuota(button.dataset.quota,button.dataset.name,button.dataset.value)));
  if(state.budget?.type==='trial')elements.keyGrid.querySelectorAll('.quota-caption').forEach(el=>el.textContent='USD · 体验额度不参与每周重置；此处为上游 Key 的真实已用量');
  else if(!state.budget?.weeklyResetEnabled)elements.keyGrid.querySelectorAll('.quota-caption').forEach(el=>el.textContent='USD · 周刷新已关闭，累计用量不自动重置');
  mountSort(elements.keyGrid,state.keys.map(k=>k.id),'keys');
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
  const label=b?.type==='trial'?'体验总额度':'月度总额度';
  elements.usageSummary.querySelector('.balance-item small').textContent=b?.limit==null?'尚未设置原额度':`${label} ${money(b.limit)} · 已用 ${b.used===null?'待同步':money(b.used)}`;
  document.getElementById('editBudget')?.addEventListener('click',()=>{elements.budgetType.value=b?.type||'monthly';elements.budgetInput.value=b?.limit??'';elements.budgetError.textContent='';elements.budgetOverlay.classList.remove('hidden');elements.budgetInput.focus()});
  const details=b?.limit!=null?`${label} · ${b.used===null?'用量待同步':`已计入 ${money(b.used)}`}${b.overage>0?` · 超出 ${money(b.overage)}`:''} · ${b.type==='trial'?'不自动刷新':b.monthlyResetEnabled?`下月刷新 ${formatTime(b.nextMonthAt)}`:'月刷新关闭 · 已用量持续累计'}`:'原额度由超级管理员设置后启用';
  elements.budgetStatus.textContent=`${b?.status==='blocked'?'原额度已用尽且无可用奖励，已配置 Key 暂停使用。 ':''}${details}${b?.pendingCount?` · ${b.pendingCount} 项状态变更待重试`:''}`;
  elements.budgetStatus.classList.toggle('budget-blocked',b?.status==='blocked');
  elements.syncStatus.textContent=`${b?.stale?'数据待同步 · ':''}最后成功更新：${b?.lastSuccessAt?formatTime(b.lastSuccessAt):'暂无'} · 下次检查：${b?.nextCheckAt?formatTime(b.nextCheckAt):'等待调度'}${b?.error?` · ${b.error}`:''}`;
}

function closeBudget(){elements.budgetOverlay?.classList.add('hidden');}
async function saveBudget(event){
  event.preventDefault();elements.budgetError.textContent='';setBusy(elements.saveBudgetButton,true,'保存中…');
  try{await api('/api/budget',{method:'PUT',body:{limit:Number(elements.budgetInput.value),type:elements.budgetType.value}});closeBudget();await loadKeys();toast('原额度设置已保存');}
  catch(error){elements.budgetError.textContent=error.message;}
  finally{setBusy(elements.saveBudgetButton,false,'保存总额度');}
}

function renderSchedule(){elements.resetCountdown.closest('.schedule-pill').classList.toggle('hidden',!state.schedule?.nextResetAt);if(!state.schedule?.nextResetAt)return;const remaining=Math.max(0,Date.parse(state.schedule.nextResetAt)-Date.now());elements.resetCountdown.textContent=formatCountdown(remaining)}

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
  if(state.role==='superadmin'&&state.selectedAccessId&&/^\/api\/(keys(?:\/|$)|budget$|refresh$|rewards$)/.test(url))url+=`?accessKeyId=${encodeURIComponent(state.selectedAccessId)}`;
  const headers={Accept:'application/json',...(options.body?{'Content-Type':'application/json'}:{}),...(state.csrfToken?{'X-CSRF-Token':state.csrfToken}:{})};
  const response=await fetch(url,{method:options.method||'GET',headers,credentials:'same-origin',body:options.body?JSON.stringify(options.body):undefined});
  const data=await response.json().catch(()=>({error:'服务器返回格式错误'}));
  if(!response.ok){if(response.status===401&&url!=='/api/login')showLogin();throw new Error(data.error||`请求失败 (${response.status})`)}
  return data;
}

function renderRewards(){
  const rewards=state.rewards;
  elements.rewardList.closest('.reward-panel').classList.toggle('hidden',state.role!=='superadmin'&&!rewards.length);
  elements.openRewardButton.disabled=rewards.some(r=>r.status==='active');
  elements.rewardList.innerHTML=rewards.length?[...rewards].reverse().map(r=>`<article class="reward-item"><div><strong>奖励已用 ${money(r.used)} / ${money(r.limit)}</strong><span>${r.status==='active'?'可用':r.status==='exhausted'?'已用完':'已到期'}</span></div><progress max="${r.limit}" value="${Math.min(r.used,r.limit)}" aria-label="奖励使用进度"></progress><small>${formatTime(r.startsAt)} 发放 · ${formatTime(r.expiresAt)} 到期${r.status==='active'?` · 剩余 ${money(r.remaining)}`:''}</small></article>`).join(''):'<p class="access-empty">暂无奖励。奖励消费单独记录，不占用原额度。</p>';
}

function mountSort(container,ids,kind,disabled=false){
  const cards=[...container.children].filter(el=>el.tagName==='ARTICLE');
  cards.forEach((card,index)=>{
    card.dataset.sortId=ids[index];
    if(disabled||ids.length<2)return;
    const handle=card.querySelector(kind==='access'?'.access-card-heading':'.key-title');
    if(!handle)return;
    handle.classList.add('card-drag-region');
    handle.tabIndex=0;
    handle.setAttribute('aria-label','卡片标题，按 Alt 加上下方向键调整顺序');
    const move=delta=>{const next=[...ids];[next[index],next[index+delta]]=[next[index+delta],next[index]];saveOrder(kind,next);};
    handle.addEventListener('keydown',event=>{
      if(!event.altKey||!['ArrowUp','ArrowDown'].includes(event.key))return;
      event.preventDefault();
      const delta=event.key==='ArrowUp'?-1:1;
      if(index+delta>=0&&index+delta<ids.length)move(delta);
    });
    handle.addEventListener('pointerdown',event=>{
      if(event.button!==0||state.sorting||state.policySaving)return;event.preventDefault();state.sorting=true;state.loadVersion++;
      card.classList.add('sort-dragging');handle.setPointerCapture(event.pointerId);
      const onMove=e=>{
        const target=document.elementFromPoint(e.clientX,e.clientY)?.closest('[data-sort-id]');
        if(target&&target!==card&&target.parentElement===container){const children=[...container.children];container.insertBefore(card,children.indexOf(card)<children.indexOf(target)?target.nextSibling:target);handle.setPointerCapture(event.pointerId);}
        const box=container.getBoundingClientRect();if(e.clientY<box.top+35)container.scrollTop-=18;else if(e.clientY>box.bottom-35)container.scrollTop+=18;
        if(e.clientY<45)window.scrollBy(0,-18);else if(e.clientY>innerHeight-45)window.scrollBy(0,18);
      };
      const finish=e=>{
        handle.removeEventListener('pointermove',onMove);handle.removeEventListener('pointerup',finish);handle.removeEventListener('pointercancel',finish);
        if(handle.hasPointerCapture(event.pointerId))handle.releasePointerCapture(event.pointerId);
        card.classList.remove('sort-dragging');state.sorting=false;
        if(e.type==='pointercancel'){loadKeys();return;}
        const next=[...container.children].filter(el=>el.dataset.sortId).map(el=>el.dataset.sortId);
        if(next.join()!==ids.join())saveOrder(kind,next);else loadKeys();
      };
      handle.addEventListener('pointermove',onMove);handle.addEventListener('pointerup',finish);handle.addEventListener('pointercancel',finish);
    });
  });
}

async function saveOrder(kind,ids){
  if(state.sorting||state.policySaving)return;state.sorting=true;state.loadVersion++;
  try{await api(kind==='access'?'/api/access-keys/order':'/api/keys/order',{method:'PUT',body:{ids,version:kind==='access'?state.accessOrderVersion:state.keyOrderVersion}});toast('卡片顺序已保存');}
  catch(error){toast(error.message);}
  finally{state.sorting=false;await loadKeys();}
}

boot();
