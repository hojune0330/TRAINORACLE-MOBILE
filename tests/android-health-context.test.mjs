import test from 'node:test';
import assert from 'node:assert/strict';
import {createAndroidHealthContext} from '../web-adapter/android-health-context.js';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
function fixture(options={}) {
  const sent=[],events=new Map(),docEvents=new Map(); let n=0;
  const channel={postMessage:s=>sent.push(JSON.parse(s)),onmessage:null};
  const win={location:{origin:'https://localhost'},TrainOracleHealthPreview:channel,document:{hidden:false,addEventListener:(k,f)=>docEvents.set(k,f),removeEventListener:k=>docEvents.delete(k)},addEventListener:(k,f)=>events.set(k,f),removeEventListener:k=>events.delete(k)}; win.top=win;
  const api=createAndroidHealthContext({window:win,randomId:()=>`id${++n}`,timeoutMs:1000,...options});
  const reply=(m,result,extra={})=>channel.onmessage?.({data:JSON.stringify({v:1,requestId:m.requestId,sessionId:m.sessionId,contextId:m.contextId,epoch:1,ok:true,result,...extra})});
  return {api,win,sent,reply,events,channel};
}
async function opened(f){const p=f.api.open();f.reply(f.sent.at(-1),{status:'open',token:'native',epoch:1});await p;}
test('exact exports and offline mainframe/channel rejection',()=>{
  assert.throws(()=>createAndroidHealthContext({window:{top:{},location:{origin:'https://localhost'}}}));
  assert.throws(()=>fixture({accountMode:'account'}));
  const f=fixture();assert.deepEqual(Object.keys(f.api),['open','availability','requestAuthorization','readRunningWorkouts','invalidateContext','session','background','dispose']);f.api.dispose();
});
test('open binding and correlated DTO-only transport request',async()=>{
  const f=fixture();await opened(f);const p=f.api.availability(),m=f.sent.at(-1);
  assert.equal(m.token,'native');assert.equal(m.accountMode,'off');assert.equal(m.method,'availability');
  f.reply(m,{status:'available'});assert.equal((await p).status,'available');f.api.dispose();
});
test('context/session/background drops late responses and no cross-context delivery',async()=>{
  for(const action of ['invalidateContext','session','background','dispose']){
    const f=fixture();await opened(f);const p=f.api.availability(),m=f.sent.at(-1);const rejected=assert.rejects(p);f.api[action]();f.reply(m,{sessions:[{secret:'not delivered'}]});await rejected;if(action!=='dispose')f.api.dispose();
  }
});
test('wrong id/session/context/epoch replies ignored until correct original reply',async()=>{
  const f=fixture();await opened(f);const p=f.api.availability(),m=f.sent.at(-1);let done=false;p.then(()=>done=true);
  for(const extra of [{requestId:'wrong'},{sessionId:'wrong'},{contextId:'wrong'},{epoch:2}])f.reply(m,{status:'wrong'},extra);
  await Promise.resolve();assert.equal(done,false);f.reply(m,{status:'available'});await p;f.api.dispose();
});
test('strict limit and no implicit public Capacitor fallback',async()=>{
  const f=fixture();await opened(f);
  for(const limit of [null,'50',1.5,Infinity,true,[],{},0,101])await assert.rejects(f.api.readRunningWorkouts({limit}));
  f.api.dispose();
});
test('timeout invalidates native context',async()=>{
  const f=fixture({timeoutMs:5});await assert.rejects(f.api.open(),/HEALTH_TIMEOUT/);assert.equal(f.sent.at(-1).method,'invalidate');f.api.dispose();
});
test('SPA invalidation event rejects pending original-document promise',async()=>{
  const f=fixture();await opened(f);const p=f.api.availability();const rejected=assert.rejects(p,/NAVIGATION/);f.events.get('trainoracle-health-invalidated')();await rejected;f.api.dispose();
});
// Synthetic JS channel only. No Android WebView, Kotlin execution, health DB or permission UI exercised.

