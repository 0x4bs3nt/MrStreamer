import { randomUUID } from "node:crypto";
import type { Driver } from "./installed-upgrade.ts";

type MediaDriver = Pick<Driver, "actions" | "wait"> & {
  page: Pick<Driver["page"], "evaluate" | "send">;
};
type Stage = "header" | "ask" | "confirm";
interface Geometry {
  x: number;
  y: number;
  rect: { x: number; y: number; width: number; height: number };
  viewport: { width: number; height: number; scrollX: number; scrollY: number };
  rowScroll: { top: number; left: number }[];
  hit: { tag: string; text: string } | null;
  contained: boolean;
  target: { tag: string; text: string };
  row: { tag: string; text: string };
}
interface Delivery {
  stage: Stage;
  at: number;
  type: string;
  target: { tag: string; text: string } | null;
  contained: boolean;
  clientX: number;
  clientY: number;
  isTrusted: boolean | null;
}
interface Snapshot {
  at: number;
  connected: boolean;
  rowConnected: boolean;
  disabled: boolean;
  sameTarget: boolean;
  expanded: string | null;
  region: boolean;
  prompt: boolean;
  events: Delivery[];
  truncated: boolean;
}
interface Phase {
  stage: Stage;
  initial?: Geometry;
  final?: Geometry;
  commands: {
    type: string;
    requestAt: number;
    ackAt?: number;
    params: Record<string, unknown>;
    reply?: Awaited<ReturnType<MediaDriver["page"]["send"]>>;
    error?: string;
  }[];
  snapshots: (Snapshot & { phase: string })[];
  outcome?: { budgetMs: number; releaseAckAt: number; deadline: number; remainingMs: number };
  diagnosticErrors: string[];
  error?: string;
}
interface MediaInputEvidence {
  trust: string;
  rowState?: { at: number; expanded: string };
  phases: Phase[];
  diagnosticErrors: string[];
  error?: string;
}
const errorText = (error: unknown) =>
  error instanceof Error ? (error.stack ?? error.message) : String(error);

