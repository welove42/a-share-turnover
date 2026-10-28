'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),https=require('node:https');
const {EventEmitter}=require('node:events');
const {requestBuffer}=require('../src/http');
test('HTTP错误携带真实状态码，消费拒绝响应，不把WAF HTML当行情解析',async()=>{
  const original=https.get;let resumed=false;
  https.get=(url,options,callback)=>{
    const request=new EventEmitter(),response=new EventEmitter();
    response.statusCode=501;response.resume=()=>{resumed=true;};
    queueMicrotask(()=>callback(response));return request;
  };
  try { await assert.rejects(requestBuffer('https://web.ifzq.gtimg.cn/test'),error=>error.statusCode===501&&error.message==='数据接口 HTTP 501');assert.equal(resumed,true); }
  finally {https.get=original;}
});
