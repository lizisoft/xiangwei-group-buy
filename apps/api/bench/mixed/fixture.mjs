import { createHash, randomUUID } from 'node:crypto';
import { BUILTIN_ACCESS_ROLES } from '@hometown/api-contracts';
import { pickupCode, pickupCodeHash } from '../../src/modules/fulfillment/pickup-code.ts';
import { createAdminCredential } from '../../src/modules/auth/admin-auth.ts';

export const origin = 'http://127.0.0.1:13181';
export const secret = 'mixed-writes-disposable-test-code';
export const sku = 'synthetic-produce';
export const hash = value => createHash('sha256').update(value).digest('hex');
export const token = id => hash('local-test/' + id);
export const csrf = id => hash('local-test/csrf/' + id);
export const idForPickup = (point, index) => 'ready-' + point + '-' + index;
export const pickupCampaign = (point, index) => 'fulfilling-' + point + '-' + Math.floor(index / 40);
export const manager = point => 'staff-' + point;
export const buyer = index => 'buyer-' + (index % 128);
export const slots = total => Math.min(1800, Math.floor(total * 0.27));

export async function fixture(total) {
  const now = new Date().toISOString();
  const future = new Date(Date.now() + 8 * 3600000).toISOString();
  const s = {};
  const add = (collection, key, value) => (s[collection] ??= []).push([key, value]);
  const max = slots(total);
  const role = BUILTIN_ACCESS_ROLES.find(r => r.id === 'PICKUP_MANAGER');
  add('accessRoles', role.id, role);
  const session = (id, roles, extra = {}) => {
    const tokenHash = hash(token(id));
    add('sessions', tokenHash, {tokenHash, userId:id, roles, expiresAt:future, authorizationVersion:1, ...extra});
  };
  for (let i = 0; i < 128; i++) {
    const id = buyer(i), version = '2026-09-07-phone-v1';
    add('users', id, {id, wechatOpenId:'synthetic-'+id, consumerNumber:i+1, phoneNumber:'138'+String(i).padStart(8,'0'), phoneVerifiedAt:now, status:'ACTIVE', createdAt:now});
    add('privacy', id+':'+version, {userId:id, documentVersion:version, consentedAt:now});
    session(id, ['USER']);
  }
  add('areas', 'area', {id:'area',regionCode:'110101',name:'Synthetic area',orderEnabled:true,status:'ENABLED',createdAt:now});
  const ci = {catalogSkuId:sku,productId:'p',title:'Synthetic produce',name:'produce',category:'local',skuName:'one',origin:'synthetic',imageUrl:null,retailPriceCents:1500,sellableQuantity:100000};
  add('catalog',sku,{id:sku,productId:'p',name:'one',retailPriceCents:1500,defaultSellableQuantity:100000,status:'ACTIVE',product:{id:'p',title:ci.title,category:ci.category,origin:ci.origin,imageUrl:null,status:'ACTIVE'},createdAt:now,updatedAt:now});
  const campaigns = new Map();
  function campaign(id,point,status) {
    if (campaigns.has(id)) return campaigns.get(id);
    const c = {id,title:'Synthetic '+id,serviceAreaId:'area',cutoffAt:status==='OPEN'?future:now,dispatchAt:future,estimatedArrivalStartAt:future,estimatedArrivalEndAt:future,minTotalQuantity:1,failureAction:'CANCEL_AND_REFUND',items:[{...ci,reservedQuantity:0}],status,version:1,createdAt:now};
    add('campaigns',id,c);
    add('plans','plan-'+id,{id:'plan-'+id,campaignId:id,serviceAreaId:'area',pickupPointId:point,status:status==='OPEN'?'SITE_CONFIRMED':'ARRIVED',siteName:point,address:'Synthetic test station',arrivalStartAt:future,arrivalEndAt:future,createdAt:now,updatedAt:now});
    campaigns.set(id,c);
    return c;
  }
  for (const point of ['A','B']) {
    add('points',point,{id:point,serviceAreaId:'area',name:point,address:'Synthetic test station',latitude:39.9,longitude:116.4,businessHours:'09:00-20:00',pickupInstructions:'Test only',contactName:'Synthetic',contactPhone:'',status:'ACTIVE',createdAt:now});
    const id = manager(point);
    add('users',id,{id,wechatOpenId:null,status:'ACTIVE',createdAt:now});
    add('staff',id,{userId:id,staffNo:id,displayName:id,role:role.id,accessRoleId:role.id,status:'ACTIVE',authorizationVersion:1,createdAt:now,updatedAt:now});
    const credential = await createAdminCredential(id,id,randomUUID(),[role.id],false,1);
    add('credentials',credential.username,credential);
    add('staffPoints',id+':'+point,{staffUserId:id,pickupPointId:point,assignedBy:id,createdAt:now});
    session(id,[role.id],{webOrigin:origin,csrfToken:csrf(id)});
    campaign('sale-'+point,point,'OPEN');
  }
  const ledger = (id,event,accounts) => add('ledger',event+'-'+id,{id:event+'-'+id,referenceType:'ORDER',referenceId:id,eventType:event,createdAt:now,lines:accounts.map((accountCode,i)=>({accountCode,ownerId:null,direction:i?'CREDIT':'DEBIT',amountCents:1500}))});
  for(let n=0;n<total;n++){
    const ready=n<2*max, pending=!ready && n<3*max;
    const i=ready?Math.floor(n/2):pending?n-2*max:n;
    const point=(n%2)?'B':'A';
    const id=ready?idForPickup(point,i):pending?'pay-'+i:'done-'+i;
    const cid=ready?pickupCampaign(point,i):pending?'sale-'+point:'archive-'+point+'-'+Math.floor(i/80);
    campaign(cid,point,ready?'FULFILLING':pending?'OPEN':'COMPLETED').items[0].reservedQuantity++;
    const pid='plan-'+cid, userId=buyer(n), no='HT-BENCH-'+id, lineId='line-'+id;
    const order={id,orderNo:no,userId,campaignId:cid,serviceAreaId:'area',pickupPointId:point,deliveryPlanId:pid,status:ready?'READY_FOR_PICKUP':pending?'PENDING_PAYMENT':'COMPLETED',totalCents:1500,items:[],createdAt:now,expiresAt:future,paidAt:pending?null:now,pickedUpAt:!ready&&!pending?now:null};
    add('orders',id,order);
    add('lines',id,[{id:lineId,orderId:id,orderNo:no,campaignId:cid,catalogSkuId:sku,productId:'p',skuName:'one',quantity:1,unitPriceCents:1500,amountCents:1500,paidAt:order.paidAt,fulfilledQuantity:pending?0:1,pickedUpQuantity:ready||pending?0:1,exceptionQuantity:0,refundedQuantity:0,refundedAmountCents:0}]);
    add('payments','p-'+id,{id:'p-'+id,orderId:id,provider:'wechat',providerPaymentId:pending?null:'provider-'+id,status:pending?'CREATED':'SUCCEEDED',amountCents:1500,succeededAt:order.paidAt,createdAt:now,clientPayload:null});
    if(!pending) ledger(id,'PAYMENT_SUCCEEDED',['PAYMENT_CLEARING','CUSTOMER_CONTRACT_LIABILITY']);
    if(ready) {
      add('pickupCredentials',id,{orderId:id,codeHash:pickupCodeHash(pickupCode(id,secret),secret),status:'ACTIVE',expiresAt:future});
      add('windows',id,{id,orderId:id,deliveryPlanId:pid,arrivedAt:now,deadlineAt:future,status:'ACTIVE',extensionCount:0});
    } else if(!pending) {
      ledger(id,'PICKUP_CONFIRMED',['CUSTOMER_CONTRACT_LIABILITY','SALES_REVENUE']);
      const rid='receipt-'+id;
      add('pickupReceipts',rid,{id:rid,orderId:id,deliveryPlanId:pid,verifierId:manager(point),pickupRequestId:randomUUID(),requestKey:hash(id),payloadHash:hash(id),createdAt:now,items:[{id:'item-'+rid,communityPickupReceiptId:rid,catalogSkuId:sku,quantity:1}]});
    }
  }
  return s;
}

