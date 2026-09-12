const { chromium } = require('playwright');
const S='/private/tmp/claude-501/-Users-rcspence/8daae3a4-8352-4f86-afda-f0a56936bc76/scratchpad';
(async()=>{
  const b=await chromium.launch({headless:true});
  for (const n of ['blog-rackets','coach-jo-ward','tournaments-hub','tournament-detail']){
    const p=await b.newPage({viewport:{width:1280,height:1050}});
    const errs=[]; p.on('pageerror',e=>errs.push(e.message));
    await p.goto('file://'+__dirname+'/_pages/'+n+'.html',{waitUntil:'load',timeout:60000});
    await p.waitForTimeout(900);
    await p.screenshot({path:`${S}/pg-${n}.png`});
    const c=await p.evaluate(()=>({
      hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth+1,
      brokenImgs: [...document.images].filter(i=>!i.complete||i.naturalWidth===0).length,
      h1: (document.querySelector('h1')||{}).textContent,
      height: document.body.scrollHeight }));
    console.log(`  ${n.padEnd(20)} hScroll:${c.hScroll} brokenImgs:${c.brokenImgs} h:${c.height} errs:${errs.length||0}`);
    await p.close();
  }
  await b.close();
})().catch(e=>{console.log('ERR',e.message);process.exit(1)});
