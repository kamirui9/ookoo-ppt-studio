// 单元与接口测试使用临时配置及模拟模型，不读取真实 .env。
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'launch-tests-'));const envFile=path.join(dir,'.env');
try{
 fs.writeFileSync(envFile,fs.readFileSync(path.join(root,'.env.example'),'utf8').replace(/^SESSION_SECRET=$/m,'SESSION_SECRET=test-only-session-secret'),{mode:0o600});
 const tests=fs.readdirSync(path.join(root,'tests')).filter(x=>x.endsWith('.test.js')).map(x=>path.join('tests',x));
 const result=spawnSync(process.execPath,['--test',...tests],{cwd:root,stdio:'inherit',env:{...process.env,IMAGE_MIN_INTERVAL_MS:'0',LAUNCH_ENV_FILE:envFile,LAUNCH_DATA_DIR:path.join(dir,'data')}});
 if(result.error)throw result.error;process.exitCode=result.status || 0;
}finally{fs.rmSync(dir,{recursive:true,force:true});}
