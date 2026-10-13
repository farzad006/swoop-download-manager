import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import Main from "./views/Main";
import Progress from "./views/Progress";
import Capture from "./views/Capture";
import Video from "./views/Video";
import Grabber from "./views/Grabber";
import Browsers from "./views/Browsers";

// Each Tauri window loads index.html#/<route>/<param>.
function Route() {
  const [, route, param] = window.location.hash.split("/");
  switch (route) {
    case "progress":
      return <Progress id={Number(param)} />;
    case "capture":
      return <Capture token={param} />;
    case "video":
      return <Video token={param} />;
    case "grabber":
      return <Grabber token={param} />;
    case "browsers":
      return <Browsers selected={(param ?? "").split(",").filter(Boolean)} />;
    default:
      return <Main />;
  }
}

// Native-app feel: no browser context menu outside text fields.
window.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement;
  if (!t.closest("input, textarea")) e.preventDefault();
});

async function boot() {
  // Plain-browser preview during development: fake the Rust backend.
  if (import.meta.env.DEV && !("__TAURI_INTERNALS__" in window && (window as any).__TAURI_INTERNALS__?.invoke)) {
    (await import("./dev/mockBackend")).installMockBackend();
  }
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <Route />
    </React.StrictMode>,
  );
}
boot();
