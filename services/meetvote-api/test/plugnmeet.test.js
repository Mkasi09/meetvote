import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createPlugNmeetClient } from "../src/plugnmeet.js";

test("signs raw request bodies and creates rooms and meeting-only join tokens", async () => {
  const requests = [];
  const client = createPlugNmeetClient({
    apiUrl: "http://video.internal",
    clientUrl: "http://video-client.internal",
    apiKey: "test-api-key",
    secret: "test-api-secret",
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url: String(url), body, options });
      assert.equal(options.headers["API-KEY"], "test-api-key");
      assert.equal(options.headers["HASH-SIGNATURE"], createHmac("sha256", "test-api-secret").update(options.body).digest("hex"));
      return String(url).endsWith("/room/create")
        ? Response.json({ status: true, room_info: { room_id: body.room_id } })
        : Response.json({ status: true, token: { value: "signed-video-token" } });
    }
  });

  assert.equal(client.isConfigured(), true);
  assert.equal(client.getClientUrl(), "http://video-client.internal");
  const roomId = await client.createRoom({ title: "Annual meeting" });
  assert.match(roomId, /^mv-[a-f0-9-]+$/);
  const token = await client.createJoinToken({
    roomId,
    userId: "resident-123",
    name: "Estate resident"
  });

  assert.equal(token, "signed-video-token");
  assert.deepEqual(requests.map(({ url }) => url), [
    "http://video.internal/auth/room/create",
    "http://video.internal/auth/room/getJoinToken"
  ]);
  assert.equal(requests[0].body.metadata.room_title, "Annual meeting");
  assert.equal(requests[0].body.metadata.room_features.auto_gen_user_id, true);
  assert.equal(requests[1].body.room_id, roomId);
  assert.deepEqual(requests[1].body.user_info, {
    user_id: "resident-123",
    name: "Estate resident",
    is_admin: false
  });
  assert.equal(Object.hasOwn(requests[1].body.user_info, "is_presenter"), false);
});

test("does not expose upstream response details when the live meeting service rejects a request", async () => {
  const client = createPlugNmeetClient({
    apiUrl: "http://video.internal",
    clientUrl: "http://video-client.internal",
    apiKey: "test-api-key",
    secret: "test-api-secret",
    fetchImpl: async () => new Response("sensitive upstream detail", { status: 500 })
  });

  await assert.rejects(client.createRoom({ title: "Annual meeting" }), {
    status: 502,
    message: "The live meeting service rejected the request (status 500)."
  });
});
