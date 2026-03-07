import { getOneBotConfig } from "./config.js";
import { connectForward, createServerAndWait, handleEchoResponse, setWs, startImageTempCleanup, stopConnection, stopImageTempCleanup } from "./connection.js";
import { handleGroupIncrease } from "./handlers/group-increase.js";
import { processInboundMessage } from "./handlers/process-inbound.js";
import type { OneBotMessage } from "./types.js";

export function registerService(api: any): void {
  api.registerService({
    id: "onebot-ws",
    start: async () => {
      const config = getOneBotConfig(api);
      if (!config) {
        api.logger?.warn?.("[onebot] no config, service not started");
        return;
      }

      try {
        const socket = config.type === "forward-websocket"
          ? await connectForward(config)
          : await createServerAndWait(config);

        setWs(socket);
        startImageTempCleanup();

        socket.on("message", (data) => {
          try {
            const payload = JSON.parse(data.toString());
            if (handleEchoResponse(payload)) return;
            if (payload.meta_event_type === "heartbeat") return;

            const msg = payload as OneBotMessage;
            if (msg.post_type === "message" && (msg.message_type === "private" || msg.message_type === "group")) {
              processInboundMessage(api, msg).catch((error) => {
                api.logger?.error?.(`[onebot] processInboundMessage failed: ${error instanceof Error ? error.message : String(error)}`);
              });
              return;
            }

            if (msg.post_type === "notice" && msg.notice_type === "group_increase") {
              handleGroupIncrease(api, msg).catch((error) => {
                api.logger?.error?.(`[onebot] handleGroupIncrease failed: ${error instanceof Error ? error.message : String(error)}`);
              });
            }
          } catch (error) {
            api.logger?.error?.(`[onebot] parse message failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        });

        socket.on("close", () => {
          api.logger?.info?.("[onebot] WebSocket closed");
          setWs(null);
        });

        socket.on("error", (error) => {
          api.logger?.error?.(`[onebot] WebSocket error: ${error.message}`);
        });

        api.logger?.info?.("[onebot] WebSocket connected");
      } catch (error) {
        api.logger?.error?.(`[onebot] service start failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    stop: async () => {
      stopImageTempCleanup();
      stopConnection();
      api.logger?.info?.("[onebot] service stopped");
    }
  });
}

