import { OneBotChannelPlugin } from "./channel.js";
import { registerService } from "./service.js";

export default function register(api: any): void {
  (globalThis as any).__onebotApi = api;
  (globalThis as any).__onebotGatewayConfig = api.config;

  api.registerChannel?.({ plugin: OneBotChannelPlugin });

  if (typeof api.registerCli === "function") {
    api.registerCli((ctx: any) => {
      const program = ctx.program;
      if (!program || typeof program.command !== "function") {
        return;
      }
      const onebot = program.command("onebot").description("OneBot 渠道配置");
      onebot.command("setup").description("交互式配置 OneBot 连接参数").action(async () => {
        const { runOneBotSetup } = await import("./setup.js");
        await runOneBotSetup();
      });
    });
  }

  registerService(api);
}

