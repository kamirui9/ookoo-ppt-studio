import type {Project, PublicProject, ProjectSummary} from '../shared/types';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {DATA} from './config';
import {text} from './domain';
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const dir=(id: string)=>{if(!UUID.test(id))throw Object.assign(new Error('项目不存在'),{status:404});return path.join(DATA,'projects',id)};
async function save(p: Project,{revision=false}: {revision?: boolean}={}) {
  const root=dir(p.id);await fs.mkdir(root,{recursive:true,mode:0o700});
  p.updatedAt=new Date().toISOString();
  if(revision){p.version=(p.version||0)+1;await fs.mkdir(path.join(root,'history'),{recursive:true});await fs.writeFile(path.join(root,'history',`${p.version}.json`),JSON.stringify(p,null,2),{mode:0o600})}
  const tmp=path.join(root,`project-${crypto.randomUUID()}.tmp`);
  await fs.writeFile(tmp,JSON.stringify(p,null,2),{mode:0o600});await fs.rename(tmp,path.join(root,'project.json'));return p;
}
async function read(id: string,owner: string): Promise<Project> {
  let p: Project;try{p=JSON.parse(await fs.readFile(path.join(dir(id),'project.json'),'utf8'))}catch{throw Object.assign(new Error('项目不存在'),{status:404})}
  if(p.owner!==owner)throw Object.assign(new Error('项目不存在'),{status:404});return p;
}
function publicProject(p: Project): PublicProject{const {owner,...result}=p;return result}
async function list(owner: string): Promise<ProjectSummary[]> {
  await fs.mkdir(path.join(DATA,'projects'),{recursive:true});const dirs=await fs.readdir(path.join(DATA,'projects'));
  const all=await Promise.all(dirs.filter(id=>UUID.test(id)).map(async id=>{try{return await read(id,owner)}catch{return null}}));
  return all.filter((p): p is Project => p !== null).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).map(p=>({id:p.id,title:text(p.title,80),source:p.source,stage:p.stage,style:p.style,pages:p.slides.length,version:p.version,updatedAt:p.updatedAt}));
}
async function startupRecovery() {
  const root=path.join(DATA,'projects');await fs.mkdir(root,{recursive:true});
  for(const id of await fs.readdir(root))if(UUID.test(id)){try{const p: Project=JSON.parse(await fs.readFile(path.join(dir(id),'project.json'),'utf8'));if(p.job&&['queued','running'].includes(p.job.status)){p.job.status='interrupted';p.job.error='服务重新启动。已受理的图片任务 ID 已保存；再次生成会继续查询。';await save(p)}}catch{}}
}
export {UUID,dir,save,read,list,publicProject,startupRecovery};
