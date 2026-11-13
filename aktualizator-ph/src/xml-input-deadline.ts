import {performance} from 'node:perf_hooks';

// Frame handoff can wait for the parent to finish other synchronous source
// work. Charge actual event-loop idle waiting, then start the separate30s
// validator service deadline only after the complete frame was written.
export class XmlInputDeadline {
  private timer:ReturnType<typeof setTimeout>|undefined;
  private stopped=false;private start:number;
  constructor(private expire:()=>void,private budgetMs=30_000,private idle=()=>performance.eventLoopUtilization().idle){
    if(!Number.isFinite(budgetMs)||budgetMs<=0)throw new Error('Invalid XML input deadline.');
    this.start=idle();this.arm(budgetMs);
  }
  private arm(delay:number){this.timer=setTimeout(()=>{
    if(this.stopped)return;
    const remaining=this.budgetMs-Math.max(0,this.idle()-this.start);
    if(remaining<=0){this.stopped=true;this.expire();}
    else this.arm(Math.max(1,remaining));
  },delay);}
  cancel(){this.stopped=true;if(this.timer)clearTimeout(this.timer);}
}
