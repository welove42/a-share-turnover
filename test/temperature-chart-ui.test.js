'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
function page() {
  const nodes = new Map(), receivers = [], messages = [];
  function node(tag) {
    const attrs = new Map(), listeners = new Map();
    return { tag, children: [], dataset: {}, style: {}, hidden: false, clientWidth: 1000, clientHeight: 440,
      setAttribute(k,v){attrs.set(k,String(v));},getAttribute:k=>attrs.get(k),append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;},
      addEventListener(k,fn){listeners.set(k,fn);},dispatch(k,event={}){listeners.get(k)?.({preventDefault(){},...event});},getScreenCTM:()=>({inverse:()=>({})}) };
  }
  const document = { body: {dataset:{token:'test'}}, getElementById:id=>{if(!nodes.has(id))nodes.set(id,node(id));return nodes.get(id);},
    createElementNS:(_,tag)=>node(tag), createElement:node, createDocumentFragment:()=>node('fragment') };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../media/temperature-chart.js'),'utf8'), {
    document, temperatureModel:require('../media/temperature-model'),
    DOMPoint:class{constructor(x,y){this.x=x;this.y=y;}matrixTransform(){return this;}},
    window:{addEventListener:(event,fn)=>{if(event==='message')receivers.push(fn);}},
    acquireVsCodeApi:()=>({postMessage:message=>messages.push(message)})
  });
  return {nodes,messages,receive:(data,token='test')=>receivers.forEach(fn=>fn({data:{type:'temperature-data',token,data}}))};
}
const descendants = node => [node,...node.children.flatMap(descendants)];
const points = [['09:35:00',10],['09:35:10',20],['09:35:20',35],['10:30:00',80],['10:30:10',90],['13:00:00',75]].map(([time,score])=>({time,score,phase:'交易中'}));
const data = () => ({date:'2026-10-28',points:structuredClone(points),current:{score:75,label:'偏热',reason:''},phase:'交易中'});

test('温度曲线悬停显示准确时间、分数和档位，不跨午休及缺采时段连线', () => {
  const p = page(); p.receive(data());
  assert.equal(p.messages[0].action,'ready');
  const svg = p.nodes.get('temperature-svg'), plot = p.nodes.get('temperature-plot');
  assert.equal(descendants(svg).filter(n=>n.getAttribute('class')==='temperature-line').length,2);
  plot.dispatch('pointermove',{clientX:48+3600/19800*928,clientY:100});
  assert.equal(p.nodes.get('temperature-tooltip').hidden,false);
  assert.match(p.nodes.get('temperature-tooltip').textContent,/2026-10-28 10:30:00[\s\S]*80 \/ 100 · 过热/);
  assert.match(p.nodes.get('temperature-detail').textContent,/10:30:00.*80\/100/);
  plot.dispatch('keydown',{key:'ArrowRight'});
  assert.match(p.nodes.get('temperature-tooltip').textContent,/10:30:10[\s\S]*90 \/ 100/);
  plot.dispatch('pointerleave'); assert.equal(p.nodes.get('temperature-tooltip').hidden,true);
  assert.match(p.nodes.get('temperature-detail').textContent,/最近记录.*13:00:00.*75\/100/);
});

test('刷新保留悬停的10秒采集点；同桶更新、跨天清空及Esc恢复最新', () => {
  const p = page(); p.receive(data()); const plot=p.nodes.get('temperature-plot');
  plot.dispatch('pointermove',{clientX:48+3600/19800*928,clientY:100});
  const update = data(); update.points[3]={time:'10:30:07',score:82,phase:'交易中'};update.points.push({time:'14:00:00',score:60,phase:'交易中'});
  p.receive(update);
  assert.match(p.nodes.get('temperature-tooltip').textContent,/10:30:07[\s\S]*82 \/ 100/);
  plot.dispatch('keydown',{key:'Escape'});assert.equal(p.nodes.get('temperature-tooltip').hidden,true);
  assert.match(p.nodes.get('temperature-detail').textContent,/14:00:00.*60\/100/);
  p.receive({...data(),date:'2026-10-29',points:[],current:{score:null,label:'盘前',reason:'等待开盘'}});
  assert.equal(p.nodes.get('temperature-tooltip').hidden,true);assert.equal(p.nodes.get('current').textContent,'盘前');
  assert.match(p.nodes.get('temperature-detail').textContent,/暂无记录/);
  assert.doesNotMatch(JSON.stringify(descendants(p.nodes.get('temperature-svg')).map(n=>n.getAttribute('points'))),/NaN|Infinity/);
});

test('单点0分可见，不把无记录当作冰点；错误令牌和无效分数不覆盖现图', () => {
  const p = page(); const d={...data(),points:[{time:'10:00:00',score:0,phase:'交易中'}],current:{score:0,label:'冰点',reason:''}};
  p.receive(d); assert.equal(p.nodes.get('current').textContent,'0 冰点');
  assert.ok(descendants(p.nodes.get('temperature-svg')).some(n=>n.getAttribute('class')==='temperature-point'));
  const old=p.nodes.get('temperature-detail').textContent;
  p.receive(data(),'wrong'); assert.equal(p.nodes.get('temperature-detail').textContent,old);
  p.receive({...data(),points:[{time:'10:00:00',score:NaN}]});assert.equal(p.nodes.get('temperature-detail').textContent,old);
  p.nodes.get('temperature-plot').dispatch('keydown',{key:'ArrowLeft'});
  assert.match(p.nodes.get('temperature-tooltip').textContent,/0 \/ 100 · 冰点/);
});
