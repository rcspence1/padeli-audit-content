const { chromium } = require('playwright');
(async()=>{
  const b=await chromium.launch({headless:true});
  const p=await b.newPage({viewport:{width:1280,height:1050}});
  await p.goto('file://'+__dirname+'/_pages/blog-rackets.html',{waitUntil:'load'});
  const before=await p.evaluate(()=>[...document.images].filter(i=>!i.complete||i.naturalWidth===0).length);
  await p.evaluate(async()=>{ for(let y=0;y<document.body.scrollHeight;y+=800){window.scrollTo(0,y);await new Promise(r=>setTimeout(r,60));} });
  await p.waitForTimeout(900);
  const after=await p.evaluate(()=>[...document.images].filter(i=>!i.complete||i.naturalWidth===0).length);
  console.log(`  broken before scroll: ${before}  after scroll: ${after}  -> ${after===0?'all fine, it was loading="lazy"':'GENUINELY BROKEN'}`);
  await b.close();
})().catch(e=>console.log('ERR',e.message));
