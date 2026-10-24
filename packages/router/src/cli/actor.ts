/** Noninteractive automation is a supervisor, never an implicit human override. */
export function cliDecisionActor(input:{id:string;humanRequested:boolean;stdinIsTTY:boolean;stdoutIsTTY:boolean}):{kind:"human"|"supervisor";id:string}{
  if(input.humanRequested&&(!input.stdinIsTTY||!input.stdoutIsTTY))throw new Error("human_authority_required: --human requires an interactive terminal; use the signed-in panel for manual approval");
  return {kind:input.humanRequested?"human":"supervisor",id:input.humanRequested?input.id:`supervisor:${input.id}`};
}
