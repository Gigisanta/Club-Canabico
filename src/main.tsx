import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { Toaster } from "sonner";
import { App } from "./App";
import { PublicSite } from "./PublicSite";
import "./styles.css";
import "./inventory.css";
import "./design.css";
import "./app-brand.css";
import "./brand-system.css";
import "./public-site.css";
function LegacyAppRedirect() {
  const location = useLocation();
  return <Navigate to={`/app${location.pathname}${location.search}${location.hash}`} replace />;
}
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<PublicSite />} />
        <Route path="/productos" element={<PublicSite />} />
        <Route path="/productos/:slug" element={<PublicSite />} />
        <Route path="/app/*" element={<App />} />
        <Route path="*" element={<LegacyAppRedirect />} />
      </Routes>
      <Toaster theme="light" richColors position="bottom-right" closeButton />
    </BrowserRouter>
  </React.StrictMode>,
);
