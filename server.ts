import type {Project, Plan, GenerationPhase, ImageJob, ServiceStatus} from './shared/types';
import http, {type IncomingMessage, type ServerResponse} from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import {ROOT,config,safeError} from './lib/config';
import {text,briefPayload,examplePlan,normalizePlan,normalizeSlide,record} from './lib/domain';
import {previewHTML,exportProject} from './lib/render';
import {planViaQwen,refineViaQwen,generateImage,imageFingerprint} from './lib/providers';
import * as store from './lib/store';
const locks=new Set<string>(), jobLocks=new Set<string>(), queue: (()=>Promise<void>)[]=[];let active=0;
function error(message: string,status=400){return Object.assign(new Error(message),{status})}
function equal(a: string | undefined,b: string | undefined){const aa=Buffer.from(a||''),bb=Buffer.from(b||'');return aa.length===bb.length&&crypto.timingSafeEqual(aa,bb)}
function sign(id: string,authed: string){const c=config();return crypto.createHmac('sha256',c.SESSION_SECRET).update(`${id}:${authed}:${c.APP_ACCESS_PASSWORD||''}`).digest('hex')}
interface Session {id: string; authed: boolean}
function session(req: IncomingMessage,res: ServerResponse): Session{
  const val=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('launch_session='))?.slice(15);
  const parts=val?.split('.');
  if(parts?.length===3&&store.UUID.test(parts[0])&&equal(sign(parts[0],parts[1]),parts[2]))return {id:parts[0],authed:parts[1]==='1'};
  const s={id:crypto.randomUUID(),authed:false};setCookie(res,s);return s;
}
function setCookie(res: ServerResponse,s: Session){res.setHeader('Set-Cookie',`launch_session=${s.id}.${s.authed?'1':'0'}.${sign(s.id,s.authed?'1':'0')}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`)}
function json(res: ServerResponse,status: number,value: unknown){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value))}
async function body(req: IncomingMessage): Promise<Record<string, unknown>>{
  if(!(req.headers['content-type']||'').startsWith('application/json'))throw error('请求需要 JSON',415);
  const chunks=[];let n=0;for await(const chunk of req){n+=chunk.length;if(n>15*1024*1024)throw error('请求超过 15MB',413);chunks.push(chunk)}
  try{const value: unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return record(value)}catch{throw error('无效 JSON')}
}
async function file(res: ServerResponse,p: string,type: string){res.writeHead(200,{'Content-Type':type,'Cache-Control':'no-store'});res.end(await fs.readFile(p))}
function requireFree(id: string){if(locks.has(id)||jobLocks.has(id))throw error('项目正在处理，请稍后再修改',409)}
async function transaction<T>(id: string,owner: string,fn: (project: Project)=>Promise<T>): Promise<T>{requireFree(id);locks.add(id);try{const p=await store.read(id,owner);const result=await fn(p);return result}finally{locks.delete(id)}}
function pendingSlides(p: Project,phase: GenerationPhase){const reps=[0,Math.floor(p.slides.length/2),p.slides.length-1];return p.slides.filter((s,i)=>(phase==='all'||reps.includes(i))&&s.needsImage&&!s.image)}
function enqueue(run: ()=>Promise<void>){queue.push(run);pump()}
function pump(){const max=Math.max(1,Math.min(2,Number(config().IMAGE_CONCURRENCY)||1));while(active<max&&queue.length){const run=queue.shift();if(!run)break;active++;run().catch(e=>console.error(safeError(e))).finally(()=>{active--;pump()})}}
function taskProgress(title: string,task: {status: string; retryAt?: string}) {
  return task.status==='rate_limited'?`${title} · 百炼限流，${task.retryAt?'等待后自动重试':'请稍后继续生成'}`:title;
}
async function generate(p: Project,phase: GenerationPhase){
  if(!p.job)throw error('缺少生成任务');
  const job=p.job;
  try{
    job.status='running';await store.save(p);
    const selected=pendingSlides(p,phase);job.total=selected.length;
    for(const s of selected){
      job.current=s.title;await store.save(p);
      const image=await generateImage(s,p.style,async task=>{s.imageTask=task;job.current=taskProgress(s.title,task);await store.save(p)});
      const assets=path.join(store.dir(p.id),'assets');await fs.mkdir(assets,{recursive:true});
      const name=`${s.id}-${crypto.randomUUID()}.png`;await fs.writeFile(path.join(assets,name),image.buffer);
      s.image=name;s.imageModel=image.model;s.imageTask=image.task;s.imageUsage=image.usage;job.done++;await store.save(p);
    }
    p.stage=phase==='samples'?'samples':'ready';job.status='succeeded';job.current='';await store.save(p,{revision:true});
  }catch(e){job.status='failed';job.error=safeError(e);await store.save(p)}finally{jobLocks.delete(p.id)}
}
async function route(req: IncomingMessage,res: ServerResponse){
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');
  const url=new URL(req.url || '/', 'http://localhost'),pathname=url.pathname,c=config();
  if(req.method==='OPTIONS')throw error('不允许跨站请求',403);
  if(req.method!=='GET'&&req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)throw error('不允许跨站请求',403);
  if(pathname==='/health')return json(res,200,{ok:true,version:'0.1.0'});
  const s=session(req,res);
  if(pathname==='/api/login'&&req.method==='POST'){
    const input=await body(req);if(c.APP_ACCESS_PASSWORD&&!equal(text(input.password,10000),c.APP_ACCESS_PASSWORD))throw error('访问密码不正确',401);
    s.authed=true;setCookie(res,s);return json(res,200,{ok:true});
  }
  const authRequired=!!c.APP_ACCESS_PASSWORD&&!s.authed;
  if(pathname==='/api/status')return json(res,200,{authRequired,bailianConfigured:!!c.BAILIAN_API_KEY,textProvider:'bailian-direct',textModel:c.QWEN_TEXT_MODEL,imageModel:c.QWEN_IMAGE_MODEL,imageQueue:queue.length+active,defaultPages:5} satisfies ServiceStatus);
  if(pathname.startsWith('/api/')&&authRequired)throw error('请先输入访问密码',401);
  if(pathname==='/api/projects'&&req.method==='GET')return json(res,200,await store.list(s.id));
  if(pathname==='/api/projects'&&req.method==='POST'){
    const input=await body(req),brief=briefPayload(input);let plan: Plan;
    if(input.mode==='example')plan=examplePlan(brief);
    else {if(!c.BAILIAN_API_KEY)throw error('请先配置百炼 API Key');plan=await planViaQwen({...brief,mode:'live'});normalizePlan(plan,brief.pages)}
    const p: Project={...brief,...plan,id:crypto.randomUUID(),owner:s.id,source:input.mode==='example'?'example':'qwen',stage:'outline',version:0,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),job:null};
    p.slides=p.slides.map(normalizeSlide);await store.save(p,{revision:true});return json(res,201,store.publicProject(p));
  }
  const m=pathname.match(/^\/api\/projects\/([a-f0-9-]+)(?:\/(.*))?$/);
  if(m){
    const [,id,tail='']=m;
    if(!tail&&req.method==='GET')return json(res,200,store.publicProject(await store.read(id,s.id)));
    if(!tail&&req.method==='PATCH')return json(res,200,await transaction(id,s.id,async p=>{
      const input=await body(req);if(input.version!==p.version)throw error('页面已更新，请刷新后修改',409);
      if(input.slides){if(!Array.isArray(input.slides)||input.slides.length!==p.slides.length)throw error('页面数量不匹配');
        const slides=input.slides.map(v=>record(v));const ids=slides.map(v=>v.id);if(new Set(ids).size!==p.slides.length||ids.some(v=>!p.slides.some(x=>x.id===v)))throw error('页面 ID 不匹配');
        p.slides=slides.map((v,i)=>{const old=p.slides.find(x=>x.id===v.id);if(!old)throw error('页面 ID 不匹配');const next={...normalizeSlide({...old,...v},i),image:old.image,imageModel:old.imageModel,imageTask:old.imageTask,revision:old.revision};if(old.imageMode==='full-slide'&&imageFingerprint(next,p.style,c.QWEN_IMAGE_MODEL)!==imageFingerprint(old,p.style,c.QWEN_IMAGE_MODEL)){next.image=null;next.imageTask=null;next.imageModel=null;next.needsImage=true;}if(JSON.stringify(next)!==JSON.stringify(old))next.revision++;return next});
      }
      if((input.style==='light'||input.style==='dark')&&input.style!==p.style){p.style=input.style;p.slides=p.slides.map(v=>v.imageMode==='full-slide'?{...v,pageStyle:p.style,image:null,imageTask:null,imageModel:null,needsImage:true,revision:v.revision+1}:v);}
      if(input.title)p.title=text(input.title,80);p.stage='outline';await store.save(p,{revision:true});return store.publicProject(p);
    }));
    if(tail==='generate'&&req.method==='POST')return transaction(id,s.id,async p=>{
      const input=await body(req);
      if(input.version!==p.version)throw error('页面已更新，请刷新后生成',409);
      const phase=input.phase==='all'?'all':'samples';
      const selected=p.source==='example'?[]:pendingSlides(p,phase);
      if(selected.length&&input.confirm!==true)throw error('请确认生图数量后继续');
      if(selected.length&&!c.BAILIAN_API_KEY)throw error('尚未配置百炼 API Key');
      if(queue.length+active>=(Number(c.MAX_IMAGE_JOBS)||12))throw error('生成队列已满，请稍后再试',429);
      if(!selected.length){p.stage=phase==='all'?'ready':'samples';await store.save(p,{revision:true});return json(res,200,store.publicProject(p))}
      p.job={id:crypto.randomUUID(),status:'queued',phase,total:selected.length,done:0,error:null};await store.save(p);jobLocks.add(id);enqueue(()=>generate(p,phase));return json(res,202,store.publicProject(p));
    });
    if(tail==='export'&&req.method==='POST')return transaction(id,s.id,async p=>{
      const input=await body(req),format=input.format;if(format!=='pdf'&&format!=='pptx')throw error('不支持的文件格式');
      if(input.version!==p.version)throw error('页面已更新，请刷新后导出',409);
      const selected=input.scope==='generated'?{...p,slides:p.slides.filter(s=>s.imageMode!=='full-slide'||s.image)}:p;
      if(!selected.slides.length)throw error('还没有生成完整页面，暂不能导出');
      const filePath=await exportProject(selected,format);return json(res,200,{url:`/api/projects/${id}/exports/${path.basename(filePath)}`,filename:`${p.title}${input.scope==='generated'?`_已生成${selected.slides.length}页`:''}.${format}`});
    });
    if(tail==='history'&&req.method==='GET'){
      const p=await store.read(id,s.id);return json(res,200,{versions:Array.from({length:p.version},(_,i)=>i+1).reverse()});
    }
    if(tail==='restore'&&req.method==='POST')return transaction(id,s.id,async p=>{
      const input=await body(req);if(input.version!==p.version)throw error('页面已更新',409);
      const v=Number(input.restoreVersion);if(!Number.isInteger(v)||v<1||v>p.version)throw error('历史版本不存在');
      const old: Project=JSON.parse(await fs.readFile(path.join(store.dir(id),'history',`${v}.json`),'utf8'));
      p.title=old.title;p.style=old.style;p.slides=old.slides;p.stage='outline';p.job=null;await store.save(p,{revision:true});return json(res,200,store.publicProject(p));
    });
    const slideMatch=tail.match(/^slides\/([a-f0-9-]+)\/(preview|refine|image|regenerate)$/);
    if(slideMatch){const [,slideId,action]=slideMatch;
      if(action==='preview'&&req.method==='GET'){
        const p=await store.read(id,s.id),idx=p.slides.findIndex(v=>v.id===slideId);if(idx<0)throw error('页面不存在',404);
        const slide=p.slides[idx],imageURL=slide.image?`/api/projects/${id}/assets/${slide.image}`:null;
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'self'"});return res.end(previewHTML(slide,p,idx,imageURL));
      }
      if(action==='refine'&&req.method==='POST')return json(res,200,await transaction(id,s.id,async p=>{
        const input=await body(req);if(input.version!==p.version)throw error('页面已更新',409);
        const idx=p.slides.findIndex(v=>v.id===slideId);if(idx<0)throw error('页面不存在',404);
        let result;if(p.source==='example')result=await refineViaQwen({mode:'example',slide:p.slides[idx],instruction:input.instruction});
        else result=await refineViaQwen({topic:p.topic,notes:p.notes,slide:p.slides[idx],instruction:text(input.instruction,2000),mode:'live'});
        const old=p.slides[idx];p.slides[idx]={...normalizeSlide(result),id:old.id,image:old.image,imageModel:old.imageModel,imageTask:null,revision:old.revision+1};
        if(old.imageMode==='full-slide'){p.slides[idx].image=null;p.slides[idx].imageModel=null;p.slides[idx].needsImage=true;}
        p.stage='outline';await store.save(p,{revision:true});return store.publicProject(p);
      }));
      if(action==='image'&&req.method==='POST')return json(res,200,await transaction(id,s.id,async p=>{
        const input=await body(req);if(input.version!==p.version)throw error('页面已更新',409);
        const slide=p.slides.find(v=>v.id===slideId);if(!slide)throw error('页面不存在',404);
        const b64=String(input.data||'').match(/^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);if(!b64)throw error('只接受 PNG、JPEG、WEBP');
        const bytes=Buffer.from(b64[1],'base64');if(bytes.length>10*1024*1024)throw error('图片超过10MB');
        const image=await sharp(bytes,{limitInputPixels:40000000}).rotate().resize(1920,1080,{fit:'cover'}).png().toBuffer();
        const assets=path.join(store.dir(id),'assets');await fs.mkdir(assets,{recursive:true});
        const name=`${slide.id}-${crypto.randomUUID()}.png`;await fs.writeFile(path.join(assets,name),image);
        slide.image=name;slide.imageModel='用户上传';slide.imageTask=null;slide.revision++;p.stage='outline';await store.save(p,{revision:true});return store.publicProject(p);
      }));
      if(action==='regenerate'&&req.method==='POST')return transaction(id,s.id,async p=>{
        const input=await body(req);
        if(input.version!==p.version)throw error('页面已更新',409);if(!input.confirm)throw error('请确认单张图片生成');if(!c.BAILIAN_API_KEY)throw error('尚未配置百炼 API Key');
        if(p.source==='example')throw error('示例项目不会调用模型；请新建真实生成项目');
        if(queue.length+active>=(Number(c.MAX_IMAGE_JOBS)||12))throw error('生成队列已满',429);
        const slide=p.slides.find(v=>v.id===slideId);if(!slide)throw error('页面不存在',404);
        slide.needsImage=true;slide.imageTask=null;const job: ImageJob={id:crypto.randomUUID(),status:'queued',phase:'single',total:1,done:0,error:null};p.job=job;await store.save(p);jobLocks.add(id);
        enqueue(async()=>{try{job.status='running';await store.save(p);const result=await generateImage(slide,p.style,async task=>{slide.imageTask=task;job.current=taskProgress(slide.title,task);await store.save(p)});const assets=path.join(store.dir(id),'assets');await fs.mkdir(assets,{recursive:true});slide.image=`${slide.id}-${crypto.randomUUID()}.png`;await fs.writeFile(path.join(assets,slide.image),result.buffer);slide.imageModel=result.model;slide.revision++;job.status='succeeded';job.done=1;job.current='';await store.save(p,{revision:true})}catch(e){job.status='failed';job.error=safeError(e);await store.save(p)}finally{jobLocks.delete(id)}});return json(res,202,store.publicProject(p));
      });
    }
    const asset=tail.match(/^(assets|exports)\/([a-zA-Z0-9.-]+)$/);
    if(asset&&req.method==='GET'){
      await store.read(id,s.id);const [_,folder,name]=asset;
      if(!/^[a-z0-9-]+\.(png|pdf|pptx)$/.test(name))throw error('文件不存在',404);
      const mime=name.endsWith('.png')?'image/png':name.endsWith('.pdf')?'application/pdf':'application/vnd.openxmlformats-officedocument.presentationml.presentation';
      if(folder==='exports')res.setHeader('Content-Disposition',`attachment; filename="${name}"`);
      return file(res,path.join(store.dir(id),folder,name),mime);
    }
    throw error('接口不存在',404);
  }
  if(req.method==='GET'&&['/','/app.js','/styles.css','/ookoo-logo.png'].includes(pathname)){
    const name=pathname==='/'?'index.html':pathname.slice(1),type=name.endsWith('html')?'text/html; charset=utf-8':name.endsWith('js')?'text/javascript; charset=utf-8':name.endsWith('.png')?'image/png':'text/css; charset=utf-8';
    res.setHeader('Content-Security-Policy',"default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");return file(res,pathname==='/app.js'?path.join(ROOT,'dist/client/public/app.js'):path.join(ROOT,'public',name),type);
  }
  throw error('页面不存在',404);
}
async function start(){await store.startupRecovery();const c=config(),host=c.HOST||'127.0.0.1',port=Number(c.PORT)||3210;
  if(!c.SESSION_SECRET)throw new Error('缺少服务器密钥');
  if(!['127.0.0.1','localhost','::1'].includes(host)&&!c.APP_ACCESS_PASSWORD)throw new Error('多人部署需要设置 APP_ACCESS_PASSWORD 或接入公司登录');
  const server=http.createServer((req,res)=>route(req,res).catch(e=>{if(!res.headersSent)json(res,typeof record(e).status==='number'?Number(record(e).status):400,{error:safeError(e)});else res.end()}));
  server.listen(port,host,()=>console.log(`Launch Studio: http://${host}:${port}`));
  return server;
}
if(require.main===module)start().catch(e=>{console.error(safeError(e));process.exit(1)});
export {start,pendingSlides,equal};
