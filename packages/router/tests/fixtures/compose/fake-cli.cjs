const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const root=path.dirname(__filename),args=process.argv.slice(2);
fs.appendFileSync(path.join(root,'calls.jsonl'),JSON.stringify({args,env:Object.keys(process.env),pid:process.pid})+'\n');
if(args.some(a=>['up','down','create','start','stop','rm','pull','build','prune'].includes(a)))process.exit(90);
const mode=fs.readFileSync(path.join(root,'mode'),'utf8');
if(mode==='hang'){
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
 fs.writeFileSync(path.join(root,'child-pid'),String(child.pid));setInterval(()=>{},1000);
}else if(mode==='oversize'){process.stdout.write('x'.repeat(20000));}
else if(mode==='invalid'){process.stdout.write('not json private-value');}
else if(mode==='fail'){process.stderr.write('private-value');process.exit(1);}
else if(args.includes('compose')){
 const file=args[args.indexOf('-f')+1];
 fs.writeFileSync(path.join(root,'snapshot-seen'),fs.readFileSync(file));
 fs.writeFileSync(path.join(root,'scratch-seen'),path.dirname(file));
 process.stdout.write(fs.readFileSync(path.join(root,'canonical.json')));
}else{
 const image=args.at(-1);
 process.stdout.write(JSON.stringify([{Id:'sha256:'+'b'.repeat(64),RepoDigests:[image],Config:{Volumes:mode==='volume'?{'/unexpected':{}}:null},Env:['SECRET=private-value']}]));
}
