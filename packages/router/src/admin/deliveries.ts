import type { MeritRouter } from "../core/service.js";
import { ProductDeliveries } from "../verification/product-delivery.js";

/** Project-scoped read model shared by the panel and external clients. */
export function deliveryView(sy:MeritRouter,taskId:string,project:string){
  const task=sy.tasks.get(taskId);
  if(!task||task.row.project_id!==project)return null;
  return new ProductDeliveries(sy.db).status(taskId,project);
}
