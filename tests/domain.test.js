const test=require('node:test');const assert=require('node:assert/strict');
const {briefPayload,normalizePlan,examplePlan}=require('../dist/lib/domain');
const {esc,scene}=require('../dist/lib/render');const {safeError,config}=require('../dist/lib/config');
test('限制页数且模型页数不匹配时明确失败',()=>{assert.throws(()=>briefPayload({topic:'测试',pages:21}));assert.throws(()=>normalizePlan({slides:[]},8));assert.equal(examplePlan(briefPayload({topic:'测试'})).slides.length,5)});
test('自选页数与独立逐页内容校验，补充说明不提取页码',()=>{
 for(const pages of [1,3,7,20])assert.equal(briefPayload({topic:'测试',pages}).pages,pages);
 for(const pages of [0,-1,21,2.5,'abc'])assert.throws(()=>briefPayload({topic:'测试',pages}),/1～20/);
 const brief=briefPayload({topic:'测试',pages:3,notes:'第4页只是材料中的页码，不是页面安排',pageContents:[' 封面，保留原文 ', '', '总结\n下一步行动']});
 assert.equal(brief.notes,'第4页只是材料中的页码，不是页面安排');
 assert.deepEqual(brief.pageContents,['封面，保留原文','','总结\n下一步行动']);
 assert.deepEqual(briefPayload({topic:'测试',pages:3}).pageContents,['','','']);
 assert.deepEqual(briefPayload({topic:'测试',pages:3,pageContents:['封面']}).pageContents,['封面','','']);
 assert.throws(()=>briefPayload({topic:'测试',pages:2,pageContents:['一','二','三']}),/不能超过所选页数/);
 for(const pageContents of ['封面',[null],[{}],['a'.repeat(2001)]])assert.throws(()=>briefPayload({topic:'测试',pages:3,pageContents}));
});
test('渲染转义文本，元素保持在16:9画布内',()=>{assert.equal(esc('<script>"'), '&lt;script&gt;&quot;');for(const style of ['dark','light']){const p=examplePlan({topic:'企业AI知识助手发布',pages:8});p.slides.forEach((s,i)=>{for(const e of scene(s,style,i,8).elements){assert.ok(e.x>=0&&e.y>=0&&e.x+e.w<=1920&&e.y+e.h<=1080,JSON.stringify(e))}})}});
test('错误信息隐藏配置密钥',()=>{assert.ok(!safeError(new Error('Bearer sk-testsecret')).includes('sk-testsecret'));const token=config().SESSION_SECRET;assert.ok(!safeError(new Error(token)).includes(token))});
test('模型不能指定文件路径或伪造既有图片任务',()=>{const p=normalizePlan({title:'测试',slides:[{title:'页面',image:'../../.env',imageTask:{taskId:'forged'},imageModel:'forged'}]},1);assert.equal(p.slides[0].image,null);assert.equal(p.slides[0].imageTask,null);assert.equal(p.slides[0].imageModel,null)});
