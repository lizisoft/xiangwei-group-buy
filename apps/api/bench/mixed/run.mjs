import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir, cpus, totalmem, availableParallelism } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { fixture, slots } from './fixture.mjs';
import { lanes, packet, send } from './protocol.mjs';
import { prepare, counters, waits, audit, connection } from './database.mjs';
import { stats } from './metrics.mjs';

const mode=process.argv[2], size=Number(process.argv[3]), output=process.env.BENCH_OUT;
if(!['LEGACY','ENTITY'].includes(mode)||![1000,10000].includes(size)||!output||process.env.GITHUB_ACTIONS!=='true')
  throw Error('Run on the dedicated disposable runner');
const variant=process.env.BENCH_VARIANT??'baseline';
const path=join(output,mode+'-'+size+'-'+variant+'.json');
await mkdir(output,{recursive:true});
const keyDir=await mkdtemp(join(tmpdir(),'mixed-'));
const pair=generateKeyPairSync('rsa',{modulusLength:2048,publicKeyEncoding:{type:'spki',format:'pem'},privateKeyEncoding:{type:'pkcs8',format:'pem'}});
const keys={priv:pair.privateKey,aes:randomBytes(16).toString('hex')};
await writeFile(join(keyDir,'priv.pem'),pair.privateKey,{mode:0o600});
await writeFile(join(keyDir,'pub.pem'),pair.publicKey);
const state=await fixture(size);
const check=await connection();
const [[sqlInfo]]=await check.query('SELECT VERSION() AS mysql,@@innodb_flush_log_at_trx_commit AS flushAtCommit,@@innodb_buffer_pool_size AS bufferPool');
await check.end();
const report={mode,size,variant,base:process.env.PRODUCT_REVISION,experiment:process.env.GITHUB_SHA,run:process.env.GITHUB_RUN_ID,sqlInfo,cpu:cpus()[0].model,vcpus:availableParallelism(),ramMiB:Math.round(totalmem()/1048576),node:process.version,stages:[]};
async function save(){await writeFile(path,JSON.stringify(report,null,2));}
function next(child,kind,action){
  return new Promise((resolve,reject)=>{
    const finish=(err,v)=>{clearTimeout(timer);child.off('message',on);child.off('exit',exit);err?reject(err):resolve(v);};
    const on=m=>{if(m.kind===kind)finish(null,m.data);};
    const exit=code=>finish(Error('server exited '+code+' waiting '+kind));
    const timer=setTimeout(()=>finish(Error('server timeout '+kind)),120000);
    child.on('message',on); child.once('exit',exit); if(action)child.send(action);
  });
}

