import type { ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { getAdminToken } from "./api/client";
import { LoginPage } from "./pages/LoginPage";
import { NodeDetailPage } from "./pages/NodeDetailPage";
import { NodesPage } from "./pages/NodesPage";

function Protected({ children }: { children: ReactNode }) {
  if (!getAdminToken()) {
    return <Navigate to="/login" replace />;
  }
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <Protected>
            <NodesPage />
          </Protected>
        }
      />
      <Route
        path="/nodes/:id"
        element={
          <Protected>
            <NodeDetailPage />
          </Protected>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
