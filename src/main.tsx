import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Toaster } from "sonner";
import { App } from "./App";
import "./styles.css";
import "./inventory.css";
import "./design.css";
import "./app-brand.css";
import "./brand-system.css";
import "./navigation.css";
import "./bombo-ui.css";
// The old public preview remains available only in explicitly enabled local dev.
// Production ships its landing as a separate static project.
const PublicPreview = import.meta.env.DEV && import.meta.env.VITE_PUBLIC_SITE_PREVIEW === "true"
  ? React.lazy(() => import("./PublicSite").then(module => ({ default: module.PublicSite })))
  : null;
const preview = PublicPreview
  ? <React.Suspense fallback={<main aria-busy="true">Abriendo el club…</main>}><PublicPreview /></React.Suspense>
  : null;
function LegacyAppRedirect() {
  const location = useLocation();
  return <Navigate to={`/app${location.pathname}${location.search}${location.hash}`} replace />;
}
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/app/*" element={<App />} />
        <Route path="/" element={preview ?? <Navigate to="/app" replace />} />
        {preview && <Route path="/productos" element={preview} />}
        {preview && <Route path="/productos/:slug" element={preview} />}
        <Route path="*" element={<LegacyAppRedirect />} />
      </Routes>
      <Toaster theme="light" richColors position="bottom-right" closeButton />
    </BrowserRouter>
  </React.StrictMode>,
);
