const { chromium } = require('playwright');
const S='/private/tmp/claude-501/-Users-rcspence/8daae3a4-8352-4f86-afda-f0a56936bc76/scratchpad';
(async()=>{
  const b=await chromium.launch({headless:true});
  const p=await b.newPage({viewport:{width:1280,height:1000}});
  await p.goto('file://'+__dirname+'/_pages/blog-rackets.html',{waitUntil:'load'});
  for (const [tag,y] of [['top',0],['mid',5000],['deep',11000]]){
    await p.evaluate(v=>window.scrollTo(0,v),y);
    await p.waitForTimeout(450);
    const r=await p.evaluate(()=>{
      const boxes=[...document.querySelectorAll('.side > .box')].map(b=>b.getBoundingClientRect());
      let overlap=false;
      for(let i=0;i<boxes.length-1;i++)
        if(boxes[i].bottom > boxes[i+1].top+1) overlap=true;
      return {overlap, n:boxes.length, sideH:Math.round(document.querySelector('.side').getBoundingClientRect().height)};
    });
    console.log(`  scroll ${tag.padEnd(5)} sidebar boxes:${r.n} overlap:${r.overlap} sideHeight:${r.sideH}`);
    await p.screenshot({path:`${S}/blogfix-${tag}.png`});
  }
  await b.close();
})().catch(e=>console.log('ERR',e.message));
