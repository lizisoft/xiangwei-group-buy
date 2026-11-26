import { join } from 'node:path';
import { buildApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { MysqlStore } from '../../src/modules/core/mysql-store.ts';
import { MockPaymentProvider, WechatPaymentProvider } from '../../src/modules/payments/payment-provider.ts';
import { observeStore } from './metrics.mjs';
import { secret } from './fixture.mjs';

const {MIX_DB:name, BENCH_KEYS:keys, BENCH_DB_PASSWORD:password}=process.env;
if(!/^mixed_[0-9a-f]{16}$/.test(name))throw Error('A fresh benchmark schema is required');
const database='mysql://root:'+encodeURIComponent(password)+'@127.0.0.1:13306/'+name;
const redis='redis://127.0.0.1:16379/5';
const config=loadConfig({NODE_ENV:'test',DATA_STORE:'mysql',DATABASE_URL:database,SINGLE_WRITER_CONFIRMED:'true',QUEUE_DRIVER:'redis',REDIS_URL:redis,AUTH_PROVIDER:'wechat',WECHAT_APP_ID:'synthetic-local-app',WECHAT_APP_SECRET:'synthetic-local-secret',PAYMENT_PROVIDER:'mock',PICKUP_CODE_SECRET:secret,PRODUCT_IMAGE_DIR:join(keys,'images'),RATE_LIMIT_MAX:'10000',LOG_LEVEL:'silent'});
const store=MysqlStore.create(database);
const probe=observeStore(store);
const decoder=new WechatPaymentProvider({privateKeyPath:join(keys,'priv.pem'),publicKeyPath:join(keys,'pub.pem'),publicKeyId:'local-bench-key',apiV3Key:process.env.BENCH_AES});
const provider=new MockPaymentProvider();
provider.parseNotification=decoder.parseNotification.bind(decoder);
const app=await buildApp({store,config,paymentProvider:provider,logger:false,subscriptionMessageProvider:{send:async()=>{throw Error('No external delivery in benchmark')}}});
await app.listen({host:'127.0.0.1',port:13181});
process.on('message',async msg=>{
  if(msg==='start'){probe.start();process.send({kind:'started'});}
  if(msg==='end'){process.send({kind:'sample',data:probe.end()});}
  if(msg==='stop'){await app.close();process.exit(0);}
});
process.send({kind:'ready'});

