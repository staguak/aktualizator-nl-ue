import {isCalendarDate} from './calendar.js';
import {sourceAuditMode} from './source-audit.js';

export const PUBLISHER_WORKFLOW='Aktualizator prawa NL i UE';
const operations=['check','initialize','update','rollback','recover'];
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export function assertPublicationAllowed(env:NodeJS.ProcessEnv):void{
  if(env.GITHUB_ACTIONS==='true'){
    if(env.GITHUB_REF!=='refs/heads/main'||env.GITHUB_WORKFLOW!==PUBLISHER_WORKFLOW||
      !['workflow_dispatch','schedule'].includes(env.GITHUB_EVENT_NAME??'')||
      !/^[-A-Za-z0-9_.]+\/[-A-Za-z0-9_.]+$/.test(env.GITHUB_REPOSITORY??''))
      throw new Error('Publication requires the trusted main workflow.');
    if(env.GITHUB_EVENT_NAME==='schedule'){
      if(env.LAW_PAIRED_RELEASES_ENABLED!=='true')throw new Error('Scheduled updates are disabled.');
      return;
    }
  }
  if(env.INPUT_APPROVE_MUTATION!=='true')throw new Error('Mutation requires explicit approval.');
}

export function publicCommand(args:string[],inherited:NodeJS.ProcessEnv){
  const env={...inherited};let planOnly=false;const seen=new Set<string>();
  const options:Record<string,string>={'operation':'INPUT_RELEASE_OPERATION','range-to':'INPUT_RANGE_TO',
    'target-release-id':'INPUT_TARGET_RELEASE_ID','expected-active-sha256':'INPUT_EXPECTED_ACTIVE_SHA256',
    'config-dir':'LAW_CONFIG_DIR','namespace':'LAW_RELEASE_NAMESPACE'};
  for(const arg of args){
    const match=/^--([a-z][a-z0-9-]*)(?:=(.*))?$/.exec(arg);
    if(!match||seen.has(match[1]))throw new Error('Unknown or duplicate command option.');
    const [,name,value]=match;seen.add(name);
    if(name==='plan'&&value===undefined)planOnly=true;
    else if(name==='approve-mutation'&&value===undefined)env.INPUT_APPROVE_MUTATION='true';
    else if(name==='full-source-audit'&&value===undefined)env.LAW_SOURCE_AUDIT='unconditional';
    else if(Object.hasOwn(options,name)&&value)env[options[name]]=value;
    else throw new Error('Unknown command option or missing value.');
  }
  const scheduled=env.GITHUB_ACTIONS==='true'&&env.GITHUB_EVENT_NAME==='schedule';
  const operation=scheduled?'update':env.INPUT_RELEASE_OPERATION?.trim()||'check';
  if(!operations.includes(operation))throw new Error('Unsupported release operation.');
  const namespace=env.LAW_RELEASE_NAMESPACE?.trim()||'production';
  // Public installations never select the private acceptance/test namespaces.
  if(!/^[A-Za-z0-9_-]{1,80}$/.test(namespace)||namespace.startsWith('release-test-'))throw new Error('Invalid installation namespace.');
  env.LAW_RELEASE_NAMESPACE=namespace;
  if(scheduled)env.LAW_SOURCE_AUDIT='unconditional';
  const sourceAudit=sourceAuditMode(env),mutating=operation!=='check';
  if(mutating)assertPublicationAllowed(env);
  if(sourceAudit==='unconditional'&&!['initialize','update'].includes(operation))throw new Error('Source audit requires initialize or update.');
  const rangeTo=env.INPUT_RANGE_TO?.trim()||'',target=env.INPUT_TARGET_RELEASE_ID?.trim()||'',expected=env.INPUT_EXPECTED_ACTIVE_SHA256?.trim()||'';
  if(rangeTo&&(!['initialize','update'].includes(operation)||!isCalendarDate(rangeTo)))throw new Error('Invalid end date for this operation.');
  if(['rollback','recover'].includes(operation)?!uuid.test(target):!!target)throw new Error('Invalid target release.');
  if(operation==='recover'?!/^(?:[a-f0-9]{64}|missing)$/.test(expected):!!expected)throw new Error('Invalid expected active hash.');
  if(rangeTo)env.LAW_RANGE_TO=rangeTo;
  const releaseArgs=operation==='check'?['--check','--full']:operation==='initialize'?['--initialize']:
    operation==='rollback'?[`--rollback=${target}`]:operation==='recover'?[`--recover=${target}`,`--expected-active-sha256=${expected}`]:[];
  return {operation,namespace,rangeTo,sourceAudit,mutating,planOnly,releaseArgs,env};
}

export async function executePublicCommand(plan:ReturnType<typeof publicCommand>,run:(args:string[])=>Promise<number>){
  const result=await run(plan.releaseArgs);
  return result!==0||!plan.mutating?result:run(['--check','--full']);
}
