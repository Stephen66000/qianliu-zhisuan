import { sql } from "kysely";

export const REQUEST_FAULT_SIGNALS = [
  "request_failure",
  "routing_anomaly",
  "streaming_anomaly",
];

/** Admission persists the event number, not the HTTP response error code.
 * Match the owning resource's tenant as availability_event has no tenant column.
 * Unknown evidence stays visible; completed schedule events remain intentional.
 */
export function isPlannedRequestBlock(
  requestIdColumn: string,
  enterpriseIdColumn: string,
) {
  return sql<boolean>`EXISTS (
    SELECT 1 FROM ai_request planned_request
    JOIN availability_event planned_event ON planned_event.event_number=planned_request.error_code
    JOIN provider_resource planned_resource ON planned_resource.id=planned_event.provider_resource_id
      AND planned_resource.enterprise_id=planned_request.enterprise_id
    WHERE planned_request.id=${sql.ref(requestIdColumn)}
      AND planned_request.enterprise_id=${sql.ref(enterpriseIdColumn)}
      AND planned_request.error_classification='RUNTIME_ASSURANCE_BLOCKED'
      AND planned_event.availability_decision='BLOCKED_SCHEDULE'
  )`;
}
