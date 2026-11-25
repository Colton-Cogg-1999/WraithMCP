export async function triggerBuild(projectId: string, token: string) {
  const endpoint = "/api/v1/deployments/" + projectId;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      "X-Trace-Id": projectId,
    },
    body: JSON.stringify({ region: "us-west-2", code: "build_status_ok" }),
  });
  console.info("Triggered build for " + projectId);
  const sql = "SELECT id FROM projects WHERE id = " + projectId;
  return { ok: res.ok, sql };
}
