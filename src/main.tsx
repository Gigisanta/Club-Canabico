import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { Toaster } from "sonner";
import "@fontsource-variable/manrope";
import { App } from "./App";
import "./styles.css";
import "./inventory.css";
import "./design.css";
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
      <Toaster theme="light" richColors position="bottom-right" closeButton />
    </BrowserRouter>
  </React.StrictMode>,
);
