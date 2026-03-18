import axios from 'axios';

const LP_API_KEY = process.env.LP_API_KEY;
const LP_API_BASE_URL = (process.env.LP_API_BASE_URL || '').replace(/\/+$/, '');

const lpClient = axios.create({
  baseURL: LP_API_BASE_URL,
  headers: {
    'Authorization': `Bearer ${LP_API_KEY}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  },
  timeout: 30000,
});

// Retry logic: up to 3 retries with exponential backoff (1s, 4s, 16s)
async function withRetry(fn, maxRetries = 3) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) {
        const delay = Math.pow(4, attempt) * 1000; // 1s, 4s, 16s
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

// Circuit breaker state
let consecutiveFailures = 0;
let circuitOpen = false;
const CIRCUIT_THRESHOLD = 10;

function checkCircuit() {
  if (circuitOpen) {
    throw new Error('Circuit breaker OPEN — LP API has failed 10 consecutive times. Sync paused.');
  }
}

function recordSuccess() {
  consecutiveFailures = 0;
  circuitOpen = false;
}

function recordFailure() {
  consecutiveFailures++;
  if (consecutiveFailures >= CIRCUIT_THRESHOLD) {
    circuitOpen = true;
  }
}

export function resetCircuit() {
  consecutiveFailures = 0;
  circuitOpen = false;
}

export function getCircuitStatus() {
  return { consecutiveFailures, circuitOpen };
}

export async function getLeads(params = {}) {
  checkCircuit();
  try {
    const result = await withRetry(() => lpClient.get('/leads', { params }));
    recordSuccess();
    return result.data;
  } catch (err) {
    recordFailure();
    throw err;
  }
}

export async function getLead(leadId) {
  checkCircuit();
  try {
    const result = await withRetry(() => lpClient.get(`/leads/${leadId}`));
    recordSuccess();
    return result.data;
  } catch (err) {
    recordFailure();
    throw err;
  }
}

export async function getLeadsUpdatedSince(since) {
  checkCircuit();
  try {
    const result = await withRetry(() =>
      lpClient.get('/leads/updated-since', { params: { since } })
    );
    recordSuccess();
    return result.data;
  } catch (err) {
    recordFailure();
    throw err;
  }
}

export async function getLeadCalls(leadId) {
  checkCircuit();
  try {
    const result = await withRetry(() => lpClient.get(`/leads/${leadId}/calls`));
    recordSuccess();
    return result.data;
  } catch (err) {
    recordFailure();
    throw err;
  }
}

export async function getLeadNotes(leadId) {
  checkCircuit();
  try {
    const result = await withRetry(() => lpClient.get(`/leads/${leadId}/notes`));
    recordSuccess();
    return result.data;
  } catch (err) {
    recordFailure();
    throw err;
  }
}

export async function getLeadActivities(leadId) {
  checkCircuit();
  try {
    const result = await withRetry(() => lpClient.get(`/leads/${leadId}/activities`));
    recordSuccess();
    return result.data;
  } catch (err) {
    recordFailure();
    throw err;
  }
}

export async function getJob(jobId) {
  checkCircuit();
  try {
    const result = await withRetry(() => lpClient.get(`/jobs/${jobId}`));
    recordSuccess();
    return result.data;
  } catch (err) {
    recordFailure();
    throw err;
  }
}

export async function getDispositions() {
  checkCircuit();
  try {
    const result = await withRetry(() => lpClient.get('/dispositions'));
    recordSuccess();
    return result.data;
  } catch (err) {
    recordFailure();
    throw err;
  }
}

export async function getSources() {
  checkCircuit();
  try {
    const result = await withRetry(() => lpClient.get('/sources'));
    recordSuccess();
    return result.data;
  } catch (err) {
    recordFailure();
    throw err;
  }
}
