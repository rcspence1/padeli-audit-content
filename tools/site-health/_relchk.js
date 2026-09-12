const { chromium } = require('playwright');
const S='/private/tmp/claude-501/-Users-rcspence/8daae3a4-8352-4f86-afda-f0a56936bc76/scratchpad';
(async()=>{
  const b=await chromium.launch({headless:true});
  const p=await b.newPage({viewport:{width:1280,height:900}});
  await p.goto('file://'+__dirname+'/_pages/blog-rackets.html',{waitUntil:'load'});
  const r=await p.evaluate(()=>{
    const out=[];
    document.querySelectorAll('.related-reading,.padeli-faq-accordion').forEach(el=>{
      const h=el.querySelector('h2,h3,h4');
      const box=el.getBoundingClientRect();
      out.push({cls:el.className.split(' ').slice(-1)[0],
        gapAboveHeading: h? Math.round(h.getBoundingClientRect().top - box.top) : null,
        headingSize: h? getComputedStyle(h).fontSize : null});
    });
    return out;
  });
  console.log('  inset blocks:',JSON.stringify(r));
  const el=await p.$('.related-reading');
  if(el){ await el.scrollIntoViewIfNeeded(); await p.waitForTimeout(400);
    await p.screenshot({path:S+'/blogfix-related.png'}); }
  await b.close();
})().catch(e=>console.log('ERR',e.message));
