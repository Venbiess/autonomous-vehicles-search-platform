const masterEndpoint = process.env.MASTER_ENDPOINT || "http://localhost:9002";

export async function POST(request) {
  try {
    const body = await request.json();
    const response = await fetch(`${masterEndpoint}/datasets/install`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json();
    return Response.json(payload, { status: response.status });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
}
