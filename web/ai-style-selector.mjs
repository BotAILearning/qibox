import './vendor/qiapp-ui-0.4.3/components.mjs';
import { personalityPresets, personalityPresetStyle } from '../server/ai-personality-catalog.mjs';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const parse=value=>{try{const v=JSON.parse(value||'{}');return v&&typeof v==='object'&&!Array.isArray(v)?v:{};}catch{return {};}};

// NAS pages also run on plain LAN HTTP, where randomUUID may be unavailable.
// getRandomValues supports that context; this is a draft ID, not an auth token.
export function newStyleDraftId(random=globalThis.crypto) {
  const bytes=random.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const hex=[...bytes].map(n=>n.toString(16).padStart(2,'0')).join('');
  return 'draft:'+hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);
}

export function activePersonality(profile,value) {
  if(!value.styleId?.startsWith('personality:'))return null;
  const id=value.styleId.slice(12),draft=parse(value.__personality);
  const selected=draft.personalityId===id?draft.traits:profile?.style?.personalityId===id?profile.style.traits:undefined;
  return personalityPresetStyle(id,selected);
}

export function styleSelector(state,profile,value,styles) {
  const personality=activePersonality(profile,value),preset=personalityPresets.find(p=>p.id===personality?.personalityId);
  const active=value.styleId||'',custom=styles.find(x=>x.id===active);
  const label=preset?`性格 · ${preset.label}`:active==='learned'?'已学习':active?'自定义'+(custom?` · ${custom.label}`:''):'默认';
  const selected=(id,label)=>`<button type="button" role="menuitemradio" aria-checked="${active===id}" data-ai-style="${esc(id)}">${esc(label)}</button>`;
  return `<div class="ai-style-source-row"><span>风格来源</span><qi-popover class="ai-style-selector" label="选择风格来源"><button type="button" class="secondary" data-trigger>${esc(label)}</button><div data-content hidden><div class="ai-style-source-menu"><div role="menu" aria-label="风格来源">${selected('','默认')}<button type="button" role="menuitemradio" aria-checked="${active==='learned'}" data-ai-style="learned" ${profile?.learnedStyle?'':'disabled'}>已学习</button><button type="button" role="menuitem" data-style-branch="personality" aria-haspopup="menu" aria-expanded="false">性格 ›</button><button type="button" role="menuitem" data-style-branch="custom" aria-haspopup="menu" aria-expanded="false">自定义 ›</button></div><div class="ai-style-submenus"><div role="menu" aria-label="性格" data-style-submenu="personality" hidden>${personalityPresets.map((p,i)=>`<button type="button" role="menuitemradio" aria-checked="${preset?.id===p.id}" data-personality-id="${p.id}" data-personality-index="${i}">${p.label}</button>`).join('')}</div><div role="menu" aria-label="自定义风格" data-style-submenu="custom" hidden>${styles.map(p=>selected(p.id,p.label)).join('')}<button type="button" role="menuitem" data-ai-style-command="add">新增自定义风格</button></div></div></div></div></qi-popover></div><input type="hidden" name="styleId" value="${esc(active)}"><input type="hidden" name="__personality" value="${esc(personality?JSON.stringify(personality):'')}"><input type="hidden" name="__personalityDrafts" value="${esc(value.__personalityDrafts||'{}')}">${personality?`<input type="hidden" name="summary" value="${esc(personality.summary)}"><fieldset class="ai-personality-traits"><legend>聊天风格</legend><div class="ai-trait-actions"><button type="button" class="quiet" data-personality-select="all">全选</button><button type="button" class="quiet" data-personality-select="none">取消全选</button></div><div class="ai-trait-options">${preset.traits.map(trait=>`<label class="qi-check"><input type="checkbox" data-personality-trait value="${trait}" ${personality.traits.includes(trait)?'checked':''}><span>${trait}</span></label>`).join('')}</div><p class="ai-help">按场景取用；取消全选后保留性格基调。</p></fieldset>`:`${active.startsWith('draft:') || active.startsWith('custom:') ? `<label class="ai-field"><span>风格名称</span><input class="qi-input" name="styleName" value="${esc(value.styleName ?? custom?.label ?? '')}" maxlength="40" required></label>` : ''}<label class="ai-field"><span>风格说明</span><textarea name="summary" maxlength="6000" rows="6">${esc(value.summary)}</textarea></label>${active?'':'<p class="ai-help">当前跟随账号默认风格。<button type="button" class="quiet" data-ai-nav="default-style">学习默认风格</button></p>'}`}`;
}

