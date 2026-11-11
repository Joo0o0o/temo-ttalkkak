// Draws extension/icons/icon-{16,32,48,128}.png with headless Chrome canvas (no image deps).
'use strict';
const {spawn}=require('node:child_process');const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const CHROME=process.env.CHROME||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT=path.resolve(__dirname,'../extension/icons');fs.mkdirSync(OUT,{recursive:true});
const prof=fs.mkdtempSync(path.join(os.tmpdir(),'temo-icon-'));
const p=spawn(CHROME,['--headless=new','--remote-debugging-pipe','--user-data-dir='+prof,'about:blank'],{stdio:['ignore','ignore','ignore','pipe','pipe']});
let buf='',id=0;const pend=new Map();p.stdio[4].on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\0'))>=0){const m=JSON.parse(buf.slice(0,i));buf=buf.slice(i+1);if(pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}}});
const send=(method,params={},sessionId)=>new Promise(r=>{const i=++id;pend.set(i,r);p.stdio[3].write(JSON.stringify({id:i,method,params,...(sessionId?{sessionId}:{})})+'\0');});
(async()=>{
 const {result:{targetId}}=await send('Target.createTarget',{url:'about:blank'});const {result:{sessionId}}=await send('Target.attachToTarget',{targetId,flatten:true});
 for(const n of [16,32,48,128]){
  const draw=`(()=>{const n=${n},c=document.createElement('canvas');c.width=c.height=n;const g=c.getContext('2d');
   const r=n*0.22;g.fillStyle='#1f5fbf';g.beginPath();g.roundRect(0,0,n,n,r);g.fill();
   // document sheet
   g.fillStyle='#fff';const w=n*0.5,h=n*0.62,x=n*0.18,y=n*0.16;g.beginPath();g.roundRect(x,y,w,h,n*0.06);g.fill();
   g.fillStyle='#1f5fbf';for(let k=0;k<3;k++){g.fillRect(x+w*0.18,y+h*(0.25+k*0.2),w*0.64,Math.max(1,n*0.045));}
   // click badge
   g.fillStyle='#ffb020';g.beginPath();g.arc(n*0.72,n*0.72,n*0.2,0,Math.PI*2);g.fill();
   g.strokeStyle='#fff';g.lineWidth=Math.max(1.5,n*0.06);g.lineCap='round';g.lineJoin='round';g.beginPath();g.moveTo(n*0.63,n*0.72);g.lineTo(n*0.70,n*0.79);g.lineTo(n*0.82,n*0.65);g.stroke();
   return c.toDataURL('image/png').split(',')[1];})()`;
  const r=await send('Runtime.evaluate',{expression:draw,returnByValue:true},sessionId);
  fs.writeFileSync(path.join(OUT,`icon-${n}.png`),Buffer.from(r.result.result.value,'base64'));
 }
 p.kill();await new Promise(r=>setTimeout(r,800));fs.rmSync(prof,{recursive:true,force:true,maxRetries:5,retryDelay:200});console.log('icons written');
})();
