const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function dateRangeField(scope, value = {}, { compact = false, label = '全部' } = {}) {
  return `<div class="ai-date-range" data-range-scope="${scope}"><input type="hidden" name="from" value="${esc(value.from)}"><input type="hidden" name="to" value="${esc(value.to)}">${compact ? '' : '<span>时间范围</span>'}<button type="button" class="secondary" aria-label="选择聊天时间范围" data-ai-date-range="${scope}">${value.from ? `${esc(value.from)} 至 ${esc(value.to)}` : esc(label)}</button></div>`;
}
export function chooseDateRange(dates, value = {}) {
  dates = [...new Set(dates)].sort();
  const available = new Set(dates), today = new Date(Date.now()+28800000).toISOString().slice(0,10);
  let from = available.has(value.from) ? value.from : dates[0] || '', to = value.to || dates.at(-1) || '', picking = 'from';
  let month = (from || today).slice(0,7), all = !value.from;
  const dialog = document.createElement('dialog'); dialog.className = 'ai-calendar-dialog';
  const shift = (n) => { const d = new Date(month+'-01T00:00:00Z'); d.setUTCMonth(d.getUTCMonth()+n); return d.toISOString().slice(0,7); };
  function calendar(ym) {
    const year=Number(ym.slice(0,4)), m=Number(ym.slice(5)), start=new Date(Date.UTC(year,m-1,1)).getUTCDay(), last=new Date(Date.UTC(year,m,0)).getUTCDate();
    return `<section><strong>${year} 年 ${m} 月</strong><div class="ai-calendar-grid">${['日','一','二','三','四','五','六'].map(d=>`<small>${d}</small>`).join('')}${'<span></span>'.repeat(start)}${Array.from({length:last},(_,i)=>{const day=ym+'-'+String(i+1).padStart(2,'0'), enabled=picking==='from'?available.has(day):day>=from&&day<=today;return `<button type="button" data-day="${day}" ${enabled?'':'disabled'} class="${day===from||day===to?'selected':day>from&&day<to?'in-range':''}" aria-label="${day}${available.has(day)?'，有聊天记录':''}">${i+1}${available.has(day)?'<i></i>':''}</button>`;}).join('')}</div></section>`;
  }
  function render() {
    const earliest=Number((dates[0]||today).slice(0,4)), latest=Number(today.slice(0,4));
    dialog.innerHTML=`<h3>选择聊天时间</h3><div class="ai-actions"><button type="button" data-mode="all" aria-pressed="${all}">全部</button><button type="button" data-mode="custom" aria-pressed="${!all}" ${dates.length?'':'disabled'}>自定义</button></div>${all?'<p>使用所选对象的全部可用聊天记录。</p>':`<p class="ai-help">起始日期只可选择有聊天记录的日期。按北京时间筛选。</p><div class="ai-actions"><button data-pick="from" aria-pressed="${picking==='from'}">开始：${from}</button><button data-pick="to" aria-pressed="${picking==='to'}">结束：${to}</button></div><div class="ai-calendar-nav"><button data-shift="-1" aria-label="上个月" ${month<=dates[0].slice(0,7)?'disabled':''}>‹</button><select data-year aria-label="年份">${Array.from({length:latest-earliest+1},(_,i)=>`<option ${earliest+i===Number(month.slice(0,4))?'selected':''}>${earliest+i}</option>`).join('')}</select><select data-month aria-label="月份">${Array.from({length:12},(_,i)=>`<option value="${String(i+1).padStart(2,'0')}" ${i+1===Number(month.slice(5))?'selected':''}>${i+1} 月</option>`).join('')}</select><button data-shift="1" aria-label="下个月" ${month>=today.slice(0,7)?'disabled':''}>›</button><button data-earliest>最早记录</button></div><div class="ai-calendar-months">${calendar(month)}${calendar(shift(1))}</div>`}<p role="status">${dates.length?'': '所选对象暂无可用聊天日期。'}</p><footer class="ai-actions"><button data-cancel class="secondary">取消</button><button data-apply class="primary" ${!all&&(!available.has(from)||!to||to<from)?'disabled':''}>应用</button></footer>`;
  }
  return new Promise(resolve=>{
    let result=null;
    dialog.addEventListener('close',()=>{dialog.remove();resolve(result);},{once:true});
    dialog.addEventListener('change',e=>{if(e.target.matches('[data-year],[data-month]')) {month=dialog.querySelector('[data-year]').value+'-'+dialog.querySelector('[data-month]').value;render();}});
    dialog.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;
      if(b.hasAttribute('data-cancel'))return dialog.close();
      if(b.hasAttribute('data-apply')){result=all?{from:'',to:''}:{from,to};return dialog.close();}
      if(b.dataset.mode==='all'){result={from:'',to:''};return dialog.close();}
      if(b.dataset.mode)all=false;
      if(b.dataset.pick)picking=b.dataset.pick;
      if(b.dataset.shift)month=shift(Number(b.dataset.shift));
      if(b.hasAttribute('data-earliest')){month=dates[0].slice(0,7);from=dates[0];picking='to';}
      if(b.dataset.day){if(picking==='from'){from=b.dataset.day;if(to<from)to=from;picking='to';}else to=b.dataset.day;}
      render();
    });
    render();document.body.append(dialog);dialog.showModal();
  });
}
