const API = 'https://v3.football.api-sports.io';

exports.handler = async function (event) {
  const key = process.env.API_FOOTBALL_KEY;

  if (!key) {
    return json(500, {
      errors: {
        configuration: 'API_FOOTBALL_KEY is not configured in Netlify.'
      }
    });
  }

  const path = event.queryStringParameters?.path || '';

  if (!path.startsWith('/')) {
    return json(400, {
      errors: {
        request: 'Invalid API path.'
      }
    });
  }

  try {
    const upstream = await fetch(API + path, {
      method: 'GET',
      headers: {
        'x-apisports-key': key,
        'Accept': 'application/json'
      }
    });

    const text = await upstream.text();

    // Try to make sure the response sent to the browser is valid JSON.
    let data;

    try {
      data = JSON.parse(text);
    } catch (parseError) {
      return json(502, {
        errors: {
          upstream: `API-Football returned non-JSON data (HTTP ${upstream.status}).`,
          response: text.slice(0, 500)
        }
      });
    }

    return {
      statusCode: upstream.status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      },
      body: JSON.stringify(data)
    };

  } catch (err) {
    return json(502, {
      errors: {
        upstream: err.message || 'Unable to reach API-Football.'
      }
    });
  }
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    },
    body: JSON.stringify(body)
  };
}
