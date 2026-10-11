const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');
process.env.PORT='3222';process.env.HOST='127.0.0.1';process.env.APP_ACCESS_PASSWORD='';process.env.BAILIAN_API_KEY='mock-test-key';
const {start}=require('../dist/server');const store=require('../dist/lib/store');
test('独立页面输入按页映射，留空自动规划且只生成所选三页',async()=>{
 const original=global.fetch,base='http://127.0.0.1:3222';const plan=require('../dist/lib/domain').examplePlan({topic:'简化流程',pages:3});let submitted=0,id,textCalls=0;const sharp=require('sharp');const png=await sharp({create:{width:1,height:1,channels:3,background:'#2255aa'}}).png().toBuffer();
 global.fetch=async(url,options={})=>{
  if(String(url).startsWith(base))return original(url,options);
  if(String(url).endsWith('/chat/completions')){textCalls++;const body=JSON.parse(options.body),brief=JSON.parse(body.messages[1].content);assert.equal(brief.页数,3);assert.deepEqual(brief.逐页内容,[{page:1,content:'封面，标题保留「欢迎新同事」'},{page:3,content:'总结与行动'}]);assert.match(body.messages[0].content,/保持顺序/);assert.equal(brief.补充说明,'受众：新员工；白底发布会风格');return Response.json({choices:[{message:{content:JSON.stringify(plan)}}]});}
  if(String(url).endsWith('/generation')){submitted++;return Response.json({output:{task_id:`mock-${submitted}`,task_status:'PENDING'}});}
  if(String(url).includes('/tasks/'))return Response.json({output:{task_status:'SUCCEEDED',choices:[{message:{content:[{image:'https://test.oss-cn-beijing.aliyuncs.com/image.png'}]}}]}});
  if(String(url)==='https://test.oss-cn-beijing.aliyuncs.com/image.png')return new Response(png);
  throw Error('unexpected test URL');
 };
 const server=await start();
 try{
  const conflict=await fetch(base+'/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({topic:'简化流程',pages:3,pageContents:['一','二','三','多出的页面'],mode:'live'})});assert.equal(conflict.status,400);assert.match((await conflict.json()).error,/不能超过所选页数/);assert.equal(textCalls,0);assert.equal(submitted,0);
  const r=await fetch(base+'/api/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({topic:'简化流程',pages:3,notes:'受众：新员工；白底发布会风格',pageContents:['封面，标题保留「欢迎新同事」','','总结与行动'],mode:'live'})});assert.equal(r.status,201);const cookie=r.headers.get('set-cookie').split(';')[0];const p=await r.json();id=p.id;assert.equal(p.stage,'outline');assert.equal(p.slides.length,3);assert.deepEqual(p.pageContents,['封面，标题保留「欢迎新同事」','','总结与行动']);
  const url=base+`/api/projects/${id}/generate`,headers={Cookie:cookie,'Content-Type':'application/json'};
  const rejected=await fetch(url,{method:'POST',headers,body:JSON.stringify({version:p.version,phase:'all'})});assert.equal(rejected.status,400);assert.equal(submitted,0);
  const generated=await fetch(url,{method:'POST',headers,body:JSON.stringify({version:p.version,phase:'all',confirm:true})});assert.equal(generated.status,202);
  let result;const deadline=Date.now()+10000;
  do{await new Promise(resolve=>setTimeout(resolve,20));result=await store.read(id,p.owner||cookie.split('=')[1].split('.')[0]);}while(['queued','running'].includes(result.job.status)&&Date.now()<deadline);
  assert.equal(result.job.status,'succeeded',result.job.error);assert.equal(result.stage,'ready');assert.equal(result.slides.filter(s=>s.image).length,3);assert.equal(submitted,3);assert.equal(textCalls,1);
 }finally{global.fetch=original;await new Promise(resolve=>server.close(resolve));if(id)await fs.rm(store.dir(id),{recursive:true,force:true});}
});