export function bindStyleSelector(panel,changed) {
  function branch(popover,name) {
    for(const menu of popover.querySelectorAll('[data-style-submenu]'))menu.hidden=menu.dataset.styleSubmenu!==name;
    for(const button of popover.querySelectorAll('[data-style-branch]'))button.setAttribute('aria-expanded',String(button.dataset.styleBranch===name));
    popover.position();
    const menu=popover.querySelector(`[data-style-submenu="${name}"]`);
    (menu?.querySelector('[aria-checked="true"]')||menu?.querySelector('button:not(:disabled)'))?.focus();
  }
  function apply(form,id,traits,focus) {
    const before=parse(form.elements.__personality.value),drafts=parse(form.elements.__personalityDrafts.value);
    if(before.personalityId)drafts[before.personalityId]=before.traits;
    const style=personalityPresetStyle(id,traits===undefined?drafts[id]:traits);
    if(!style)return;
    drafts[id]=style.traits;form.elements.__personalityDrafts.value=JSON.stringify(drafts);
    form.elements.__personality.value=JSON.stringify(style);form.elements.styleId.value='personality:'+id;form.elements.summary.value=style.summary;
    form.querySelector('qi-popover')?.hide(false);changed();
    const target=focus?[...panel.querySelectorAll('[data-personality-trait]')].find(x=>x.value===focus):panel.querySelector('.ai-style-selector [data-trigger]');
    target?.focus({preventScroll:true});
  }
  panel.addEventListener('click',event=>{
    const button=event.target.closest?.('[data-style-branch],[data-personality-id],[data-personality-select]');if(!button)return;
    event.preventDefault();event.stopImmediatePropagation();
    const popover=button.closest('qi-popover'),form=button.closest('form');
    if(button.dataset.styleBranch){branch(popover,button.dataset.styleBranch);return;}
    if(button.dataset.personalityId){apply(form,button.dataset.personalityId);return;}
    const current=parse(form.elements.__personality.value),preset=personalityPresets.find(p=>p.id===current.personalityId);
    apply(form,preset.id,button.dataset.personalitySelect==='all'?preset.traits:[]);
  },true);
  panel.addEventListener('change',event=>{
    if(!event.target.matches?.('[data-personality-trait]'))return;
    event.stopImmediatePropagation();const form=event.target.closest('form'),current=parse(form.elements.__personality.value);
    apply(form,current.personalityId,[...form.querySelectorAll('[data-personality-trait]:checked')].map(x=>x.value),event.target.value);
  },true);
  panel.addEventListener('keydown',event=>{
    const popover=event.target.closest?.('.ai-style-selector');if(!popover?.open)return;
    const button=event.target.closest('button');if(!button)return;
    const submenu=button.closest('[data-style-submenu]');
    if(event.key==='Escape'&&submenu){event.preventDefault();event.stopImmediatePropagation();submenu.hidden=true;const trigger=popover.querySelector(`[data-style-branch="${submenu.dataset.styleSubmenu}"]`);trigger?.setAttribute('aria-expanded','false');trigger?.focus();popover.position();return;}
    if(event.key==='ArrowRight'&&button.dataset.styleBranch){event.preventDefault();event.stopImmediatePropagation();branch(popover,button.dataset.styleBranch);return;}
    if(!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    const items=[...(submenu||button.parentElement).querySelectorAll('button:not(:disabled)')],index=items.indexOf(button);if(index<0)return;
    let next=index;
    if(submenu?.dataset.styleSubmenu==='personality'){
      const col=Math.floor(index/5),row=index%5;
      if(event.key==='ArrowDown')next=col*5+(row+1)%5;
      if(event.key==='ArrowUp')next=col*5+(row+4)%5;
      if(event.key==='ArrowRight'&&col===0)next=index+5;
      if(event.key==='ArrowLeft'){if(col===1)next=index-5;else{event.preventDefault();event.stopImmediatePropagation();submenu.hidden=true;const trigger=popover.querySelector('[data-style-branch="personality"]');trigger?.setAttribute('aria-expanded','false');trigger?.focus();popover.position();return;}}
    }else{
      if(event.key==='ArrowDown')next=(index+1)%items.length;
      if(event.key==='ArrowUp')next=(index+items.length-1)%items.length;
      if(event.key==='ArrowLeft'&&submenu){event.preventDefault();event.stopImmediatePropagation();submenu.hidden=true;popover.querySelector('[data-style-branch="custom"]')?.focus();popover.position();return;}
    }
    if(event.key==='Home')next=0;if(event.key==='End')next=items.length-1;
    event.preventDefault();event.stopImmediatePropagation();items[next]?.focus();
  },true);
}
