import type {GeneratedPlan, ImageTask, Slide, Style, Usage, Mode} from '../shared/types';
interface TextResponse { choices?: {message?: {content?: string}}[]; usage?: Usage }
interface ImageResponse {
 request_id?: string; usage?: Usage;
 output?: {task_id?: string; task_status?: string; message?: string; code?: string;
 choices?: {message?: {content?: {image?: string; text?: string}[]}}[]};
}
interface RefineInput { slide: unknown; instruction: unknown; topic?: unknown; notes?: unknown; mode?: Mode }
import crypto from 'node:crypto';
import sharp from 'sharp';
import {config} from './config';
import {SYSTEM,normalizePlan,normalizeSlide,parseJSON,examplePlan,briefPayload,text,record} from './domain';
const pause=(ms: number)=>new Promise(r=>setTimeout(r,ms));
class APIError extends Error {
  constructor(message: string,readonly httpStatus: number,readonly retryAfter: number=0){super(message)}
}
interface RequestPolicy {
  beforeAttempt?: ()=>Promise<void>;
  onRateLimit?: (delay: number)=>Promise<void>;
}
const submissionGates=new Map<string,{tail: Promise<void>; last: number}>();
async function paceSubmission(model: string,before: ()=>Promise<void>) {
  let gate=submissionGates.get(model);
  if(!gate){gate={tail:Promise.resolve(),last:-Infinity};submissionGates.set(model,gate)}
  const current=gate,c=config(),configured=Number(c.IMAGE_MIN_INTERVAL_MS);
  const interval=c.IMAGE_MIN_INTERVAL_MS?.trim()&&Number.isFinite(configured)&&configured>=0?configured:model==='qwen-image-3.0-pro'?13000:4000;
  const turn=current.tail.then(async()=>{
    const delay=interval>0?current.last+interval-Date.now():0;if(delay>0)await pause(delay);
    await before();current.last=Date.now();
  });
  current.tail=turn.catch(()=>{});await turn;
}
async function networkRequest<T>(stage: string,retry: boolean,run: ()=>Promise<T>): Promise<T> {
  for(let attempt=0;;attempt++) {
    try{return await run()}catch(e){
      const err=record(e),cause=record(err.cause);
      const network=e instanceof TypeError&&e.message==='fetch failed'||['TimeoutError','AbortError'].includes(String(err.name));
      if(!network)throw e;
      if(retry&&attempt<2){await pause(500*(attempt+1));continue;}
      const code=typeof cause.code==='string'&&/^[A-Z0-9_]+$/.test(cause.code)?`（${cause.code}）`:'';
      throw new Error(`${stage}网络请求失败${code}。${retry?'已尝试 3 次；已受理任务会保留，继续生成可复用任务。':'提交结果可能未知，请先确认任务记录，避免重复计费。'}`);
    }
  }
}
async function requestJSON<T>(url: string,options: RequestInit={},timeout=180000,policy: RequestPolicy={}): Promise<T> {
  const retry=(options.method||'GET')==='GET';
  const stage=url.includes('/tasks/')?'查询图片任务':url.endsWith('/generation')?'提交图片生成':'调用文本模型';
  for(let attempt=0;;attempt++) {
  await policy.beforeAttempt?.();
  const {res,str}=await networkRequest(stage,retry,async()=>{const res=await fetch(url,{...options,signal:AbortSignal.timeout(timeout)});return {res,str:await res.text()}});
  let parsed: unknown;
  try{parsed=JSON.parse(str)}catch{if(res.status!==429)throw new Error(`接口返回非 JSON（HTTP ${res.status}）`)}
  const obj=record(parsed);
  // 即使异常响应携带了任务 ID，也按已受理处理，禁止再次提交生图。
  if(res.status===429&&url.endsWith('/generation')&&record(obj.output).task_id)return obj as T;
  if(res.status===429) {
    const header=res.headers.get('retry-after'),seconds=header===null?NaN:Number(header);
    const retryAfter=header===null?0:Number.isFinite(seconds)?Math.max(0,seconds*1000):Math.max(0,Date.parse(header)-Date.now())||0;
    const delay=Math.max(15000*2**attempt,retryAfter);
    const retryAllowed=attempt<3&&delay<=120000;
    await policy.onRateLimit?.(retryAllowed?delay:0);
    if(retryAllowed){await pause(delay);continue;}
    throw new APIError(`${stage}被百炼限流（HTTP 429）。${attempt?'等待重试后仍未恢复。':''}请稍后点击“继续生成”；已完成页面和已受理任务会保留。`,429,retryAfter);
  }
  if(!res.ok||obj.code||obj.error) throw new APIError(`接口调用失败（HTTP ${res.status}）：${text(obj.message||record(obj.error).message||obj.code||'未知错误',250)}`,res.status);
  return obj as T;
  }
}
async function qwenText(system: string,user: string) {
  const c=config();if(!c.BAILIAN_API_KEY)throw new Error('尚未配置百炼 API Key，请在本地 .env 中填写');
  if(c.QWEN_TEXT_MODEL!=='qwen3.8-max')throw new Error('文本模型应配置为 qwen3.8-max');
  const response=await requestJSON<TextResponse>(`${c.BAILIAN_TEXT_BASE_URL.replace(/\/$/,'')}/chat/completions`,{
    method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${c.BAILIAN_API_KEY}`},
    body:JSON.stringify({model:c.QWEN_TEXT_MODEL,messages:[{role:'system',content:system},{role:'user',content:user}],temperature:.5,max_tokens:12000,response_format:{type:'json_object'},enable_thinking:false})
  },240000);
  return {value:parseJSON(response.choices?.[0]?.message?.content),usage:response.usage,model:c.QWEN_TEXT_MODEL};
}
async function planViaQwen(value: unknown): Promise<GeneratedPlan> {
  const input=record(value);
  const brief=briefPayload(input);
  if(input.mode==='example')return {...examplePlan(brief),source:'example',textModel:null};
  const result=await qwenText(SYSTEM,JSON.stringify({主题:brief.topic,补充说明:brief.notes,页数:brief.pages,逐页内容:(brief.pageContents||[]).map((content,i)=>({page:i+1,content})).filter(v=>v.content),视觉方向:brief.style==='light'?'纯白极简新品发布会，黑字、银灰、电光蓝，偶有黑底反差页':'纯黑科技新品发布会，白字、银灰、电光蓝，偶有白底反差页',要求:'页数严格一致。逐页内容按 page 放在对应页，不合并、不调换；只自动补全未指定页。生成具体内容和整页构图；不用模板化装饰。'}));
  const plan=normalizePlan(result.value,brief.pages);
  plan.slides=plan.slides.map(s=>({...s,imageMode:'full-slide',needsImage:true}));
  return {...plan,source:'qwen',textModel:result.model,usage:result.usage};
}
async function refineViaQwen(input: RefineInput): Promise<Slide> {
  const old=normalizeSlide(input.slide),instruction=text(input.instruction,2000);
  if(!instruction)throw new Error('请输入修改要求');
  if(input.mode==='example') {
    let title=old.title,layout=old.layout;
    const rename=instruction.match(/(?:标题改为|标题改成|标题：|标题:)[“"']?([^”"'\n]+)/);
    if(rename)title=rename[1].trim();
    if(/数字|指标/.test(instruction))layout='metrics';
    if(/卡片|三点/.test(instruction))layout='cards';
    return {...old,title,layout,notes:`示例修改（未调用模型）：${instruction}`,revision:old.revision+1};
  }
  const result=await qwenText(`${SYSTEM}\n本次只修改一个页面。仅返回单个页面 JSON 对象，不要返回 slides 数组。保留用户没有要求修改的事实和数据。`,JSON.stringify({主题:input.topic,补充说明:input.notes,原页面:old,修改要求:instruction}));
  const s=normalizeSlide(result.value);
  return {...s,imageMode:old.imageMode,pageStyle:s.pageStyle||old.pageStyle,id:old.id,image:old.image,imageModel:old.imageModel,imageTask:null,revision:old.revision+1};
}
function buildImagePrompt(slide: Slide,style: Style) {
  if(slide.imageMode!=='full-slide')return `${slide.imagePrompt}\n${style==='light'?'白底简洁发布会，暖白与金属灰':'暗色科技发布会，石墨黑与暖白光影'}。16:9，主视觉在右侧，左侧留白，不包含文字、数字或Logo。`;
  const tone=slide.pageStyle||style;
  // 移除引用了禁止词的否定分句，避免生图模型把它们也画在图中。
  const visual=slide.imagePrompt.replace(/(?:绝不|禁止|不得|不要|不出现|不包含|不含)[^。！？；;\n]*[「“"][^。！？；;\n]*(?:[。！？；;\n]|$)/g,'');
  // 兼容旧项目把明确的品牌文案写在构图中的情况。
  const brand=slide.brand||visual.match(/品牌(?:文字|名称|标识)?[^「“"\n。]{0,16}[「“"]([^」”"\n]{1,50})[」”"]/u)?.[1]||'';
  const copy=[...new Set([slide.kicker,slide.title,slide.subtitle,brand,...slide.bullets.flatMap(b=>[b.title,b.body]),...slide.metrics.flatMap(m=>[m.value,m.label,m.note])].filter(Boolean))];
  return `生成一张已经设计完成、可以直接放映的新品发布会幻灯片，1920×1080，16:9。画面本身同时包含精确中文排版和主体视觉；不要留给程序叠字的空白，不要画PPT软件界面或演讲会场。
视觉语言：大型消费电子新品发布会的简洁与摄影质感。${tone==='light'?'纯白或极浅银灰背景，黑色中文，克制电光蓝点缀':'深黑背景，大面积纯净暗部，明亮白色中文，银灰与克制电光蓝点缀'}。采用现代中文无衬线粗体，标题有压倒性的层级，其余已指定文字小而清楚；不要棕金商务模板、无关圆环或通用卡片背景。品牌文字仅按下方文案清单绘制，其余区域保持无字，产品机身表面也保持干净。与主题有关的主体占画面50%以上。全文四周至少5%安全边距，不裁字，不挤压文字。
本页构图与视觉：${visual}
页面类型：${slide.layout}。本页只有以下 ${copy.length} 条可见文案，每条只出现一次。逐字绘制，标点和英文拼写也严格保持；按构图设计分行与大小。未列出的副标题、结束语和其他文字一律省略，不将指令或引号印在画面上：
${copy.map(v=>`「${v}」`).join('\n')}
只输出完整的一张幻灯片图像。讲稿不印在画面上。`;
}
function imageFingerprint(slide: Slide,style: Style,model: string) {return crypto.createHash('sha256').update(slide.imageMode==='full-slide'?JSON.stringify(['full-slide-v1',buildImagePrompt(slide,style),model]):JSON.stringify([slide.imagePrompt,style,model])).digest('hex')}
async function generateImage(slide: Slide,style: Style,persistTask: (task: ImageTask) => Promise<unknown>) {
  const c=config();if(!c.BAILIAN_API_KEY)throw new Error('尚未配置百炼 API Key');
  if(!/^qwen-image-(?:3\.0(?:-pro)?|2\.1-(?:pro|turbo))$/.test(c.QWEN_IMAGE_MODEL))throw new Error('图片模型必须是当前百炼 Qwen 图片模型，请核实型号');
  const base=c.BAILIAN_API_BASE_URL.replace(/\/$/,''),fingerprint=imageFingerprint(slide,style,c.QWEN_IMAGE_MODEL);
  let task=slide.imageTask;
  if(task?.fingerprint!==fingerprint)task=null;
  if(task?.status==='submission_unknown')throw new Error('上次图片提交结果未知。请先在百炼确认任务，避免重复计费；确认后重新生成');
  if(task?.taskId && ['FAILED','CANCELED','UNKNOWN'].includes(task.status))throw new Error('上次任务已终止。请明确选择“重新生成图片”以发起新任务');
  if(!task?.taskId) {
    const content: ({text: string} | {image: string})[]=[{text:buildImagePrompt(slide,style)}];
    if(slide.imageReference)content.unshift({image:slide.imageReference});
    task={fingerprint,model:c.QWEN_IMAGE_MODEL,status:'waiting',createdAt:new Date().toISOString()};await persistTask(task);
    const response: ImageResponse=await requestJSON<ImageResponse>(`${base}/services/aigc/image-generation/generation`,{
      method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${c.BAILIAN_API_KEY}`,'X-DashScope-Async':'enable'},
      body:JSON.stringify({model:c.QWEN_IMAGE_MODEL,input:{messages:[{role:'user',content}]},parameters:{n:1,size:'1920*1080',prompt_extend:slide.imageMode!=='full-slide',watermark:false}})
    },60000,{
      beforeAttempt:()=>paceSubmission(c.QWEN_IMAGE_MODEL,async()=>{
        task={...task!,status:'submission_unknown',retryAt:undefined};await persistTask(task);
      }),
      onRateLimit:async delay=>{
        task={...task!,status:'rate_limited',retryAt:delay?new Date(Date.now()+delay).toISOString():undefined};await persistTask(task);
      }
    });
    if(!response.output?.task_id)throw new Error('百炼未返回图片任务 ID；请检查任务记录后再重试');
    task={...task,taskId:response.output.task_id,status:response.output.task_status || 'UNKNOWN',requestId:response.request_id,retryAt:undefined};await persistTask(task);
  }
  const taskId=task.taskId;if(!taskId)throw new Error('图片任务缺少受理 ID');
  const deadline=Date.now()+900000;
  while(Date.now()<deadline) {
    const response: ImageResponse=await requestJSON<ImageResponse>(`${base}/tasks/${encodeURIComponent(taskId)}`,{headers:{Authorization:`Bearer ${c.BAILIAN_API_KEY}`}},60000,{
      onRateLimit:async delay=>{task={...task!,status:'rate_limited',retryAt:delay?new Date(Date.now()+delay).toISOString():undefined};await persistTask(task)}
    });
    const out: ImageResponse['output']=response.output;task={...task,status:out?.task_status || 'UNKNOWN',requestId:response.request_id,retryAt:undefined};await persistTask(task);
    if(out?.task_status==='SUCCEEDED') {
      const url=out.choices?.flatMap(v=>v.message?.content||[]).find(v=>v.image)?.image;
      if(!url)throw new Error('图片任务成功但未返回图片 URL');
      const remote=new URL(url);
      if(remote.protocol!=='https:'||!remote.hostname.endsWith('.aliyuncs.com'))throw new Error('图片结果地址不属于阿里云，已停止下载');
      const bytes=await networkRequest('下载已生成图片',true,async()=>{
        const res=await fetch(url,{signal:AbortSignal.timeout(60000),redirect:'error'});
        if(!res.ok)throw new Error(`下载图片失败（HTTP ${res.status}）`);
        return Buffer.from(await res.arrayBuffer());
      });if(bytes.length>25*1024*1024)throw new Error('图片超过 25MB');
      return {buffer:await sharp(bytes,{limitInputPixels:40000000}).rotate().resize(1920,1080,{fit:'cover'}).png().toBuffer(),model:c.QWEN_IMAGE_MODEL,usage:response.usage,task};
    }
    if(out && ['FAILED','CANCELED','UNKNOWN'].includes(out.task_status || ''))throw new Error(`图片任务${out.task_status}：${text(out.message||out.code||'请查看百炼记录',200)}`);
    await pause(5000);
  }
  throw new Error('图片任务仍未完成。任务 ID 已保存，重试会继续查询同一任务');
}
export {requestJSON,qwenText,planViaQwen,refineViaQwen,generateImage,imageFingerprint,buildImagePrompt};
