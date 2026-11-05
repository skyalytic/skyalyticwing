export const GENERATION_PENDING_MESSAGE='生成任务的提交结果待核实，已暂停后续生成。请查询原任务，不要重新提交，以免重复扣费。';
export class GenerationPending extends Error {
  readonly code='generation_pending';
  constructor(readonly taskId?:string){super(GENERATION_PENDING_MESSAGE);}
}
