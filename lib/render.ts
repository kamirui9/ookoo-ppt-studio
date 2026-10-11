import type {Slide, Style, Layout, PublicProject, ExportFormat} from '../shared/types';
interface Box {x:number; y:number; w:number; h:number; color:string}
interface TextOptions {bold?:boolean; align?:'left'|'center'|'right'; tracking?:number}
interface RectOptions {radius?:number; opacity?:number}
type SceneElement = (Box & TextOptions & {type:'text'; value:string; size:number}) | (Box & RectOptions & {type:'rect'});
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import PptxGenJS from 'pptxgenjs';
import { chromium, type Browser } from 'playwright';
import { config, DATA } from './config';
const W = 1920, H = 1080, SCALE = 144;
function esc(s: unknown) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] || c)); }
function fit(s: string, max: number, width: number) {
  const len = [...s].reduce((n, c) => n + (/[\u2e80-\uffff]/.test(c) ? 1 : .55), 0);
  return Math.max(38, Math.min(max, width / Math.max(len, 1)));
}
function palette(style: Style) { return style === 'light' ? { bg: 'F5F3EE', fg: '191B1E', muted: '696D72', accent: 'AA612D', panel: 'E9E6DF', border: 'D7D3CC' } : { bg: '0C1015', fg: 'F5F3EE', muted: 'A9AFB8', accent: 'E9B079', panel: '151B22', border: '333A43' }; }
function backgroundSVG(style: Style, layout: Layout) {
  const light = style === 'light';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080"><defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${light ? '#f9f7f2' : '#090d12'}"/><stop offset="1" stop-color="${light ? '#e2e4e5' : '#19212b'}"/></linearGradient>
    <radialGradient id="glow"><stop stop-color="${light ? '#ffffff' : '#63757f'}" stop-opacity=".55"/><stop offset="1" stop-color="${light ? '#ffffff' : '#19212b'}" stop-opacity="0"/></radialGradient>
    <linearGradient id="metal" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${light ? '#7f8990' : '#3a4652'}"/><stop offset=".26" stop-color="${light ? '#ffffff' : '#d8e0df'}"/><stop offset=".43" stop-color="${light ? '#c6ced1' : '#536472'}"/><stop offset=".7" stop-color="${light ? '#ffffff' : '#18232e'}"/><stop offset="1" stop-color="${light ? '#adb7bc' : '#9eafb8'}"/></linearGradient>
    <filter id="blur"><feGaussianBlur stdDeviation="35"/></filter>
  </defs><rect width="1920" height="1080" fill="url(#bg)"/><ellipse cx="1530" cy="650" rx="800" ry="720" fill="url(#glow)"/>
  ${['hero','closing','statement'].includes(layout) ? `<ellipse cx="1465" cy="925" rx="380" ry="36" fill="${light ? '#48525b' : '#000'}" opacity=".32" filter="url(#blur)"/><g transform="translate(1485 515) rotate(-24)"><ellipse rx="335" ry="410" fill="none" stroke="url(#metal)" stroke-width="96"/><ellipse rx="280" ry="355" fill="none" stroke="${light ? '#fff' : '#c6d3da'}" stroke-width="2" opacity=".55"/><ellipse rx="397" ry="143" fill="none" stroke="${light ? '#9a7d63' : '#e9b079'}" stroke-width="3" opacity=".72"/></g><path d="M920 970L1920 840" stroke="${light ? '#aba9a4' : '#8b98a1'}" opacity=".15"/>` : `<path d="M1400 0L1920 520M1530 0L1920 390" stroke="${light ? '#c6c9cd' : '#45535f'}" opacity=".2"/>`}
  </svg>`;
}
function scene(slide: Slide, style: Style, index: number, count: number) {
  const p = palette(style), elements: SceneElement[] = [];
  const t = (value: string, x: number, y: number, w: number, h: number, size: number, color = p.fg, options: TextOptions = {}) => elements.push({ type: 'text', value, x, y, w, h, size, color, ...options });
  const r = (x:number,y:number,w:number,h:number,color:string,options:RectOptions={}) => elements.push({ type:'rect', x,y,w,h,color,...options });
  const hero = ['hero','closing'].includes(slide.layout);
  t(slide.kicker, 104, hero ? 125 : 100, 1300, 48, 26, p.accent, { tracking: 5 });
  if (hero) {
    const size = fit(slide.title, 122, 1070);
    t(slide.title,104,285,1120,315,size,p.fg,{bold:true});
    t(slide.subtitle,110,640,980,170,39,p.muted);
    r(110,875,120,5,p.accent);
    t('LAUNCH / YOUR NEXT CHAPTER',110,913,800,42,22,p.muted,{tracking:3});
  } else {
    t(slide.title,104,190,1700,145,fit(slide.title,83,1670),p.fg,{bold:true});
    if (slide.subtitle) t(slide.subtitle,110,350,1540,115,34,p.muted);
    const top = slide.subtitle ? 530 : 440;
    if (slide.layout === 'metrics') {
      const metrics = slide.metrics.length ? slide.metrics : [{value:'待补充',label:'核心指标',note:'补充真实数据'}];
      const width = 1650 / metrics.length;
      metrics.forEach((m,i) => {
        const x = 110 + i * width;
        if (i) r(x-28,top+20,2,300,p.border);
        t(m.value,x,top,width-65,165,fit(m.value,132,width-70),p.accent,{bold:true});
        t(m.label,x,top+188,width-65,70,35,p.fg);
        t(m.note,x,top+275,width-65,105,26,p.muted);
      });
    } else if (['cards','comparison','timeline'].includes(slide.layout)) {
      const bs = slide.bullets.length ? slide.bullets : [{title:'核心观点',body:slide.subtitle}];
      const width = 1700 / bs.length;
      bs.forEach((b,i) => {
        const x = 110 + i*width;
        r(x,top,width-24,370,p.panel,{radius:10,opacity:slide.image ? .87 : 1});
        t(String(i+1).padStart(2,'0'),x+32,top+30,width-90,58,31,p.accent);
        t(b.title,x+32,top+130,width-90,110,fit(b.title,43,width-90),p.fg,{bold:true});
        t(b.body,x+32,top+248,width-90,95,27,p.muted);
      });
    } else {
      const bs = slide.bullets.slice(0,3);
      bs.forEach((b,i) => { const y=top+i*135; r(110,y+15,4,46,p.accent); t(b.title,140,y,940,60,38,p.fg,{bold:true}); t(b.body,140,y+67,900,70,27,p.muted); });
      if (!bs.length) { r(110,top+30,130,5,p.accent); }
    }
  }
  t('LAUNCH STUDIO',110,1010,850,35,20,p.muted,{tracking:3});
  t(`${String(index+1).padStart(2,'0')} / ${String(count).padStart(2,'0')}`,1640,1010,170,35,20,p.muted,{align:'right'});
  return { palette:p, elements, background:backgroundSVG(style,slide.layout) };
}
function elementsHTML(elements: SceneElement[]) {
  return elements.map(e => e.type === 'rect' ? `<div style="position:absolute;left:${e.x}px;top:${e.y}px;width:${e.w}px;height:${e.h}px;background:#${e.color};border-radius:${e.radius||0}px;opacity:${e.opacity||1}"></div>` : `<div class="text" style="left:${e.x}px;top:${e.y}px;width:${e.w}px;height:${e.h}px;font-size:${e.size}px;color:#${e.color};font-weight:${e.bold?700:400};text-align:${e.align||'left'};letter-spacing:${e.tracking||0}px">${esc(e.value)}</div>`).join('');
}
function slideMarkup(slide: Slide, style: Style, index: number, count: number, imageURL?: string | null) {
  if(slide.imageMode==='full-slide') {
    if(imageURL)return `<div class="slide" data-slide="${esc(slide.id)}"><img class="backdrop full-slide" alt="${esc(slide.title)}" src="${esc(imageURL)}"/></div>`;
    return `<div class="slide outline" data-slide="${esc(slide.id)}"><div class="outline-label">大纲草稿 · 尚未生成整页图片</div><h1>${esc(slide.title)}</h1><p>${esc(slide.subtitle)}</p><div class="outline-points">${slide.bullets.map(b=>`<div><strong>${esc(b.title)}</strong><span>${esc(b.body)}</span></div>`).join('')}${slide.metrics.map(m=>`<div><strong>${esc(m.value)} ${esc(m.label)}</strong><span>${esc(m.note)}</span></div>`).join('')}</div><div class="outline-foot">确认文案后生成代表页，最终设计以生成图片为准</div></div>`;
  }
  const s=scene(slide,style,index,count);
  const bg = imageURL ? `<img class="backdrop" src="${esc(imageURL)}"/><div class="shade ${style}"></div>` : `<div class="backdrop">${s.background}</div>`;
  return `<div class="slide" data-slide="${esc(slide.id)}">${bg}${elementsHTML(s.elements)}</div>`;
}
const CSS = `*{box-sizing:border-box}body{margin:0;background:#0c1015;font-family:"PingFang SC","Noto Sans CJK SC","Microsoft YaHei",sans-serif}.slide{position:relative;width:1920px;height:1080px;overflow:hidden;flex-shrink:0}.backdrop{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}.full-slide{object-fit:contain;background:#000}.outline{background:#111418;color:#f5f5f5;padding:100px 120px}.outline-label{font-size:28px;color:#9ea5b1;margin-bottom:90px;letter-spacing:3px}.outline h1{font-size:86px;line-height:1.15;max-width:1600px;margin:0 0 55px}.outline p{font-size:40px;color:#b2b8c2;margin:0 0 70px}.outline-points{display:flex;gap:70px}.outline-points>div{flex:1;border-top:2px solid #3c424b;padding-top:40px}.outline-points strong{display:block;font-size:42px;margin-bottom:24px}.outline-points span{font-size:28px;color:#b2b8c2}.outline-foot{position:absolute;bottom:90px;font-size:28px;color:#8d96a3}.text{position:absolute;line-height:1.16;white-space:pre-wrap;overflow:hidden;overflow-wrap:anywhere}.shade{position:absolute;inset:0;background:linear-gradient(90deg,rgba(6,10,15,.93),rgba(6,10,15,.67) 40%,rgba(6,10,15,.08) 80%)}.shade.light{background:linear-gradient(90deg,rgba(249,247,242,.97),rgba(249,247,242,.77) 44%,rgba(249,247,242,.06) 85%)}@page{size:1920px 1080px;margin:0}@media print{body{background:white}.slide{break-after:page}.slide:last-child{break-after:auto}}`;
function previewHTML(slide: Slide,project: PublicProject,index: number,imageURL?: string | null) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${CSS}html,body{width:100%;height:100%;overflow:hidden}.slide{transform-origin:top left}</style></head><body>${slideMarkup(slide,project.style,index,project.slides.length,imageURL)}<script>const fit=()=>{const s=Math.min(innerWidth/1920,innerHeight/1080);document.querySelector('.slide').style.transform='scale('+s+')'};addEventListener('resize',fit);fit()</script></body></html>`;
}
let browserPromise: Promise<Browser> | null = null;
async function getBrowser() {
  if (!browserPromise) {
    const cfg=config();
    const executablePath=cfg.CHROMIUM_EXECUTABLE || (require('node:fs').existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
    browserPromise=chromium.launch({headless:true,executablePath,args:['--no-sandbox']}).catch(e=>{browserPromise=null;throw e});
  }
  return browserPromise;
}
async function exportProject(project: PublicProject,format: ExportFormat) {
  if(project.slides.some(s=>s.imageMode==='full-slide'&&!s.image))throw new Error('整页图片尚未完成。请先生成，或导出已生成页');
  const dir=path.join(DATA,'projects',project.id,'exports');await fs.mkdir(dir,{recursive:true});
  const suffix=`${project.version}-${Date.now()}`,file=path.join(dir,`deck-${suffix}.${format}`);
  const assets=path.join(DATA,'projects',project.id,'assets');
  if(format==='pdf') {
    const pages=[];
    for(let i=0;i<project.slides.length;i++) {
      const s=project.slides[i];let imageURL;
      if(s.image) imageURL=`data:image/png;base64,${(await fs.readFile(path.join(assets,s.image))).toString('base64')}`;
      pages.push(slideMarkup(s,project.style,i,project.slides.length,imageURL));
    }
    const browser=await getBrowser();const page=await browser.newPage({viewport:{width:1920,height:1080}});
    try {await page.setContent(`<!doctype html><meta charset="utf-8"><style>${CSS}</style>${pages.join('')}`,{waitUntil:'load'});await page.evaluate(()=>document.fonts.ready);await page.pdf({path:file,preferCSSPageSize:true,printBackground:true});}finally{await page.close()}
  } else {
    const pptx=new PptxGenJS();pptx.layout='LAYOUT_WIDE';pptx.author='Launch Studio';pptx.subject=project.source==='example'?'明确标注的本地示例，未调用模型':'百炼 Qwen 发布会风格演示';pptx.title=project.title;
    const font=config().PPT_FONT || 'Arial Unicode MS';pptx.theme={headFontFace:font,bodyFontFace:font};
    for(let i=0;i<project.slides.length;i++) {
      const src=project.slides[i],s=scene(src,project.style,i,project.slides.length),slide=pptx.addSlide();
      if(src.imageMode==='full-slide'&&src.image) {
        slide.addImage({path:path.join(assets,src.image),x:0,y:0,w:13.333333,h:7.5});
        slide.addNotes(`${src.notes}\n整页图片；文字不单独可编辑。\n图片模型：${src.imageModel||'用户上传'}`);
        continue;
      }
      let bg;
      if(src.image) {
        const image=await sharp(path.join(assets,src.image)).resize(W,H,{fit:'cover'}).png().toBuffer();
        const shade=Buffer.from(`<svg width="1920" height="1080" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"><stop stop-color="${project.style==='light'?'#f9f7f2':'#060a0f'}" stop-opacity=".96"/><stop offset=".44" stop-color="${project.style==='light'?'#f9f7f2':'#060a0f'}" stop-opacity=".73"/><stop offset="1" stop-color="${project.style==='light'?'#f9f7f2':'#060a0f'}" stop-opacity=".08"/></linearGradient></defs><rect width="1920" height="1080" fill="url(#g)"/></svg>`);
        bg=await sharp(image).composite([{input:shade}]).png().toBuffer();
      } else bg=await sharp(Buffer.from(s.background)).png().toBuffer();
      slide.addImage({data:`image/png;base64,${bg.toString('base64')}`,x:0,y:0,w:13.333333,h:7.5});
      for(const e of s.elements) {
        const box={x:e.x/SCALE,y:e.y/SCALE,w:e.w/SCALE,h:e.h/SCALE};
        if(e.type==='rect') slide.addShape(pptx.ShapeType.rect,{...box,line:{color:e.color,transparency:100},fill:{color:e.color,transparency:Math.round((1-(e.opacity||1))*100)}});
        else slide.addText(e.value,{...box,fontFace:font,lang:'zh-CN',fontSize:e.size/2,color:e.color,bold:!!e.bold,align:e.align||'left',valign:'top',margin:0,breakLine:false,paraSpaceAfter:0,lineSpacingMultiple:1.16,charSpacing:e.tracking?e.tracking/2:0,fit:'shrink'});
      }
      slide.addNotes(`${src.notes}\n${project.source==='example'?'本地示例，未调用模型。':''}\n文本模型：${project.textModel||'未调用'}；图片模型：${src.imageModel||'未调用'}`);
    }
    await pptx.writeFile({fileName:file});
  }
  return file;
}
async function closeRenderer(){if(browserPromise){const browser=await browserPromise;browserPromise=null;await browser.close()}}
export {esc,scene,slideMarkup,previewHTML,exportProject,backgroundSVG,closeRenderer};
