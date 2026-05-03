import { Hono } from "hono";
import type { HonoEnv } from "./types";
import { registerHandler } from "./routes/register";
import { nodeConfigHandler } from "./routes/config";
import { nodeSessionAuth } from "./middleware/auth-node";

const app = new Hono<HonoEnv>();

app.post("/api/register", registerHandler);
app.get("/api/nodes/:id/config", nodeSessionAuth, nodeConfigHandler);

export default {
  fetch: app.fetch,
};
