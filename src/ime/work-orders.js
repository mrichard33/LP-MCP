// ─── IME Work Order Operations — src/ime/work-orders.js ──────────
//
// Wrappers around IME WorkOrder endpoints used by Reece's outbound flows.
// Most state-transition endpoints return 204 No Content on success.
//
// Path/body conventions follow the IME MIC Provider API Introduction PDF
// and the live UAT swagger at:
//   https://imewebapiexternal-uat.azurewebsites.net/swagger/index.html
// Confirm against UAT swagger before flipping IME_ENV=prod.

import client from './client.js';

export async function getWorkOrder(workOrderId) {
  const { data } = await client.get(`/api/v2/WorkOrders/${workOrderId}`);
  return data;
}

export async function scheduleAppointment(workOrderId, isoDate) {
  const { status } = await client.post(
    `/api/v2/WorkOrders/${workOrderId}/appointments`,
    { date: isoDate, type: 'ESTIMATE_APPOINTMENT' }
  );
  return status === 204;
}

export async function rescheduleAppointment(workOrderId, isoDate) {
  const { status } = await client.put(
    `/api/v2/WorkOrders/${workOrderId}/appointments`,
    { date: isoDate, type: 'ESTIMATE_APPOINTMENT' }
  );
  return status === 204;
}

export async function scheduleInstall(workOrderId, isoDate, estimatedCompletionDate) {
  const { status } = await client.post(
    `/api/v2/WorkOrders/${workOrderId}/appointments`,
    { date: isoDate, type: 'INSTALL_STARTED', estimatedCompletionDate }
  );
  return status === 204;
}

export async function closeWorkOrder(workOrderId) {
  const { status } = await client.post(`/api/v2/WorkOrders/${workOrderId}/close`);
  return status === 204;
}

export async function cancelWorkOrder(workOrderId) {
  const { status } = await client.post(`/api/v2/WorkOrders/${workOrderId}/cancel`);
  return status === 204;
}

export async function completeWorkOrder(workOrderId) {
  const { status } = await client.post(`/api/v2/WorkOrders/${workOrderId}/complete`);
  return status === 204;
}

export async function addComment(workOrderId, comment) {
  const { status } = await client.post(
    `/api/v2/WorkOrders/${workOrderId}/comments`,
    { comment }
  );
  return status === 204;
}
