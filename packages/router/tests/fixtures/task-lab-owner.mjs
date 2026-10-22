import {writeFileSync,existsSync} from 'node:fs';
import {loadConfig} from '../../dist/config/load.js';
import {openDatabase} from '../../dist/storage/db.js';
import {ProjectRegistry} from '../../dist/projects/registry.js';
import {LabManager} from '../../dist/labs/lab.js';
import {TaskLabLifecycle} from '../../dist/labs/task-attempt.js';
const [config,mode,barrierPath]=process.argv.slice(2);
const cfg=loadConfig(config),db=openDatabase(cfg.storageDir),registry=new ProjectRegistry(cfg);
const manager=new LabManager({db,cfg,storageDir:cfg.storageDir,project:s=>registry.require(s),monitor:false});
const lifecycle=new TaskLabLifecycle(manager,async(phase,row)=>{
  if(row.kind!=='check'||phase!==mode)return;
  if(phase==='granted'){
    const lab=manager.store.byId(row.lab_id),marker=lab.root+'/data/db/check-started';
    const deadline=Date.now()+10000;
    while(!existsSync(marker)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,30));
    if(!existsSync(marker))throw new Error('fixture auxiliary never started');
  }
  writeFileSync(barrierPath,JSON.stringify({ownerPid:process.pid,processId:row.id,labId:row.lab_id}));
  await new Promise(()=>{});
});
setInterval(()=>{},1000);
await lifecycle.process();
