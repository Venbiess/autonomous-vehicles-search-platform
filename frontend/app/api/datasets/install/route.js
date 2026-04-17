export async function POST(request) {
  await request.json().catch(() => null);
  return Response.json(
    { error: "Dataset installation endpoint is not implemented by master server." },
    { status: 501 }
  );
}
