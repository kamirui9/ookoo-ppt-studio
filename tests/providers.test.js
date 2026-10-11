const test=require('node:test');const assert=require('node:assert/strict');const sharp=require('sharp');
process.env.BAILIAN_API_KEY='local-test-key';process.env.QWEN_IMAGE_MODEL='qwen-image-3.0-pro';
const {generateImage,imageFingerprint}=require('../dist/lib/providers');
async function advanceUntilDone(t,run){
 t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()+1000000});
 let settled=false;const result=run();result.then(()=>{settled=true},()=>{settled=true});
 for(let i=0;i<2000&&!settled;i++){await new Promise(resolve=>setImmediate(resolve));t.mock.timers.tick(1000)}
 assert.ok(settled,'模拟时间内应结束');return result;
}
const succeeded=()=>Response.json({output:{task_status:'SUCCEEDED',choices:[{message:{content:[{image:'https://test.oss-cn-beijing.aliyuncs.com/test.png'}]}}]}});
test('提交与查询的 429 等待后恢复，查询限流复用已受理任务',async t=>{
 const original=global.fetch;const slide={imagePrompt:'限流恢复测试'},saved=[];let submits=0,queries=0;const times=[];
 const png=await sharp({create:{width:1,height:1,channels:3,background:'#112233'}}).png().toBuffer();
 global.fetch=async url=>{
  if(url.endsWith('/generation')){times.push(Date.now());return ++submits===1?Response.json({code:'Throttling',message:'Rate limited'},{status:429,headers:{'Retry-After':'20'}}):Response.json({output:{task_id:'rate-task',task_status:'PENDING'}})}
  if(url.includes('/tasks/'))return ++queries===1?new Response('Rate limited',{status:429}):succeeded();
  return new Response(png);
 };
 try{const result=await advanceUntilDone(t,()=>generateImage(slide,'dark',async v=>saved.push(structuredClone(v))));assert.equal(result.task.taskId,'rate-task');assert.equal(submits,2);assert.equal(queries,2);assert.ok(times[1]-times[0]>=20000);assert.equal(saved.filter(v=>v.status==='rate_limited').length,2);assert.equal(saved.find(v=>v.status==='rate_limited').taskId,undefined);assert.ok(saved.find(v=>v.status==='rate_limited'&&v.taskId==='rate-task'));assert.equal(saved.at(-1).retryAt,undefined);
 }finally{global.fetch=original;}
});
test('持续提交限流只重试三次，保留可安全继续的状态',async t=>{
 const original=global.fetch;let calls=0;const slide={imagePrompt:'持续限流测试'},saved=[];
 global.fetch=async()=>{calls++;return Response.json({code:'Throttling'},{status:429})};
 try{
  await advanceUntilDone(t,()=>assert.rejects(()=>generateImage(slide,'dark',async v=>saved.push(structuredClone(v))),/HTTP 429.*继续生成/));
  assert.equal(calls,4);assert.equal(saved.at(-1).status,'rate_limited');assert.equal(saved.at(-1).taskId,undefined);assert.equal(saved.at(-1).retryAt,undefined);
  slide.imageTask=saved.at(-1);global.fetch=async()=>{calls++;return Response.json({code:'Throttling'},{status:429,headers:{'Retry-After':'600'}})};
  await assert.rejects(()=>generateImage(slide,'dark',async()=>{}),/HTTP 429/);assert.equal(calls,5);
 }finally{global.fetch=original;}
});
test('异常响应携带任务 ID 时不再提交；日期格式等待头可识别',async t=>{
 const {requestJSON}=require('../dist/lib/providers');const original=global.fetch;let calls=0;const times=[];
 try{
  global.fetch=async()=>{calls++;return Response.json({output:{task_id:'accepted-despite-429'}},{status:429})};
  assert.equal((await requestJSON('https://test.invalid/generation',{method:'POST'})).output.task_id,'accepted-despite-429');assert.equal(calls,1);
  global.fetch=async()=>{times.push(Date.now());return times.length===1?Response.json({code:'Throttling'},{status:429,headers:{'Retry-After':new Date(Date.now()+25000).toUTCString()}}):Response.json({ok:true})};
  await advanceUntilDone(t,()=>requestJSON('https://test.invalid/tasks/accepted'));assert.ok(times[1]-times[0]>=24000);
 }finally{global.fetch=original;}
});
test('并发项目共享模型的提交间隔',async t=>{
 const original=global.fetch,oldInterval=process.env.IMAGE_MIN_INTERVAL_MS;process.env.IMAGE_MIN_INTERVAL_MS='4000';const times=[];
 global.fetch=async url=>{if(url.endsWith('/generation')){times.push(Date.now());return Response.json({output:{task_id:'paced-task',task_status:'FAILED'}})}return Response.json({output:{task_status:'FAILED'}})};
 try{await advanceUntilDone(t,()=>Promise.allSettled([generateImage({imagePrompt:'项目 A'},'dark',async()=>{}),generateImage({imagePrompt:'项目 B'},'dark',async()=>{})]));assert.equal(times.length,2);assert.ok(times[1]-times[0]>=4000);
 }finally{global.fetch=original;if(oldInterval===undefined)delete process.env.IMAGE_MIN_INTERVAL_MS;else process.env.IMAGE_MIN_INTERVAL_MS=oldInterval;}
});
test('任务查询短暂断连可恢复，生图提交失败不自动重发',async()=>{
 const {requestJSON}=require('../dist/lib/providers');const original=global.fetch;let calls=0;
 const failure=()=>Object.assign(new TypeError('fetch failed'),{cause:{code:'ECONNRESET'}});
 try{
  global.fetch=async()=>{if(++calls<3)throw failure();return Response.json({output:{task_status:'SUCCEEDED'}})};
  assert.equal((await requestJSON('https://test.invalid/tasks/saved-id')).output.task_status,'SUCCEEDED');assert.equal(calls,3);
  calls=0;global.fetch=async()=>{calls++;throw failure()};
  await assert.rejects(()=>requestJSON('https://test.invalid/generation',{method:'POST'}),/提交图片生成网络请求失败.*ECONNRESET.*避免重复计费/);assert.equal(calls,1);
 }finally{global.fetch=original;}
});
test('整页提示词包含精确文案，修改文案或构图会使旧任务失效',()=>{
 const {normalizeSlide}=require('../dist/lib/domain');const {buildImagePrompt}=require('../dist/lib/providers');
 const s=normalizeSlide({title:'你的新搭档',subtitle:'从一个任务开始',imageMode:'full-slide',pageStyle:'light',imagePrompt:'笔记本电脑特写',bullets:[{title:'写总结',body:'先核对事实'}]});
 const prompt=buildImagePrompt(s,'dark');assert.match(prompt,/「你的新搭档」/);assert.match(prompt,/「写总结」/);assert.match(prompt,/纯白/);assert.doesNotMatch(prompt,/不包含文字/);
 const fingerprint=imageFingerprint(s,'dark','qwen-image-3.0-pro');
 for(const change of [{title:'新标题'},{bullets:[{title:'另一任务',body:''}]},{pageStyle:'dark'},{imagePrompt:'另一构图'}])assert.notEqual(imageFingerprint({...s,...change},'dark','qwen-image-3.0-pro'),fingerprint);
 assert.equal(imageFingerprint({...s,notes:'只改讲稿'},'dark','qwen-image-3.0-pro'),fingerprint);
});
for(const model of ['qwen-image-3.0-pro','qwen-image-3.0','qwen-image-2.1-pro'])test(`${model} 图片任务受理后复用任务 ID，结果未知时不重复提交`,async()=>{
 const original=global.fetch,originalModel=process.env.QWEN_IMAGE_MODEL;process.env.QWEN_IMAGE_MODEL=model;
 const slide={imagePrompt:'右侧抽象科技主视觉'},saved=[],calls=[];
 const png=await sharp({create:{width:1,height:1,channels:3,background:'#112233'}}).png().toBuffer();
 global.fetch=async(url,options={})=>{calls.push({url,method:options.method||'GET'});
  if(url.endsWith('/generation')){const input=JSON.parse(options.body);assert.equal(input.model,model);assert.equal(input.parameters.n,1);assert.equal(input.parameters.size,'1920*1080');return Response.json({output:{task_id:'test-task',task_status:'PENDING'}})}
  if(url.includes('/tasks/'))return Response.json({output:{task_status:'SUCCEEDED',choices:[{message:{content:[{image:'https://test.oss-cn-beijing.aliyuncs.com/test.png'}]}}]}});
  return new Response(png,{status:200});
 };
  try{const result=await generateImage(slide,'dark',async t=>saved.push(structuredClone(t)));assert.equal(result.model,model);assert.equal(calls.filter(c=>c.method==='POST').length,1);assert.equal(saved[0].status,'waiting');assert.ok(saved.some(t=>t.status==='submission_unknown'));
  slide.imageTask=saved.at(-1);calls.length=0;await generateImage(slide,'dark',async()=>{});assert.equal(calls.filter(c=>c.method==='POST').length,0);
  slide.imageTask={fingerprint:imageFingerprint(slide,'dark',model),status:'submission_unknown'};calls.length=0;await assert.rejects(()=>generateImage(slide,'dark',async()=>{}),/提交结果未知/);assert.equal(calls.length,0);
 }finally{global.fetch=original;process.env.QWEN_IMAGE_MODEL=originalModel;}
});

test('结束页只允许指定标题与品牌，不向生图模型重复禁止词',()=>{
 const {normalizeSlide}=require('../dist/lib/domain');const {buildImagePrompt}=require('../dist/lib/providers');
 const s=normalizeSlide({title:'每天，都有新的好状态',imageMode:'full-slide',layout:'closing',imagePrompt:'纯白背景，产品居中。底部放置品牌文字「Panasonic 松下」。绝不出现「谢谢观看」、二维码或价格。'});
 const prompt=buildImagePrompt(s,'light');assert.match(prompt,/只有以下 2 条可见文案/);assert.match(prompt,/「Panasonic 松下」/);assert.doesNotMatch(prompt,/谢谢观看|不要Logo|品牌名/);assert.match(prompt,/逐字绘制/);
 const explicit=normalizeSlide({...s,brand:'Panasonic 松下',imagePrompt:'纯白背景，产品居中，品牌位于底部。'});
 assert.match(buildImagePrompt(explicit,'light'),/「Panasonic 松下」/);
 assert.notEqual(imageFingerprint(explicit,'light','qwen-image-3.0-pro'),imageFingerprint({...explicit,brand:'Panasonic'},'light','qwen-image-3.0-pro'));
});
