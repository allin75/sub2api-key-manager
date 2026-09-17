const state = { csrfToken: '', keys: [], schedule: null };
const elements = Object.fromEntries(['loginScreen','loginForm','loginError','password','app','logoutButton','refreshButton','resetCountdown','openAddButton','usageSummary','keyGrid','addOverlay','addForm','customKey','addError','closeAddButton','cancelAddButton','quotaOverlay','quotaForm','quotaInput','quotaError','quotaDescription','closeQuotaButton','cancelQuotaButton','toast'].map(id => [id, document.getElementById(id)]));

boot();

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
elements.openAddButton.addEventListener('click', () => { elements.addOverlay.classList.remove('hidden'); elements.customKey.focus(); });
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
  elements.loginScreen.classList.add('hidden');
  elements.app.classList.remove('hidden');
  loadKeys();
}

function showLogin() {
  elements.app.classList.add('hidden');
  elements.loginScreen.classList.remove('hidden');
  elements.password.focus();
}

async function loadKeys(showMessage=false) {
  setBusy(elements.refreshButton,true,'刷新中…');
  elements.keyGrid.innerHTML='<div class="loading">正在读取 Sub2API 数据…</div>';
  try {
    const data=await api('/api/keys');
    state.keys=data.keys; state.schedule=data.schedule;
    renderSummary(); renderKeys(); renderSchedule();
    if(showMessage) toast('数据已刷新');
  } catch(error) {
    elements.keyGrid.innerHTML=`<div class="empty">${escapeHtml(error.message)}</div>`;
  } finally { setBusy(elements.refreshButton,false,'刷新数据'); }
}

function renderKeys() {
  if(!state.keys.length){elements.keyGrid.innerHTML='<div class="empty"><strong>尚未配置自定义 Key</strong><br>点击右上角“添加自定义 Key”开始管理。</div>';return;}
  const labels=[['yesterday','昨日'],['today','今日'],['week','本周'],['month','本月'],['lastMonth','上月']];
  elements.keyGrid.innerHTML=state.keys.map((key,index)=>{
    if(!key.matched) return `<article class="key-card"><div class="card-head"><div class="key-title"><div class="key-number">${pad(index+1)}</div><div><div class="key-name">未匹配 Key</div><div class="key-value">${escapeHtml(key.maskedKey)}</div></div></div><span class="status missing">未找到</span></div><div class="card-error">${escapeHtml(key.error||'无法匹配')}</div><div class="card-footer"><span>不会参与重置</span><button class="remove" data-remove="${key.id}">移除</button></div></article>`;
    const periods=labels.map(([id,label])=>`<div class="period"><span>${label}</span><strong>${money(key.usage?.[id]?.cost)}</strong></div>`).join('');
    return `<article class="key-card"><div class="card-head"><div class="key-title"><div class="key-number">${pad(index+1)}</div><div><div class="key-name">${escapeHtml(key.name)}</div><div class="key-value">${escapeHtml(key.maskedKey)}</div></div></div><span class="status ${key.status==='active'?'active':'missing'}">${key.status==='active'?'正常':escapeHtml(key.status||'未知')}</span></div><div class="periods">${periods}</div>${renderQuota(key)}${key.error?`<div class="card-error">用量读取失败：${escapeHtml(key.error)}</div>`:''}<div class="card-footer"><span>最后使用：${formatTime(key.lastUsedAt)}</span><button class="remove" data-remove="${key.id}">移除</button></div></article>`;
  }).join('');
  document.querySelectorAll('[data-remove]').forEach(button=>button.addEventListener('click',()=>removeKey(button.dataset.remove)));
  document.querySelectorAll('[data-quota]').forEach(button=>button.addEventListener('click',()=>openQuota(button.dataset.quota,button.dataset.name,button.dataset.value)));
}

function renderQuota(key){
  const limit=Math.max(0,Number(key.quota)||0), used=Math.max(0,Number(key.quotaUsed)||0);
  const percent=limit>0?used/limit*100:0;
  const tone=limit===0?'unlimited':percent>=100?'exhausted':percent>=80?'warning':'normal';
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
  const items=[['total','当前已用额度'],['yesterday','昨日'],['today','今日'],['week','本周'],['month','本月'],['lastMonth','上月']];
  elements.usageSummary.innerHTML=items.map(([id,label])=>`<div class="summary-item"><span>${label}</span><strong>${money(totals[id])}</strong></div>`).join('');
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
function escapeHtml(value){return String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))}
function toast(message){elements.toast.textContent=message;elements.toast.classList.add('show');setTimeout(()=>elements.toast.classList.remove('show'),3000)}

async function api(url, options={}) {
  const headers={Accept:'application/json',...(options.body?{'Content-Type':'application/json'}:{}),...(state.csrfToken?{'X-CSRF-Token':state.csrfToken}:{})};
  const response=await fetch(url,{method:options.method||'GET',headers,credentials:'same-origin',body:options.body?JSON.stringify(options.body):undefined});
  const data=await response.json().catch(()=>({error:'服务器返回格式错误'}));
  if(!response.ok){if(response.status===401&&url!=='/api/login')showLogin();throw new Error(data.error||`请求失败 (${response.status})`)}
  return data;
}