async function stage(rate,seconds,tag){
  const startedAt=new Date().toISOString();
  const {db,name,initialBytes}=await prepare(mode,state);
  const child=fork(fileURLToPath(new URL('./server.mjs',import.meta.url)),[],{execArgv:['--import','tsx','--max-old-space-size=3072'],env:{...process.env,MIX_DB:name,BENCH_KEYS:keyDir,BENCH_AES:keys.aes},stdio:['ignore','inherit','inherit','ipc']});
  try {
    await next(child,'ready');
    const mutations=[],errors=[],checks=new Map();
    const run=async(l,i,p)=>{
      const data=await send(p);
      const id=l==='callback'?'pay-'+i:data.data.id;
      mutations.push({lane:l,id,point:i%2?'B':'A'});
      if(!checks.has(l))checks.set(l,{p,id});
    };
    const isolated={};
    for(const l of lanes){const p=packet(l,0,keys);const t=performance.now();await run(l,0,p);isolated[l]=performance.now()-t;}
    if(report.stages.length===0){
      // Hold exactly the disputed record. Never change data in the diagnostic transaction.
      const blocker=await connection(name);await blocker.beginTransaction();
      await blocker.query('SELECT id FROM community_product_state WHERE id=1 FOR UPDATE');
      const tick=performance.now();let completed=0;const peaks={};let all;
      try{
        all=Promise.allSettled(lanes.map(async l=>{await run(l,1,packet(l,1,keys));completed++;}));
        for(let i=0;i<30;i++){
          await sleep(75);
          for(const w of await waits(db,name)){const key=w.obj+'/'+w.idx+'/'+w.rowKey;peaks[key]=Math.max(peaks[key]??0,Number(w.n));}
          if(Math.max(0,...Object.values(peaks))>=4)break;
        }
        report.control={heldMs:performance.now()-tick,completedBeforeRelease:completed,peaks};
      }finally{await blocker.rollback();await blocker.end();}
      for(const result of await all) if(result.status==='rejected')throw result.reason;
      report.control.completedAfterRelease=completed;await save();
    }
    const planned=4*Math.max(1,Math.floor(rate*seconds/4)), lanesCount=planned/4;
    assert(lanesCount+2<=slots(size),'too few unique business facts for requested probe');
    const packets=Array.from({length:planned},(_,j)=>packet(lanes[j%4],Math.floor(j/4)+2,keys));
    const active=new Set(), samples=Object.fromEntries(lanes.map(l=>[l,[]])),dispatch=[],lockSamples={};
    const innodbBefore=await counters(db);
    await next(child,'started','start');
    let polling=true, observerError=null, polls=0, waitingPolls=0, missed=0, completedByDeadline=0,maxInflight=0;
    const pollingTask=(async()=>{
      while(polling){
        const rows=await waits(db,name);polls++;if(rows.length)waitingPolls++;
        for(const w of rows){const k=w.obj+'/'+w.idx+'/'+w.rowKey;const x=lockSamples[k]??={sum:0,peak:0,polls:0};x.sum+=Number(w.n);x.peak=Math.max(x.peak,Number(w.n));x.polls++;}
        if(polling)await sleep(100);
      }
    })().catch(e=>{observerError=e.message;});
    const start=performance.now(),deadline=start+planned/rate*1000,window=deadline-start;
    for(let j=0;j<planned;j++){
      // Stations A and B arrive together; order and notify follow at half a cycle.
      const scheduled=start+(4*Math.floor(j/4)+(j%4>=2?2:0))*1000/rate;
      const delay=scheduled-performance.now();if(delay>0)await sleep(delay);
      const l=lanes[j%4],i=Math.floor(j/4)+2;
      if(active.size>=Number(process.env.BENCH_INFLIGHT??16)){missed++;continue;}
      dispatch.push(Math.max(0,performance.now()-scheduled));
      const work=run(l,i,packets[j]).then(()=>{
        const end=performance.now();samples[l].push(end-scheduled);
        if(end<=deadline)completedByDeadline++;
      }).catch(e=>{errors.push(e.message);});
      active.add(work);work.finally(()=>active.delete(work));maxInflight=Math.max(maxInflight,active.size);
    }
    await Promise.all(active);
    const last=performance.now();
    if(last<deadline)await sleep(deadline-last);
    const end=Math.max(last,deadline), elapsed=end-start;
    const measured=await next(child,'sample','end');
    polling=false;await pollingTask;
    if(observerError)throw Error('Database monitor disconnected: '+observerError);
    const innodbAfter=await counters(db);
    const n=Object.values(samples).reduce((a,x)=>a+x.length,0);
    const perLane=Object.fromEntries(lanes.map(l=>[l,stats(samples[l])]));
    const latency=stats(Object.values(samples).flat());
    const effective=n*1000/elapsed;
    const pass=missed===0 && errors.length===0 && effective>=rate*.95 && lanes.every(l=>perLane[l].p95<=500 && perLane[l].p99<=1000);
    // Resend identical accepted requests; acknowledgements must not create additional facts.
    for(const [lane,{p,id}] of checks){const v=await send(p);if(lane==='order')assert.equal(v.data.id,id);}
    const correctness=await audit(db,mode,state,mutations);
    const result={tag,rate,seconds:window/1000,startedAt,initialBytes,planned,sent:planned-missed,ok:n,missed,errors:errors.length,errorExamples:[...new Set(errors)].slice(0,6),maxInflight,completedByDeadline,drainMs:Math.max(0,last-deadline),effective,latency,perLane,pass,dispatch:stats(dispatch),isolated,measured,polls,waitingPolls,lockSamples,innodb:Object.fromEntries(Object.keys(innodbAfter).map(k=>[k,innodbAfter[k]-innodbBefore[k]])),correctness};
    report.stages.push(result);await save();
    console.log(JSON.stringify({mode,size,tag,rate,effective,p95:latency.p95,p99:latency.p99,missed,errors:errors.length,pass,lock:measured.lockSql.p95,hold:measured.hold.avg,peaks:lockSamples}));
    if(errors.length)throw Error('Unexpected business error '+errors[0]);
    return result;
  }finally{
    if(child.exitCode===null){const stopped=new Promise(r=>child.once('exit',r));child.send('stop');const kill=setTimeout(()=>child.kill('SIGKILL'),12000);await stopped;clearTimeout(kill);}
    await db.end();
  }
}
try {
  if(process.env.BENCH_PLAN){
    for(const [rate,seconds] of JSON.parse(process.env.BENCH_PLAN))await stage(rate,seconds,'match');
    report.finished=true;await save();
  }else{
  const rates=mode==='ENTITY'?[4,8,16,32,64,96,128]:size===1000?[2,4,8,16,32]:[.5,1,2,4,8];
  let good=0,bad=0;
  for(const r of rates){
    const row=await stage(r,24,'ramp');
    if(row.pass&&!bad) good=r; else if(!row.pass&&!bad)bad=r;
    if(bad && (r>=bad*2 || row.missed>0) && r>=2)break;
  }
  if(good&&bad && bad>good){
    const mid=(good+bad)/2;
    const row=await stage(mid,24,'bracket');if(row.pass)good=mid;else bad=mid;
  }
  if(good){
    const seconds=Math.min(60,4*(slots(size)-3)/good);
    const repeat=await stage(good,seconds,'confirm');
    if(!repeat.pass){const fallback=report.stages.filter(s=>s.pass&&s.rate<good).at(-1);if(fallback)await stage(fallback.rate,Math.min(60,4*(slots(size)-3)/fallback.rate),'confirm-lower');}
  }
  report.finished=true;await save();
  }
} catch(error){report.failure=error.stack;await save();throw error;}

