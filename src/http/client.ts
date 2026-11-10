import http from "node:http";
import type { AppConfig } from "../types.js";
import type { ConnectionPool } from "../ssh/pool.js";

/** 极简 HTTP 客户端（本机 /admin） */
export function adminRequest(
  cfg: AppConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request(
      {
        host: cfg.host,
        port: cfg.port,
        path,
        method,
        headers: {
          authorization: `Bearer ${cfg.token}`,
          "content-type": "application/json",
          ...(data ? { "content-length": String(data.length) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(Buffer.from(c)));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          let json: any = undefined;
          try {
            json = text ? JSON.parse(text) : undefined;
          } catch {
            json = text;
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

export function daemonAlive(cfg: AppConfig): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      { host: cfg.host, port: cfg.port, path: "/health", method: "GET", timeout: 1500 },
      (res) => {
        res.resume();
        resolve((res.statusCode ?? 0) === 200);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.end();
  });
}

export type { ConnectionPool };
