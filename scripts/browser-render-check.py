"""Optional UI/runtime smoke test using Playwright and a local-only transport fixture.

The build environment's Chromium policy denies URL navigation. This script does NOT
modify that policy. It loads our own HTML/CSS/JS into about:blank, replacing only
location/storage and HTTP/SSE transports with a Python loopback bridge. This tests
DOM behavior against the running server, NOT native browser-origin/CSP behavior,
real TTS, or OBS. Requirements: Python playwright + an installed Chromium.
Run a demo server on :8787 with the test-only tokens below before invoking.
"""
from pathlib import Path
import base64,json,re,threading,urllib.request,urllib.error,uuid,os,time
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parents[1]
BASE='http://127.0.0.1:8787'
ADMIN=os.environ.get('TEST_ADMIN','a'*48); VIEW=os.environ.get('TEST_VIEW','v'*48)
EVENTS=[]; LOCK=threading.Lock(); finished=False

def fetch_local(path,opts=None):
    opts=opts or {}
    if not path.startswith('/') or path.startswith('//'): raise ValueError('Only this local test server is allowed')
    req=urllib.request.Request(BASE+path,data=opts.get('body','').encode() if opts.get('body') is not None else None,headers=opts.get('headers',{}),method=opts.get('method','GET'))
    try: r=urllib.request.urlopen(req,timeout=10)
    except urllib.error.HTTPError as e: r=e
    with r: return {'status':r.status,'headers':dict(r.headers),'data':base64.b64encode(r.read()).decode()}

def pull(cursor):
    with LOCK: return {'cursor':len(EVENTS),'events':EVENTS[cursor:]}

def consume():
    try:
        with urllib.request.urlopen(BASE+'/events?token='+VIEW,timeout=60) as r:
            for raw in r:
                if finished: break
                line=raw.decode().strip()
                if line.startswith('data: '):
                    with LOCK: EVENTS.append(json.loads(line[6:]))
    except Exception:
        if not finished: raise

WRAPPER=r'''(args)=>{
 const fixtureFetch=async(url,opts={})=>{const r=await window.top.__http(url,opts);return new Response(Uint8Array.from(atob(r.data),x=>x.charCodeAt(0)),{status:r.status,headers:r.headers});};
 class FixtureEvents{
  constructor(){this.cursor=0;this.busy=false;this.timer=setInterval(async()=>{if(this.busy)return;this.busy=true;try{const r=await window.top.__pull(this.cursor);this.cursor=r.cursor;for(const e of r.events)this.onmessage?.({data:JSON.stringify(e)});if(!this.opened){this.opened=true;this.onopen?.();}}finally{this.busy=false;}},100);}
  close(){clearInterval(this.timer);}
 }
 const storage={getItem:()=>'',setItem:()=>{}};
 const fn=new Function('location','sessionStorage','history','crypto','fetch','EventSource',args.code);
 fn({hash:args.hash,pathname:'/setup'},storage,{replaceState:()=>{}},{randomUUID:()=>args.client},fixtureFetch,FixtureEvents);
}'''

def html(name):
    s=(ROOT/'public'/name).read_text()
    s=re.sub(r'<link[^>]+rel="stylesheet"[^>]*>','',s)
    s=re.sub(r'<script[^>]+src="[^"]+"[^>]*></script>','',s)
    return s

def setup_page(page,width,height):
    page.set_viewport_size({'width':width,'height':height})
    page.set_content(html('index.html'))
    page.add_style_tag(content=(ROOT/'public/studio.css').read_text())
    # Keep the preview iframe in memory; no blocked navigation is attempted.
    page.evaluate("Object.defineProperty(document.getElementById('preview'),'src',{set(v){this.dataset.testSrc=v;},get(){return this.dataset.testSrc;}})")
    page.evaluate(WRAPPER,{'code':(ROOT/'public/studio.mjs').read_text(),'hash':'#admin='+ADMIN,'client':str(uuid.uuid4())})
    page.locator('#workspace').wait_for(state='visible')
    frame=page.locator('#preview').element_handle().content_frame()
    frame.set_content(html('stage.html'))
    frame.add_style_tag(content=(ROOT/'public/stage.css').read_text())
    frame.evaluate(WRAPPER,{'code':(ROOT/'public/stage.mjs').read_text(),'hash':'#token='+VIEW+'&preview=1','client':str(uuid.uuid4())})
    return frame

