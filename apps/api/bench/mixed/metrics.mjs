export function stats(values) {
  const sorted = [...values].sort((a,b)=>a-b);
  const sum=sorted.reduce((a,b)=>a+b,0);
  const pct=p=>sorted[Math.max(0,Math.ceil(p*sorted.length)-1)] ?? 0;
  const round=n=>Number(n.toFixed(2));
  return {n:sorted.length,sum:round(sum),avg:round(sum/(sorted.length||1)),p50:round(pct(.5)),p95:round(pct(.95)),p99:round(pct(.99)),max:round(sorted.at(-1)??0)};
}

// Observation only. The driver's SQL, bind parameters and transaction boundaries are unchanged.
export function observeStore(store) {
  let samples, active=false, cpu, start, peak=0;
  const pool=store.pool;
  const acquire=pool.getConnection.bind(pool);
  pool.getConnection=async()=>{
    const t=performance.now(); const connection=await acquire();
    if(active)samples.pool.push(performance.now()-t);
    let locked;
    const query=connection.query.bind(connection);
    connection.query=async(sql,...args)=>{
      const clock=performance.now();
      const result=await query(sql,...args);
      if(active && sql==='SELECT id FROM community_product_state WHERE id=1 FOR UPDATE'){
        locked=performance.now();samples.acquire.push(locked-clock);
      }
      return result;
    };
    for(const method of ['commit','rollback']){
      const finish=connection[method].bind(connection);
      connection[method]=async(...args)=>{
        const value=await finish(...args);
        if(active && locked!==undefined)samples.hold.push(performance.now()-locked);
        locked=undefined;
        return value;
      };
    }
    return connection;
  };
  const sampler=setInterval(()=>{if(active)peak=Math.max(peak,process.memoryUsage.rss());},100);
  sampler.unref();
  return {
    start(){ samples={pool:[],acquire:[],hold:[]};peak=process.memoryUsage.rss();cpu=process.cpuUsage();start=performance.now();active=true; },
    end(){ active=false; const usage=process.cpuUsage(cpu);return {pool:stats(samples.pool),lockSql:stats(samples.acquire),hold:stats(samples.hold),windowMs:performance.now()-start,apiCpuMs:(usage.system+usage.user)/1000,peakRssMiB:peak/1048576}; }
  };
}

