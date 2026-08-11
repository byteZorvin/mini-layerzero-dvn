interface Env {
  VERCEL_RELAY_URL: string;
  RELAY_TRIGGER_SECRET: string;
}

interface ScheduledController {
  scheduledTime: number;
  cron: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

declare const scheduler: { wait(delayMs: number): Promise<void> };

export async function trigger(env: Env, scheduledTime: number, pass: number): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(env.VERCEL_RELAY_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${env.RELAY_TRIGGER_SECRET}`,
          "content-type": "application/json",
          "x-mini-dvn-scheduled-time": String(scheduledTime),
          "x-mini-dvn-pass": String(pass),
        },
        body: JSON.stringify({ scheduledTime, pass }),
      });
      if (response.ok || response.status === 202) return;
      if (response.status < 500 || attempt === 1) throw new Error(`Vercel returned HTTP ${response.status}`);
    } catch (error) {
      if (attempt === 1) throw error;
    }
    await scheduler.wait(250 + Math.floor(Math.random() * 750));
  }
}

export async function runSchedule(controller: ScheduledController, env: Env): Promise<void> {
  await trigger(env, controller.scheduledTime, 1);
  await scheduler.wait(15_000);
  await trigger(env, controller.scheduledTime, 2);
}

export default {
  async scheduled(controller: ScheduledController, env: Env, context: ExecutionContext): Promise<void> {
    context.waitUntil(runSchedule(controller, env));
  },
  async fetch(): Promise<Response> {
    return Response.json({ status: "ok", service: "mini-dvn-scheduler" });
  },
};
