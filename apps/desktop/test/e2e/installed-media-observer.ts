import type { Page } from "./app.ts";

type ObserverPage = Pick<Page, "evaluate" | "on" | "send">;
interface Observation {
  at: number;
  sequence: number;
  window: number;
}
interface MediaObservation extends Observation {
  requestId: number | null;
  deliverySequence: number | null;
}
interface TypeCheck extends MediaObservation {
  type: string;
  supported: boolean;
}
interface BrowserError extends MediaObservation {
  code: number | null;
  message: string;
  time: number;
  generation: number;
}
interface Delivery extends Observation {
  requestId: number;
  requestSequence: number;
  responseWindow: number;
  requestUrl: string;
  url: string;
  query: string;
  status: number;
  headers: Record<string, string>;
  video: string | null;
  audio: string | null;
}
interface WindowStart extends Observation {
  name: string;
}
interface BrowserFacts {
  sequence: number;
  window: number;
  checks: TypeCheck[];
  errors: BrowserError[];
  generation: number;
  buffers: (MediaObservation & { generation: number; type: string })[];
  requests: (Observation & { id: number; url: string })[];
  deliveries: Delivery[];
  currentDelivery: Delivery | null;
  injections: (MediaObservation & { generation: number })[];
}
export function browserFacts(page: ObserverPage) {
  return page.evaluate<BrowserFacts>(
    `(()=>{const p=window.__installedMediaProbe;return p?{
      sequence:p.sequence,window:p.window,checks:p.checks,errors:p.errors,generation:p.generation,
      buffers:p.buffers,requests:p.requests,deliveries:p.deliveries,currentDelivery:p.delivery,injections:p.injections
    }:{sequence:0,window:0,checks:[],errors:[],generation:0,buffers:[],requests:[],deliveries:[],currentDelivery:null,injections:[]};})()`,
  );
}

/** Passive observations only. CDP receipt times are diagnostics, never browser causal order. */
export async function probe(page: ObserverPage) {
  const events: { nodeReceivedAt: number; kind: string; data: unknown }[] = [];
  const network: { nodeReceivedAt: number; data: unknown }[] = [];
  for (const method of [
    "Media.playerPropertiesChanged",
    "Media.playerEventsAdded",
    "Media.playerMessagesLogged",
    "Media.playerErrorsRaised",
  ])
    page.on(method, (data) => events.push({ nodeReceivedAt: Date.now(), kind: method, data }));
  page.on("Network.responseReceived", (data) => network.push({ nodeReceivedAt: Date.now(), data }));
  await page.send("Media.enable");
  // The title consumer gets the identical Response and body after its response facts are recorded.
  await page.evaluate(`(()=>{
    const p=window.__installedMediaProbe={node:null,checks:[],errors:[],generation:0,buffers:[],buffer:null,
      sequence:0,window:0,requestId:0,requests:[],deliveries:[],delivery:null,injections:[]};
    p.stamp=()=>({at:Date.now(),sequence:++p.sequence,window:p.window});
    p.mediaStamp=()=>({...p.stamp(),window:p.delivery?.window??p.window,
      requestId:p.delivery?.requestId??null,deliverySequence:p.delivery?.sequence??null});
    const fetch=window.fetch;
    window.fetch=function(...args){
      const input=args[0];
      if(typeof input!=='string'&&!(input instanceof URL)&&!(input instanceof Request))return fetch.apply(this,args);
      let url;
      try{url=new URL(input instanceof Request?input.url:input,document.baseURI);}
      catch{return fetch.apply(this,args);}
      if(!url.pathname.startsWith('/title/')||url.searchParams.has('only'))return fetch.apply(this,args);
      const request={...p.stamp(),id:++p.requestId,url:url.href};p.requests.push(request);
      return fetch.apply(this,args).then(response=>{
        const headers=Object.fromEntries(response.headers.entries());
        const header=name=>Object.entries(headers).find(([key])=>key.toLowerCase()===name)?.[1].toLowerCase()??null;
        const occurrence=p.stamp();
        const delivery={...occurrence,window:request.window,responseWindow:occurrence.window,
          requestId:request.id,requestSequence:request.sequence,requestUrl:request.url,
          url:response.url,query:response.url?new URL(response.url).search:'',status:response.status,headers,
          video:header('x-title-video'),audio:header('x-title-audio')};
        p.deliveries.push(delivery);if(request.window===p.window)p.delivery=delivery;return response;
      });
    };
    const support=MediaSource.isTypeSupported;
    MediaSource.isTypeSupported=function(...args){const supported=support.apply(this,args);
      p.checks.push({...p.mediaStamp(),type:args[0],supported});return supported;};
    const add=MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer=function(...args){const b=add.apply(this,args);p.buffer=b;
      p.buffers.push({...p.mediaStamp(),generation:++p.generation,type:args[0]});return b;};
    document.addEventListener('error',e=>{if(e.target instanceof HTMLVideoElement){
      const b=p.buffers.at(-1);p.errors.push({...p.stamp(),window:b?.window??p.window,
        requestId:b?.requestId??null,deliverySequence:b?.deliverySequence??null,code:e.target.error?.code??null,
        message:e.target.error?.message??'',time:e.target.currentTime,generation:p.generation});}},true);
  })()`);
  return {
    events,
    network,
    beginWindow(name: string) {
      return page.evaluate<WindowStart>(`(()=>{const p=window.__installedMediaProbe;
        p.node=null;p.progress=null;p.delivery=null;++p.window;return {...p.stamp(),name:${JSON.stringify(name)}};})()`);
    },
    async windowFacts(window: WindowStart) {
      const facts = await browserFacts(page);
      return {
        ...window,
        deliveries: facts.deliveries.filter(
          (item) =>
            item.window === window.window &&
            item.responseWindow === window.window &&
            item.requestSequence > window.sequence,
        ),
        checks: facts.checks.filter(
          (item) => item.window === window.window && item.sequence > window.sequence,
        ),
        errors: facts.errors.filter(
          (item) => item.window === window.window && item.sequence > window.sequence,
        ),
      };
    },
  };
}
