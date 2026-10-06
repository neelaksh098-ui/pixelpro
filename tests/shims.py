"""Browser shims for driving Pixel Pro headlessly.

These replace exactly three things the app cannot have in a headless browser
-- speech recognition, the Cartesia WebSocket, and a user gesture for audio --
and nothing else. Everything the tests assert on is the app's own code.
"""

# A SpeechRecognition that behaves like Chrome on Android rather than like a
# well-behaved spec implementation. Each quirk is switchable via window.__q so
# a failure can be attributed to exactly one of them.
ANDROID_SR = """
window.__starts=0; window.__srLive=[]; window.__srAll=[];
window.__q = {
  ignoreContinuous: true,    // Android ends the session after one utterance
  redeliverFinal: 0,         // times a final is handed back at a NEW index
  lateOnend: 0,              // ms to delay onend past abort()/stop()
  fireResultAfterAbort:false,// a queued result lands after abort()
  autoEndMs: 0               // engine ends by itself this long after start
};
class AndroidSR{
  constructor(){
    this.lang=''; this.interimResults=false; this.continuous=false; this.maxAlternatives=1;
    this.started=false; this._r=[]; window.__srAll.push(this);
  }
  start(){
    if(this.started) throw new DOMException('already started','InvalidStateError');
    this.started=true; window.__starts++; window.__srLive.push(this);
    if(this.onstart) this.onstart({});
    if(window.__q.autoEndMs){
      this._auto=setTimeout(()=>{ if(this.started) this._finish(); }, window.__q.autoEndMs);
    }
  }
  _drop(){ clearTimeout(this._auto); this.started=false;
           const i=window.__srLive.indexOf(this); if(i>=0) window.__srLive.splice(i,1); }
  _finish(){ if(!this.started) return; this._drop();
             const go=()=>{ if(this.onend) this.onend({}); };
             if(window.__q.lateOnend) setTimeout(go, window.__q.lateOnend); else go(); }
  stop(){ this._finish(); }
  abort(){
    if(!this.started) return;
    const queued = window.__q.fireResultAfterAbort && this._pendingFinal;
    this._drop();
    if(queued){ const self=this; setTimeout(()=>{ if(self.onresult) self.onresult(self._pendingEvent); }, 5); }
    const go=()=>{ if(this.onend) this.onend({}); };
    if(window.__q.lateOnend) setTimeout(go, window.__q.lateOnend); else go();
  }
  _emitRaw(){
    const res=this._r.slice(); res.length=this._r.length;
    const evt={resultIndex:this._r.length-1, results:res};
    this._pendingEvent=evt;
    if(this.onresult) this.onresult(evt);
  }
  /* one utterance, the way Android delivers it */
  say(text, opts){
    opts=opts||{};
    const words=text.split(' ');
    if(this.interimResults && !opts.noInterim){
      for(let i=1;i<=words.length;i++){
        this._r=[{0:{transcript:words.slice(0,i).join(' ')},isFinal:false,length:1}];
        this._emitRaw();
      }
    }
    this._r=[{0:{transcript:text},isFinal:true,length:1}];
    this._pendingFinal=true;
    this._emitRaw();
    for(let k=0;k<window.__q.redeliverFinal;k++){
      this._r.push({0:{transcript:text},isFinal:true,length:1});
      this._emitRaw();
    }
    if(window.__q.ignoreContinuous) this._finish();
  }
  silence(){ if(this.onerror) this.onerror({error:'no-speech'}); this._finish(); }
  /* interims growing over real time, then the person stops -- no final */
  async sayLive(text, wordMs){
    const words=text.split(' ');
    for(let i=1;i<=words.length;i++){
      this._r=[{0:{transcript:words.slice(0,i).join(' ')},isFinal:false,length:1}];
      this._emitRaw();
      await new Promise(r=>setTimeout(r, wordMs||110));
    }
  }
}
window.SpeechRecognition=AndroidSR; window.webkitSpeechRecognition=AndroidSR;
window.__cur=()=>window.__srLive[window.__srLive.length-1]||null;
"""

# A Cartesia TTS WebSocket that speaks the real protocol: it accepts the app's
# JSON request and answers with base64 PCM `chunk` frames and a `done`, keyed
# by context_id. Deliberately faithful -- the attribution logic in
# ttsWsMessage is exactly the part worth exercising.
CARTESIA_WS = """
window.__ttsReqs=[]; window.__wsOpens=0;
window.__wsCfg={openMs:40, firstChunkMs:30, chunks:2, fail:false, silent:false};
function __pcm(n){
  const a=new Int16Array(n);
  for(let i=0;i<n;i++) a[i]=Math.round(Math.sin(i/14)*5000);
  let s=''; const b=new Uint8Array(a.buffer);
  for(let i=0;i<b.length;i++) s+=String.fromCharCode(b[i]);
  return btoa(s);
}
class FakeCartesiaWS{
  constructor(url){
    this.url=url; this.readyState=0; window.__wsOpens++;
    setTimeout(()=>{
      if(window.__wsCfg.fail){ this.readyState=3; this.onclose&&this.onclose({}); return; }
      this.readyState=1; this.onopen&&this.onopen({});
    }, window.__wsCfg.openMs);
  }
  send(raw){
    let req; try{ req=JSON.parse(raw); }catch(e){ return; }
    window.__ttsReqs.push(req);
    if(window.__wsCfg.silent) return;            /* accepts and never answers */
    const id=req.context_id, rate=(req.output_format||{}).sample_rate||22050;
    const n=window.__wsCfg.chunks;
    for(let k=0;k<n;k++){
      setTimeout(()=>{
        this.onmessage&&this.onmessage({data:JSON.stringify(
          {type:'chunk', context_id:id, data:__pcm(Math.round(rate*0.12))})});
        if(k===n-1) this.onmessage&&this.onmessage({data:JSON.stringify({type:'done', context_id:id})});
      }, window.__wsCfg.firstChunkMs + k*25);
    }
  }
  close(){ this.readyState=3; this.onclose&&this.onclose({}); }
}
window.WebSocket=FakeCartesiaWS;
"""

# Headless Chromium reports a desktop UA by default; some paths branch on it.
DESKTOP_UA = ("Object.defineProperty(navigator,'userAgent',{configurable:true,"
              "get:()=>'Mozilla/5.0 (Macintosh) Chrome/126 Safari/537.36'});")
ANDROID_UA = ("Object.defineProperty(navigator,'userAgent',{configurable:true,"
              "get:()=>'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/126 Mobile Safari/537.36'});")

ALL = ANDROID_SR + CARTESIA_WS