/** Writes media-removal evidence after each stage and before listener cleanup. */
export async function removeMediaSubscription(
  d: MediaDriver,
  writeEvidence: (evidence: MediaInputEvidence) => Promise<void>,
): Promise<void> {
  const boundary = `Symbol.for(${JSON.stringify(`mrstreamer.media-removal.${randomUUID()}`)})`;
  const rows = `[...document.querySelectorAll('li')].filter(r=>r.querySelector('button')?.textContent.includes(' · '))`;
  const resolveTarget = `(stage === 'header'
    ? [...p.row.querySelectorAll('button[aria-expanded]')]
    : [...p.row.querySelectorAll('button')].filter(b=>stage === 'ask'
      ? b.textContent.trim().startsWith('Remove ') : b.textContent.trim() === 'Remove'))`;
  const describe = `const summary = e => e ? {tag:e.tagName??e.nodeName,text:(e.textContent??'').trim().slice(0,120)} : null;`;
  const geometry = `
    ${describe}
    const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
    const hit=document.elementFromPoint(x,y), rowScroll=[];
    for(let a=p.row;a;a=a.parentElement) rowScroll.push({top:a.scrollTop,left:a.scrollLeft});
    const geometry={x,y,rect:{x:r.x,y:r.y,width:r.width,height:r.height},
      viewport:{width:innerWidth,height:innerHeight,scrollX,scrollY},rowScroll,
      hit:summary(hit),contained:!!hit&&(hit===e||e.contains(hit)),target:summary(e),row:summary(p.row)};`;
  const validate = `
    const currentRows=${rows}, targets=${resolveTarget}, e=p.target;
    if(currentRows.length!==1 || currentRows[0]!==p.row || !p.row.isConnected ||
       targets.length!==1 || targets[0]!==e || !e?.isConnected ||
       e.tagName!=='BUTTON' || e.closest('li')!==p.row || e.matches(':disabled'))
      throw new Error('Media removal target missing, ambiguous, disabled, replaced or in wrong row');`;
  const trace: MediaInputEvidence = {
    trust:
      "Windows acceptance requires one contained isTrusted=true mousedown/mouseup/click per executed stage. CDP delivery is not OS or hardware input; synthetic trust is false/unavailable.",
    phases: [],
    diagnosticErrors: [],
  };
  const snapshot = async (record: Phase, phase: string, close = false) => {
    try {
      const value = await d.page.evaluate<Snapshot>(
        `(()=>{
        const p=globalThis[${boundary}]; if(!p) throw new Error('Media observer missing');
        const stage=${JSON.stringify(record.stage)}, current=p.stage===stage,
          e=current?p.target:null, targets=${resolveTarget};
        if(${close}) p.armed=false;
        return {at:Date.now(),connected:!!e?.isConnected,rowConnected:p.row.isConnected,
          disabled:!!e?.matches(':disabled'),sameTarget:targets.length===1&&targets[0]===e,
          expanded:p.row.querySelector('button[aria-expanded]')?.getAttribute('aria-expanded')??null,
          region:!!p.row.querySelector('[role=region]'),
          prompt:document.body.innerText.includes('from this device?'),
          events:current?p.events:[],truncated:current&&p.truncated};})()`,
        1000,
      );
      record.snapshots.push({ ...value, phase });
    } catch (error) {
      record.diagnosticErrors.push(`${phase}: ${errorText(error)}`);
    }
  };
  const input = async (record: Phase, type: string, point: { x: number; y: number }) => {
    const params = { type, ...point, button: "left", clickCount: 1 };
    const command: Phase["commands"][number] = { type, requestAt: Date.now(), params };
    record.commands.push(command);
    try {
      const reply = await d.page.send("Input.dispatchMouseEvent", params, 10_000);
      command.ackAt = Date.now();
      command.reply = reply;
      if (reply.error)
        throw new Error(`Media removal input protocol error: ${JSON.stringify(reply.error)}`);
      return command.ackAt;
    } catch (error) {
      command.error = errorText(error);
      throw error;
    }
  };
  const save = async () => {
    try {
      await writeEvidence(trace);
    } catch (error) {
      trace.diagnosticErrors.push(`write evidence: ${errorText(error)}`);
    }
  };
  const stage = async (
    name: Stage,
    label: string,
    existenceMs: number,
    outcomeMs: number,
    outcomeLabel: string,
    check: () => Promise<boolean>,
  ) => {
    const record: Phase = { stage: name, commands: [], snapshots: [], diagnosticErrors: [] };
    trace.phases.push(record);
    let failed = false;
    let primaryError: unknown;
    try {
      await d.wait(
        () =>
          d.page.evaluate<boolean>(
            `(()=>{
        const p=globalThis[${boundary}],stage=${JSON.stringify(name)};
        return ${resolveTarget}.length>0;})()`,
            1000,
          ),
        existenceMs,
        label,
      );
      record.initial = await d.page.evaluate<Geometry>(
        `(()=>{
        const p=globalThis[${boundary}],stage=${JSON.stringify(name)};
        p.armed=false;p.stage=stage;p.events=[];p.truncated=false;
        {const targets=${resolveTarget}; p.target=targets.length===1?targets[0]:null;}
        ${validate}
        e.scrollIntoView({block:'center'}); ${geometry} return geometry;})()`,
      );
      await input(record, "mouseMoved", { x: record.initial.x, y: record.initial.y });
      await d.page.evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
      d.actions.push({ at: new Date().toISOString(), action: label });
      // This check also arms capture and is the last page command before the single press.
      record.final = await d.page.evaluate<Geometry>(
        `(()=>{
        const p=globalThis[${boundary}],stage=${JSON.stringify(name)};
        ${validate} ${geometry}
        p.stage=stage;p.events=[];p.truncated=false;
        p.armed=!!r.width&&!!r.height&&geometry.contained;return geometry;})()`,
      );
      if (!record.final.rect.width || !record.final.rect.height || !record.final.contained)
        throw new Error("Media removal target not under pointer");
      await input(record, "mousePressed", { x: record.final.x, y: record.final.y });
      const releaseAckAt = await input(record, "mouseReleased", {
        x: record.final.x,
        y: record.final.y,
      });
      const deadline = releaseAckAt + outcomeMs;
      await snapshot(record, "post-release");
      const remainingMs = deadline - Date.now();
      record.outcome = { budgetMs: outcomeMs, releaseAckAt, deadline, remainingMs };
      if (remainingMs <= 0)
        throw new Error(`Media removal instrumentation/evidence overrun: ${outcomeLabel}`);
      // Delivery diagnostics cannot replace or skip the original outcome assertion.
      await d.wait(check, remainingMs, outcomeLabel);
    } catch (error) {
      failed = true;
      primaryError = error;
      record.error = errorText(error);
    } finally {
      await snapshot(record, failed ? "original-failure" : "post-outcome", true);
      const last = record.snapshots.at(-1);
      if (
        !last ||
        last.truncated ||
        ["mousedown", "mouseup", "click"].some((type) => {
          const events = last.events.filter((event) => event.type === type);
          return events.length !== 1 || !events[0]?.contained || events[0].stage !== name;
        })
      )
        record.diagnosticErrors.push("Missing, truncated or wrong-target native delivery receipts");
      await save();
    }
    if (failed) throw primaryError;
    if (record.diagnosticErrors.length || trace.diagnosticErrors.length)
      throw new Error(
        `Media removal evidence incomplete: ${[...record.diagnosticErrors, ...trace.diagnosticErrors].join("; ")}`,
      );
  };
  let failed = false;
  let primaryError: unknown;
  try {
    await d.wait(
      () =>
        d.page.evaluate<boolean>(
          `(${rows})[0]?.querySelector('button[aria-expanded]')!=null`,
          1000,
        ),
      10_000,
      "subscription header",
    );
    const expanded = await d.page.evaluate<string>(
      `(()=>{
      const rows=${rows};if(rows.length!==1)throw new Error('Expected one subscription row');
      const row=rows[0],headers=row.querySelectorAll('button[aria-expanded]');
      if(headers.length!==1)throw new Error('Expected one subscription header');
      const p={row,target:null,armed:false,stage:null,events:[],truncated:false};
      ${describe}
      p.listener=event=>{
        if(!p.armed)return;
        if(p.events.length>=128){p.truncated=true;return;}
        p.events.push({stage:p.stage,at:Date.now(),type:event.type,target:summary(event.target),
          contained:event.target===p.target||p.target.contains(event.target),
          clientX:event.clientX,clientY:event.clientY,isTrusted:event.isTrusted??null});
      };
      globalThis[${boundary}]=p;
      for(const type of ['mousedown','mouseup','click'])document.addEventListener(type,p.listener,true);
      return headers[0].getAttribute('aria-expanded');})()`,
    );
    trace.rowState = { at: Date.now(), expanded };
    if (expanded !== "true" && expanded !== "false")
      throw new Error("Invalid subscription expansion");
    const region = () =>
      d.page.evaluate<boolean>(
        `!!globalThis[${boundary}].row.querySelector('[role=region]')`,
        1000,
      );
    if (expanded === "false")
      await stage(
        "header",
        "Open collapsed subscription",
        10_000,
        10_000,
        "subscription row",
        region,
      );
    else await d.wait(region, 10_000, "subscription row");
    await stage("ask", "Ask removal", 30_000, 10_000, "removal confirmation", () =>
      d.page.evaluate<boolean>("document.body.innerText.includes('from this device?')"),
    );
    await stage("confirm", "Remove", 30_000, 30_000, "Connect", () =>
      d.page.evaluate<boolean>('!!document.querySelector("form input")'),
    );
  } catch (error) {
    failed = true;
    primaryError = error;
    trace.error = errorText(error);
  } finally {
    await save();
    try {
      await d.page.evaluate(
        `(()=>{
        const p=globalThis[${boundary}];if(!p)return;
        p.armed=false;
        for(const type of ['mousedown','mouseup','click'])document.removeEventListener(type,p.listener,true);
        delete globalThis[${boundary}];})()`,
        1000,
      );
    } catch (error) {
      trace.diagnosticErrors.push(`remove listeners: ${errorText(error)}`);
      await save();
    }
  }
  if (failed) throw primaryError;
  if (trace.diagnosticErrors.length)
    throw new Error(`Media removal evidence incomplete: ${trace.diagnosticErrors.join("; ")}`);
}
