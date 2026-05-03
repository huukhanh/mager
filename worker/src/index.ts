import { Hono } from "hono";
import type { HonoEnv } from "./types";
import { adminJwtAuth } from "./middleware/auth-admin";
import { nodeSessionAuth } from "./middleware/auth-node";
import { loginHandler } from "./routes/auth";
import { nodeConfigHandler } from "./routes/config";
import { putIngressHandler } from "./routes/ingress-put";
import { deleteNodeHandler } from "./routes/nodes-delete";
import { listNodesHandler } from "./routes/nodes-list";
import { patchNodeHandler } from "./routes/nodes-patch";
import { registerHandler } from "./routes/register";

const app = new Hono<HonoEnv>();

app.post("/api/register", registerHandler);
app.post("/api/auth/login", loginHandler);

app.get("/api/nodes", adminJwtAuth, listNodesHandler);
app.patch("/api/nodes/:id", adminJwtAuth, patchNodeHandler);
app.delete("/api/nodes/:id", adminJwtAuth, deleteNodeHandler);
app.put("/api/nodes/:id/ingress", adminJwtAuth, putIngressHandler);

app.get("/api/nodes/:id/config", nodeSessionAuth, nodeConfigHandler);

export default {
  fetch: app.fetch,
};
