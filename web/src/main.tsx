import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./styles.css";
import { connect } from "./store.ts";

// the pixel font has to be resident before the canvas draws text
document.fonts.load('8px "Silkscreen"').catch(() => {});

connect();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
