// ─── Railway GraphQL API Client — src/admin/railway-client.js ─────
//
// Wrapper for Railway's GraphQL API (backboard.railway.app).
// Requires RAILWAY_API_TOKEN env var scoped to the Reece project.

const RAILWAY_API = 'https://backboard.railway.app/graphql/v2';

export const railwayQuery = async (query, variables = {}) => {
  const token = process.env.RAILWAY_API_TOKEN;
  if (!token) throw new Error('RAILWAY_API_TOKEN not configured');

  const res = await fetch(RAILWAY_API, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Railway API ${res.status}: ${text}`);
  }

  const data = await res.json();
  if (data.errors?.length) {
    throw new Error(`Railway GQL: ${data.errors[0].message}`);
  }

  return data.data;
};

export const getServiceId = () => {
  const id = process.env.RAILWAY_SERVICE_ID;
  if (!id) throw new Error('RAILWAY_SERVICE_ID not configured');
  return id;
};
