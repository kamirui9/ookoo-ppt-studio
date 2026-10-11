const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');
process.env.PORT='3221';process.env.HOST='127.0.0.1';process.env.APP_ACCESS_PASSWORD='';
const {start}=require('../dist/server');const store=require('../dist/lib/store');
test('项目隔离、版本冲突、单页修改与双格式导出',async t=>{
 const server=await start();let cookie='',id;
 const base='http://127.0.0.1:3221';
 async function req(url,method='GET',body,options={}){const r=await fetch(base+url,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{}),...options},body:body?JSON.stringify(body):undefined});cookie=r.headers.get('set-cookie')?.split(';')[0]||cookie;return {status:r.status,value:await r.json()}}
 try{
  const created=await req('/api/projects','POST',{topic:'自动验收样例',mode:'example',pages:8});assert.equal(created.status,201);let p=created.value;id=p.id;
  const foreign=await fetch(base+`/api/projects/${id}`);assert.equal(foreign.status,404);
  const csrf=await req(`/api/projects/${id}`,'PATCH',{version:p.version},{Origin:'http://evil.example'});assert.equal(csrf.status,403);
  const old=structuredClone(p.slides);p.slides[2].title='只修改第三页';p=(await req(`/api/projects/${id}`,'PATCH',{version:p.version,slides:p.slides})).value;
  assert.equal(p.slides[2].title,'只修改第三页');old.forEach((s,i)=>{if(i!==2)assert.deepEqual(p.slides[i],s)});
  assert.equal((await req(`/api/projects/${id}`,'PATCH',{version:1,title:'冲突'})).status,409);
  const raced=await Promise.all([
   req(`/api/projects/${id}`,'PATCH',{version:p.version,title:'并发保存 A'}),
   req(`/api/projects/${id}`,'PATCH',{version:p.version,title:'并发保存 B'})
  ]);assert.deepEqual(raced.map(x=>x.status).sort(),[200,409]);p=raced.find(x=>x.status===200).value;
  const refined=await req(`/api/projects/${id}/slides/${p.slides[2].id}/refine`,'POST',{version:p.version,instruction:'标题改为“一个重点”'});assert.equal(refined.status,200);p=refined.value;assert.equal(p.slides[2].title,'一个重点');
  const slideIds=p.slides.map(s=>s.id);const reverse=[...p.slides].reverse();p=(await req(`/api/projects/${id}`,'PATCH',{version:p.version,slides:reverse})).value;assert.deepEqual(p.slides.map(s=>s.id),slideIds.reverse());
  for(const format of ['pptx','pdf']){const result=await req(`/api/projects/${id}/export`,'POST',{version:p.version,format});assert.equal(result.status,200,JSON.stringify(result.value));const r=await fetch(base+result.value.url,{headers:{Cookie:cookie}});const bytes=Buffer.from(await r.arrayBuffer());assert.equal(r.status,200);assert.ok(bytes.length>10000);assert.equal(bytes.subarray(0,format==='pdf'?4:2).toString(),format==='pdf'?'%PDF':'PK');}
 }finally{await require('../dist/lib/render').closeRenderer();await new Promise(resolve=>server.close(resolve));if(id)await fs.rm(store.dir(id),{recursive:true,force:true});}
});
test('真实接口直连百炼，不依赖工作流，失败明确返回',async()=>{
 const original=global.fetch,priorKey=process.env.BAILIAN_API_KEY;
 process.env.BAILIAN_API_KEY='direct-test-key';
 const {examplePlan}=require('../dist/lib/domain');
 const modelPlan=examplePlan({topic:'直连测试',pages:5});
 const calls=[];let fail=false;
 global.fetch=async(url,options={})=>{
  if(String(url).startsWith('http://127.0.0.1:3221'))return original(url,options);
  assert.equal(String(url),'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions');
  const payload=JSON.parse(options.body);assert.equal(payload.model,'qwen3.8-max');calls.push(payload);
  if(fail)return Response.json({message:'服务暂时不可用'},{status:503});
  const value=calls.length===1?modelPlan:{...modelPlan.slides[1],title:'直连修改结果'};
  return Response.json({choices:[{message:{content:JSON.stringify(value)}}],usage:{total_tokens:10}});
 };
 const server=await start();let id;
 try{
  const base='http://127.0.0.1:3221';
  const created=await fetch(base+'/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({topic:'直连测试',pages:5,mode:'live'})});
  assert.equal(created.status,201);const cookie=created.headers.get('set-cookie').split(';')[0];const p=await created.json();id=p.id;
  assert.equal(p.source,'qwen');assert.equal(p.slides.length,5);assert.equal(calls.length,1);assert.equal(p.workflowRunId,undefined);
  const status=await (await fetch(base+'/api/status')).json();assert.equal(status.textProvider,'bailian-direct');assert.equal(status.difyConfigured,undefined);
  assert.equal((await fetch(base+'/internal/plan')).status,404);
  const refined=await fetch(base+`/api/projects/${id}/slides/${p.slides[1].id}/refine`,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({version:p.version,instruction:'改标题'})});
  assert.equal(refined.status,200);const updated=await refined.json();assert.equal(updated.slides[1].title,'直连修改结果');
  p.slides.forEach((s,i)=>{if(i!==1)assert.deepEqual(updated.slides[i],s)});assert.equal(calls.length,2);
  fail=true;const failure=await fetch(base+'/api/projects',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({topic:'失败测试',pages:5})});
  assert.equal(failure.status,400);assert.match((await failure.json()).error,/HTTP 503/);
 }finally{global.fetch=original;if(priorKey===undefined)delete process.env.BAILIAN_API_KEY;else process.env.BAILIAN_API_KEY=priorKey;await new Promise(resolve=>server.close(resolve));if(id)await fs.rm(store.dir(id),{recursive:true,force:true});}
});
test('整页图片直接预览与导出，改文案失效但改讲稿保留图片',async()=>{
 const server=await start();let id;const base='http://127.0.0.1:3221';let cookie='';
 async function req(tail,method='GET',body){const r=await fetch(base+tail,{method,headers:{Cookie:cookie,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});cookie=r.headers.get('set-cookie')?.split(';')[0]||cookie;return {status:r.status,value:await r.json()};}
 try{
  let p=(await req('/api/projects','POST',{topic:'整图导出',mode:'example',pages:5})).value;id=p.id;
  p=(await req(`/api/projects/${id}`,'PATCH',{version:p.version,slides:p.slides.map(s=>({...s,imageMode:'full-slide',needsImage:true}))})).value;
  const sharp=require('sharp');const bytes=await sharp({create:{width:1920,height:1080,channels:3,background:'#efefef'}}).png().toBuffer();
  p=(await req(`/api/projects/${id}/slides/${p.slides[0].id}/image`,'POST',{version:p.version,data:`data:image/png;base64,${bytes.toString('base64')}`})).value;
  const preview=await (await fetch(base+`/api/projects/${id}/slides/${p.slides[0].id}/preview`,{headers:{Cookie:cookie}})).text();assert.match(preview,/class="backdrop full-slide"/);assert.doesNotMatch(preview,/class="shade/);assert.doesNotMatch(preview,/LAUNCH STUDIO/);
  assert.equal((await req(`/api/projects/${id}/export`,'POST',{version:p.version,format:'pptx'})).status,400);
  const out=await req(`/api/projects/${id}/export`,'POST',{version:p.version,format:'pptx',scope:'generated'});assert.equal(out.status,200);
  const ppt=Buffer.from(await (await fetch(base+out.value.url,{headers:{Cookie:cookie}})).arrayBuffer());const zip=await require('jszip').loadAsync(ppt);const names=Object.keys(zip.files).filter(n=>/^ppt\/slides\/slide\d+\.xml$/.test(n));assert.equal(names.length,1);
  const xml=await zip.file(names[0]).async('string');assert.equal((xml.match(/<p:pic>/g)||[]).length,1);assert.doesNotMatch(xml,/<p:sp>/);
  const image=p.slides[0].image;p.slides[0].notes='只修改讲稿';p=(await req(`/api/projects/${id}`,'PATCH',{version:p.version,slides:p.slides})).value;assert.equal(p.slides[0].image,image);
  p.slides[0].title='修改后的标题';p=(await req(`/api/projects/${id}`,'PATCH',{version:p.version,slides:p.slides})).value;assert.equal(p.slides[0].image,null);
 }finally{await new Promise(r=>server.close(r));if(id)await fs.rm(store.dir(id),{recursive:true,force:true});}
});
