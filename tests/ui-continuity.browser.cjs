// SPDX-License-Identifier: AGPL-3.0-only
// Run with playwright-core available. Only synthetic DOM; no user database writes.
const fs=require('fs'),assert=require('node:assert/strict'),{chromium}=require('playwright-core');
const asset=fs.readFileSync(process.argv[2],'utf8');
(async()=>{
 const browser=await chromium.launch({headless:true,args:['--no-sandbox']});const results=[];
 try{
  for(const mode of ['replacement','spell','delayed-layout','same-root','reverse','disabled','wheel-cancel','different-message','unrelated']){
   const page=await browser.newPage({viewport:{width:390,height:900}});
   await page.setContent(`<style>.chat-content{height:400px;overflow:auto;scroll-behavior:smooth}.filler{height:2200px}.x-risu-th-side-wrap{position:fixed;right:10px;top:10px}</style><main><div class="risu-chat" data-chat-index="2" data-chat-id="message-unique"><div class="chat-content"><div class="filler">본문</div><div class="${mode==='unrelated'?'other':'x-risu-th-side-wrap'}"><button risu-btn="th_ui_sidebar">열기</button></div></div></div></main>`);
   if(mode==='spell')await page.evaluate(()=>{const wrap=document.querySelector('.x-risu-th-side-wrap');wrap.className='x-risu-th-spell-wrap';wrap.style.cssText='position:fixed;right:10px;top:10px';wrap.firstElementChild.setAttribute('risu-btn','th_ui_spell');});
   await page.addScriptTag({content:asset});
   await page.evaluate(mode=>{
    if(mode!=='disabled')document.documentElement.setAttribute('x-risu-bg-ui-enabled','thgy-v1');
    const sc=document.querySelector('.chat-content');sc.style.scrollBehavior='auto';
    if(mode==='reverse'){sc.style.display='flex';sc.style.flexDirection='column-reverse';sc.firstElementChild.style.flexShrink='0';}
    sc.scrollTop=mode==='reverse'?-500:500;
    window.original=document.querySelector('.risu-chat');
    document.querySelector('button').addEventListener('click',()=>{
     setTimeout(()=>{
      const old=document.querySelector('.risu-chat');
      if(mode==='same-root'){old.querySelector('.chat-content').innerHTML='<div class="filler">new</div>';old.querySelector('.chat-content').scrollTop=0;return;}
      const next=old.cloneNode(true);if(mode==='different-message')next.dataset.chatId='different';
      if(mode==='delayed-layout')next.querySelector('.filler').style.height='10px';
      old.replaceWith(next);
      if(mode==='delayed-layout')setTimeout(()=>{next.querySelector('.filler').style.height='2200px'},250);
     },100);
    });
   },mode);
   if(mode==='unrelated')await page.locator('button').evaluate(e=>e.click());else await page.locator('button').click();
   if(mode==='wheel-cancel')await page.evaluate(()=>document.dispatchEvent(new WheelEvent('wheel',{bubbles:true})));
   await page.waitForTimeout(1200);
   const actual=await page.evaluate(()=>({top:document.querySelector('.chat-content').scrollTop,result:document.documentElement.getAttribute('x-risu-bg-ui-last-result')}));
   const expected=['disabled','wheel-cancel','different-message','unrelated'].includes(mode)?0:mode==='reverse'?-500:500;
   assert.ok(Math.abs(actual.top-expected)<1,`${mode}: ${JSON.stringify(actual)}`);
   results.push({mode,...actual});await page.close();
  }
  console.log(JSON.stringify(results,null,2));
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
