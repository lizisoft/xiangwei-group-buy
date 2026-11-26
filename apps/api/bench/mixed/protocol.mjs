import { createCipheriv, randomBytes, randomUUID, sign } from 'node:crypto';
import { pickupCode } from '../../src/modules/fulfillment/pickup-code.ts';
import { manager,buyer,token,csrf,idForPickup,pickupCampaign,secret,sku,origin } from './fixture.mjs';

export const lanes=['pickupA','pickupB','order','callback'];
export function packet(lane,i,keys) {
  const point=lane==='pickupA'?'A':lane==='pickupB'?'B':i%2?'B':'A';
  if(lane.startsWith('pickup')){
    const id=idForPickup(point,i), staff=manager(point);
    return {url:'/api/v1/pickup/verify',expect:200,headers:{cookie:'staff-session='+token(staff),origin,'x-csrf-token':csrf(staff)},body:{orderId:id,deliveryPlanId:'plan-'+pickupCampaign(point,i),code:pickupCode(id,secret),pickupRequestId:randomUUID(),items:[{catalogSkuId:sku,quantity:1}]}};
  }
  if(lane==='order'){
    return {url:'/api/v1/orders',expect:201,headers:{authorization:'Bearer '+token(buyer(i)),'idempotency-key':'synthetic-order-'+i},body:{campaignId:'sale-'+point,serviceAreaId:'area',pickupPointId:point,items:[{skuId:sku,quantity:1}]}};
  }
  const identity='pay-'+i, nonce=randomBytes(6).toString('hex');
  const cipher=createCipheriv('aes-256-gcm',Buffer.from(keys.aes),Buffer.from(nonce));
  cipher.setAAD(Buffer.from('bench'));
  const plain=JSON.stringify({out_trade_no:'HT-BENCH-'+identity,transaction_id:'provider-'+identity,amount:{total:1500}});
  const ciphertext=Buffer.concat([cipher.update(plain),cipher.final(),cipher.getAuthTag()]).toString('base64');
  const body={id:'event-'+identity,event_type:'TRANSACTION.SUCCESS',resource:{algorithm:'AEAD_AES_256_GCM',associated_data:'bench',nonce,ciphertext}};
  const ts=String(Math.floor(Date.now()/1000));
  const signature=sign('RSA-SHA256',Buffer.from(ts+'\n'+nonce+'\n'+JSON.stringify(body)+'\n'),keys.priv).toString('base64');
  return {url:'/api/v1/payments/wechat/notify',expect:200,headers:{'wechatpay-timestamp':ts,'wechatpay-nonce':nonce,'wechatpay-serial':'local-bench-key','wechatpay-signature':signature},body};
}
export async function send(p) {
  const r=await fetch(origin+p.url,{method:'POST',headers:{'content-type':'application/json',...p.headers},body:JSON.stringify(p.body),signal:AbortSignal.timeout(90000)});
  const data=await r.json();
  if(r.status!==p.expect)throw Error(p.url+' '+r.status+' '+data.code+' '+data.message);
  if(p.url==='/api/v1/pickup/verify' && (data.data.id!==p.body.orderId || data.data.status!=='COMPLETED' || data.data.items[0].pickedUpQuantity!==1))throw Error('pickup response invariant');
  if(p.url==='/api/v1/orders' && (data.data.status!=='PENDING_PAYMENT'||data.data.totalCents!==1500))throw Error('order response invariant');
  if(p.url.endsWith('/notify')&&data.code!=='SUCCESS')throw Error('callback not acknowledged');
  return data;
}

