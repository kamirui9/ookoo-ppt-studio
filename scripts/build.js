// 只编译 TypeScript，不读取项目密钥或数据。
const fs = require('node:fs');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const packageFile = require.resolve('typescript/package.json');
const compiler = path.join(path.dirname(packageFile), require(packageFile).bin.tsc);
fs.rmSync(path.join(root,'dist'), {recursive:true,force:true});
for (const config of ['tsconfig.json','tsconfig.client.json']) {
 const result = spawnSync(process.execPath,[compiler,'--project',config],{cwd:root,stdio:'inherit'});
 if(result.error){console.error(result.error.message);process.exit(1)}
 if(result.status!==0)process.exit(result.status || 1);
}
