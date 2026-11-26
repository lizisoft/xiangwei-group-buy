import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { legacyStateRecords,entityRecordRelations } from '../../src/modules/core/entity-store-records.ts';
import { hash } from './fixture.mjs';

export async function connection(db) {
  return mysql.createConnection({host:'127.0.0.1',port:13306,user:'root',password:process.env.BENCH_DB_PASSWORD,database:db,multipleStatements:true,timezone:'Z',jsonStrings:true});
}

// Fresh random schema for every measurement; the job owns its disposable MySQL instance.
export async function prepare(mode,state) {
  const name='mixed_'+randomBytes(8).toString('hex'), db=await connection();
  await db.query('CREATE DATABASE ??',[name]);await db.query('USE ??',[name]);
  for(const migration of ['0001_community_baseline','0005_entity_store']){
    await db.query(await readFile(new URL('../../../../infra/mysql/migrations/'+migration+'.sql',import.meta.url),'utf8'));
  }
  const raw=JSON.stringify(state);
  if(mode==='LEGACY') await db.execute('UPDATE community_product_state SET payload=? WHERE id=1',[raw]);
  else {
    const records=legacyStateRecords(raw);
    const columns=['collection','entityKey','lookupA','lookupB','lookupC','lookupD','lookupE','lookupF','status','createdAt','queueAt','paidAt','dueAt','retryAt','leaseUntil','providerStartedAt','uniqueKey','searchText'];
    for(let i=0;i<records.length;i+=350){
      const group=records.slice(i,i+350);
      const rows=group.map(r=>[...columns.map(k=>r[k]),JSON.stringify(r.document)]);
      await db.query('INSERT INTO community_entity_records(collection,entity_key,lookup_a,lookup_b,lookup_c,lookup_d,lookup_e,lookup_f,record_status,created_at,queue_at,paid_at,due_at,retry_at,lease_until,provider_started_at,unique_key,search_text,document) VALUES ?',[rows]);
      const relations=group.flatMap(r=>entityRecordRelations(r).map(([relation,target])=>[r.collection,r.entityKey,Buffer.from(hash(r.entityKey),'hex'),relation,target,Buffer.from(hash(target),'hex')]));
      if(relations.length)await db.query('INSERT INTO community_entity_relations(source_collection,source_key,source_key_sha256,relation_name,target_key,target_key_sha256) VALUES ?',[relations]);
    }
    await db.query("UPDATE community_entity_store_state SET mode='ENTITY' WHERE id=1");
  }
  return {name,db,initialBytes:Buffer.byteLength(raw)};
}

export async function waits(db,name){
  const [rows]=await db.execute(`SELECT l.OBJECT_NAME AS obj,l.INDEX_NAME AS idx,l.LOCK_DATA AS rowKey,COUNT(DISTINCT w.REQUESTING_ENGINE_TRANSACTION_ID) AS n
    FROM performance_schema.data_lock_waits w
    JOIN performance_schema.data_locks l ON l.ENGINE=w.ENGINE AND l.ENGINE_LOCK_ID=w.REQUESTING_ENGINE_LOCK_ID
    WHERE l.OBJECT_SCHEMA=? GROUP BY l.OBJECT_NAME,l.INDEX_NAME,l.LOCK_DATA`,[name]);
  return rows;
}
export async function counters(db){
  const [rows]=await db.query("SHOW GLOBAL STATUS WHERE Variable_name IN ('Innodb_row_lock_time','Innodb_row_lock_waits','Innodb_deadlocks')");
  return Object.fromEntries(rows.map(r=>[r.Variable_name,Number(r.Value)]));
}
export async function audit(db,mode,before,mutations){
  let groups={};
  if(mode==='LEGACY'){
    const [[row]]=await db.query('SELECT CAST(payload AS CHAR) AS payload FROM community_product_state WHERE id=1');
    const state=JSON.parse(row.payload);
    for(const col of ['orders','payments','pickupReceipts','ledger','campaigns','callbacks','lines','idempotency','pickupCredentials'])
      groups[col]=new Map(state[col]??[]);
  } else {
    for(const col of ['orders','payments','pickupReceipts','ledger','campaigns','callbacks','lines','idempotency','pickupCredentials']){
      const [rows]=await db.execute('SELECT entity_key,document FROM community_entity_records WHERE collection=?',[col]);
      groups[col]=new Map();
      for(const row of rows){
        const d=JSON.parse(row.document);
        if(col==='lines')groups.lines.set(d.orderId,[d]);
        else groups[col].set(row.entity_key,d);
      }
    }
  }
  const pick=mutations.filter(t=>t.lane.startsWith('pickup'));
  const pay=mutations.filter(t=>t.lane==='callback');
  const orders=mutations.filter(t=>t.lane==='order');
  const initial=k=>(before[k]??[]).length;
  assert.equal(groups.orders.size,initial('orders')+orders.length);
  assert.equal(groups.callbacks.size,initial('callbacks')+pay.length);
  assert.equal(groups.pickupReceipts.size,initial('pickupReceipts')+pick.length);
  assert.equal(groups.idempotency.size,initial('idempotency')+orders.length);
  assert.equal(groups.ledger.size,initial('ledger')+pick.length+pay.length);
  const events=new Map();
  for(const post of groups.ledger.values()){
    const k=post.referenceId+'/'+post.eventType;
    assert(!events.has(k),'duplicate posting '+k); events.set(k,post);
  }
  let cents=0;
  for(const t of [...pay,...pick]){
    const isPay=t.lane==='callback';
    const entry=events.get(t.id+'/'+(isPay?'PAYMENT_SUCCEEDED':'PICKUP_CONFIRMED'));
    assert.deepEqual(entry.lines.map(v=>[v.direction,Number(v.amountCents)]),[['DEBIT',1500],['CREDIT',1500]]);
    assert.equal(groups.orders.get(t.id).status,isPay?'PAID_WAITING_CLOSE':'COMPLETED');
    if(isPay){assert.equal(groups.payments.get('p-'+t.id).status,'SUCCEEDED');cents+=1500;}
    else{assert.equal(groups.lines.get(t.id)[0].pickedUpQuantity,1);assert.equal(groups.pickupCredentials.get(t.id).status,'USED');}
  }
  for(const o of orders){assert.equal(groups.orders.get(o.id).status,'PENDING_PAYMENT');assert.equal(groups.lines.get(o.id)[0].quantity,1);}
  for(const p of ['A','B']){
    const c=groups.campaigns.get('sale-'+p);
    const initialC=before.campaigns.find(([id])=>id===c.id)[1];
    assert.equal(c.items[0].reservedQuantity,initialC.items[0].reservedQuantity+orders.filter(t=>t.point===p).length);
    assert(c.items[0].reservedQuantity<=c.items[0].sellableQuantity);
  }
  return {ok:true,newOrders:orders.length,callbacks:pay.length,newPickupReceipts:pick.length,newLedgerRows:pay.length+pick.length,callbackCents:cents};
}

