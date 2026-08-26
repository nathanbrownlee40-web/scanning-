const API = 'https://v3.football.api-sports.io';

exports.handler = async function (event) {
  const key = process.env.API_FOOTBALL_KEY;
  if (!key) {
    return json(500, { errors: { configuration: 'API_FOOTBALL_KEY is not configured in Netlify.' } });
  }

  const path = event.queryStringParameters?.path || '';
  if (!path.startsWith('/')) {
    return json(400, { errors: { request: 'Invalid API path.' } });
  }

  // Only proxy read-only API-Football GET requests.
  try {
    const upstream = await fetch(API + path, {
      headers: {
        'x-apisports-key': key,
        'Accept': 'application/json'
      }
    });
    const text = await upstream.text();
    return {
      statusCode: upstream.status,
      headers: {
        'Content-Type': upstream.headers.get('content-type') || 'application/json',
        'Cache-Control': 'no-store'
      },
      body: text
    };
  } catch (err) {
    return json(502, { errors: { upstream: err.message } });
  }
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body)
  };
}
