import { createIOSHealthContext } from './ios-health-context.js';
import { createAndroidHealthContext } from './android-health-context.js';
import { installOfflineHealthPreview } from './offline-health-preview.js';
const SAFE = new Set(['USER_CANCELLED','CANCELLED','ABORT_ERR','BUSY','HEALTH_TIMEOUT','PERMISSION_REQUIRED','CONTEXT_CHANGED','STALE_CONTEXT','HEALTH_UNAVAILABLE']);
function safeError(e) { const c=SAFE.has(e?.code)?e.code:SAFE.has(e?.message)?e.message:'HEALTH_PREVIEW_UNAVAILABLE'; return Object.assign(new Error(c),{code:c}); }
export function createOfflineHealthDriver(env,{platform,native,iosFactory=createIOSHealthContext,androidFactory=createAndroidHealthContext}={}) {
  if(!['ios','android'].includes(platform))throw new Error('UNSUPPORTED_PLATFORM');
  const underlying=platform==='ios'?iosFactory({native,consumerIntegrated:true,isForeground:()=>env.document.visibilityState==='visible',randomId:()=>env.crypto.randomUUID()}):androidFactory({window:env,accountMode:'off',randomId:()=>env.crypto.randomUUID()});
  const invoke=(fn,...args)=>Promise.resolve().then(()=>Reflect.apply(fn,underlying,args)).catch(e=>{throw safeError(e);});
  const need=platform==='ios'?['open','request','invalidateContext','invalidateSession','background','dispose']:['open','requestAuthorization','readRunningWorkouts','invalidateContext','session','background','dispose'];
  if(need.some(k=>typeof underlying?.[k]!=='function'))throw new Error('INVALID_DRIVER');
  return Object.freeze({
    open:()=>invoke(underlying.open),
    request:(method,input={})=>{
      if(!['availability','requestAuthorization','readRunningWorkouts'].includes(method))return Promise.reject(new Error('INVALID_METHOD'));
      if(method==='availability')return invoke(underlying.availability);
      const clean=method==='readRunningWorkouts'?Object.fromEntries(['start','end','limit'].filter(k=>Object.hasOwn(input,k)).map(k=>[k,input[k]])):{};
      const androidInput=method==='readRunningWorkouts'?{startTime:clean.start,endTime:clean.end,...(Object.hasOwn(clean,'limit')?{limit:clean.limit}:{})}:{};
      return platform==='ios'?invoke(underlying.request,method,clean):invoke(underlying[method],androidInput);
    },
    invalidateContext:()=>invoke(underlying.invalidateContext),
    invalidateSession:()=>invoke(platform==='ios'?underlying.invalidateSession:underlying.session),
    background:()=>invoke(underlying.background),dispose:()=>invoke(underlying.dispose)
  });
}
function offlineFrame(env,platform){
  try{return !!env&&env===env.top&&(platform==='ios'?env.location.protocol==='capacitor:'&&env.location.hostname==='localhost':platform==='android'&&env.location.origin==='https://localhost');}catch{return false;}
}
function readyForeground(env){
  const doc=env.document;
  const ready=()=>env.document===doc&&doc.readyState!=='loading'&&doc.visibilityState==='visible';
  if(ready())return Promise.resolve(true);
  if(!doc.addEventListener||!doc.removeEventListener||!env.addEventListener||!env.removeEventListener)return Promise.resolve(false);
  // Event-driven installation only. No health read or permission request while waiting.
  return new Promise(resolve=>{
    let settled=false;
    const finish=ok=>{if(settled)return;settled=true;doc.removeEventListener('DOMContentLoaded',check);doc.removeEventListener('visibilitychange',check);env.removeEventListener('pagehide',cancel);resolve(ok);};
    const check=()=>{if(env.document!==doc)finish(false);else if(ready())finish(true);};
    const cancel=()=>finish(false);
    doc.addEventListener('DOMContentLoaded',check);doc.addEventListener('visibilitychange',check);env.addEventListener('pagehide',cancel,{once:true});check();
  });
}
export async function installOfflineHealthBootstrap(env,{enabled=false,platform,native,createDriver=createOfflineHealthDriver,installPreview=installOfflineHealthPreview}={}) {
  if(enabled!==true)return null;
  if(!offlineFrame(env,platform))return null;
  if(!await readyForeground(env)||!offlineFrame(env,platform)||!env.document.body)return null;
  let driver;
  try {driver=createDriver(env,{platform,native});return installPreview(env,{driver,platform,enabled:true});}
  catch {try{Promise.resolve(driver?.dispose()).catch(()=>{});}catch{}return null;}
}
