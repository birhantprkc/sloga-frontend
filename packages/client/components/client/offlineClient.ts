import { type ClientOptions, Client } from "stoat.js";

/**
 * A preset node configuration. Without one, `new Client()` fetches `GET /`
 * from its default baseURL (upstream Stoat's public API) to learn it, and a
 * 429 from there lands after the test ends and fails the whole spec file.
 */
const OFFLINE_CONFIG = {
  revolt: "test",
  features: {
    autumn: { enabled: false, url: "" },
    january: { enabled: false, url: "" },
  },
  ws: "ws://127.0.0.1:9",
  app: "",
  vapid: "",
  build: {},
};

/**
 * A stoat.js client for unit specs that never touches the network when it is
 * constructed.
 * @param options Client options
 * @returns Client
 */
export function offlineClient(options?: Partial<ClientOptions>): Client {
  return new Client(options, OFFLINE_CONFIG as never);
}
