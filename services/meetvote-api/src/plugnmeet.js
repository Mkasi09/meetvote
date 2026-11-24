import { createHmac, randomUUID } from "node:crypto";

const required = (value, name) => {
  if (!value) {
    throw Object.assign(new Error(`Live meeting setup is unavailable (${name}). Contact an administrator.`), { status: 503 });
  }
  return value;
};

function findField(value, field) {
  if (!value || typeof value !== "object") return undefined;
  if (Object.hasOwn(value, field) && value[field] !== null) return value[field];
  for (const child of Object.values(value)) {
    const found = findField(child, field);
    if (found !== undefined) return found;
  }
}

export function createPlugNmeetClient({
  apiUrl = process.env.PLUGNMEET_API_URL,
  clientUrl = process.env.PLUGNMEET_CLIENT_URL,
  apiKey = process.env.PLUGNMEET_API_KEY,
  secret = process.env.PLUGNMEET_API_SECRET,
  fetchImpl = fetch
} = {}) {
  async function request(path, payload) {
    const base = required(apiUrl, "video service address");
    const key = required(apiKey, "video service key");
    const sharedSecret = required(secret, "video service secret");
    const body = JSON.stringify(payload);
    const signature = createHmac("sha256", sharedSecret).update(body).digest("hex");
    let response;
    try {
      response = await fetchImpl(new URL(`/auth/${path}`, base), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "API-KEY": key,
          "HASH-SIGNATURE": signature
        },
        body,
        signal: AbortSignal.timeout(10_000)
      });
    } catch {
      throw Object.assign(new Error("The live meeting service is unavailable. Try again or contact an administrator."), { status: 502 });
    }

    if (!response.ok) {
      throw Object.assign(new Error(`The live meeting service rejected the request (status ${response.status}).`), { status: 502 });
    }
    let result;
    try {
      result = await response.json();
    } catch {
      throw Object.assign(new Error("The live meeting service returned an invalid response."), { status: 502 });
    }
    if (result.status !== true) {
      throw Object.assign(new Error("The live meeting service could not complete the request. Check its configuration and try again."), { status: 502 });
    }
    return result;
  }

  return {
    isConfigured() {
      return Boolean(apiUrl && clientUrl && apiKey && secret);
    },
    getClientUrl() {
      return required(clientUrl, "video meeting client address");
    },
    async createRoom({ roomId = `mv-${randomUUID()}`, title }) {
      if (!/^[a-zA-Z0-9_-]+$/.test(roomId)) throw new Error("Invalid internal room identifier.");
      const result = await request("room/create", {
        room_id: roomId,
        metadata: {
          room_title: title,
          room_features: {
            auto_gen_user_id: true,
            allow_webcams: true,
            allow_screen_share: true,
            allow_view_other_webcams: true,
            allow_view_other_users_list: true,
            chat_features: { is_allow: true },
            recording_features: {
              is_allow: process.env.PLUGNMEET_RECORDING_ENABLED === "true",
              is_allow_local: process.env.PLUGNMEET_RECORDING_ENABLED === "true",
              is_allow_cloud: false
            }
          }
        }
      });
      if (!result.room_info?.room_id) {
        throw Object.assign(new Error("The live meeting service did not return a room identifier."), { status: 502 });
      }
      return result.room_info.room_id;
    },
    async createJoinToken({ roomId, userId, name, isAdmin = false }) {
      const result = await request("room/getJoinToken", {
        room_id: roomId,
        user_info: {
          user_id: userId,
          name,
          is_admin: isAdmin
        }
      });
      const token = typeof result.token === "string" ? result.token : result.token?.value;
      if (!token) throw Object.assign(new Error("The live meeting service did not return a join token."), { status: 502 });
      return token;
    }
  };
}