def setup_wizard(page,width=1440,height=1100):
    page.set_viewport_size({'width':width,'height':height})
    page.set_content(html('setup.html'))
    page.add_style_tag(content=(ROOT/'public/studio.css').read_text())
    page.add_style_tag(content=(ROOT/'public/setup.css').read_text())
    page.evaluate(WRAPPER,{'code':(ROOT/'public/setup.mjs').read_text(),'hash':'#admin='+ADMIN,'client':str(uuid.uuid4())})
    page.locator('#settings').wait_for(state='visible')

if __name__=='__main__':
    fetch_local('/api/control',{'method':'POST','headers':{'Authorization':'Bearer '+ADMIN,'Content-Type':'application/json'},'body':json.dumps({'action':'stop','force':True})})
    fetch_local('/api/control',{'method':'POST','headers':{'Authorization':'Bearer '+ADMIN,'Content-Type':'application/json'},'body':json.dumps({'action':'reset'})})
    threading.Thread(target=consume,daemon=True).start()
    with sync_playwright() as p:
        browser=p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox'])
        page=browser.new_page();errors=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.expose_function('__http',fetch_local);page.expose_function('__pull',pull)
        setup_wizard(page)
        page.locator('[name=SHOW_TITLE]').fill('夜ふかし観測室')
        page.locator('.savebar button').click();page.wait_for_timeout(250)
        assert '保存' in page.locator('#save-status').inner_text()
        page.screenshot(path=str(ROOT/'docs/setup-preview.png'),full_page=True)
        wizard_mobile=browser.new_page();wizard_mobile.expose_function('__http',fetch_local);wizard_mobile.expose_function('__pull',pull)
        setup_wizard(wizard_mobile,390,844)
        wizard_mobile.screenshot(path=str(ROOT/'docs/setup-mobile.png'),full_page=True)
        assert wizard_mobile.evaluate('document.documentElement.scrollWidth') <= 390
        wizard_mobile.close()
        frame=setup_page(page,1440,1100)
        frame.locator('#audio-button').click()
        page.locator('#start').click()
        page.wait_for_timeout(2000)
        assert 'お話し中' in page.locator('#phase').inner_text(),page.locator('#phase').inner_text()
        assert 'ノア' in frame.locator('#caption').inner_text()
        page.screenshot(path=str(ROOT/'docs/studio-preview.png'),full_page=True)
        frame.locator('#canvas').screenshot(path=str(ROOT/'docs/stage-preview.png'))
        page.locator('#chat-input').fill('小さなロボットと暮らしたい')
        page.locator('#chat-form').evaluate('(form)=>form.requestSubmit()')
        page.wait_for_timeout(12500)
        spoken=page.locator('#spoken').inner_text();score=frame.locator('#score').inner_text();activity=page.locator('#activity').inner_text()
        assert int(spoken.split()[0])>=1,spoken
        assert frame.locator('#game-panel').is_hidden()
        assert 'コメント' in activity,activity
        page.locator('#panic').click();page.wait_for_timeout(300)
        assert '緊急停止中'==page.locator('#phase').inner_text()
        page.locator('#start').click();page.wait_for_timeout(300)
        assert '待機中'==page.locator('#phase').inner_text()
        mobile=browser.new_page();mobile.expose_function('__http',fetch_local);mobile.expose_function('__pull',pull)
        setup_page(mobile,390,844);mobile.wait_for_timeout(200)
        mobile.screenshot(path=str(ROOT/'docs/mobile-preview.png'),full_page=True)
        mobile_width=mobile.evaluate('document.body.scrollWidth')
        assert mobile_width<=390,mobile_width
        assert not errors,errors
        result={'transport':'isolated DOM with actual loopback HTTP/SSE bridge; browser navigation unavailable by managed policy','browser':browser.version,'checks':{'autonomous_demo_started':True,'speech_started_ack':True,'speech_completed':spoken,'talk_profile':True,'game_hidden':True,'setup_save':True,'setup_mobile_no_overflow':True,'emergency_stop':True,'explicit_reset':True,'mobile_no_horizontal_overflow':mobile_width<=390,'page_errors':errors},'desktop_viewport':[1440,1100],'mobile_viewport':[390,844],'real_external_services_tested':False, 'normal_url_navigation':'blocked by managed Chromium policy (not modified)' }
        (ROOT/'docs/browser-check.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
        print(json.dumps(result,ensure_ascii=False,indent=2))
        finished=True;browser.close()