// Explicit reference-state model only: this does not execute Kotlin or Android callbacks.
class ReadyReference {
  constructor(){this.nav=0;this.commitObserved=false;this.proxyReady=false;this.proxy=null;this.challenge=null;this.serial=0;this.seq=0;this.probes=[];}
  navigate(){this.nav++;this.commitObserved=false;this.proxyReady=false;this.proxy=null;this.challenge=null;}
  commit(){this.nav++;this.commitObserved=true;this.proxyReady=false;this.proxy=null;this.challenge=null;this.reconcile();}
  documentStart(){this.serial++;this.reconcile();} // Sender proxy is deliberately not trusted.
  reconcile(){if(!this.commitObserved||this.proxyReady||this.challenge)return;const p={generation:this.nav,serial:this.serial,challenge:'c'+(++this.seq)};this.challenge=p;this.probes.push(p);}
  missingHookResult(p){if(this.challenge!==p||p.generation!==this.nav)return;this.challenge=null;if(p.serial!==this.serial)this.reconcile();}
  ready(p,proxy){if(!this.commitObserved||this.proxyReady||this.challenge!==p||p.generation!==this.nav)return;this.challenge=null;this.proxy=proxy;this.proxyReady=true;}
}
test('referenced ready state: start before commit and delayed start after commit both converge',()=>{
  for(const order of ['start-first','commit-first']){
    const m=new ReadyReference();m.navigate();
    if(order==='start-first'){m.documentStart();m.commit();}
    else {m.commit();const first=m.challenge;m.missingHookResult(first);m.documentStart();}
    const probe=m.challenge;assert.ok(probe);m.ready(probe,'current-document');assert.equal(m.proxyReady,true);assert.equal(m.proxy,'current-document');
  }
});
test('referenced ready state: delayed start while missing-hook callback queued retries',()=>{
  const m=new ReadyReference();m.navigate();m.commit();const first=m.challenge;m.documentStart();m.missingHookResult(first);assert.notEqual(m.challenge,first);m.ready(m.challenge,'current');assert.equal(m.proxyReady,true);
});
test('referenced ready state: previous navigation challenge and init replays never bind old proxy',()=>{
  const m=new ReadyReference();m.navigate();m.commit();const old=m.challenge;m.navigate();m.commit();const current=m.challenge;
  m.documentStart();m.ready(old,'old-document');assert.equal(m.proxyReady,false);assert.equal(m.challenge,current);
  m.ready(current,'new-document');m.documentStart();m.ready(current,'replay');assert.equal(m.proxy,'new-document');
});
class PermissionReference {
  constructor(){this.pending=null;this.flight=null;this.result=null;this.resumed=false;this.delivered=[];this.observer=true;}
  launch(r){if(this.flight)throw Error('BUSY');this.pending=r;this.flight=r;}
  callback(){const original=this.flight;this.flight=null;if(original&&this.pending===original&&original.live){this.result=original;this.complete();}}
  complete(){const r=this.result;if(!r)return;if(this.pending!==r||!r.live){this.result=null;return;}if(!this.resumed)return;this.result=null;this.delivered.push(r.id);this.pending=null;}
  onResumeHook(){this.complete();}
  onLifecycleResume(){this.resumed=true;if(this.observer)this.complete();}
  stop(){if(this.pending)this.pending.live=false;this.pending=null;this.result=null;} // Original flight remains until its callback.
  dispose(){this.stop();this.flight=null;this.observer=false;}
}
test('referenced permission state: callback and handleOnResume in STARTED retry only after lifecycle ON_RESUME',()=>{
  const m=new PermissionReference();m.launch({id:'original',live:true});m.callback();m.onResumeHook();assert.deepEqual(m.delivered,[]);m.onLifecycleResume();m.onLifecycleResume();assert.deepEqual(m.delivered,['original']);
});
test('referenced permission state: stopped old flight never resolves a new request',()=>{
  const m=new PermissionReference();m.launch({id:'old',live:true});m.stop();m.pending={id:'new',live:true};m.callback();m.onLifecycleResume();assert.deepEqual(m.delivered,[]);assert.equal(m.pending.id,'new');m.dispose();assert.equal(m.observer,false);
});

test('extracted native document-start JavaScript parses and returns readiness-only challenge from its own document',async()=>{
  const kotlin=await readFile(new URL('../native-templates/android/NativeHealthPlugin.kt',import.meta.url),'utf8');
  const source=kotlin.match(/addDocumentStartJavaScript\(bridge.webView, """([\s\S]*?)"""\.trimIndent\(\)/)?.[1];
  assert.ok(source);
  const messages=[];const win={TrainOracleHealthPreview:{postMessage:s=>messages.push(JSON.parse(s))},addEventListener(){},dispatchEvent(){}};win.top=win;
  runInNewContext(source,{window:win,history:{pushState(){},replaceState(){}},crypto:{randomUUID:()=> 'document_nonce'},Event:class{}});
  assert.deepEqual(messages[0],{v:1,method:'documentStart',documentId:'document_nonce'});
  assert.equal(win.__TrainOracleHealthProbe('native_challenge'),true);
  assert.deepEqual(messages[1],{v:1,method:'documentReady',documentId:'document_nonce',challenge:'native_challenge'});
  assert.equal(Object.getOwnPropertyDescriptor(win,'__TrainOracleHealthProbe').writable,false);
  assert.equal(win.__TrainOracleHealthProbe(null),false);
  assert.doesNotMatch(JSON.stringify(messages),/sessions|sourceRecordId|health-connect/);
});
